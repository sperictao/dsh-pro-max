//! Provider 模型发现请求适配。
//!
//! `dsh::models` 负责 settings.yaml 模型域；这里承接带自定义 headers 的
//! `/models` HTTP 探测以及凭据环境变量可用性检查。后者只返回布尔值，绝不
//! 把 secret 内容跨 IPC 暴露给前端。

use crate::i18n::keyf;
use serde::Deserialize;
use std::collections::BTreeMap;

const REMOTE_LIST_TIMEOUT_SECS: u64 = 10;
const RESERVED_HEADERS: [&str; 4] = [
    "authorization",
    "x-api-key",
    "cookie",
    "proxy-authorization",
];

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn env_value_available(name: &str) -> bool {
    std::env::var(name)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn required_env_value(name: &str) -> Result<String, String> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Ok(value),
        _ => {
            crate::logging::warn("模型服务缺密钥环境变量", name);
            Err(keyf(
                "Environment variable is not set in the environment where dsh-pro-max was launched",
                &[],
            ))
        }
    }
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
    headers: Option<&BTreeMap<String, String>>,
) -> Result<Vec<String>, String> {
    // apiKeyEnv 未配置 = 明确允许匿名模型发现；一旦配置则环境变量必须存在且
    // 非空，不静默回退匿名访问，避免把凭据配置错误伪装成可用状态。
    let key = if let Some(env_name) = non_empty(api_key_env) {
        Some(required_env_value(env_name)?)
    } else {
        None
    };

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
    headers: Option<&BTreeMap<String, String>>,
    model: &str,
) -> Result<(), String> {
    let key = if let Some(env_name) = non_empty(api_key_env) {
        Some(required_env_value(env_name)?)
    } else {
        None
    };
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
pub async fn model_test_connection(
    base_url: String,
    api: String,
    api_key_env: Option<String>,
    headers: Option<BTreeMap<String, String>>,
    model: String,
) -> Result<(), String> {
    crate::dsh::ipc_blocking(move || {
        test_provider_connection(
            &base_url,
            &api,
            api_key_env.as_deref(),
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
) -> Result<Vec<String>, String> {
    crate::dsh::ipc_blocking(move || {
        fetch_remote_models(
            &base_url,
            api.as_deref(),
            api_key_env.as_deref(),
            headers.as_ref(),
        )
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