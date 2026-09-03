//! 模型配置：读写 ~/.dsh/settings.yaml 的模型相关两键。
//!
//! UI 管理域 = `agent-default-model`（默认模型选择）+ `llm-pi-ai.providers`
//! （自定义提供商路由）。settings.yaml 其余顶层键（llm-deepseek、
//! agent-presets、ui-onboarding 等）不属于本域，save 一律原样保留；每个
//! 提供商路由的非管理键（超时、compat 等高级字段）经 extra 原样透传，
//! 编辑不丢失。凭据只存环境变量名（apiKeyEnv），密钥永不进配置文件。

use super::components::dsh_dir;
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value as Yaml};
use std::fs;
use std::path::PathBuf;
use crate::i18n::keyf;

/// UI 管理的提供商字段；其余字段经 extra 透传保留
const MANAGED_PROVIDER_KEYS: [&str; 5] = ["displayName", "baseURL", "api", "apiKeyEnv", "models"];
/// agent-default-model 与 llm-pi-ai 在 settings.yaml 的键名
const DEFAULT_MODEL_KEY: &str = "agent-default-model";
const PI_AI_KEY: &str = "llm-pi-ai";

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
                .filter_map(|e| e.get(Yaml::String("id".into())).and_then(Yaml::as_str).map(str::to_string))
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
        keyf("Failed to read settings.yaml: {error}", &[("error", e.to_string())])
    })?;
    let root: Yaml = serde_yaml::from_str(&raw).map_err(|e| {
        crate::logging::warn("解析 settings.yaml", &e.to_string());
        keyf("Failed to parse settings.yaml: {error}", &[("error", e.to_string())])
    })?;
    let map = root.as_mapping();
    let default = map.and_then(|m| m.get(Yaml::String(DEFAULT_MODEL_KEY.into()))).and_then(Yaml::as_mapping);
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
        serde_json::Value::Array(items) => items.iter().map(yaml_from_json).collect::<Vec<_>>().into(),
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
    match (non_empty(&config.default_provider), non_empty(&config.default_model)) {
        (Some(provider), Some(model)) => {
            let mut default = Mapping::new();
            default.insert(Yaml::String("provider".into()), Yaml::String(provider.into()));
            default.insert(Yaml::String("model".into()), Yaml::String(model.into()));
            if let Some(effort) = non_empty(&config.default_reasoning_effort) {
                default.insert(Yaml::String("reasoningEffort".into()), Yaml::String(effort.into()));
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
            providers.insert(Yaml::String(p.route.trim().to_string()), provider_to_yaml(p)?);
        }
        let mut pi_ai = Mapping::new();
        pi_ai.insert(Yaml::String("providers".into()), Yaml::Mapping(providers));
        root.insert(pi_ai_key, Yaml::Mapping(pi_ai));
    }
    let text = serde_yaml::to_string(&Yaml::Mapping(root)).map_err(|e| {
        crate::logging::error("序列化 settings.yaml", &e.to_string());
        keyf("Failed to serialize settings.yaml: {error}", &[("error", e.to_string())])
    })?;
    fs::write(path, text).map_err(|e| {
        crate::logging::error("写入 settings.yaml", &e.to_string());
        keyf("Failed to write settings.yaml: {error}", &[("error", e.to_string())])
    })
}

fn read_root(path: &PathBuf) -> Result<Yaml, String> {
    if !path.exists() {
        return Ok(Yaml::Mapping(Mapping::new()));
    }
    let raw = fs::read_to_string(path).map_err(|e| {
        crate::logging::warn("读取 settings.yaml", &e.to_string());
        keyf("Failed to read settings.yaml: {error}", &[("error", e.to_string())])
    })?;
    serde_yaml::from_str(&raw).map_err(|e| {
        crate::logging::warn("解析 settings.yaml", &e.to_string());
        keyf("Failed to parse settings.yaml: {error}", &[("error", e.to_string())])
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
