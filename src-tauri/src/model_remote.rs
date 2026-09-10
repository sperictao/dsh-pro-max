//! Provider 模型发现请求适配。
//!
//! `dsh::models` 负责 settings.yaml 模型域；这里仅承接带自定义 headers 的
//! `/models` HTTP 探测命令，避免凭据类 header 覆盖 `apiKeyEnv` 的认证语义。

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
    // apiKeyEnv 未配置 = 明确允许匿名模型发现；一旦配置则环境变量必须存在，
    // 不静默回退匿名访问，避免把凭据配置错误伪装成可用状态。
    let key = if let Some(env_name) = non_empty(api_key_env) {
        Some(std::env::var(env_name).map_err(|_| {
            crate::logging::warn("模型列表拉取缺密钥环境变量", env_name);
            keyf(
                "Environment variable is not set in the environment where dsh-pro-max was launched",
                &[],
            )
        })?)
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
}
