//! 插件市场：社区目录浏览与 web profile 插件一键安装/移除。
//!
//! 目录数据源是 dsh-plugins-store 的公开 API（静态 JSON 快照，无鉴权）。
//! 消费约定遵循其 API 文档：验证状态只认 `validation.overall == "verified"`；
//! 安装只读 `install.candidate` 的 `action` + `specifier`（机器标识），
//! `command`/`args` 仅供展示，绝不执行。目录在 Rust 侧解析并投影成精简
//! 列表（丢弃 starTrend 历史点等大字段），前端只收几百 KB。

use super::components::{resolve_dsh_bin, web_profile_package_path};
use super::process::run_capture;
use crate::i18n::{tr, trf};
use serde::Serialize;
use std::time::Duration;

const MARKET_CATALOG_URL: &str = "https://api.dshmk.com/";
/// 目录约 27MB（gzip 后约 3MB）；慢网总超时放宽到 90s
const MARKET_FETCH_TIMEOUT: Duration = Duration::from_secs(90);
/// Launcher 自己管理的授权插件，不出现在可移除列表
const MANAGED_PLUGIN_PACKAGES: [&str; 2] = [
    "@dsh-external/dsh-client-connection-authz",
    "@dsh-external/dsh-auth-tailscale",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPlugin {
    pub repository_id: u64,
    pub full_name: String,
    pub name: String,
    pub description: Option<String>,
    pub url: String,
    pub stars: u64,
    pub category: Option<String>,
    pub language: Option<String>,
    /// 仅 validation.overall == "verified" 为真（目录约定的唯一判定依据）
    pub verified: bool,
    /// candidate.action == "add" 时的机器安装标识；None = 无一键安装候选
    pub install_specifier: Option<String>,
    pub install_executable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCatalog {
    pub generated_at: Option<String>,
    pub total: usize,
    pub plugins: Vec<MarketPlugin>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    /// npm 包名（profile package.json dependencies 键）
    pub name: String,
    /// 安装 spec（file: tarball / npm:x@ver / github:owner/repo 等）
    pub spec: String,
    /// Launcher 自管授权插件：不出移除按钮，由 Launcher 的修复/卸载流程管理
    pub managed: bool,
}

// ============ 目录 ============

pub(crate) fn plugin_from_json(v: &serde_json::Value) -> Option<MarketPlugin> {
    let full_name = v.get("fullName")?.as_str()?.to_string();
    let candidate = v.pointer("/install/candidate");
    let action = candidate.and_then(|c| c.get("action")).and_then(serde_json::Value::as_str);
    let specifier = candidate.and_then(|c| c.get("specifier")).and_then(serde_json::Value::as_str);
    let install_specifier = match (action, specifier) {
        (Some("add"), Some(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    };
    let name = v
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| full_name.clone());
    Some(MarketPlugin {
        repository_id: v.get("repositoryId").and_then(serde_json::Value::as_u64).unwrap_or(0),
        full_name,
        name,
        description: v.get("description").and_then(serde_json::Value::as_str).map(str::to_string),
        url: v
            .get("url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        stars: v.get("stars").and_then(serde_json::Value::as_u64).unwrap_or(0),
        category: v.get("category").and_then(serde_json::Value::as_str).map(str::to_string),
        language: v.get("language").and_then(serde_json::Value::as_str).map(str::to_string),
        verified: v.pointer("/validation/overall").and_then(serde_json::Value::as_str) == Some("verified"),
        install_specifier,
        install_executable: candidate
            .and_then(|c| c.get("executable"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

/// 拉取并解析社区目录。只投影浏览/安装所需字段，其余（starTrend 历史点、
/// validation stages 等）在解析时丢弃，避免 27MB 原文整包进 WebView
pub(crate) fn fetch_catalog() -> Result<MarketCatalog, String> {
    let resp = reqwest::blocking::Client::builder()
        .timeout(MARKET_FETCH_TIMEOUT)
        .user_agent(concat!("dsh-pro-max/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| {
            crate::logging::error("[market] HTTP client 初始化失败", &e.to_string());
            trf("Cannot initialize HTTP client: {error}", &[("error", e.to_string())])
        })?
        .get(MARKET_CATALOG_URL)
        .send()
        .map_err(|e| {
            crate::logging::error("[market] 目录拉取失败", &e.to_string());
            trf("Failed to fetch plugin catalog: {error}", &[("error", e.to_string())])
        })?;
    if !resp.status().is_success() {
        let status = resp.status();
        crate::logging::error("[market] 目录拉取失败", &status.to_string());
        return Err(trf(
            "Failed to fetch plugin catalog: HTTP {status}",
            &[("status", status.as_u16().to_string())],
        ));
    }
    let body: serde_json::Value = resp.json().map_err(|e| {
        crate::logging::error("[market] 目录解析失败", &e.to_string());
        trf("Failed to parse plugin catalog: {error}", &[("error", e.to_string())])
    })?;
    let generated_at = body
        .get("generatedAt")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let plugins: Vec<MarketPlugin> = body
        .get("repositories")
        .and_then(serde_json::Value::as_array)
        .map(|arr| arr.iter().filter_map(plugin_from_json).collect())
        .unwrap_or_default();
    let total = plugins.len();
    Ok(MarketCatalog {
        generated_at,
        total,
        plugins,
    })
}

// ============ 已装列表 / 安装 / 移除 ============

pub(crate) fn installed_plugins() -> Result<Vec<InstalledPlugin>, String> {
    installed_list_from_profile(&web_profile_package_path()?)
}

pub(crate) fn installed_list_from_profile(path: &std::path::PathBuf) -> Result<Vec<InstalledPlugin>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| {
        crate::logging::warn("[market] 读取 profile package.json 失败", &e.to_string());
        trf("Failed to read web profile: {error}", &[("error", e.to_string())])
    })?;
    let package: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        crate::logging::warn("[market] 解析 profile package.json 失败", &e.to_string());
        trf("Failed to parse web profile: {error}", &[("error", e.to_string())])
    })?;
    let deps = package
        .get("dependencies")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| tr("Web profile has no dependencies"))?;
    Ok(deps
        .iter()
        .map(|(name, spec)| InstalledPlugin {
            name: name.clone(),
            spec: spec.as_str().unwrap_or_default().to_string(),
            managed: MANAGED_PLUGIN_PACKAGES.contains(&name.as_str()),
        })
        .collect())
}

/// specifier / 包名白名单：npm 与 pnpm 的合法字符集。市场数据只经这两个
/// 参数进 dsh plugin 子命令（不经 shell），白名单挡的是写歪的目录数据与
/// 手改 IPC 的误用，而非注入
pub(crate) fn valid_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 214
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '.' | '_' | '-' | '#' | ':'))
        && !s.starts_with(['-', '#', ':', '/', '.'])
        && !s.contains("..")
}

fn run_plugin_cmd(action: &str, arg: &str) -> Result<(), String> {
    if !valid_identifier(arg) {
        return Err(tr("Invalid plugin identifier"));
    }
    let dsh = resolve_dsh_bin()?.display().to_string();
    let fail_key = |error: String| {
        if action == "add" {
            trf("Failed to install plugin: {error}", &[("error", error)])
        } else {
            trf("Failed to remove plugin: {error}", &[("error", error)])
        }
    };
    match run_capture(&dsh, &["plugin", "--profile", "web", action, arg]) {
        Ok((_, _, true)) => Ok(()),
        Ok((_, err, false)) => {
            let error = if err.is_empty() {
                format!("dsh plugin {action} failed")
            } else {
                err
            };
            crate::logging::error(&format!("[market] plugin {action} 失败"), &error);
            Err(fail_key(error))
        }
        Err(e) => {
            crate::logging::error(&format!("[market] plugin {action} 执行失败"), &e);
            Err(e)
        }
    }
}

// ============ IPC ============

#[tauri::command]
pub fn market_fetch() -> Result<MarketCatalog, String> {
    fetch_catalog()
}

#[tauri::command]
pub fn market_installed() -> Result<Vec<InstalledPlugin>, String> {
    installed_plugins()
}

/// 安装一键候选（specifier 如 npm:dsh-better-sidebar@latest 或
/// github:owner/repo#<sha>）；长操作（pnpm 下载依赖），UI 显示 busy
#[tauri::command]
pub fn market_install(specifier: String) -> Result<(), String> {
    run_plugin_cmd("add", &specifier)
}

#[tauri::command]
pub fn market_remove(name: String) -> Result<(), String> {
    run_plugin_cmd("remove", &name)
}
