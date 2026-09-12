//! Provider 模型发现请求适配。
//!
//! `dsh::models` 负责 settings.yaml 模型域；这里承接带自定义 headers 的
//! `/models` HTTP 探测以及凭据环境变量可用性检查。后者只返回布尔值，绝不
//! 把 secret 内容跨 IPC 暴露给前端。

use crate::i18n::keyf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const REMOTE_LIST_TIMEOUT_SECS: u64 = 10;
const PROVIDER_MODELS_CACHE_VERSION: u8 = 1;
static PROVIDER_MODELS_CACHE_LOCK: Mutex<()> = Mutex::new(());
const RESERVED_HEADERS: [&str; 4] = [
    "authorization",
    "x-api-key",
    "cookie",
    "proxy-authorization",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelsCacheEntry {
    pub models: Vec<String>,
    pub fetched_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProviderModelsCacheFile {
    version: u8,
    #[serde(default)]
    entries: BTreeMap<String, ProviderModelsCacheEntry>,
}

fn provider_models_cache_path() -> Result<PathBuf, String> {
    Ok(crate::config::home_dir()?
        .join(".dsh-pro-max")
        .join("cache")
        .join("provider-models.json"))
}

fn provider_models_cache_key(
    base_url: &str,
    api: Option<&str>,
    api_key_env: Option<&str>,
    headers: Option<&BTreeMap<String, String>>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(base_url.trim().trim_end_matches('/').as_bytes());
    hasher.update([0]);
    hasher.update(api.unwrap_or("").trim().as_bytes());
    hasher.update([0]);
    hasher.update(api_key_env.unwrap_or("").trim().as_bytes());
    hasher.update([0]);
    if let Some(headers) = headers {
        for (name, value) in headers {
            if name.trim().is_empty() || is_reserved_header(name) {
                continue;
            }
            hasher.update(name.trim().to_ascii_lowercase().as_bytes());
            hasher.update([0]);
            hasher.update(value.as_bytes());
            hasher.update([0]);
        }
    }
    format!("{:x}", hasher.finalize())
}

fn load_provider_models_cache() -> ProviderModelsCacheFile {
    let Ok(path) = provider_models_cache_path() else {
        return ProviderModelsCacheFile::default();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return ProviderModelsCacheFile::default();
    };
    match serde_json::from_str::<ProviderModelsCacheFile>(&raw) {
        Ok(cache) if cache.version == PROVIDER_MODELS_CACHE_VERSION => cache,
        Ok(_) => ProviderModelsCacheFile::default(),
        Err(error) => {
            crate::logging::warn("解析 Provider 模型缓存失败", &error.to_string());
            ProviderModelsCacheFile::default()
        }
    }
}

fn save_provider_models_cache(cache: &ProviderModelsCacheFile) -> Result<(), String> {
    let path = provider_models_cache_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(cache).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())
}

fn cached_provider_models(
    base_url: &str,
    api: Option<&str>,
    api_key_env: Option<&str>,
    headers: Option<&BTreeMap<String, String>>,
) -> Option<ProviderModelsCacheEntry> {
    let _guard = PROVIDER_MODELS_CACHE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let key = provider_models_cache_key(base_url, api, api_key_env, headers);
    load_provider_models_cache().entries.get(&key).cloned()
}

fn remember_provider_models(
    base_url: &str,
    api: Option<&str>,
    api_key_env: Option<&str>,
    headers: Option<&BTreeMap<String, String>>,
    models: &[String],
) {
    if models.is_empty() {
        return;
    }
    let _guard = PROVIDER_MODELS_CACHE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fetched_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let key = provider_models_cache_key(base_url, api, api_key_env, headers);
    let mut cache = load_provider_models_cache();
    cache.version = PROVIDER_MODELS_CACHE_VERSION;
    cache.entries.insert(
        key,
        ProviderModelsCacheEntry { models: models.to_vec(), fetched_at },
    );
    if let Err(error) = save_provider_models_cache(&cache) {
        crate::logging::warn("写入 Provider 模型缓存失败", &error);
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn env_value_available(name: &str) -> bool {
    std::env::var(name)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn request_api_key(api_key: Option<&str>, api_key_env: Option<&str>) -> Result<Option<String>, String> {
    if let Some(value) = non_empty(api_key) {
        if !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
            return Err(keyf("API key contains invalid characters", &[]));
        }
        return Ok(Some(value.to_string()));
    }
    let Some(reference) = non_empty(api_key_env) else { return Ok(None) };
    let value = crate::model_credential_resolver::resolve(reference)?;
    value.map(Some).ok_or_else(|| keyf("API key is not configured", &[]))
}

fn remote_models_url(base_url: &str, api: Option<&str>) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(keyf(
            "Provider base URL is required to fetch models",
            &[],
        ));
    }
    if api == Some("anthropic-messages") {
        Ok(format!("{base}/v1/models"))
    } else {
        Ok(format!("{base}/models"))
    }
}

fn parse_remote_models(json: &str) -> Vec<String> {
    #[derive(Deserialize)]
    struct Resp {
        #[serde(default)]
        data: Vec<serde_json::Value>,
    }

    let Ok(resp) = serde_json::from_str::<Resp>(json) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = resp
        .data
        .iter()
        .filter_map(|value| value.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

fn is_reserved_header(name: &str) -> bool {
    let normalized = name.trim().to_ascii_lowercase();
    RESERVED_HEADERS.contains(&normalized.as_str())
}

fn apply_provider_headers(
    mut request: reqwest::blocking::RequestBuilder,
    headers: Option<&BTreeMap<String, String>>,
) -> reqwest::blocking::RequestBuilder {
    if let Some(headers) = headers {
        for (name, value) in headers {
            if name.trim().is_empty() || is_reserved_header(name) {
                continue;
            }
            request = request.header(name.as_str(), value.as_str());
        }
    }
    request
}

fn fetch_remote_models(
    base_url: &str,
    api: Option<&str>,
    api_key_env: Option<&str>,
    api_key: Option<&str>,
    headers: Option<&BTreeMap<String, String>>,
) -> Result<Vec<String>, String> {
    // Transient write-only key wins for an unsaved draft; otherwise resolve the stored
    // reference using the same precedence as DSH credentials-local.
    let key = request_api_key(api_key, api_key_env)?;

    let url = remote_models_url(base_url, api)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(REMOTE_LIST_TIMEOUT_SECS))
        .user_agent(concat!("dsh-pro-max/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| {
            crate::logging::error("HTTP client 初始化失败", &e.to_string());
            keyf("Cannot initialize the HTTP client", &[])
        })?;

    let mut request = client.get(&url);
    if api == Some("anthropic-messages") {
        request = request.header("anthropic-version", "2023-06-01");
        if let Some(key) = key.as_deref() {
            request = request.header("x-api-key", key);
        }
    } else if let Some(key) = key.as_deref() {
        request = request.bearer_auth(key);
    }

    // 普通自定义头最后应用；Authorization / x-api-key / Cookie /
    // Proxy-Authorization 永远由认证层掌控。
    request = apply_provider_headers(request, headers);

    let response = request.send().map_err(|e| {
        crate::logging::error("拉取模型列表失败", &format!("{url}: {e}"));
        keyf("Failed to reach the provider models endpoint", &[])
    })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        crate::logging::warn("上游模型列表请求失败", &format!("HTTP {status}: {url}"));
        return Err(keyf(
            "The provider models endpoint returned an HTTP error",
            &[],
        ));
    }

    let text = response
        .text()
        .map_err(|_| keyf("Failed to read the models response", &[]))?;
    Ok(parse_remote_models(&text))
}

/// 按 wire 协议拼真实推理端点。连接测试刻意不依赖 /models：一些兼容服务
/// 可以正常推理但没有模型列表接口。
fn provider_inference_url(base_url: &str, api: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(keyf("Provider base URL is required to test the connection", &[]));
    }
    match api {
        "openai-completions" => Ok(format!("{base}/chat/completions")),
        "openai-responses" => Ok(format!("{base}/responses")),
        "anthropic-messages" => {
            if base.ends_with("/v1") {
                Ok(format!("{base}/messages"))
            } else {
                Ok(format!("{base}/v1/messages"))
            }
        }
        _ => Err(keyf("Provider wire protocol is required to test the connection", &[])),
    }
}

/// 最小真实请求：只要求模型返回最多 16 个 token，既验证模型路由/认证，又避免
/// 把 Test Connection 变成一次正常对话。
fn provider_test_body(api: &str, model: &str) -> Result<serde_json::Value, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err(keyf("Provider model is required to test the connection", &[]));
    }
    match api {
        "openai-completions" => Ok(serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": "Reply OK." }],
            "max_tokens": 16
        })),
        "openai-responses" => Ok(serde_json::json!({
            "model": model,
            "input": "Reply OK.",
            "max_output_tokens": 16
        })),
        "anthropic-messages" => Ok(serde_json::json!({
            "model": model,
            "max_tokens": 16,
            "messages": [{ "role": "user", "content": "Reply OK." }]
        })),
        _ => Err(keyf("Provider wire protocol is required to test the connection", &[])),
    }
}

fn test_provider_connection(
    base_url: &str,
    api: &str,
    api_key_env: Option<&str>,
    api_key: Option<&str>,
    headers: Option<&BTreeMap<String, String>>,
    model: &str,
) -> Result<(), String> {
    let key = request_api_key(api_key, api_key_env)?;
    let url = provider_inference_url(base_url, api)?;
    let body = provider_test_body(api, model)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(REMOTE_LIST_TIMEOUT_SECS))
        .user_agent(concat!("dsh-pro-max/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| {
            crate::logging::error("HTTP client 初始化失败", &e.to_string());
            keyf("Cannot initialize the HTTP client", &[])
        })?;

    let mut request = client.post(&url);
    if api == "anthropic-messages" {
        request = request.header("anthropic-version", "2023-06-01");
        if let Some(key) = key.as_deref() {
            request = request.header("x-api-key", key);
        }
    } else if let Some(key) = key.as_deref() {
        request = request.bearer_auth(key);
    }
    request = apply_provider_headers(request, headers).json(&body);

    let response = request.send().map_err(|e| {
        crate::logging::error("模型服务连接测试失败", &format!("{url}: {e}"));
        keyf("Failed to reach the provider inference endpoint", &[])
    })?;
    if response.status().is_success() {
        return Ok(());
    }

    let status = response.status().as_u16();
    crate::logging::warn("模型服务连接测试返回错误", &format!("HTTP {status}: {url}"));
    Err(keyf(
        match status {
            401 | 403 => "Provider authentication failed",
            404 | 405 => "Provider endpoint or wire protocol is invalid",
            429 => "Provider connection test was rate limited",
            _ => "Provider connection test failed",
        },
        &[],
    ))
}

/// 批量检查密钥环境变量是否在 launcher 当前进程环境中存在且非空。
/// 返回值仅包含调用方传入的变量名与布尔状态，不读取/返回 secret 内容。
#[tauri::command]
pub fn model_env_status(names: Vec<String>) -> BTreeMap<String, bool> {
    names
        .into_iter()
        .filter_map(|raw| {
            let name = raw.trim().to_string();
            if name.is_empty() {
                None
            } else {
                let available = env_value_available(&name);
                Some((name, available))
            }
        })
        .collect()
}

#[tauri::command]
pub async fn model_remote_cache_get(
    base_url: String,
    api: Option<String>,
    api_key_env: Option<String>,
    headers: Option<BTreeMap<String, String>>,
) -> Result<Option<ProviderModelsCacheEntry>, String> {
    crate::dsh::ipc_blocking(move || {
        Ok(cached_provider_models(
            &base_url,
            api.as_deref(),
            api_key_env.as_deref(),
            headers.as_ref(),
        ))
    })
    .await
}

#[tauri::command]
pub async fn model_test_connection(
    base_url: String,
    api: String,
    api_key_env: Option<String>,
    headers: Option<BTreeMap<String, String>>,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    crate::dsh::ipc_blocking(move || {
        test_provider_connection(
            &base_url,
            &api,
            api_key_env.as_deref(),
            api_key.as_deref(),
            headers.as_ref(),
            &model,
        )
    })
    .await
}

#[tauri::command]
pub async fn model_remote_list_with_headers(
    base_url: String,
    api: Option<String>,
    api_key_env: Option<String>,
    headers: Option<BTreeMap<String, String>>,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    crate::dsh::ipc_blocking(move || {
        let models = fetch_remote_models(
            &base_url,
            api.as_deref(),
            api_key_env.as_deref(),
            api_key.as_deref(),
            headers.as_ref(),
        )?;
        remember_provider_models(
            &base_url,
            api.as_deref(),
            api_key_env.as_deref(),
            headers.as_ref(),
            &models,
        );
        Ok(models)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_credential_headers_are_filtered() {
        for name in ["Authorization", "x-api-key", "COOKIE", "Proxy-Authorization"] {
            assert!(is_reserved_header(name));
        }
        assert!(!is_reserved_header("X-Title"));
        assert!(!is_reserved_header("anthropic-version"));
    }

    #[test]
    fn provider_headers_apply_non_credentials_only() {
        let client = reqwest::blocking::Client::new();
        let mut headers = BTreeMap::new();
        headers.insert("X-Title".to_string(), "my-app".to_string());
        headers.insert("Authorization".to_string(), "Bearer should-not-win".to_string());
        headers.insert("x-api-key".to_string(), "should-not-win".to_string());

        let request = apply_provider_headers(client.get("http://127.0.0.1/"), Some(&headers))
            .build()
            .unwrap();
        assert_eq!(
            request
                .headers()
                .get("x-title")
                .and_then(|value| value.to_str().ok()),
            Some("my-app")
        );
        assert!(request.headers().get("authorization").is_none());
        assert!(request.headers().get("x-api-key").is_none());
    }

    #[test]
    fn connection_test_urls_target_inference_not_models() {
        assert_eq!(
            provider_inference_url("https://api.example.com/v1/", "openai-completions").unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            provider_inference_url("https://api.example.com/v1", "openai-responses").unwrap(),
            "https://api.example.com/v1/responses"
        );
        assert_eq!(
            provider_inference_url("https://api.anthropic.com", "anthropic-messages").unwrap(),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            provider_inference_url("https://api.anthropic.com/v1", "anthropic-messages").unwrap(),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn connection_test_bodies_cap_output_at_sixteen_tokens() {
        let chat = provider_test_body("openai-completions", "m").unwrap();
        assert_eq!(chat["model"], "m");
        assert_eq!(chat["max_tokens"], 16);

        let responses = provider_test_body("openai-responses", "m").unwrap();
        assert_eq!(responses["max_output_tokens"], 16);

        let anthropic = provider_test_body("anthropic-messages", "m").unwrap();
        assert_eq!(anthropic["max_tokens"], 16);
    }

    #[test]
    fn transient_api_key_is_validated_without_becoming_cache_identity() {
        assert_eq!(request_api_key(Some("sk-test_123"), None).unwrap().as_deref(), Some("sk-test_123"));
        assert!(request_api_key(Some("bad key"), None).is_err());
        assert_eq!(request_api_key(None, None).unwrap(), None);
    }

    #[test]
    fn provider_cache_key_tracks_connection_fingerprint_without_secret_values() {
        let mut headers = BTreeMap::new();
        headers.insert("X-Tenant".to_string(), "desktop".to_string());
        let a = provider_models_cache_key(
            "https://api.example.com/v1/",
            Some("openai-responses"),
            Some("API_KEY_ENV"),
            Some(&headers),
        );
        let b = provider_models_cache_key(
            "https://api.example.com/v1",
            Some("openai-responses"),
            Some("API_KEY_ENV"),
            Some(&headers),
        );
        assert_eq!(a, b);

        headers.insert("X-Tenant".to_string(), "other".to_string());
        let c = provider_models_cache_key(
            "https://api.example.com/v1",
            Some("openai-responses"),
            Some("API_KEY_ENV"),
            Some(&headers),
        );
        assert_ne!(a, c);

        headers.insert("Authorization".to_string(), "Bearer ignored".to_string());
        let d = provider_models_cache_key(
            "https://api.example.com/v1",
            Some("openai-responses"),
            Some("API_KEY_ENV"),
            Some(&headers),
        );
        assert_eq!(c, d);
    }

    #[test]
    fn env_status_trims_dedupes_and_does_not_expose_values() {
        let missing = "__DSH_PRO_MAX_READINESS_TEST_MISSING_8E4D3A2F__";
        let status = model_env_status(vec![
            "".to_string(),
            format!("  {missing}  "),
            missing.to_string(),
        ]);
        assert_eq!(status.len(), 1);
        assert_eq!(status.get(missing), Some(&false));
    }
}