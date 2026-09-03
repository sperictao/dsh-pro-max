//! 插件市场：社区目录浏览与 web profile 插件一键安装/移除。
//!
//! 目录数据源是 awesome-dsh-plugin 的 curated 目录（静态 JSON，无鉴权），
//! 可经 LauncherConfig 的 `market_catalog_url` 指向镜像（同一 plugins.json
//! 契约）。目录没有契约版本字段，用结构校验代替：`plugins` 投影不出非空
//! 列表即拒绝（升级是破坏性默认，不猜格式）；安装 specifier 从条目
//! `install` 命令串中解析机器标识，命令本身绝不执行；`deprecated`/
//! `replacement` 弃用标记与多语言描述原样透传，launcher 不做二次加工。
//! 目录在 Rust 侧解析并投影成精简列表（丢弃 screenshots、tarball 等浏览
//! 用不上的字段），前端只收几百 KB。
//!
//! 可复述与可治理：每次成功拉取后把投影目录落盘为本地快照（旧契约快照按
//! 无快照处理、下次成功拉取自动重建）；前端首屏直读快照、网络目录由
//! market_fetch 后台刷新替换，快照数据与断网降级都如实标注 `fromSnapshot`。
//! 安装/移除写 append-only 审计台账（app log dir 下 `plugin-audit.jsonl`）；
//! `~/.dsh-pro-max/plugin-policy.json` 白名单约束可安装的包；安装成功返回
//! 落盘回执（name + spec）。

use super::components::{resolve_dsh_bin, web_profile_package_path};
use super::process::{run_capture_lines};
use crate::i18n::{tr, trf};
use crate::version::{is_newer, parse_version};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;
use tauri::Emitter;

pub(crate) const MARKET_CATALOG_URL: &str = "https://awesome-dsh-plugin.com/plugins.json";
/// 目录约 300KB（curated 精选列表），30s 足够慢网走完
const MARKET_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// 单包 registry latest 查询超时（逐包串行，已装列表是个位数）
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(10);
/// Launcher 自己管理的授权插件，不出现在可移除列表
const MANAGED_PLUGIN_PACKAGES: [&str; 2] = [
    "@dsh-external/dsh-client-connection-authz",
    "@dsh-external/dsh-auth-tailscale",
];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPlugin {
    /// `owner/name`（owner 缺失时从 repo url 派生）：展示与排序键
    pub full_name: String,
    pub name: String,
    /// 多语言描述原样透传（如 {"en": "...", "zh": "..."}），前端按界面语言取
    pub description: Option<BTreeMap<String, String>>,
    pub url: String,
    /// null = 目录暂无数据（新收录或仓库 404），不静默当 0
    pub stars: Option<u64>,
    /// 分类 id（显示名经目录顶层的 categories 表本地化）
    pub category: Option<String>,
    /// 目录 `install` 命令串中解析出的安装标识；None = 无一键安装候选，
    /// 前端显示 Manual install only
    pub install_specifier: Option<String>,
    /// 目录侧弃用标记原样透传
    pub deprecated: bool,
    /// 弃用时目录建议的替代插件名
    pub replacement: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCatalog {
    /// 目录生成日期（目录原生 `updated`，如 "2026-08-31"）
    pub updated: Option<String>,
    /// 分类 id → {语言 → 显示名}，目录原生表原样透传（前端按界面语言取）
    pub categories: BTreeMap<String, BTreeMap<String, String>>,
    pub total: usize,
    pub plugins: Vec<MarketPlugin>,
    /// 数据来自本地快照（首屏直读或断网降级）；UI 在刷新结束后如实标注
    pub from_snapshot: bool,
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

/// 安装回执：本次安装落进 profile 的 dependencies 键与 spec。
/// github: 重装等无法唯一确定落点的场景返回 None（安装本身仍成功）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReceipt {
    pub name: String,
    pub spec: String,
}

/// 安装结果：成功带回执；被 pnpm 拦截构建脚本时转审批请求（被拦包名 +
/// 待写文件路径）。审批是用户决策点：安装脚本以用户身份执行任意代码，
/// launcher 不静默放行
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum InstallOutcome {
    Installed { receipt: Option<InstallReceipt> },
    #[serde(rename_all = "camelCase")]
    NeedsApproval { packages: Vec<String>, workspace_yaml: String },
}

/// 目录加载失败的两类：契约不符必须原样上报（不能拿旧快照掩盖升级信号），
/// 网络/响应体问题允许降级到本地快照
#[derive(Debug)]
pub(crate) enum CatalogLoadError {
    UnsupportedSchema(String),
    Transient(String),
}

// ============ 目录 ============

/// 从目录 JSON 条目投影出 MarketPlugin，只取浏览/安装所需字段（screenshots、
/// page、npm、tarball、added、downloads 等浏览与安装用不上的字段丢弃）。
/// 缺 name 的条目整条丢弃：脏数据不进列表
pub(crate) fn plugin_from_json(v: &serde_json::Value) -> Option<MarketPlugin> {
    let name = v.get("name").and_then(serde_json::Value::as_str).filter(|s| !s.is_empty())?;
    let url = v
        .get("url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let owner = v
        .get("owner")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            // owner 缺失时从 repo url 派生（目录条目形如 https://github.com/<owner>/<name>）
            url.strip_prefix("https://github.com/")?
                .split('/')
                .next()
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_default();
    let full_name = if owner.is_empty() { name.to_string() } else { format!("{owner}/{name}") };
    let description = v
        .get("description")
        .and_then(serde_json::Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<BTreeMap<_, _>>()
        })
        .filter(|m| !m.is_empty());
    // category 是分类 id；数组形态（旧目录遗留）取首个
    let category = match v.get("category") {
        Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .find_map(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        _ => None,
    };
    // 安装 specifier = `install` 命令串中 ` add ` 之后的 token：命令是给人看的
    // 展示文本，launcher 只取机器标识，绝不执行整条命令。解析不出或过不了
    // 字符白名单 → None（前端显示 Manual install only，与安装时闸门同一规则）
    let install_specifier = v
        .get("install")
        .and_then(serde_json::Value::as_str)
        .and_then(|cmd| cmd.rsplit_once(" add "))
        .map(|(_, spec)| spec.trim())
        .filter(|spec| valid_identifier(spec))
        .map(str::to_string);
    Some(MarketPlugin {
        full_name,
        name: name.to_string(),
        description,
        url,
        stars: v.get("stars").and_then(serde_json::Value::as_u64),
        category,
        install_specifier,
        deprecated: v.get("deprecated").and_then(serde_json::Value::as_bool).unwrap_or(false),
        replacement: v
            .get("replacement")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    })
}

/// 解析目录 JSON 原文并投影。目录没有契约版本字段，用结构校验代替：
/// `plugins` 投影不出非空列表即按目录格式不符拒绝（不拿旧快照掩盖，
/// 给升级/修镜像两条下一步）
pub(crate) fn catalog_from_raw(raw: &str, from_snapshot: bool) -> Result<MarketCatalog, CatalogLoadError> {
    let body: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        crate::logging::error("[market] 目录解析失败", &e.to_string());
        CatalogLoadError::Transient(trf(
            "Failed to parse plugin catalog: {error}",
            &[("error", e.to_string())],
        ))
    })?;
    let plugins: Vec<MarketPlugin> = body
        .get("plugins")
        .and_then(serde_json::Value::as_array)
        .map(|arr| arr.iter().filter_map(plugin_from_json).collect())
        .unwrap_or_default();
    if plugins.is_empty() {
        crate::logging::error("[market] 目录格式不符", "plugins 非空数组缺失或全部条目无法投影");
        return Err(CatalogLoadError::UnsupportedSchema(tr(
            "Unrecognized plugin catalog format; update the app or fix the catalog mirror",
        )));
    }
    // 分类表原样透传；缺失/畸形按空表处理，前端回退展示分类 id（纯展示数据，
    // 失败不放大全目录）
    let categories: BTreeMap<String, BTreeMap<String, String>> = body
        .get("categories")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let updated = body.get("updated").and_then(serde_json::Value::as_str).map(str::to_string);
    let total = plugins.len();
    Ok(MarketCatalog {
        updated,
        categories,
        total,
        plugins,
        from_snapshot,
    })
}

/// 目录源：空 = 内置官方源；非空必须显式带协议，避免把写歪的配置当地址用
pub(crate) fn resolve_catalog_url(configured: &str) -> Result<String, String> {
    let url = configured.trim();
    if url.is_empty() {
        return Ok(MARKET_CATALOG_URL.to_string());
    }
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(trf(
            "Invalid plugin catalog URL: {url}; it must start with https:// or http://",
            &[("url", url.to_string())],
        ));
    }
    Ok(url.to_string())
}

/// 纯网络拉取：取回目录原文并解析投影。降级编排不在此处（调用方决策）
pub(crate) fn fetch_catalog_raw(url: &str) -> Result<MarketCatalog, CatalogLoadError> {
    let resp = reqwest::blocking::Client::builder()
        .timeout(MARKET_FETCH_TIMEOUT)
        .user_agent(concat!("dsh-pro-max/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| {
            crate::logging::error("[market] HTTP client 初始化失败", &e.to_string());
            CatalogLoadError::Transient(trf(
                "Cannot initialize HTTP client: {error}",
                &[("error", e.to_string())],
            ))
        })?
        .get(url)
        .send()
        .map_err(|e| {
            crate::logging::error("[market] 目录拉取失败", &e.to_string());
            CatalogLoadError::Transient(trf(
                "Failed to fetch plugin catalog: {error}",
                &[("error", e.to_string())],
            ))
        })?;
    if !resp.status().is_success() {
        let status = resp.status();
        crate::logging::error("[market] 目录拉取失败", &status.to_string());
        return Err(CatalogLoadError::Transient(trf(
            "Failed to fetch plugin catalog: HTTP {status}",
            &[("status", status.as_u16().to_string())],
        )));
    }
    // 原文仅作解析输入，不落盘（快照存投影后的目录，见 write_catalog_snapshot）
    let raw = resp.text().map_err(|e| {
        crate::logging::error("[market] 目录读取失败", &e.to_string());
        CatalogLoadError::Transient(trf(
            "Failed to fetch plugin catalog: {error}",
            &[("error", e.to_string())],
        ))
    })?;
    catalog_from_raw(&raw, false)
}

fn catalog_snapshot_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|p| p.join("market-catalog-snapshot.json"))
        .map_err(|e| e.to_string())
}

/// 快照即投影后的 MarketCatalog（与前端消费同一份数据），读写都是亚 MB 级
pub(crate) fn write_catalog_snapshot_file(path: &std::path::Path, catalog: &MarketCatalog) -> Result<(), String> {
    let json = serde_json::to_string(catalog).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn write_catalog_snapshot(app: &tauri::AppHandle, catalog: &MarketCatalog) {
    // 尽力而为：写失败只影响下次断网降级，不影响本次结果
    if let Ok(path) = catalog_snapshot_path(app) {
        if let Err(e) = write_catalog_snapshot_file(&path, catalog) {
            crate::logging::warn("[market] 目录快照写入失败", &e);
        }
    }
}

/// 快照读取：内容即投影后的 MarketCatalog，读出恒标 `from_snapshot`（数据
/// 来自本地快照，前端在刷新结束后如实标注）。缺失/损坏/旧契约格式反序列化
/// 失败，调用方按"无快照"处理
pub(crate) fn load_catalog_snapshot_file(path: &std::path::Path) -> Result<MarketCatalog, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        crate::logging::warn("[market] 目录快照读取失败", &e.to_string());
        trf(
            "Failed to read catalog snapshot: {error}",
            &[("error", e.to_string())],
        )
    })?;
    let mut catalog: MarketCatalog = serde_json::from_str(&raw).map_err(|e| {
        crate::logging::warn("[market] 目录快照解析失败", &e.to_string());
        trf(
            "Failed to parse catalog snapshot: {error}",
            &[("error", e.to_string())],
        )
    })?;
    catalog.from_snapshot = true;
    Ok(catalog)
}

/// 快照降级决策（纯函数）：快照可用返回整个 catalog，不可用（缺失/损坏/
/// 旧格式）回退原始网络错误——它比"没有快照"更有行动价值，
/// 坏快照不掩盖在线数据的问题
pub(crate) fn catalog_snapshot_decision(path: &std::path::Path, network_error: String) -> Result<MarketCatalog, String> {
    match load_catalog_snapshot_file(path) {
        Ok(catalog) => Ok(catalog),
        Err(e) => {
            crate::logging::warn("[market] 目录快照不可用", &e);
            Err(network_error)
        }
    }
}

/// 拉取并解析社区目录；网络失败时降级到最近一次成功的本地快照。
/// 只投影浏览/安装所需字段，其余（screenshots、tarball、downloads 等）
/// 在解析时丢弃，避免目录原文整包进 WebView
fn fetch_catalog(app: &tauri::AppHandle) -> Result<MarketCatalog, String> {
    let configured = crate::config::load_config()?.market_catalog_url;
    let url = resolve_catalog_url(&configured)?;
    match fetch_catalog_raw(&url) {
        Ok(catalog) => {
            write_catalog_snapshot(app, &catalog);
            Ok(catalog)
        }
        Err(CatalogLoadError::UnsupportedSchema(msg)) => Err(msg),
        Err(CatalogLoadError::Transient(e)) => {
            let path = catalog_snapshot_path(app)?;
            match catalog_snapshot_decision(&path, e.clone()) {
                Ok(catalog) => {
                    crate::logging::warn("[market] 网络拉取失败，降级使用本地目录快照", &e);
                    Ok(catalog)
                }
                Err(e) => Err(e),
            }
        }
    }
}

// ============ 已装列表 / 安装 / 移除 ============

pub(crate) fn installed_plugins() -> Result<Vec<InstalledPlugin>, String> {
    installed_list_from_profile(&web_profile_package_path()?)
}

/// 插件更新检测的单包结果。检测范围 = npm 形态安装的非受管插件：协议形态
/// （github:/file: 等）来源不是 registry、范围 spec 无具体版本可比，均如实
/// 返回 None（不猜）；受管插件由 Launcher 的修复流程管理，不参与
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateInfo {
    pub name: String,
    /// 落盘 spec 原文（file:/github: 等形态如实展示）
    pub spec: String,
    pub managed: bool,
    /// 从 spec 解析出的具体当前版本；范围/协议形态为 None
    pub installed_version: Option<String>,
    /// registry latest；该包查询失败为 None
    pub latest_version: Option<String>,
    pub update_available: bool,
}

/// 依赖 spec 值 → 具体当前版本。可检形态："pkg@1.2.3"、"npm:pkg@1.0.0"、
/// "@scope/pkg@1.2.3"、裸版本 "1.2.3"；协议形态（github:/file: 等）与范围
/// range（^ ~ * latest 等）返回 None。具体性由 parse_version 裁决，不另设规则
pub(crate) fn installed_version_from_spec(spec: &str) -> Option<String> {
    let rest = spec.strip_prefix("npm:").unwrap_or(spec);
    if rest.contains(':') {
        return None;
    }
    // scope 保护：@scope/pkg@ver 的版本在 scope 段之后的 @
    let scope_start = if rest.starts_with('@') { rest.find('/')? + 1 } else { 0 };
    let version = match rest[scope_start..].rfind('@') {
        Some(i) => &rest[scope_start + i + 1..],
        None => rest,
    };
    parse_version(version).map(|_| version.to_string())
}

/// registry 响应 → latest 版本（纯解析，HTTP 与此分离以便测试）。
/// version 字段缺失或不是合法语义版本时不采信
pub(crate) fn latest_from_registry_json(raw: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| v.get("version").and_then(serde_json::Value::as_str).map(str::to_string))
        .filter(|v| parse_version(v).is_some())
}

/// 单包 registry latest 查询：GET {registry}/{name}/latest → version 字段。
/// 与目录拉取同一 reqwest blocking 模式（npm CLI 要起 node 进程且无超时，不取）
fn registry_latest(name: &str) -> Result<String, String> {
    let url = format!("https://registry.npmjs.org/{name}/latest");
    let resp = reqwest::blocking::Client::builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .user_agent(concat!("dsh-pro-max/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let raw = resp.text().map_err(|e| e.to_string())?;
    latest_from_registry_json(&raw)
        .ok_or_else(|| trf("Cannot parse npm registry response for {name}", &[("name", name.to_string())]))
}

/// 更新检测执行体（market_check_updates 的阻塞部分）：逐包串行查 registry
/// （已装列表是个位数，并发无收益）。部分包查询失败不放大为整体失败（如实
/// 无 latest、不出更新按钮）；全部可检包都失败才报错——那是网络问题的信号
fn check_updates_once() -> Result<Vec<PluginUpdateInfo>, String> {
    let list = installed_plugins()?;
    let mut infos: Vec<PluginUpdateInfo> = list
        .into_iter()
        .map(|p| PluginUpdateInfo {
            installed_version: if p.managed { None } else { installed_version_from_spec(&p.spec) },
            update_available: false,
            latest_version: None,
            name: p.name,
            spec: p.spec,
            managed: p.managed,
        })
        .collect();
    let mut checked = 0usize;
    let mut failed = 0usize;
    let mut first_error: Option<String> = None;
    for info in infos.iter_mut().filter(|i| !i.managed && i.installed_version.is_some()) {
        checked += 1;
        match registry_latest(&info.name) {
            Ok(latest) => {
                info.update_available = is_newer(&latest, info.installed_version.as_deref().unwrap_or_default());
                info.latest_version = Some(latest);
            }
            Err(e) => {
                failed += 1;
                crate::logging::warn("[market] 单包更新检测失败", &format!("{}: {}", info.name, e));
                first_error.get_or_insert(e);
            }
        }
    }
    if checked > 0 && failed == checked {
        let e = first_error.unwrap_or_default();
        crate::logging::error("[market] 插件更新检测失败", &e);
        return Err(trf("Failed to check plugin updates: {error}", &[("error", e)]));
    }
    Ok(infos)
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

/// npm 形态 specifier 的包名部分；带协议前缀的形态（github:/file:/npm: 等）
/// 返回 None（安装后的 dependencies 键名无法预知）。前端
/// packageNameFromSpecifier 同一套语义，改一侧必须同步另一侧
pub(crate) fn package_name_from_specifier(specifier: &str) -> Option<String> {
    // npm 包名不含 ':'，带即协议形态
    if specifier.contains(':') {
        return None;
    }
    let scope_start = if specifier.starts_with('@') { specifier.find('/')? } else { 0 };
    let at = specifier.rfind('@').filter(|&i| i > scope_start).unwrap_or(specifier.len());
    let name = &specifier[..at];
    (!name.is_empty()).then(|| name.to_string())
}

/// 安装策略匹配规则（任一命中即允许）：
/// 1. identifier 与条目完全一致；
/// 2. 条目以 `/` 结尾 → 前缀匹配（`@scope/` 或 `github:owner/` 粒度）；
/// 3. npm 形态 identifier 的包名（去版本）与条目一致；
/// 4. 协议形态条目（含 `:`）是 identifier 前缀且边界是 `#` 或 `/`
///    （写 `github:owner/repo` 即允许其任意 ref）
pub(crate) fn policy_allows(entries: &[String], identifier: &str) -> bool {
    entries.iter().any(|e| {
        identifier == e
            || (e.ends_with('/') && identifier.starts_with(e.as_str()))
            || package_name_from_specifier(identifier).as_deref() == Some(e.as_str())
            || (e.contains(':')
                && identifier.starts_with(e.as_str())
                && identifier[e.len()..].chars().next().map_or(true, |c| c == '#' || c == '/'))
    })
}

/// 安装策略文件：`~/.dsh-pro-max/plugin-policy.json`，契约
/// `{ "allowed": ["dsh-better-sidebar", "@scope/", "github:owner/repo"] }`。
/// 文件缺失或 `allowed` 键缺席 → 不启用白名单（默认全允许）；`allowed`
/// 存在即生效（空数组 = 全部拒绝）。只约束安装：移除是清理，总能做。
/// 文件损坏按失败处理（fail closed）：策略是治理基线，宁可拒绝不可静默放行
pub(crate) fn policy_entries_from_raw(raw: &str) -> Result<Option<Vec<String>>, String> {
    let policy: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        crate::logging::warn("[market] 解析插件策略失败", &e.to_string());
        trf(
            "Failed to parse plugin policy: {error}",
            &[("error", e.to_string())],
        )
    })?;
    let Some(allowed) = policy.get("allowed") else {
        return Ok(None);
    };
    let arr = allowed
        .as_array()
        .ok_or_else(|| tr("Plugin policy field \"allowed\" must be an array"))?;
    Ok(Some(
        arr.iter().filter_map(|v| v.as_str()).map(str::to_string).collect(),
    ))
}

/// 策略文件路径的唯一来源
fn plugin_policy_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::config::home_dir()?.join(".dsh-pro-max").join("plugin-policy.json"))
}

fn load_policy_entries() -> Result<Option<Vec<String>>, String> {
    let path = plugin_policy_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        crate::logging::warn("[market] 读取插件策略失败", &e.to_string());
        trf(
            "Failed to read plugin policy: {error}",
            &[("error", e.to_string())],
        )
    })?;
    policy_entries_from_raw(&raw)
}

/// 安装前的策略闸门：拒绝时说明命中了哪条约束与策略文件在哪
fn enforce_install_policy(identifier: &str) -> Result<(), String> {
    let Some(entries) = load_policy_entries()? else {
        return Ok(());
    };
    if policy_allows(&entries, identifier) {
        return Ok(());
    }
    let path = plugin_policy_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    Err(trf(
        "Plugin install blocked by policy: {identifier} is not in the allowlist ({path})",
        &[("identifier", identifier.to_string()), ("path", path)],
    ))
}

/// 安装失败的文案加工：pnpm 10+ 的构建脚本拦截是 git 来源插件最常见的失败，
/// 识别后给出精确到文件的问题/下一步，而不是把上游整段 stderr 原样丢给用户。
/// 拦截的自动化路径是 market_approve_builds（用户审批后写入 allowBuilds），
/// 本函数保留给解析失败与普通错误的文案加工
pub(crate) fn install_failure_message(action: &str, error: &str) -> String {
    if action != "add" {
        return trf("Failed to remove plugin: {error}", &[("error", error.to_string())]);
    }
    if error.contains("allowBuilds") || error.contains("Ignored build scripts") {
        let path = web_profile_package_path()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("pnpm-workspace.yaml")))
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "~/.dsh/profiles/web/pnpm-workspace.yaml".to_string());
        return trf(
            "Plugin build scripts were blocked by pnpm. Add the package name printed in the log under \"allowBuilds\" in {path}, then retry. Detail: {error}",
            &[("path", path), ("error", error.to_string())],
        );
    }
    trf("Failed to install plugin: {error}", &[("error", error.to_string())])
}

/// 安装输出行事件（`market-install-log`）：specifier 锚定前端卡片（安装全局
/// 单飞，带上是防御错位），line 为 dsh/pnpm 子进程的展示行
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketInstallLogEvent {
    pub specifier: String,
    pub line: String,
}

/// 执行 dsh plugin 子命令；每行输出经 on_line 实时回调（首行是执行命令本身，
/// 与实际 argv 同一拼装），Err 的 (raw, display) 中 raw 是本地化前的原始
/// 错误（审计台账的可复述事实，不随界面语言漂移），display 是加工后的用户文案
fn run_plugin_cmd(
    action: &str,
    arg: &str,
    on_line: impl Fn(&str) + Send + Sync + 'static,
) -> Result<(), (String, String)> {
    if !valid_identifier(arg) {
        let raw = format!("invalid plugin identifier: {arg}");
        return Err((raw, tr("Invalid plugin identifier")));
    }
    if action == "add" {
        if let Err(display) = enforce_install_policy(arg) {
            return Err((format!("policy blocked: {arg}"), display));
        }
    }
    let dsh = resolve_dsh_bin().map_err(|e| (e.clone(), e))?;
    let dsh = dsh.display().to_string();
    let argv: [&str; 5] = ["plugin", "--profile", "web", action, arg];
    on_line(&format!("$ dsh {}", argv.join(" ")));
    match run_capture_lines(&dsh, &argv, on_line) {
        Ok((_, _, true)) => Ok(()),
        Ok((_, err, false)) => {
            let raw = if err.is_empty() {
                format!("dsh plugin {action} failed")
            } else {
                err
            };
            crate::logging::error(&format!("[market] plugin {action} 失败"), &raw);
            let display = install_failure_message(action, &raw);
            Err((raw, display))
        }
        Err(e) => {
            crate::logging::error(&format!("[market] plugin {action} 执行失败"), &e);
            Err((e.clone(), e))
        }
    }
}

/// 从 pnpm stderr 提取被拦构建脚本的包名。pnpm 10 与 11/12 的错误形态不同
/// 但都含 `Ignored build scripts:` 行（逗号分隔、带版本号）；scope 包剥版本
/// 用 rfind 保护 `@scope` 前缀。解析不出的脏数据被 valid_identifier 过滤，
/// 空结果 → 调用方回退普通失败文案
pub(crate) fn blocked_build_packages(stderr: &str) -> Vec<String> {
    let Some(line) = stderr.lines().find(|l| l.contains("Ignored build scripts:")) else {
        return Vec::new();
    };
    let list = line.split("Ignored build scripts:").nth(1).unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    for raw in list.split(',') {
        let spec = raw.trim();
        let name = match spec.rfind('@') {
            Some(i) if i > 0 => &spec[..i],
            _ => spec,
        };
        if valid_identifier(name) && !out.iter().any(|p| p == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// profile 的 pnpm-workspace.yaml 路径（package.json 同目录）
fn workspace_yaml_path() -> Result<std::path::PathBuf, String> {
    web_profile_package_path()?
        .parent()
        .map(|d| d.join("pnpm-workspace.yaml"))
        .ok_or_else(|| tr("Web profile has no parent directory"))
}

/// 合并放行构建脚本到 profile 的 pnpm-workspace.yaml（上游 dsh 对 pnpm 10+
/// 拦截的官方姿势）。`allowBuilds: {pkg: true}`（pnpm 11+ 认）与
/// `onlyBuiltDependencies: [pkg]`（pnpm 10 认）双键同写；用户已有键与显式
/// false 不覆盖、只插入缺失项，幂等。pnpm 9 不拦脚本，不会走到这里
pub(crate) fn merge_allow_builds(path: &std::path::Path, packages: &[String]) -> Result<(), String> {
    let yaml_invalid = || tr("Invalid pnpm workspace config");
    let mut root: serde_yaml::Value = if path.exists() {
        let raw = std::fs::read_to_string(path).map_err(|e| {
            crate::logging::warn("[market] 读取 pnpm-workspace.yaml 失败", &e.to_string());
            trf(
                "Failed to read {path}: {error}",
                &[("path", path.display().to_string()), ("error", e.to_string())],
            )
        })?;
        serde_yaml::from_str(&raw).map_err(|e| {
            crate::logging::warn("[market] 解析 pnpm-workspace.yaml 失败", &e.to_string());
            // 损坏时拒绝覆盖：宁可让用户手改，不可静默丢配置
            trf(
                "Failed to parse {path}: {error}",
                &[("path", path.display().to_string()), ("error", e.to_string())],
            )
        })?
    } else {
        serde_yaml::Value::Mapping(serde_yaml::Mapping::new())
    };
    let map = root.as_mapping_mut().ok_or_else(yaml_invalid)?;
    let allows = map
        .entry(serde_yaml::Value::from("allowBuilds"))
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    let allows_map = allows.as_mapping_mut().ok_or_else(yaml_invalid)?;
    for p in packages {
        allows_map
            .entry(serde_yaml::Value::from(p.as_str()))
            .or_insert(serde_yaml::Value::Bool(true));
    }
    let only = map
        .entry(serde_yaml::Value::from("onlyBuiltDependencies"))
        .or_insert_with(|| serde_yaml::Value::Sequence(Vec::new()));
    let only_seq = only.as_sequence_mut().ok_or_else(yaml_invalid)?;
    for p in packages {
        if !only_seq.iter().any(|v| v.as_str() == Some(p.as_str())) {
            only_seq.push(serde_yaml::Value::from(p.as_str()));
        }
    }
    only_seq.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    let out = serde_yaml::to_string(&root).map_err(|e| e.to_string())?;
    std::fs::write(path, out).map_err(|e| {
        crate::logging::warn("[market] 写入 pnpm-workspace.yaml 失败", &e.to_string());
        trf(
            "Failed to write {path}: {error}",
            &[("path", path.display().to_string()), ("error", e.to_string())],
        )
    })
}

// ============ 审计台账 ============

/// 台账行（JSONL 单行）：ts/action/identifier/result/error/两个版本号。
/// error 记本地化前的原始错误（stderr 或内部原因），不随界面语言漂移——
/// 台账是"可复述"的最低形态：排错日志 2MB 轮转即删，装了什么必须另有所在
pub(crate) fn audit_line(action: &str, identifier: &str, dsh_version: Option<String>, error: Option<&str>) -> String {
    serde_json::json!({
        "ts": rfc3339_now(),
        "action": action,
        "identifier": identifier,
        "result": if error.is_none() { "ok" } else { "failed" },
        "error": error,
        "dshVersion": dsh_version,
        "launcherVersion": env!("CARGO_PKG_VERSION"),
    })
    .to_string()
}

fn rfc3339_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown".to_string())
}

/// 追加一条审计记录。尽力而为：写失败只落排错日志，不回滚已完成的操作、
/// 不改变返回值——台账服务于"事后说清"，不是操作的组成步骤
fn append_audit(app: &tauri::AppHandle, action: &str, identifier: &str, error: Option<&str>) {
    use std::io::Write;
    use tauri::Manager;
    let Ok(path) = app
        .path()
        .app_log_dir()
        .map(|p| p.join("plugin-audit.jsonl"))
    else {
        return;
    };
    let line = audit_line(action, identifier, super::components::dsh_version(), error);
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            if let Err(e) = writeln!(f, "{line}") {
                crate::logging::warn("[market] 审计台账写入失败", &e.to_string());
            }
        }
        Err(e) => crate::logging::warn("[market] 审计台账打开失败", &e.to_string()),
    }
}

// ============ 安装回执 ============

/// 安装回执定位：优先取 before/after 差集里的唯一新键（github: 首装只有
/// 这条路）；差集不可用或为空时按 npm 包名定位（覆盖同键重装/升版）。
/// 都无法唯一确定 → None，如实返回，不猜
pub(crate) fn install_receipt(
    specifier: &str,
    before: Option<Vec<String>>,
    list: &[InstalledPlugin],
) -> Option<InstallReceipt> {
    if let Some(before) = before {
        let added: Vec<&InstalledPlugin> = list.iter().filter(|p| !before.contains(&p.name)).collect();
        if added.len() == 1 {
            return Some(InstallReceipt {
                name: added[0].name.clone(),
                spec: added[0].spec.clone(),
            });
        }
    }
    let name = package_name_from_specifier(specifier)?;
    list.iter().find(|p| p.name == name).map(|p| InstallReceipt {
        name: p.name.clone(),
        spec: p.spec.clone(),
    })
}

// ============ IPC ============

/// 同步 command 在 Tauri 主线程执行：目录下载解析、pnpm 子进程这类长操作
/// 会冻结 WebView。统一丢进阻塞线程池，命令本身保持 async
async fn ipc_blocking<T: Send + 'static>(task: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("market task failed: {e}"))?
}

#[tauri::command]
pub async fn market_fetch(app: tauri::AppHandle) -> Result<MarketCatalog, String> {
    ipc_blocking(move || fetch_catalog(&app)).await
}

#[tauri::command]
pub fn market_installed() -> Result<Vec<InstalledPlugin>, String> {
    installed_plugins()
}

/// 本地快照直读：前端首屏秒显用（新数据由 market_fetch 后台刷新替换）。
/// 缺失/损坏/旧格式一律 None——快照是缓存不是事实来源，静默跳过
#[tauri::command]
pub fn market_snapshot(app: tauri::AppHandle) -> Option<MarketCatalog> {
    catalog_snapshot_path(&app)
        .ok()
        .and_then(|p| load_catalog_snapshot_file(&p).ok())
}

/// 安装一键候选的执行体（market_install 的阻塞部分）
fn install_once(app: &tauri::AppHandle, specifier: &str) -> Result<InstallOutcome, String> {
    let before = installed_plugins()
        .ok()
        .map(|l| l.iter().map(|p| p.name.clone()).collect::<Vec<_>>());
    match run_plugin_cmd("add", specifier, emit_install_line(app, specifier)) {
        Ok(()) => {
            append_audit(app, "add", specifier, None);
            let receipt = installed_plugins()
                .ok()
                .and_then(|list| install_receipt(specifier, before, &list));
            Ok(InstallOutcome::Installed { receipt })
        }
        Err((raw, display)) => {
            let packages = blocked_build_packages(&raw);
            if !packages.is_empty() {
                // 拦截不算安装失败：转审批请求，台账记请求本身（复述字段含被拦包名）
                append_audit(app, "needs-approval", specifier, Some(&raw));
                return Ok(InstallOutcome::NeedsApproval {
                    packages,
                    workspace_yaml: workspace_yaml_path()?.display().to_string(),
                });
            }
            append_audit(app, "add", specifier, Some(&raw));
            Err(display)
        }
    }
}

/// 安装输出行的 emit 闭包（run_plugin_cmd 回调）：逐行推 `market-install-log`
fn emit_install_line(app: &tauri::AppHandle, specifier: &str) -> impl Fn(&str) + Send + Sync + 'static {
    let app = app.clone();
    let specifier = specifier.to_string();
    move |line| {
        let _ = app.emit(
            "market-install-log",
            MarketInstallLogEvent { specifier: specifier.clone(), line: line.to_string() },
        );
    }
}

/// 安装一键候选（specifier 为 npm 包名/版本或 github:owner/repo 形态，由
/// 目录 install 命令串解析而来）；长操作（pnpm 下载依赖），UI 显示 busy。
/// 成功返回落盘回执（无法唯一定位落点时为 None）；被 pnpm 拦截构建脚本时
/// 返回 NeedsApproval（被拦包名 + 待写 yaml 路径），由前端弹窗征得用户
/// 审批后再经 market_approve_builds 放行。写入审计台账
#[tauri::command]
pub async fn market_install(app: tauri::AppHandle, specifier: String) -> Result<InstallOutcome, String> {
    ipc_blocking(move || install_once(&app, &specifier)).await
}

/// 用户审批放行构建脚本后的执行体（market_approve_builds 的阻塞部分）
fn approve_builds_once(app: &tauri::AppHandle, specifier: &str, packages: Vec<String>) -> Result<Option<InstallReceipt>, String> {
    let yaml = workspace_yaml_path()?;
    merge_allow_builds(&yaml, &packages)?;
    append_audit(app, "approve-builds", &format!("{specifier} allow={}", packages.join(",")), None);
    let before = installed_plugins()
        .ok()
        .map(|l| l.iter().map(|p| p.name.clone()).collect::<Vec<_>>());
    match run_plugin_cmd("add", specifier, emit_install_line(app, specifier)) {
        Ok(()) => {
            append_audit(app, "add", specifier, None);
            let receipt = installed_plugins()
                .ok()
                .and_then(|list| install_receipt(specifier, before, &list));
            Ok(receipt)
        }
        Err((raw, display)) => {
            append_audit(app, "add", specifier, Some(&raw));
            Err(display)
        }
    }
}

/// 用户审批放行构建脚本后执行：合并写入 profile 的 pnpm-workspace.yaml →
/// 重跑安装。包名来自前端回传（最初由 launcher 从 pnpm stderr 解析），IPC
/// 层不可信，逐个过与目录 specifier 同一白名单
#[tauri::command]
pub async fn market_approve_builds(
    app: tauri::AppHandle,
    specifier: String,
    packages: Vec<String>,
) -> Result<Option<InstallReceipt>, String> {
    if !valid_identifier(&specifier)
        || packages.is_empty()
        || packages.iter().any(|p| !valid_identifier(p))
    {
        return Err(tr("Invalid plugin identifier"));
    }
    ipc_blocking(move || approve_builds_once(&app, &specifier, packages)).await
}

/// 移除插件的执行体（market_remove 的阻塞部分）
fn remove_once(app: &tauri::AppHandle, name: &str) -> Result<(), String> {
    match run_plugin_cmd("remove", name, |_| {}) {
        Ok(()) => {
            append_audit(app, "remove", name, None);
            Ok(())
        }
        Err((raw, display)) => {
            append_audit(app, "remove", name, Some(&raw));
            Err(display)
        }
    }
}

#[tauri::command]
pub async fn market_remove(app: tauri::AppHandle, name: String) -> Result<(), String> {
    ipc_blocking(move || remove_once(&app, &name)).await
}

/// 更新检测：npm 形态已装插件比对 registry latest（进入市场页自动跑，
/// 已安装页可手动重跑）。更新本身不在此处——前端以 name@latest 重装，
/// 与安装同一 dsh 闸门、审计与审批路径
#[tauri::command]
pub async fn market_check_updates() -> Result<Vec<PluginUpdateInfo>, String> {
    ipc_blocking(check_updates_once).await
}
