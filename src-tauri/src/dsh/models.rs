//! 模型配置：读写 ~/.dsh/settings.yaml 的模型相关两键。
//!
//! UI 管理域 = `agent-default-model`（默认模型选择）+ `llm-pi-ai.providers`
//! （自定义提供商路由）。settings.yaml 其余顶层键（llm-deepseek、
//! agent-presets、ui-onboarding 等）不属于本域，save 一律原样保留。管理键
//! 以 dsh `PiAiProviderProfile` / `PiAiModelProfile` schema（UI 子集）为准：
//! 提供商级 = displayName/baseURL/api/apiKeyEnv/models/headers/timeoutMs/
//! reasoning，模型条目级 = id/name/contextWindow/maxTokens/input/
//! reasoningEfforts；每个提供商与其模型条目的非管理键（compat、重试策略等）
//! 分别经 extra 原样透传，编辑不丢失。凭据只存环境变量名（apiKeyEnv），
//! 密钥永不进配置文件。

use super::components::dsh_dir;
use crate::i18n::keyf;
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value as Yaml};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

/// UI 管理的提供商字段；其余字段经 extra 透传保留（dsh schema UI 子集）
const MANAGED_PROVIDER_KEYS: [&str; 8] = [
    "displayName",
    "baseURL",
    "api",
    "apiKeyEnv",
    "models",
    "headers",
    "timeoutMs",
    "reasoning",
];
/// UI 管理的模型条目字段；其余字段（compat 等）经条目 extra 透传保留
const MANAGED_MODEL_KEYS: [&str; 6] = [
    "id",
    "name",
    "contextWindow",
    "maxTokens",
    "input",
    "reasoningEfforts",
];
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
    /// wire 协议：openai-completions | openai-responses | anthropic-messages；
    /// 缺省时目录路由继承目录协议
    #[serde(default)]
    pub api: Option<String>,
    /// 凭据引用（环境变量名），密钥永不落盘
    #[serde(default)]
    pub api_key_env: Option<String>,
    /// 本路由的模型条目；空 = 不写 models 键（继承内置目录）
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    /// 请求头（凭据类保留头由 UI 拒收；dsh Harness 归因头优先）
    #[serde(default)]
    pub headers: Option<BTreeMap<String, String>>,
    /// 请求超时（毫秒）
    #[serde(default)]
    #[ts(type = "number | null")]
    pub timeout_ms: Option<u64>,
    /// 本路由默认推理档：off..max
    #[serde(default)]
    pub reasoning: Option<String>,
    /// 本路由的非管理键（compat、重试策略等高级字段），原样透传
    #[serde(default)]
    #[ts(type = "import(\"./serde_json/JsonValue\").JsonValue")]
    pub extra: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct ModelEntry {
    /// 模型 id（请求身份），非空
    pub id: String,
    /// 显示名；缺省回落目录名或 id
    #[serde(default)]
    pub name: Option<String>,
    /// 上下文窗口（token）；缺省继承目录
    #[serde(default)]
    #[ts(type = "number | null")]
    pub context_window: Option<u64>,
    /// 最大输出（token）；缺省继承目录
    #[serde(default)]
    #[ts(type = "number | null")]
    pub max_tokens: Option<u64>,
    /// 输入模态原样保留（text/image/...）；UI 以三态开关投影，缺省=继承目录
    #[serde(default)]
    pub input: Option<Vec<String>>,
    /// 推理档声明原样；缺省=继承目录（手写模型视为不支持推理）
    #[serde(default)]
    pub reasoning_efforts: Option<ReasoningEfforts>,
    /// 条目内非管理键（compat 等），原样透传
    #[serde(default)]
    #[ts(type = "import(\"./serde_json/JsonValue\").JsonValue")]
    pub extra: serde_json::Value,
}

/// dsh reasoningEfforts 原样形态：false = 手写声明不支持推理（UI 不改写，
/// 原样保留）；map = 档位 → wire 拼写（null = 支持但不发参，仅 off 档合法）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[serde(untagged)]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub enum ReasoningEfforts {
    Disabled(bool),
    Levels(BTreeMap<String, Option<String>>),
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

/// 剥出 mapping 中管理键后的剩余键（透传集合）；
/// 病态 YAML（非字符串键）序列化失败时记日志并以空透传兜底，不炸整个加载
fn unmanaged_fields(map: &Mapping, managed: &[&str]) -> serde_json::Value {
    let mut rest = map.clone();
    for key in managed {
        rest.remove(Yaml::String((*key).into()));
    }
    serde_json::to_value(&rest).unwrap_or_else(|e| {
        crate::logging::warn("透传字段序列化失败", &e.to_string());
        serde_json::Value::Null
    })
}

/// 类型不符的管理键按"丢弃"处理（与提供商级 extra 同名键丢弃规则一致）：
/// UI 字段是其唯一事实来源，schema 不接受的形态 dsh 也会拒收整个段落
fn model_entry_from_yaml(value: &Yaml) -> Option<ModelEntry> {
    if let Some(id) = value.as_str() {
        // 裸字符串条目（手写容错）= 仅 id
        return Some(ModelEntry {
            id: id.to_string(),
            name: None,
            context_window: None,
            max_tokens: None,
            input: None,
            reasoning_efforts: None,
            extra: serde_json::Value::Null,
        });
    }
    let map = value.as_mapping()?;
    let id = yaml_str(Some(map), "id")?;
    let input = map
        .get(Yaml::String("input".into()))
        .and_then(Yaml::as_sequence)
        .map(|seq| {
            seq.iter()
                .filter_map(Yaml::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        });
    let reasoning_efforts = map
        .get(Yaml::String("reasoningEfforts".into()))
        .and_then(|v| serde_json::to_value(v).ok())
        .and_then(|v| serde_json::from_value::<ReasoningEfforts>(v).ok());
    Some(ModelEntry {
        id,
        name: yaml_str(Some(map), "name"),
        context_window: map
            .get(Yaml::String("contextWindow".into()))
            .and_then(Yaml::as_u64),
        max_tokens: map
            .get(Yaml::String("maxTokens".into()))
            .and_then(Yaml::as_u64),
        input,
        reasoning_efforts,
        extra: unmanaged_fields(map, &MANAGED_MODEL_KEYS),
    })
}

fn provider_from_yaml(route: &str, value: &Yaml) -> Option<ProviderConfig> {
    let map = value.as_mapping()?;
    let models = map
        .get(Yaml::String("models".into()))
        .and_then(Yaml::as_sequence)
        .map(|seq| seq.iter().filter_map(model_entry_from_yaml).collect())
        .unwrap_or_default();
    let headers = map
        .get(Yaml::String("headers".into()))
        .and_then(Yaml::as_mapping)
        .map(|hm| {
            hm.iter()
                .filter_map(|(k, v)| {
                    let key = k.as_str()?;
                    let value = v.as_str()?;
                    Some((key.to_string(), value.to_string()))
                })
                .collect::<BTreeMap<_, _>>()
        });
    Some(ProviderConfig {
        route: route.to_string(),
        display_name: yaml_str(Some(map), "displayName"),
        base_url: yaml_str(Some(map), "baseURL"),
        api: yaml_str(Some(map), "api"),
        api_key_env: yaml_str(Some(map), "apiKeyEnv"),
        models,
        headers,
        timeout_ms: map
            .get(Yaml::String("timeoutMs".into()))
            .and_then(Yaml::as_u64),
        reasoning: yaml_str(Some(map), "reasoning"),
        extra: unmanaged_fields(map, &MANAGED_PROVIDER_KEYS),
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

fn reasoning_efforts_to_yaml(re: &ReasoningEfforts) -> Yaml {
    match re {
        ReasoningEfforts::Disabled(b) => Yaml::Bool(*b),
        ReasoningEfforts::Levels(levels) => {
            let mut map = Mapping::new();
            for (level, spelling) in levels {
                let value = spelling
                    .as_deref()
                    .map(|s| Yaml::String(s.to_string()))
                    .unwrap_or(Yaml::Null);
                map.insert(Yaml::String(level.clone()), value);
            }
            Yaml::Mapping(map)
        }
    }
}

fn model_entry_to_yaml(e: &ModelEntry) -> Result<Yaml, String> {
    if e.id.trim().is_empty() {
        return Err("Model id cannot be empty".to_string());
    }
    let mut map = Mapping::new();
    // 条目透传字段先进且无条件剥离管理键：与提供商级同规则，管理键的唯一
    // 事实来源是 UI 字段
    match &e.extra {
        serde_json::Value::Null => {}
        serde_json::Value::Object(fields) => {
            for (k, v) in fields {
                if !MANAGED_MODEL_KEYS.contains(&k.as_str()) {
                    map.insert(Yaml::String(k.clone()), yaml_from_json(v));
                }
            }
        }
        _ => return Err("Model entry advanced fields must be an object".to_string()),
    }
    map.insert(Yaml::String("id".into()), Yaml::String(e.id.clone()));
    if let Some(v) = non_empty(&e.name) {
        map.insert(Yaml::String("name".into()), v.into());
    }
    if let Some(v) = e.context_window {
        map.insert(Yaml::String("contextWindow".into()), v.into());
    }
    if let Some(v) = e.max_tokens {
        map.insert(Yaml::String("maxTokens".into()), v.into());
    }
    if let Some(input) = &e.input {
        let seq: Vec<Yaml> = input.iter().map(|m| Yaml::String(m.clone())).collect();
        if !seq.is_empty() {
            map.insert(Yaml::String("input".into()), seq.into());
        }
    }
    if let Some(re) = &e.reasoning_efforts {
        map.insert(
            Yaml::String("reasoningEfforts".into()),
            reasoning_efforts_to_yaml(re),
        );
    }
    Ok(Yaml::Mapping(map))
}

fn provider_to_yaml(p: &ProviderConfig) -> Result<Yaml, String> {
    let mut map = Mapping::new();
    // 高级字段先进且无条件剥离管理键：这些键的唯一事实来源是 UI 字段，
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
    // 空列表 = 不写 models 键：dsh 里缺省即继承内置目录，写空数组反而会
    // 把目录路由清成零模型
    if !p.models.is_empty() {
        let models: Vec<Yaml> = p
            .models
            .iter()
            .map(model_entry_to_yaml)
            .collect::<Result<_, _>>()?;
        map.insert(Yaml::String("models".into()), models.into());
    }
    if let Some(headers) = &p.headers {
        if !headers.is_empty() {
            let mut hm = Mapping::new();
            for (k, v) in headers {
                hm.insert(Yaml::String(k.clone()), Yaml::String(v.clone()));
            }
            map.insert(Yaml::String("headers".into()), Yaml::Mapping(hm));
        }
    }
    if let Some(v) = p.timeout_ms {
        map.insert(Yaml::String("timeoutMs".into()), v.into());
    }
    if let Some(v) = non_empty(&p.reasoning) {
        map.insert(Yaml::String("reasoning".into()), v.into());
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

/// models.dev 投影条目：模型身份 + 核心容量/能力元数据。
/// 新增字段保持 optional，使旧快照仍可反序列化；新投影会完整填充这些字段。
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    /// openai | anthropic（dsh pi-ai 无 gemini 原生协议，google 端点经 openai 兼容）
    pub family: String,
    /// 目录标注的上下文窗口（token）；缺失为 null（UI 不显示缩写）
    #[serde(default)]
    #[ts(type = "number | null")]
    pub context: Option<i64>,
    /// 最大输出 token；旧快照/目录未发布时省略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub max_tokens: Option<i64>,
    /// 已发布的输入模态（text/image/pdf/...）；未发布时省略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub input: Option<Vec<String>>,
    /// models.dev 对 reasoning 的显式声明；未发布时省略而不是猜测。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reasoning: Option<bool>,
    /// 规范化后的 reasoning 档位；none 归一为 off，按 dsh canonical order 排序。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reasoning_levels: Option<Vec<String>>,
    /// 核心能力投影：text/vision/pdf/audio/video/tools/attachments/reasoning/json。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub capabilities: Option<Vec<String>>,
}

/// 目录快照：缓存不是事实来源，fetched_at 供过期判断
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct CatalogFile {
    /// unix 秒（IPC 走 JSON number）
    #[ts(type = "number")]
    pub fetched_at: i64,
    /// models.dev 中至少发布一个模型的 provider 数；旧快照缺席时为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub provider_count: Option<usize>,
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
    #[serde(default)]
    limit: Option<ModelsDevLimit>,
    #[serde(default)]
    reasoning: Option<bool>,
    #[serde(default)]
    reasoning_options: Option<Vec<ModelsDevReasoningOption>>,
    #[serde(default)]
    modalities: Option<ModelsDevModalities>,
    #[serde(default)]
    attachment: Option<bool>,
    #[serde(default)]
    tool_call: Option<bool>,
    #[serde(default)]
    structured_output: Option<bool>,
}

#[derive(Deserialize)]
struct ModelsDevLimit {
    #[serde(default)]
    context: Option<i64>,
    #[serde(default)]
    output: Option<i64>,
}

#[derive(Deserialize)]
struct ModelsDevReasoningOption {
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    values: Option<Vec<serde_json::Value>>,
}

#[derive(Deserialize)]
struct ModelsDevModalities {
    #[serde(default)]
    input: Vec<String>,
    #[serde(default)]
    output: Vec<String>,
}

/// family 归类：anthropic 官方键 → anthropic，其余（含 google）→ openai
fn catalog_family(provider_key: &str) -> &'static str {
    if provider_key == "anthropic" {
        "anthropic"
    } else {
        "openai"
    }
}

const REASONING_LEVEL_ORDER: [&str; 7] =
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

fn normalize_reasoning_level(value: &str) -> Option<&'static str> {
    let normalized = if value == "none" { "off" } else { value };
    REASONING_LEVEL_ORDER
        .iter()
        .copied()
        .find(|level| *level == normalized)
}

/// 与 PI-Desktop 的 models.dev 规则对齐：显式 values 转 canonical level；
/// toggle / budget_tokens 至少支持 off + medium；仅声明 reasoning=true 而没有
/// option 时采用 low/medium/high 的保守默认档。
fn catalog_reasoning_levels(model: &ModelsDevModel) -> Option<Vec<String>> {
    match model.reasoning {
        None => None,
        Some(false) => Some(Vec::new()),
        Some(true) => {
            let mut found: Vec<&'static str> = Vec::new();
            for option in model.reasoning_options.as_deref().unwrap_or_default() {
                if matches!(option.kind.as_deref(), Some("toggle" | "budget_tokens")) {
                    found.push("off");
                    found.push("medium");
                }
                for value in option.values.as_deref().unwrap_or_default() {
                    if let Some(value) = value.as_str().and_then(normalize_reasoning_level) {
                        found.push(value);
                    }
                }
            }
            if found.is_empty() {
                found.extend(["low", "medium", "high"]);
            }
            let levels = REASONING_LEVEL_ORDER
                .iter()
                .filter(|level| found.contains(level))
                .map(|level| (*level).to_string())
                .collect();
            Some(levels)
        }
    }
}

fn catalog_capabilities(model: &ModelsDevModel) -> Vec<String> {
    let mut values = vec!["text".to_string()];
    let mut add = |capability: &str| {
        if !values.iter().any(|item| item == capability) {
            values.push(capability.to_string());
        }
    };
    if model.attachment == Some(true) {
        add("attachments");
    }
    if model.tool_call == Some(true) {
        add("tools");
    }
    if model.reasoning == Some(true) {
        add("reasoning");
    }
    if model.structured_output == Some(true) {
        add("json");
    }
    if let Some(modalities) = &model.modalities {
        for modality in modalities.input.iter().chain(modalities.output.iter()) {
            match modality.as_str() {
                "image" => add("vision"),
                "pdf" => add("pdf"),
                "audio" => add("audio"),
                "video" => add("video"),
                _ => {}
            }
        }
    }
    values
}

/// 解析 models.dev api.json 并投影核心模型元数据；按 id 去重（first-wins）、
/// 按 id 排序保证快照稳定；无 id 的条目丢弃。
pub(crate) fn project_catalog(raw: &str, fetched_at: i64) -> Result<CatalogFile, String> {
    // BTreeMap：跨 provider 重复 id 的 first-wins 胜者按 provider 键序确定，刷新间不漂移
    let root: BTreeMap<String, ModelsDevProvider> = serde_json::from_str(raw).map_err(|e| {
        crate::logging::error("解析 models.dev 目录", &e.to_string());
        keyf("Failed to parse the model catalog", &[])
    })?;
    // providerCount 表达目录覆盖面，不从跨 provider 去重后的 model 数反推。
    // 空 provider 不计入可用覆盖面；旧快照没有该字段时由 UI 触发后台刷新。
    let provider_count = root
        .values()
        .filter(|provider| !provider.models.is_empty())
        .count();
    let mut by_id: BTreeMap<String, CatalogEntry> = BTreeMap::new();
    for (provider_key, provider) in root {
        let family = catalog_family(&provider_key);
        for (key, model) in provider.models {
            let Some(id) = model
                .id
                .clone()
                .or(if key.is_empty() { None } else { Some(key) })
            else {
                continue;
            };
            if id.trim().is_empty() {
                continue;
            }
            let context = model.limit.as_ref().and_then(|limit| limit.context);
            let max_tokens = model.limit.as_ref().and_then(|limit| limit.output);
            let input = model
                .modalities
                .as_ref()
                .map(|modalities| modalities.input.clone());
            let reasoning_levels = catalog_reasoning_levels(&model);
            let capabilities = catalog_capabilities(&model);
            by_id.entry(id.clone()).or_insert_with(|| CatalogEntry {
                name: model.name.clone().unwrap_or_else(|| id.clone()),
                family: family.to_string(),
                context,
                max_tokens,
                input,
                reasoning: model.reasoning,
                reasoning_levels,
                capabilities: Some(capabilities),
                id,
            });
        }
    }
    Ok(CatalogFile {
        fetched_at,
        provider_count: Some(provider_count),
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
        return Err(keyf(
            "The model catalog request returned an HTTP error",
            &[],
        ));
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
        return Err(keyf("Provider base URL is required to fetch models", &[]));
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

/// 可选凭据仅在本函数内存中出现，不落盘、不进日志。
/// 未配置 apiKeyEnv 时按无认证服务请求；一旦显式配置环境变量名，则变量
/// 缺失仍视为配置错误，不静默降级成匿名请求。
pub(crate) fn fetch_remote_models(
    base_url: &str,
    api: Option<&str>,
    api_key_env: Option<&str>,
) -> Result<Vec<String>, String> {
    let env_name = api_key_env.map(str::trim).filter(|name| !name.is_empty());
    let key = match env_name {
        Some(name) => Some(std::env::var(name).map_err(|_| {
            crate::logging::warn("模型列表拉取缺密钥环境变量", name);
            keyf(
                "Environment variable is not set in the environment where dsh-pro-max was launched",
                &[],
            )
        })?),
        None => None,
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
    let mut req = client.get(&url);
    if api == Some("anthropic-messages") {
        req = req.header("anthropic-version", "2023-06-01");
        if let Some(key) = key.as_deref() {
            req = req.header("x-api-key", key);
        }
    } else if let Some(key) = key.as_deref() {
        req = req.bearer_auth(key);
    }
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

#[cfg(test)]
mod catalog_observability_tests {
    use super::{project_catalog, CatalogFile};

    #[test]
    fn catalog_reports_provider_coverage_independent_of_model_deduplication() {
        let raw = r#"{
            "alpha": {"models": {"a": {"id": "shared", "name": "Shared A"}}},
            "beta": {"models": {"b": {"id": "shared", "name": "Shared B"}}},
            "empty": {"models": {}}
        }"#;
        let catalog = project_catalog(raw, 123).expect("project catalog");
        assert_eq!(catalog.provider_count, Some(2));
        assert_eq!(
            catalog.entries.len(),
            1,
            "model ids remain globally deduplicated"
        );
    }

    #[test]
    fn legacy_catalog_snapshot_without_provider_count_remains_readable() {
        let legacy = r#"{"fetchedAt":123,"entries":[]}"#;
        let catalog: CatalogFile = serde_json::from_str(legacy).expect("legacy snapshot");
        assert_eq!(catalog.provider_count, None);
    }
}
