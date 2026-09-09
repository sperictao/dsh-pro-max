//! 模型配置：读写 ~/.dsh/settings.yaml 的模型相关两键。
//!
//! UI 管理域 = `agent-default-model`（默认模型选择）+ `llm-pi-ai.providers`
//! （自定义提供商路由）。settings.yaml 其余顶层键（llm-deepseek、
//! agent-presets、ui-onboarding 等）不属于本域，save 一律原样保留；每个
//! 提供商路由的非管理键（超时、compat 等高级字段）经 extra 原样透传，
//! 编辑不丢失。凭据只存环境变量名（apiKeyEnv），密钥永不进配置文件。

use super::components::dsh_dir;
use crate::i18n::keyf;
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value as Yaml};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

/// UI 管理的提供商字段；其余字段经 extra 透传保留
const MANAGED_PROVIDER_KEYS: [&str; 5] = ["displayName", "baseURL", "api", "apiKeyEnv", "models"];
/// agent-default-model 与 llm-pi-ai 在 settings.yaml 的键名
const DEFAULT_MODEL_KEY: &str = "agent-default-model";
const PI_AI_KEY: &str = "llm-pi-ai";

/// models.dev 全量模型目录（与 CCursor 同源）
pub(crate) const MODELS_DEV_API: &str = "https://models.dev/api.json";
const REMOTE_LIST_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct ProviderConfig {
    /// 提供商路由键（providers dict 的键，如 spero-ai），非空
    pub route: String,
    /// 显示名；缺省回落路由键
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default, rename = "baseURL")]
    #[ts(rename = "baseURL")]
    pub base_url: Option<String>,
    /// wire 协议：openai-completions | openai-responses | anthropic-messages
    #[serde(default)]
    pub api: Option<String>,
    /// 凭据引用（环境变量名），密钥永不落盘
    #[serde(default)]
    pub api_key_env: Option<String>,
    /// 模型 id 列表（models[].id）
    #[serde(default)]
    pub models: Vec<String>,
    /// 本路由的非管理键（高级字段），原样透传
    #[serde(default)]
    #[ts(type = "import(\"./serde_json/JsonValue\").JsonValue")]
    pub extra: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct ModelConfig {
    #[serde(default)]
    pub default_provider: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    /// 思考等级：off | minimal | low | medium | high | xhigh | max
    #[serde(default)]
    pub default_reasoning_effort: Option<String>,
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
}

pub(crate) fn settings_path() -> Result<PathBuf, String> {
    Ok(dsh_dir()?.join("settings.yaml"))
}

// ============ load ============

fn yaml_str(map: Option<&Mapping>, key: &str) -> Option<String> {
    map.and_then(|m| m.get(Yaml::String(key.into())))
        .and_then(Yaml::as_str)
        .map(str::to_string)
}

fn provider_from_yaml(route: &str, value: &Yaml) -> Option<ProviderConfig> {
    let map = value.as_mapping()?;
    let mut rest = map.clone();
    for key in MANAGED_PROVIDER_KEYS {
        rest.remove(Yaml::String(key.into()));
    }
    let models = map
        .get(Yaml::String("models".into()))
        .and_then(Yaml::as_sequence)
        .map(|seq| {
            seq.iter()
                .filter_map(|e| {
                    e.get(Yaml::String("id".into()))
                        .and_then(Yaml::as_str)
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    Some(ProviderConfig {
        route: route.to_string(),
        display_name: yaml_str(Some(map), "displayName"),
        base_url: yaml_str(Some(map), "baseURL"),
        api: yaml_str(Some(map), "api"),
        api_key_env: yaml_str(Some(map), "apiKeyEnv"),
        models,
        extra: serde_json::to_value(&rest).unwrap_or(serde_json::Value::Null),
    })
}

/// 从 settings.yaml 内容解析模型配置；文件不存在或为空 = 空配置
pub(crate) fn load_model_config_at(path: &PathBuf) -> Result<ModelConfig, String> {
    if !path.exists() {
        return Ok(ModelConfig::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| {
        crate::logging::warn("读取 settings.yaml", &e.to_string());
        keyf(
            "Failed to read settings.yaml: {error}",
            &[("error", e.to_string())],
        )
    })?;
    let root: Yaml = serde_yaml::from_str(&raw).map_err(|e| {
        crate::logging::warn("解析 settings.yaml", &e.to_string());
        keyf(
            "Failed to parse settings.yaml: {error}",
            &[("error", e.to_string())],
        )
    })?;
    let map = root.as_mapping();
    let default = map
        .and_then(|m| m.get(Yaml::String(DEFAULT_MODEL_KEY.into())))
        .and_then(Yaml::as_mapping);
    let providers = map
        .and_then(|m| m.get(Yaml::String(PI_AI_KEY.into())))
        .and_then(|v| v.get(Yaml::String("providers".into())))
        .and_then(Yaml::as_mapping)
        .map(|pm| {
            pm.iter()
                .filter_map(|(k, v)| k.as_str().and_then(|route| provider_from_yaml(route, v)))
                .collect()
        })
        .unwrap_or_default();
    Ok(ModelConfig {
        default_provider: yaml_str(default, "provider"),
        default_model: yaml_str(default, "model"),
        default_reasoning_effort: yaml_str(default, "reasoningEffort"),
        providers,
    })
}

// ============ save ============

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

fn provider_to_yaml(p: &ProviderConfig) -> Result<Yaml, String> {
    let mut map = Mapping::new();
    // 高级字段先进且无条件剥离管理键：这 5 个键的唯一事实来源是 UI 字段，
    // extra 混入同名键时一律丢弃；UI 提供值则随后写入，未提供则不出现
    match &p.extra {
        serde_json::Value::Null => {}
        serde_json::Value::Object(fields) => {
            for (k, v) in fields {
                if !MANAGED_PROVIDER_KEYS.contains(&k.as_str()) {
                    map.insert(Yaml::String(k.clone()), yaml_from_json(v));
                }
            }
        }
        _ => return Err("Model provider advanced fields must be an object".to_string()),
    }
    if let Some(v) = non_empty(&p.display_name) {
        map.insert(Yaml::String("displayName".into()), v.into());
    }
    if let Some(v) = non_empty(&p.base_url) {
        map.insert(Yaml::String("baseURL".into()), v.into());
    }
    if let Some(v) = non_empty(&p.api) {
        map.insert(Yaml::String("api".into()), v.into());
    }
    if let Some(v) = non_empty(&p.api_key_env) {
        map.insert(Yaml::String("apiKeyEnv".into()), v.into());
    }
    let models: Vec<Yaml> = p
        .models
        .iter()
        .filter(|id| !id.trim().is_empty())
        .map(|id| {
            let mut entry = Mapping::new();
            entry.insert(Yaml::String("id".into()), Yaml::String(id.clone()));
            Yaml::Mapping(entry)
        })
        .collect();
    if !models.is_empty() {
        map.insert(Yaml::String("models".into()), models.into());
    }
    Ok(Yaml::Mapping(map))
}

fn yaml_from_json(v: &serde_json::Value) -> Yaml {
    match v {
        serde_json::Value::Null => Yaml::Null,
        serde_json::Value::Bool(b) => Yaml::Bool(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Yaml::Number(i.into())
            } else {
                Yaml::Number(n.as_f64().unwrap_or(0.0).into())
            }
        }
        serde_json::Value::String(s) => Yaml::String(s.clone()),
        serde_json::Value::Array(items) => {
            items.iter().map(yaml_from_json).collect::<Vec<_>>().into()
        }
        serde_json::Value::Object(fields) => {
            let mut map = Mapping::new();
            for (k, v) in fields {
                map.insert(Yaml::String(k.clone()), yaml_from_json(v));
            }
            Yaml::Mapping(map)
        }
    }
}

/// 用 UI 状态重建模型相关两键并写回 settings.yaml；其余顶层键原样保留。
/// 默认模型 provider/model 缺任一则移除 agent-default-model；提供商列表
/// 为空则移除整个 llm-pi-ai 键（schema 里空 dict 与缺席等价，都不承载路由）
pub(crate) fn save_model_config_at(path: &PathBuf, config: &ModelConfig) -> Result<(), String> {
    let mut root = match read_root(path)? {
        Yaml::Mapping(map) => map,
        _ => Mapping::new(),
    };
    let default_key = Yaml::String(DEFAULT_MODEL_KEY.into());
    match (
        non_empty(&config.default_provider),
        non_empty(&config.default_model),
    ) {
        (Some(provider), Some(model)) => {
            let mut default = Mapping::new();
            default.insert(
                Yaml::String("provider".into()),
                Yaml::String(provider.into()),
            );
            default.insert(Yaml::String("model".into()), Yaml::String(model.into()));
            if let Some(effort) = non_empty(&config.default_reasoning_effort) {
                default.insert(
                    Yaml::String("reasoningEffort".into()),
                    Yaml::String(effort.into()),
                );
            }
            root.insert(default_key, Yaml::Mapping(default));
        }
        _ => {
            root.remove(default_key);
        }
    }
    let pi_ai_key = Yaml::String(PI_AI_KEY.into());
    if config.providers.is_empty() {
        root.remove(pi_ai_key);
    } else {
        let mut providers = Mapping::new();
        for p in &config.providers {
            if p.route.trim().is_empty() {
                return Err("Provider route key cannot be empty".to_string());
            }
            providers.insert(
                Yaml::String(p.route.trim().to_string()),
                provider_to_yaml(p)?,
            );
        }
        let mut pi_ai = Mapping::new();
        pi_ai.insert(Yaml::String("providers".into()), Yaml::Mapping(providers));
        root.insert(pi_ai_key, Yaml::Mapping(pi_ai));
    }
    let text = serde_yaml::to_string(&Yaml::Mapping(root)).map_err(|e| {
        crate::logging::error("序列化 settings.yaml", &e.to_string());
        keyf(
            "Failed to serialize settings.yaml: {error}",
            &[("error", e.to_string())],
        )
    })?;
    write_atomic(path, &text)
}

/// temp + rename 原子写：写入中断电/崩溃不会留下截断的 settings.yaml
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("yaml.tmp");
    fs::write(&tmp, text).map_err(|e| {
        crate::logging::error("写入 settings.yaml", &e.to_string());
        keyf(
            "Failed to write settings.yaml: {error}",
            &[("error", e.to_string())],
        )
    })?;
    // fsync 后再 rename：断电时 rename 后的目标不会是空/截断文件
    if let Ok(f) = fs::File::open(&tmp) {
        let _ = f.sync_all();
    }
    fs::rename(&tmp, path).map_err(|e| {
        crate::logging::error("替换 settings.yaml", &e.to_string());
        let _ = fs::remove_file(&tmp);
        keyf(
            "Failed to write settings.yaml: {error}",
            &[("error", e.to_string())],
        )
    })
}

fn read_root(path: &PathBuf) -> Result<Yaml, String> {
    if !path.exists() {
        return Ok(Yaml::Mapping(Mapping::new()));
    }
    let raw = fs::read_to_string(path).map_err(|e| {
        crate::logging::warn("读取 settings.yaml", &e.to_string());
        keyf(
            "Failed to read settings.yaml: {error}",
            &[("error", e.to_string())],
        )
    })?;
    serde_yaml::from_str(&raw).map_err(|e| {
        crate::logging::warn("解析 settings.yaml", &e.to_string());
        keyf(
            "Failed to parse settings.yaml: {error}",
            &[("error", e.to_string())],
        )
    })
}

// ============ IPC ============

#[tauri::command]
pub fn model_config_load() -> Result<ModelConfig, String> {
    load_model_config_at(&settings_path()?)
}

#[tauri::command]
pub fn model_config_save(config: ModelConfig) -> Result<(), String> {
    save_model_config_at(&settings_path()?, &config)
}

// ============ 模型目录（models.dev 全量快照）============

/// models.dev 投影条目：模型 id + 展示名 + 协议家族
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    /// openai | anthropic（dsh pi-ai 无 gemini 原生协议，google 端点经 openai 兼容）
    pub family: String,
}

/// 目录快照：缓存不是事实来源，fetched_at 供过期判断
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct CatalogFile {
    /// unix 秒（IPC 走 JSON number）
    #[ts(type = "number")]
    pub fetched_at: i64,
    pub entries: Vec<CatalogEntry>,
}

#[derive(Deserialize)]
struct ModelsDevProvider {
    #[serde(default)]
    models: HashMap<String, ModelsDevModel>,
}

#[derive(Deserialize)]
struct ModelsDevModel {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

/// family 归类：anthropic 官方键 → anthropic，其余（含 google）→ openai
fn catalog_family(provider_key: &str) -> &'static str {
    if provider_key == "anthropic" {
        "anthropic"
    } else {
        "openai"
    }
}

/// 解析 models.dev api.json 并投影：提取 {id,name,family}、按 id 去重（first-wins）、
/// 按 id 排序保证快照稳定；无 id 的条目丢弃
pub(crate) fn project_catalog(raw: &str, fetched_at: i64) -> Result<CatalogFile, String> {
    // BTreeMap：跨 provider 重复 id 的 first-wins 胜者按 provider 键序确定，刷新间不漂移
    let root: BTreeMap<String, ModelsDevProvider> = serde_json::from_str(raw).map_err(|e| {
        crate::logging::error("解析 models.dev 目录", &e.to_string());
        keyf("Failed to parse the model catalog", &[])
    })?;
    let mut by_id: BTreeMap<String, CatalogEntry> = BTreeMap::new();
    for (provider_key, provider) in root {
        let family = catalog_family(&provider_key);
        for (key, model) in provider.models {
            let Some(id) = model.id.or(if key.is_empty() { None } else { Some(key) }) else {
                continue;
            };
            if id.trim().is_empty() {
                continue;
            }
            by_id
                .entry(id.clone())
                .or_insert_with(|| CatalogEntry {
                    name: model.name.unwrap_or_else(|| id.clone()),
                    family: family.to_string(),
                    id,
                });
        }
    }
    Ok(CatalogFile {
        fetched_at,
        entries: by_id.into_values().collect(),
    })
}

fn unix_now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

fn fetch_url_text(url: &str, timeout_secs: u64) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .user_agent(concat!("dsh-pro-max/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| {
            crate::logging::error("HTTP client 初始化失败", &e.to_string());
            keyf("Cannot initialize the HTTP client", &[])
        })?;
    let resp = client.get(url).send().map_err(|e| {
        crate::logging::error("网络请求失败", &format!("{url}: {e}"));
        keyf("Failed to reach the model catalog", &[])
    })?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        crate::logging::warn("模型目录请求失败", &format!("HTTP {status}: {url}"));
        return Err(keyf("The model catalog request returned an HTTP error", &[]));
    }
    resp.text()
        .map_err(|_| keyf("Failed to read the model catalog response", &[]))
}

fn refresh_catalog_at(snapshot_path: &Path) -> Result<CatalogFile, String> {
    let raw = fetch_url_text(MODELS_DEV_API, REMOTE_LIST_TIMEOUT_SECS * 3)?;
    let file = project_catalog(&raw, unix_now())?;
    // 快照尽力而为：写失败只影响下次离线兜底，不影响本次返回
    if let Some(dir) = snapshot_path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(&file) {
        if let Err(e) = write_atomic(snapshot_path, &json) {
            crate::logging::warn("[models] 目录快照写入失败", &e);
        }
    }
    Ok(file)
}

fn catalog_snapshot_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|p| p.join("model-catalog-snapshot.json"))
        .map_err(|e| e.to_string())
}

/// 快照即缓存：缺失/损坏一律 None，静默等待后台刷新
pub(crate) fn load_model_catalog_snapshot(path: &Path) -> Option<CatalogFile> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[tauri::command]
pub fn model_catalog_load(app: tauri::AppHandle) -> Result<Option<CatalogFile>, String> {
    let path = catalog_snapshot_path(&app)?;
    Ok(load_model_catalog_snapshot(&path))
}

#[tauri::command]
pub async fn model_catalog_refresh(app: tauri::AppHandle) -> Result<CatalogFile, String> {
    super::ipc_blocking(move || refresh_catalog_at(&catalog_snapshot_path(&app)?)).await
}

// ============ 远端模型列表拉取（兼连通性验证）============

/// 按 wire 协议拼上游模型列表 URL；尾斜杠归一
pub(crate) fn remote_models_url(base_url: &str, api: Option<&str>) -> Result<String, String> {
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

/// 解析上游 /models 响应：取 data[].id，去重、字典序
pub(crate) fn parse_remote_models(json: &str) -> Vec<String> {
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
        .filter_map(|v| v.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// 密钥只在本函数内存中出现，不落盘、不进日志
pub(crate) fn fetch_remote_models(base_url: &str, api: Option<&str>, api_key_env: Option<&str>) -> Result<Vec<String>, String> {
    let env_holder = api_key_env.map(str::to_string);
    let env_name = non_empty(&env_holder)
        .ok_or_else(|| keyf("Provider API key environment variable is not configured", &[]))?;
    let key = std::env::var(env_name).map_err(|_| {
        crate::logging::warn("模型列表拉取缺密钥环境变量", env_name);
        keyf(
            "Environment variable is not set in the environment where dsh-pro-max was launched",
            &[],
        )
    })?;
    let url = remote_models_url(base_url, api)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(REMOTE_LIST_TIMEOUT_SECS))
        .user_agent(concat!("dsh-pro-max/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| {
            crate::logging::error("HTTP client 初始化失败", &e.to_string());
            keyf("Cannot initialize the HTTP client", &[])
        })?;
    let mut req = client.get(&url);
    req = if api == Some("anthropic-messages") {
        req.header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
    } else {
        req.bearer_auth(key)
    };
    let resp = req.send().map_err(|e| {
        // 细节（URL/原因）只进日志；key 值任何路径都不出现
        crate::logging::error("拉取模型列表失败", &format!("{url}: {e}"));
        keyf("Failed to reach the provider models endpoint", &[])
    })?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        crate::logging::warn("上游模型列表请求失败", &format!("HTTP {status}: {url}"));
        return Err(keyf(
            "The provider models endpoint returned an HTTP error",
            &[],
        ));
    }
    let text = resp
        .text()
        .map_err(|_| keyf("Failed to read the models response", &[]))?;
    Ok(parse_remote_models(&text))
}

#[tauri::command]
pub async fn model_remote_list(
    base_url: String,
    api: Option<String>,
    api_key_env: Option<String>,
) -> Result<Vec<String>, String> {
    super::ipc_blocking(move || {
        fetch_remote_models(&base_url, api.as_deref(), api_key_env.as_deref())
    })
    .await
}
