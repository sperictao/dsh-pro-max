//! 模型配置导入：扫描本机其他 agent 工具的 provider 声明并导入 settings.yaml。
//!
//! 凭据语义对齐本应用的 apiKeyEnv 设计：来源是环境变量引用（`{env:VAR}`、
//! `env:VAR`、Codex `env_key`）的直接映射为 apiKeyEnv；来源是明文密钥的
//! 一律不读取、不展示、不落盘，只以 literal 计数提示（内置目录路由可靠
//! pi-ai 的环境发现兜底）。解析规则对齐 PI-Desktop 的五源导入器
//! （claude-code / codex / opencode / pi / cc-switch）；CC Switch 仅支持
//! legacy config.json 形态（sqlite 不引入 rusqlite 依赖）。
//!
//! 扫描源缺失/损坏一律静默跳过：导入是便利功能，来源工具未装不是错误。

use crate::config::home_dir;
use super::models::{
    load_model_config_at, save_model_config_at, settings_path, ModelEntry, ProviderConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// 单个来源条目的模型数上限与显示名截断（防病态来源文件，对齐 PI 导入器）
const MAX_MODELS_PER_PROVIDER: usize = 64;
const MAX_NAME_LENGTH: usize = 80;

/// 一个可导入的候选 provider（凭据明文永不进入本结构）
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct ImportCandidate {
    /// `source:externalId`，run 的选择依据
    pub key: String,
    /// 建议路由键（providers dict 的键）
    pub route: String,
    /// 显示名
    pub name: String,
    #[serde(default, rename = "baseURL")]
    #[ts(rename = "baseURL")]
    pub base_url: Option<String>,
    /// wire 协议（openai-completions | openai-responses | anthropic-messages | null）
    #[serde(default)]
    pub api: Option<String>,
    /// 环境变量引用名；仅 credential = "env" 时非空
    #[serde(default)]
    pub api_key_env: Option<String>,
    /// env = 环境变量引用 | literal = 来源持明文（值不导入）| none = 无凭据声明
    pub credential: String,
    pub models: Vec<String>,
}

/// 按来源分组的扫描结果（固定来源顺序，缺失的来源为空组）
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct ImportGroup {
    pub source: String,
    pub entries: Vec<ImportCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct ImportRunResult {
    pub imported: u32,
    pub skipped: u32,
    pub failed: u32,
    /// 选中条目中来源为明文密钥的数量（提示用户补环境变量）
    pub literal: u32,
}

/// 导入源顺序即展示顺序
const SOURCES: [&str; 5] = ["claude-code", "codex", "opencode", "pi", "cc-switch"];

#[derive(Debug, Clone, PartialEq)]
enum Credential {
    /// 环境变量名引用，可直接映射 apiKeyEnv
    Env(String),
    /// 来源持明文密钥：值不读取，仅计数提示
    Literal,
    None,
}

#[derive(Debug, Clone)]
struct Draft {
    external_id: String,
    name: Option<String>,
    base_url: Option<String>,
    api: Option<String>,
    credential: Credential,
    models: Vec<String>,
}

fn candidate_from_draft(key_prefix: &str, draft: Draft) -> Option<(String, ImportCandidate)> {
    let external = draft.external_id.trim();
    if external.is_empty() {
        return None;
    }
    let (api_key_env, credential) = match draft.credential {
        Credential::Env(name) => (Some(name), "env"),
        Credential::Literal => (None, "literal"),
        Credential::None => (None, "none"),
    };
    let key = format!("{key_prefix}{external}");
    Some((
        key.clone(),
        ImportCandidate {
            key,
            route: sanitize_route(external),
            name: clip_name(draft.name.as_deref().unwrap_or(external)),
            base_url: draft.base_url,
            api: draft.api,
            api_key_env,
            credential: credential.into(),
            models: unique_models(draft.models),
        },
    ))
}

// ============ 解析工具 ============

fn first_string(values: Vec<Option<String>>) -> Option<String> {
    values
        .iter()
        .flatten()
        .map(|s| s.trim().to_string())
        .find(|s| !s.is_empty())
}

/// 病态占位值判定（对齐 PI isPlaceholderSecret），占位值视同无凭据
fn is_placeholder_secret(value: &str) -> bool {
    let t = value.trim();
    if t.is_empty() {
        return true;
    }
    let lower = t.to_lowercase();
    if lower == "changeme" || lower.chars().all(|c| c == 'x') {
        return true;
    }
    // ${VAR} / $VAR 形态
    let inner = t.strip_prefix("${").and_then(|s| s.strip_suffix('}'));
    let var_ref = inner.or_else(|| t.strip_prefix('$'));
    if let Some(name) = var_ref {
        if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return true;
        }
    }
    lower.contains("your") && lower.contains("key")
}

/// 密钥值分类：`{env:VAR}` / `env:VAR` = 环境变量引用；其余非占位值 = 明文
fn classify_secret(raw: Option<&str>) -> Credential {
    let Some(raw) = raw else { return Credential::None };
    let t = raw.trim();
    if t.is_empty() || is_placeholder_secret(t) {
        return Credential::None;
    }
    let braced = t
        .strip_prefix("{env:")
        .and_then(|s| s.strip_suffix('}'))
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(name) = braced {
        return Credential::Env(name.to_string());
    }
    if let Some(name) = t.strip_prefix("env:").map(str::trim).filter(|s| !s.is_empty()) {
        return Credential::Env(name.to_string());
    }
    Credential::Literal
}

/// 取第一个非 None 的凭据分类
fn first_credential(values: &[Option<String>]) -> Credential {
    for v in values {
        let c = classify_secret(v.as_deref());
        if c != Credential::None {
            return c;
        }
    }
    Credential::None
}

/// 来源 wire 协议别名 → 本应用三协议；不可识别 = None（路由键命中目录时继承）
fn resolve_api(raw: Option<String>) -> Option<String> {
    let key = raw?.trim().to_lowercase().replace(['_', ' '], "-");
    match key.as_str() {
        "chat" | "chat-completions" | "completions" | "openai-chat" | "openai-completions" => {
            Some("openai-completions".into())
        }
        "responses" | "openai-responses" => Some("openai-responses".into()),
        "anthropic" | "anthropic-messages" => Some("anthropic-messages".into()),
        _ => None,
    }
}

/// npm 适配器名 → 协议猜测（对齐 PI apiStyleForAdapter 的常用分支）
fn api_from_npm(npm: Option<String>) -> Option<String> {
    if npm?.to_lowercase().contains("anthropic") {
        Some("anthropic-messages".into())
    } else {
        Some("openai-completions".into())
    }
}

/// 模型 id 提取：字符串 | {id|model|modelId|modelID} 对象
fn model_id_from(value: &Json) -> Option<String> {
    match value {
        Json::String(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        Json::Object(o) => ["id", "model", "modelId", "modelID"]
            .iter()
            .find_map(|k| {
                o.get(*k)
                    .and_then(Json::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            }),
        _ => None,
    }
}

/// models 字段：字符串/对象数组，或以键为 id 的 dict
fn model_ids_from(value: Option<&Json>) -> Vec<String> {
    match value {
        Some(Json::Array(items)) => items.iter().filter_map(model_id_from).collect(),
        Some(Json::Object(o)) => o
            .keys()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn unique_models(mut ids: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    ids.retain(|id| seen.insert(id.clone()));
    ids.truncate(MAX_MODELS_PER_PROVIDER);
    ids
}

fn sanitize_route(external: &str) -> String {
    let cleaned = external.split_whitespace().collect::<Vec<_>>().join("-");
    if cleaned.is_empty() {
        "imported".into()
    } else {
        cleaned
    }
}

fn clip_name(name: &str) -> String {
    let collapsed = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return "Imported provider".into();
    }
    if collapsed.chars().count() > MAX_NAME_LENGTH {
        let cut: String = collapsed.chars().take(MAX_NAME_LENGTH - 1).collect();
        format!("{cut}…")
    } else {
        collapsed
    }
}

// ============ 各来源解析（纯函数，tests.rs 覆盖）============

/// Claude Code：`~/.claude/settings.json(.local)` 的 env 块。凭据是明文值
/// （Claude 运行时注入，不一定是全局导出的环境变量），一律只按 literal 计数；
/// 无自定义端点时路由键取内置目录 id `anthropic`（继承目录端点与模型目录）。
pub(crate) fn parse_claude_code(settings: &Json, local: Option<&Json>) -> Vec<(String, ImportCandidate)> {
    let empty = serde_json::Map::new();
    let global = settings.as_object().unwrap_or(&empty);
    let local_map = local.and_then(Json::as_object).unwrap_or(&empty);
    let env_str = |name: &str| -> Option<String> {
        local_map
            .get("env")
            .and_then(|e| e.get(name))
            .or_else(|| global.get("env").and_then(|e| e.get(name)))
            .and_then(Json::as_str)
            .map(str::to_string)
    };
    let str_field = |m: &serde_json::Map<String, Json>, name: &str| -> Option<String> {
        m.get(name)
            .and_then(Json::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let base_url = first_string(vec![
        env_str("ANTHROPIC_BASE_URL"),
        env_str("ANTHROPIC_API_URL"),
    ]);
    let credential = first_credential(&[
        env_str("ANTHROPIC_API_KEY"),
        env_str("ANTHROPIC_AUTH_TOKEN"),
    ]);
    let models = unique_models(
        [
            str_field(local_map, "model"),
            str_field(global, "model"),
            env_str("ANTHROPIC_DEFAULT_SONNET_MODEL"),
            env_str("ANTHROPIC_DEFAULT_OPUS_MODEL"),
            env_str("ANTHROPIC_DEFAULT_HAIKU_MODEL"),
            env_str("ANTHROPIC_MODEL"),
        ]
        .into_iter()
        .flatten()
        .collect(),
    );
    if models.is_empty() && base_url.is_none() && credential == Credential::None {
        return Vec::new();
    }
    let route = if base_url.is_some() { "claude-code" } else { "anthropic" };
    let (api_key_env, credential_str) = match credential {
        // Claude 的 env 块持的是值；即使形如 env 引用也按 literal 处理，
        // 因为那不是本机 shell 可保证的环境变量
        Credential::Env(_) | Credential::Literal => (None, "literal"),
        Credential::None => (None, "none"),
    };
    let key = format!("claude-code:{route}");
    vec![(
        key.clone(),
        ImportCandidate {
            key,
            route: route.into(),
            name: "Claude Code".into(),
            base_url,
            api: Some("anthropic-messages".into()),
            api_key_env,
            credential: credential_str.into(),
            models,
        },
    )]
}

/// Codex：`~/.codex/config.toml` 的 `[model_providers.<id>]`。`env_key` 是
/// 环境变量名引用，直接映射 apiKeyEnv；明文 `api_key` 只按 literal 计数。
pub(crate) fn parse_codex(toml_text: &str) -> Vec<(String, ImportCandidate)> {
    // toml 0.9 的 Value::from_str 只解析单值，文档必须经 from_str::<Table>
    let Ok(root) = toml::from_str::<toml::Table>(toml_text) else {
        return Vec::new();
    };
    let Some(providers) = root.get("model_providers").and_then(|v| v.as_table()) else {
        return Vec::new();
    };
    let default_model = root
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let mut out = Vec::new();
    for (id, value) in providers {
        let Some(table) = value.as_table() else { continue };
        let get_str = |k: &str| -> Option<String> {
            table
                .get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let env_key = get_str("env_key").or_else(|| get_str("envKey"));
        let credential = match first_credential(&[get_str("api_key"), get_str("apiKey")]) {
            Credential::Literal => Credential::Literal,
            _ => match env_key {
                Some(name) => Credential::Env(name),
                None => Credential::None,
            },
        };
        let mut models = Vec::new();
        if let Some(m) = default_model.clone() {
            models.push(m);
        }
        if let Some(csv) = get_str("models") {
            models.extend(csv.split(',').map(|s| s.trim().to_string()));
        }
        let api = resolve_api(get_str("wire_api").or_else(|| get_str("wireApi")))
            .or_else(|| Some("openai-completions".into()));
        let Some((key, candidate)) = candidate_from_draft(
            "codex:",
            Draft {
                external_id: id.clone(),
                name: get_str("name"),
                base_url: get_str("base_url").or_else(|| get_str("baseUrl")),
                api,
                credential,
                models,
            },
        ) else {
            continue;
        };
        out.push((key, candidate));
    }
    out
}

/// 剥离 JSON 里的行/块注释（OpenCode 的 jsonc 形态），字符串内的内容不动
fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    let mut quote = ' ';
    let mut escaped = false;
    while let Some(ch) = chars.next() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' | '\'' => {
                in_string = true;
                quote = ch;
                out.push(ch);
            }
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        out.push(c);
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '*' && chars.peek() == Some(&'/') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => out.push(ch),
        }
    }
    out
}

fn parse_json_text(text: &str) -> Option<Json> {
    serde_json::from_str(text)
        .ok()
        .or_else(|| serde_json::from_str(&strip_jsonc(text)).ok())
}

/// OpenCode：`~/.config/opencode/opencode.json(c)` + `auth.json`。配置里的
/// apiKey 可能是 `{env:VAR}` 引用（映射 apiKeyEnv）；auth.json 里是明文（只计数）。
pub(crate) fn parse_opencode(config: &Json, auth: Option<&Json>) -> Vec<(String, ImportCandidate)> {
    let empty = serde_json::Map::new();
    let root = config.as_object().unwrap_or(&empty);
    let providers = root
        .get("provider")
        .or_else(|| root.get("providers"))
        .and_then(Json::as_object)
        .unwrap_or(&empty);
    let auth_map = auth.and_then(Json::as_object).unwrap_or(&empty);
    let default_model = root
        .get("model")
        .and_then(Json::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let mut out = Vec::new();
    for (id, raw) in providers {
        let Some(record) = raw.as_object() else { continue };
        let options = record.get("options").and_then(Json::as_object);
        let opt_str = |key: &str| -> Option<String> {
            options
                .and_then(|o| o.get(key))
                .or_else(|| record.get(key))
                .and_then(Json::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let base_url = first_string(vec![opt_str("baseURL"), opt_str("baseUrl")]);
        let npm = opt_str("npm").or_else(|| opt_str("adapter"));
        let api = resolve_api(opt_str("api").or_else(|| opt_str("apiStyle")))
            .or_else(|| api_from_npm(npm.clone()))
            .or_else(|| Some("openai-completions".into()));
        let mut models = model_ids_from(record.get("models"));
        if models.is_empty() {
            if let Some(dm) = default_model.clone() {
                models.push(dm);
            }
        }
        if models.is_empty() {
            continue;
        }
        let auth_key = auth_map
            .get(id)
            .and_then(Json::as_object)
            .and_then(|o| o.get("api_key").or_else(|| o.get("apiKey")))
            .and_then(Json::as_str)
            .map(str::to_string);
        let credential =
            first_credential(&[opt_str("apiKey"), opt_str("api_key"), auth_key.clone()]);
        let Some((key, candidate)) = candidate_from_draft(
            "opencode:",
            Draft {
                external_id: id.clone(),
                name: opt_str("name").or_else(|| opt_str("label")),
                base_url,
                api,
                credential,
                models,
            },
        ) else {
            continue;
        };
        out.push((key, candidate));
    }
    out
}

/// Pi：`~/.pi/agent/models.json` 的 `{providers: {id: {...}}}`（或顶层即 map）
pub(crate) fn parse_pi(models_json: &Json) -> Vec<(String, ImportCandidate)> {
    let empty = serde_json::Map::new();
    let root = models_json.as_object().unwrap_or(&empty);
    let providers = root
        .get("providers")
        .and_then(Json::as_object)
        .unwrap_or(root);
    let mut out = Vec::new();
    for (id, raw) in providers {
        if id == "providers" {
            continue;
        }
        let Some(record) = raw.as_object() else { continue };
        let get_str = |k: &str| -> Option<String> {
            record
                .get(k)
                .and_then(Json::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let base_url = first_string(vec![get_str("baseUrl"), get_str("baseURL"), get_str("url")]);
        let api = resolve_api(get_str("api").or_else(|| get_str("apiStyle")).or_else(|| get_str("type")))
            .or_else(|| Some("openai-completions".into()));
        let models = model_ids_from(record.get("models"));
        if models.is_empty() {
            continue;
        }
        let credential = first_credential(&[get_str("apiKey"), get_str("api_key")]);
        let Some((key, candidate)) = candidate_from_draft(
            "pi:",
            Draft {
                external_id: id.clone(),
                name: get_str("name").or_else(|| get_str("label")),
                base_url,
                api,
                credential,
                models,
            },
        ) else {
            continue;
        };
        out.push((key, candidate));
    }
    out
}

/// CC Switch legacy `~/.cc-switch/config.json`（MultiAppConfig）：每个
/// appType 下 `{ providers: { id: { name, settingsConfig } } }`，settingsConfig
/// 按对应工具的形态复用同一套解析器
pub(crate) fn parse_cc_switch(config: &Json) -> Vec<(String, ImportCandidate)> {
    let empty = serde_json::Map::new();
    let root = config.as_object().unwrap_or(&empty);
    let mut out = Vec::new();
    for app_type in [
        "claude",
        "claude-desktop",
        "codex",
        "opencode",
        "hermes",
        "pi",
        "gemini",
    ] {
        let Some(app) = root.get(app_type).and_then(Json::as_object) else {
            continue;
        };
        let Some(providers) = app.get("providers").and_then(Json::as_object) else {
            continue;
        };
        for (id, raw) in providers {
            let Some(record) = raw.as_object() else { continue };
            let display_name = record
                .get("name")
                .and_then(Json::as_str)
                .map(str::to_string);
            let settings = record
                .get("settingsConfig")
                .or_else(|| record.get("settings_config"))
                .cloned()
                .unwrap_or_else(|| raw.clone());
            let tagged = match app_type {
                "claude" | "claude-desktop" => parse_claude_code(&settings, None),
                "codex" => parse_codex(
                    settings.get("config").and_then(Json::as_str).unwrap_or_default(),
                ),
                "opencode" | "hermes" => parse_opencode(&settings, None),
                "pi" => parse_pi(&settings),
                "gemini" => parse_cc_switch_gemini(&settings),
                _ => Vec::new(),
            };
            for (_, mut candidate) in tagged {
                if let Some(name) = &display_name {
                    candidate.name = clip_name(name);
                }
                // CC Switch 一次导入多个 app 的同名 id，路由键带 appType 前缀防撞
                candidate.route = sanitize_route(&format!("{app_type}-{id}"));
                candidate.key = format!("cc-switch:{app_type}:{id}");
                out.push((candidate.key.clone(), candidate));
            }
        }
    }
    out
}

fn parse_cc_switch_gemini(settings: &Json) -> Vec<(String, ImportCandidate)> {
    let empty = serde_json::Map::new();
    let record = settings.as_object().unwrap_or(&empty);
    let env = record.get("env").and_then(Json::as_object).unwrap_or(&empty);
    let env_str = |k: &str| -> Option<String> {
        env.get(k)
            .and_then(Json::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let base_url = first_string(vec![
        env_str("GOOGLE_GEMINI_BASE_URL"),
        env_str("GEMINI_BASE_URL"),
        env_str("GOOGLE_API_BASE"),
    ]);
    let credential = first_credential(&[env_str("GEMINI_API_KEY"), env_str("GOOGLE_API_KEY")]);
    let models = unique_models(
        [
            record
                .get("config")
                .and_then(|c| c.get("model"))
                .and_then(Json::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            record
                .get("model")
                .and_then(Json::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            env_str("GEMINI_MODEL"),
            env_str("GOOGLE_MODEL"),
        ]
        .into_iter()
        .flatten()
        .collect(),
    );
    if models.is_empty() && base_url.is_none() && credential == Credential::None {
        return Vec::new();
    }
    let key = "cc-switch:gemini".to_string();
    vec![(
        key.clone(),
        ImportCandidate {
            key,
            route: "gemini".into(),
            name: "Gemini".into(),
            base_url,
            api: None,
            api_key_env: None,
            credential: match credential {
                Credential::Env(_) | Credential::Literal => "literal".into(),
                Credential::None => "none".into(),
            },
            models,
        },
    )]
}

// ============ 扫描与导入 ============

fn source_files(home: &Path) -> [(&'static str, [PathBuf; 2]); 5] {
    [
        (
            "claude-code",
            [
                home.join(".claude").join("settings.json"),
                home.join(".claude").join("settings.local.json"),
            ],
        ),
        ("codex", [home.join(".codex").join("config.toml"), PathBuf::new()]),
        (
            "opencode",
            [
                home.join(".config").join("opencode").join("opencode.json"),
                home.join(".config").join("opencode").join("auth.json"),
            ],
        ),
        ("pi", [home.join(".pi").join("agent").join("models.json"), PathBuf::new()]),
        ("cc-switch", [home.join(".cc-switch").join("config.json"), PathBuf::new()]),
    ]
}

fn read_optional_json(path: &Path) -> Option<Json> {
    let text = fs::read_to_string(path).ok()?;
    parse_json_text(&text)
}

/// 扫描本机导入源；来源缺失/损坏静默为空组（导入是便利功能，不是错误）。
/// 来源顺序固定为 SOURCES，保证 key 与展示稳定。
pub(crate) fn scan_at(home: &Path) -> Vec<ImportGroup> {
    let files = source_files(home);
    SOURCES
        .iter()
        .map(|&source| {
            let paths = &files.iter().find(|(s, _)| *s == source).unwrap().1;
            let entries = match source {
                "claude-code" => read_optional_json(&paths[0])
                    .map(|settings| {
                        parse_claude_code(&settings, read_optional_json(&paths[1]).as_ref())
                    })
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(_, c)| c)
                    .collect(),
                "codex" => fs::read_to_string(&paths[0])
                    .map(|text| parse_codex(&text))
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(_, c)| c)
                    .collect(),
                "opencode" => read_optional_json(&paths[0])
                    .map(|config| parse_opencode(&config, read_optional_json(&paths[1]).as_ref()))
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(_, c)| c)
                    .collect(),
                "pi" => read_optional_json(&paths[0])
                    .map(|f| parse_pi(&f))
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(_, c)| c)
                    .collect(),
                "cc-switch" => read_optional_json(&paths[0])
                    .map(|f| parse_cc_switch(&f))
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(_, c)| c)
                    .collect(),
                _ => Vec::new(),
            };
            ImportGroup {
                source: source.into(),
                entries,
            }
        })
        .collect()
}

/// 与既有 provider 重复 = 路由键相同，或（端点 + 协议 + 凭据引用）三元组全同
fn matches_existing(candidate: &ImportCandidate, providers: &[ProviderConfig]) -> bool {
    providers.iter().any(|p| {
        if p.route == candidate.route {
            return true;
        }
        let url_eq = match (&p.base_url, &candidate.base_url) {
            (Some(a), Some(b)) => {
                a.trim().trim_end_matches('/') == b.trim().trim_end_matches('/')
            }
            (None, None) => true,
            _ => false,
        };
        url_eq && p.api == candidate.api && p.api_key_env == candidate.api_key_env
    })
}

/// 把选中候选合并进 settings.yaml（重新扫描后按 key 选择，保证与展示一致）
pub(crate) fn run_at(
    home: &Path,
    settings: &Path,
    keys: &[String],
) -> Result<ImportRunResult, String> {
    let selected: Vec<ImportCandidate> = scan_at(home)
        .into_iter()
        .flat_map(|g| g.entries)
        .filter(|c| keys.iter().any(|k| k == &c.key))
        .collect();
    let mut result = ImportRunResult {
        imported: 0,
        skipped: 0,
        failed: 0,
        literal: selected.iter().filter(|c| c.credential == "literal").count() as u32,
    };
    if selected.is_empty() {
        return Ok(result);
    }
    let mut config = load_model_config_at(&settings.to_path_buf())?;
    let mut batch_routes: BTreeSet<String> = BTreeSet::new();
    for candidate in selected {
        if matches_existing(&candidate, &config.providers)
            || !batch_routes.insert(candidate.route.clone())
        {
            result.skipped += 1;
            continue;
        }
        config.providers.push(ProviderConfig {
            route: candidate.route.clone(),
            display_name: Some(candidate.name.clone()),
            base_url: candidate.base_url.clone(),
            api: candidate.api.clone(),
            api_key_env: candidate.api_key_env.clone(),
            models: candidate
                .models
                .iter()
                .map(|id| ModelEntry {
                    id: id.clone(),
                    name: None,
                    context_window: None,
                    max_tokens: None,
                    input: None,
                    reasoning_efforts: None,
                    extra: Json::Null,
                })
                .collect(),
            headers: None,
            timeout_ms: None,
            reasoning: None,
            extra: Json::Null,
        });
        result.imported += 1;
    }
    save_model_config_at(&settings.to_path_buf(), &config)?;
    Ok(result)
}

fn import_scan() -> Result<Vec<ImportGroup>, String> {
    Ok(scan_at(&home_dir()?))
}

fn import_run(keys: Vec<String>) -> Result<ImportRunResult, String> {
    run_at(&home_dir()?, &settings_path()?, &keys)
}

#[tauri::command]
pub async fn model_config_import_scan() -> Result<Vec<ImportGroup>, String> {
    super::ipc_blocking(import_scan).await
}

#[tauri::command]
pub async fn model_config_import_run(keys: Vec<String>) -> Result<ImportRunResult, String> {
    super::ipc_blocking(move || import_run(keys)).await
}
