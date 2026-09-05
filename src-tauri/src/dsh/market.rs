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
//! 更新检测以磁盘实际版本（profile node_modules 内的 package.json）为
//! 事实来源，落盘 spec 只作回退——pnpm 常把依赖写成 `^x.y.z` 范围形态，
//! 单靠 spec 解析会让 npm 形态插件整体脱离更新检测。
//!
//! 可复述与可治理：每次成功拉取后把投影目录落盘为本地快照（旧契约快照按
//! 无快照处理、下次成功拉取自动重建）；前端首屏直读快照、网络目录由
//! market_fetch 后台刷新替换，快照数据与断网降级都如实标注 `fromSnapshot`。
//! 安装/移除写 append-only 审计台账（app log dir 下 `plugin-audit.jsonl`）；
//! `~/.dsh-pro-max/plugin-policy.json` 白名单约束可安装的包；安装成功返回
//! 落盘回执（name + spec）。

use super::components::{resolve_dsh_bin, web_profile_package_path};
use super::process::run_capture_lines;
use crate::i18n::keyf;
use crate::version::{is_newer, parse_version};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

pub(crate) const MARKET_CATALOG_URL: &str = "https://awesome-dsh-plugin.com/plugins.json";
/// 目录约 300KB（curated 精选列表），30s 足够慢网走完
const MARKET_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// 单包 registry latest 查询超时（逐包串行，已装列表是个位数）
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(10);
/// dsh plugin add 硬超时：pnpm 下载依赖 + git 来源 clone 大仓库的宽上限
/// （B 方 6min 会误杀慢网 clone），到点杀进程防 busy 态无限挂起
const PLUGIN_ADD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// dsh plugin remove 硬超时（卸载只删依赖，2min 与 B 方同值）
const PLUGIN_REMOVE_TIMEOUT: Duration = Duration::from_secs(2 * 60);
/// --dump-config 组合预检超时（解析入口不绑端口，秒级；90s 与 B 方同值）
const DUMP_CONFIG_TIMEOUT: Duration = Duration::from_secs(90);
/// Launcher 自己管理的授权插件，不出现在可移除列表
const MANAGED_PLUGIN_PACKAGES: [&str; 2] = [
    "@dsh-external/dsh-client-connection-authz",
    "@dsh-external/dsh-auth-tailscale",
];

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct MarketPlugin {
    /// `owner/name`（owner 缺失时从 repo url 派生）：展示与排序键
    pub full_name: String,
    pub name: String,
    /// 多语言描述原样透传（如 {"en": "...", "zh": "..."}），前端按界面语言取
    #[ts(type = "Record<string, string>")]
    pub description: Option<BTreeMap<String, String>>,
    pub url: String,
    /// null = 目录暂无数据（新收录或仓库 404），不静默当 0
    pub stars: Option<f64>,
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

#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct MarketCatalog {
    /// 目录生成日期（目录原生 `updated`，如 "2026-08-31"）
    pub updated: Option<String>,
    /// 分类 id → {语言 → 显示名}，目录原生表原样透传（前端按界面语言取）
    #[ts(type = "Record<string, Record<string, string>>")]
    pub categories: BTreeMap<String, BTreeMap<String, String>>,
    pub total: usize,
    pub plugins: Vec<MarketPlugin>,
    /// 数据来自本地快照（首屏直读或断网降级）；UI 在刷新结束后如实标注
    pub from_snapshot: bool,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct InstalledPlugin {
    /// npm 包名（profile package.json dependencies 键）
    pub name: String,
    /// 安装 spec（file: tarball / npm:x@ver / github:owner/repo 等）
    pub spec: String,
    /// 实际安装版本：磁盘事实（node_modules/<name>/package.json）优先，
    /// spec 精确版本次之；协议形态（github:/file: 等，版本多为 0.0.0 占位）
    /// 与两者均不可得为 None。更新检测复用同一事实（check_updates_once 不再
    /// 自算），前端卡片版本号即时显示靠它
    pub version: Option<String>,
    /// Launcher 自管授权插件：不出移除按钮，由 Launcher 的修复/卸载流程管理
    pub managed: bool,
    /// 下次启动启用状态（profile cordis.patch.yml 的 disabled 覆盖行判定，
    /// 缺席 = 启用）。翻转对运行中的 dsh 无影响，重启后生效
    pub enabled: bool,
}

/// 安装回执：本次安装落进 profile 的 dependencies 键与 spec。
/// github: 重装等无法唯一确定落点的场景返回 None（安装本身仍成功）
#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct InstallReceipt {
    pub name: String,
    pub spec: String,
}

/// 安装结果：成功带回执与护栏事实（notices）；被 pnpm 拦截构建脚本时转
/// 审批请求（被拦包名 + 待写文件路径）。审批是用户决策点：安装脚本以用户
/// 身份执行任意代码，launcher 不静默放行
#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(tag = "status", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub enum InstallOutcome {
    #[serde(rename_all = "camelCase")]
    Installed {
        receipt: Option<InstallReceipt>,
        notices: Vec<InstallNotice>,
    },
    #[serde(rename_all = "camelCase")]
    NeedsApproval {
        packages: Vec<String>,
        workspace_yaml: String,
    },
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
    let name = v
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())?;
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
    let full_name = if owner.is_empty() {
        name.to_string()
    } else {
        format!("{owner}/{name}")
    };
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
        stars: v.get("stars").and_then(serde_json::Value::as_f64),
        category,
        install_specifier,
        deprecated: v
            .get("deprecated")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
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
pub(crate) fn catalog_from_raw(
    raw: &str,
    from_snapshot: bool,
) -> Result<MarketCatalog, CatalogLoadError> {
    let body: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        crate::logging::error("[market] 目录解析失败", &e.to_string());
        CatalogLoadError::Transient(keyf(
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
        crate::logging::error(
            "[market] 目录格式不符",
            "plugins 非空数组缺失或全部条目无法投影",
        );
        return Err(CatalogLoadError::UnsupportedSchema(keyf(
            "Unrecognized plugin catalog format; update the app or fix the catalog mirror",
            &[],
        )));
    }
    // 分类表原样透传；缺失/畸形按空表处理，前端回退展示分类 id（纯展示数据，
    // 失败不放大全目录）
    let categories: BTreeMap<String, BTreeMap<String, String>> = body
        .get("categories")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let updated = body
        .get("updated")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
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
        return Err(keyf(
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
            CatalogLoadError::Transient(keyf(
                "Cannot initialize HTTP client: {error}",
                &[("error", e.to_string())],
            ))
        })?
        .get(url)
        .send()
        .map_err(|e| {
            crate::logging::error("[market] 目录拉取失败", &e.to_string());
            CatalogLoadError::Transient(keyf(
                "Failed to fetch plugin catalog: {error}",
                &[("error", e.to_string())],
            ))
        })?;
    if !resp.status().is_success() {
        let status = resp.status();
        crate::logging::error("[market] 目录拉取失败", &status.to_string());
        return Err(CatalogLoadError::Transient(keyf(
            "Failed to fetch plugin catalog: HTTP {status}",
            &[("status", status.as_u16().to_string())],
        )));
    }
    // 原文仅作解析输入，不落盘（快照存投影后的目录，见 write_catalog_snapshot）
    let raw = resp.text().map_err(|e| {
        crate::logging::error("[market] 目录读取失败", &e.to_string());
        CatalogLoadError::Transient(keyf(
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
pub(crate) fn write_catalog_snapshot_file(
    path: &std::path::Path,
    catalog: &MarketCatalog,
) -> Result<(), String> {
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
        keyf(
            "Failed to read catalog snapshot: {error}",
            &[("error", e.to_string())],
        )
    })?;
    let mut catalog: MarketCatalog = serde_json::from_str(&raw).map_err(|e| {
        crate::logging::warn("[market] 目录快照解析失败", &e.to_string());
        keyf(
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
pub(crate) fn catalog_snapshot_decision(
    path: &std::path::Path,
    network_error: String,
) -> Result<MarketCatalog, String> {
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

/// 插件更新检测的单包结果。检测范围 = npm 形态安装的非受管插件：实际版本
/// 优先取磁盘事实（node_modules 内 package.json 的 version，范围 spec
/// `^x.y.z` 就靠它参与检测），磁盘不可得回退 spec 精确版本；协议形态
/// （github:/file: 等）来源不是 registry，恒不检（不猜）
// 判定来源改版（Bug 修复）：范围 spec 不再排除出检测。—— Eric Tao, 2026-09-04 09:10:00
#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct PluginUpdateInfo {
    pub name: String,
    /// 落盘 spec 原文（file:/github: 等形态如实展示）
    pub spec: String,
    pub managed: bool,
    /// 实际安装版本：磁盘事实（node_modules/<name>/package.json）优先，
    /// spec 精确版本次之；协议形态与两者均不可得时为 None
    pub installed_version: Option<String>,
    /// registry latest；该包查询失败为 None
    pub latest_version: Option<String>,
    /// latest 是否落在 pnpm minimumReleaseAge 保护窗口内（pnpm 11 内置默认
    /// 24h）：窗口内 @latest 会被静默解析回旧版、退出码仍为 0（假成功），
    /// 前端据此先弹供应链确认框，用户知情确认后才钉版本重装
    pub latest_in_release_age_window: bool,
    /// latestVersion 的发布时间（RFC3339，来自完整 packument 的 time 字段，
    /// 仅对确有更新的包多付一次 HTTP 取得）。供应链确认框据此展示"发布
    /// 多久了"——新鲜度是用户"等窗口过期还是现在就装"决策的核心事实；
    /// packument 不可得（网络失败等）为 None，前端回退"刚发布"模糊文案
    pub latest_publish_time: Option<String>,
    /// 目标包最新版 manifest 声明的 dsh 最低版本（包 manifest 的
    /// `dsh.engines.dsh`，回退顶层 `engines.dsh`；未声明为 None）
    pub requires_dsh: Option<String>,
    /// 宿主 dsh 是否满足 requiresDsh。未声明为 None；声明后宿主版本不可得、
    /// 声明形态不支持或任一侧解析失败一律 false——声明了的最低版本不能
    /// 装作满足（fail closed）
    pub compatible: Option<bool>,
    pub update_available: bool,
}

/// 依赖 spec 值 → 具体当前版本。可检形态："pkg@1.2.3"、"npm:pkg@1.0.0"、
/// "@scope/pkg@1.2.3"、裸版本 "1.2.3"；协议形态（github:/file: 等）与范围
/// range（^ ~ * latest 等）返回 None。具体性由 parse_version 裁决，不另设规则。
/// 范围 range 本身不含版本，由调用方经磁盘事实补齐（installed_version_for_update），
/// 本函数语义不变
pub(crate) fn installed_version_from_spec(spec: &str) -> Option<String> {
    let rest = spec.strip_prefix("npm:").unwrap_or(spec);
    if rest.contains(':') {
        return None;
    }
    // scope 保护：@scope/pkg@ver 的版本在 scope 段之后的 @
    let scope_start = if rest.starts_with('@') {
        rest.find('/')? + 1
    } else {
        0
    };
    let version = match rest[scope_start..].rfind('@') {
        Some(i) => &rest[scope_start + i + 1..],
        None => rest,
    };
    parse_version(version).map(|_| version.to_string())
}

/// 包名的路径安全校验，四条缺一即拒：非空；不含 `..`；字符白名单（字母
/// 数字 + `@ / . _ -`，Windows 盘符 `C:` 与反斜杠路径因 `:` `\` 不在集合内
/// 天然被挡，合法 scope 分隔符 `/` 与点划线不受影响）；不以 `/` 开头——
/// `Path::join` 遇绝对路径组件会整体替换基路径，Windows 下 `/evil` 即指向
/// 当前盘根。node_modules 路径拼接前的唯一闸门，不信任调用方
pub(crate) fn safe_package_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '.' | '_' | '-'))
        && !name.starts_with('/')
}

/// 磁盘事实 → 实际安装版本：读 `<profile_dir>/node_modules/<name>/package.json`
/// 的 version 字段（scope 包 `@scope/pkg` 即子路径 `node_modules/@scope/pkg/`，
/// pnpm 的 junction/symlink 读穿即得真实版本）。为什么需要它：pnpm 落盘的
/// 依赖 spec 常是 `^x.y.z` 范围形态，installed_version_from_spec 对其返回
/// None，而 registry 比对必须有具体版本——磁盘上的实际版本是现成事实。
/// 版本不可解析 → None
// 新增（Bug 修复）：市场插件更新检测的版本事实来源。—— Eric Tao, 2026-09-04 09:10:00
pub(crate) fn installed_version_from_disk(
    profile_dir: &std::path::Path,
    name: &str,
) -> Option<String> {
    if !safe_package_name(name) {
        return None;
    }
    let raw = std::fs::read_to_string(
        profile_dir
            .join("node_modules")
            .join(name)
            .join("package.json"),
    )
    .ok()?;
    let package: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let version = package.get("version")?.as_str()?;
    parse_version(version).map(|_| version.to_string())
}

/// 单包实际版本判定（纯函数，check_updates_once 的版本决策抽出来以便测试）：
/// 可检形态（去掉 `npm:` 前缀后不含协议 `:`，与 installed_version_from_spec
/// 判据一致）先读磁盘事实、磁盘不可得回退 spec 精确版本；协议形态
/// （github:/file:/git+https: 等）不来自 registry，恒 None——其版本号多为
/// 0.0.0 占位，误检会诱导按 registry 名重装覆盖掉 git 源。profile_dir 不可得
/// （极端环境）时按 None 传入，整体回退纯 spec 解析的现状行为
pub(crate) fn installed_version_for_update(
    profile_dir: Option<&std::path::Path>,
    name: &str,
    spec: &str,
) -> Option<String> {
    let rest = spec.strip_prefix("npm:").unwrap_or(spec);
    if rest.contains(':') {
        return None;
    }
    profile_dir
        .and_then(|dir| installed_version_from_disk(dir, name))
        .or_else(|| installed_version_from_spec(spec))
}

/// registry /latest 响应的解析产物：latest 版本 + 声明的 dsh 最低版本
pub(crate) struct RegistryLatest {
    pub version: String,
    pub requires_dsh: Option<String>,
}

/// registry manifest → 声明的 dsh 最低版本：包 manifest 的 `dsh.engines.dsh`
/// 优先，顶层 `engines.dsh` 回退；空串与非字符串按未声明处理
pub(crate) fn dsh_requirement_from_manifest(body: &serde_json::Value) -> Option<String> {
    let dsh_engines = body.get("dsh").and_then(|d| d.get("engines"));
    let top_engines = body.get("engines");
    [dsh_engines, top_engines]
        .into_iter()
        .flatten()
        .find_map(|e| e.get("dsh"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 宿主 dsh 是否满足声明的最低版本。仅支持 `>=X.Y.Z[-pre]` 单比较子形态：
/// 其它形态（裸版本 / ^ ~/范围组）与宿主版本不可得、任一侧解析失败一律
/// false——读不懂的声明约束不能装作满足（fail closed）
pub(crate) fn meets_dsh_minimum(host: Option<&str>, minimum: &str) -> bool {
    let Some(host) = host else { return false };
    let Some(rest) = minimum.trim().strip_prefix(">=") else {
        return false;
    };
    let rest = rest.trim().trim_start_matches('v');
    match (parse_version(host), parse_version(rest)) {
        (Some(h), Some(m)) => h >= m,
        _ => false,
    }
}

/// registry /latest 响应 → latest 版本与声明的 dsh 最低版本。version 字段
/// 缺失或不是合法语义版本时不采信
pub(crate) fn registry_latest_from_json(raw: &str) -> Option<RegistryLatest> {
    let body: serde_json::Value = serde_json::from_str(raw).ok()?;
    let version = body.get("version")?.as_str()?;
    parse_version(version)?;
    Some(RegistryLatest {
        version: version.to_string(),
        requires_dsh: dsh_requirement_from_manifest(&body),
    })
}

/// 单包 registry latest 查询：GET {registry}/{name}/latest → version 字段与
/// dsh/engines 兼容性元数据（同一请求，零额外 HTTP）。与目录拉取同一
/// reqwest blocking 模式（npm CLI 要起 node 进程且无超时，不取）
fn registry_latest(name: &str) -> Result<RegistryLatest, String> {
    let client = update_http_client()?;
    registry_latest_with(&client, name)
}

/// 更新检测/兼容性查询共用的 HTTP 客户端（同超时同 UA；批量拉取共享一个
/// 连接池，避免逐包重建 TLS 会话）
fn update_http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .user_agent(concat!("dsh-pro-max/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

fn registry_latest_with(
    client: &reqwest::blocking::Client,
    name: &str,
) -> Result<RegistryLatest, String> {
    let url = format!("https://registry.npmjs.org/{name}/latest");
    let resp = client.get(&url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let raw = resp.text().map_err(|e| e.to_string())?;
    registry_latest_from_json(&raw).ok_or_else(|| {
        keyf(
            "Cannot parse npm registry response for {name}",
            &[("name", name.to_string())],
        )
    })
}

/// pnpm 11 内置的 minimumReleaseAge 默认窗口（分钟）。profile yaml 未显式
/// 配置时 pnpm 按此生效（实测 config get 显示 undefined，解析仍拦 4h 前
/// 发布的新版）
pub(crate) const DEFAULT_MINIMUM_RELEASE_AGE_MINUTES: u64 = 24 * 60;

/// profile pnpm-workspace.yaml 的 minimumReleaseAge 策略：(窗口分钟数,
/// exclude 列表)。键缺席 = 内置默认；显式 0 = 关闭供应链窗口。文件损坏
/// 回退内置默认——窗口判定是提示性增强，不放大为检测失败
pub(crate) fn release_age_policy_from_yaml(raw: &str) -> (u64, Vec<String>) {
    let Ok(v) = serde_yaml::from_str::<serde_yaml::Value>(raw) else {
        return (DEFAULT_MINIMUM_RELEASE_AGE_MINUTES, Vec::new());
    };
    let minutes = v
        .get("minimumReleaseAge")
        .and_then(serde_yaml::Value::as_u64)
        .unwrap_or(DEFAULT_MINIMUM_RELEASE_AGE_MINUTES);
    let excludes = v
        .get("minimumReleaseAgeExclude")
        .and_then(serde_yaml::Value::as_sequence)
        .map(|s| {
            s.iter()
                .filter_map(|e| e.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    (minutes, excludes)
}

/// minimumReleaseAgeExclude 命中判定：`name@version` 精确命中或裸 `name`
/// 命中该包全版本（pnpm 11 起裸名规则一致匹配任意版本）
pub(crate) fn release_age_excluded(excludes: &[String], name: &str, version: &str) -> bool {
    excludes
        .iter()
        .any(|e| e == name || *e == format!("{name}@{version}"))
}

/// latest 是否落在 minimumReleaseAge 窗口内（纯函数，IO 全在调用方）：
/// 发布时间距 now 不足窗口分钟数即窗口内。窗口 0（显式关闭）与已豁免直接
/// false；发布时间缺失/不可解析按窗口内——安全方向：钉版本对成熟版本同样
/// 正确（pnpm 原样安装），反向才会复现 @latest 静默解析回旧版的假成功
pub(crate) fn in_release_age_window(
    publish_time: Option<&str>,
    now: time::OffsetDateTime,
    minimum_age_minutes: u64,
    excluded: bool,
) -> bool {
    if minimum_age_minutes == 0 || excluded {
        return false;
    }
    let Some(raw) = publish_time else { return true };
    let Ok(published) =
        time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)
    else {
        return true;
    };
    now - published < time::Duration::minutes(minimum_age_minutes as i64)
}

/// 完整 packument → 指定版本的发布时间（RFC3339 原样返回）。time 只存在于
/// 完整 packument（/latest 端点与精简 metadata 都没有），故仅在确有更新时
/// 才多付这一次 HTTP
pub(crate) fn publish_time_from_packument(raw: &str, version: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()?
        .get("time")?
        .get(version)?
        .as_str()
        .map(str::to_string)
}

/// 单包发布时间查询：GET {registry}/{name} 完整 packument → time[version]。
/// 失败返回 None（调用方按窗口内处理——钉版本对成熟版本同样正确）
fn registry_publish_time(name: &str, version: &str) -> Option<String> {
    let url = format!("https://registry.npmjs.org/{name}");
    let resp = reqwest::blocking::Client::builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .user_agent(concat!("dsh-pro-max/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?
        .get(&url)
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let raw = resp.text().ok()?;
    publish_time_from_packument(&raw, version)
}

/// 当前 profile 的 minimumReleaseAge 策略（读 pnpm-workspace.yaml）；路径/
/// 读取失败回退内置默认。只覆盖 profile 级配置与内置默认，全局 config.yaml
/// 覆盖是边缘形态，不在此展开
fn release_age_policy() -> (u64, Vec<String>) {
    workspace_yaml_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|raw| release_age_policy_from_yaml(&raw))
        .unwrap_or_else(|| (DEFAULT_MINIMUM_RELEASE_AGE_MINUTES, Vec::new()))
}

/// 更新检测执行体（market_check_updates 的阻塞部分）：逐包串行查 registry
/// （已装列表是个位数，并发无收益）。实际版本复用已装列表的磁盘事实
/// （InstalledPlugin.version，installed_list_from_profile 统一判定——协议
/// 形态为 None，天然不参与检测）；latest 落在 pnpm minimumReleaseAge 窗口内
/// 的额外标记 latest_in_release_age_window 并携带 latest_publish_time（窗口内
/// @latest 会被静默拦回旧版，前端据此先弹确认框并展示发布新鲜度）。部分
/// 包查询失败不放大为整体失败（如实无 latest、不出更新
/// 按钮）；全部可检包都失败才报错——那是网络问题的信号
fn check_updates_once() -> Result<Vec<PluginUpdateInfo>, String> {
    let list = installed_plugins()?;
    let mut infos: Vec<PluginUpdateInfo> = list
        .into_iter()
        .map(|p| PluginUpdateInfo {
            installed_version: p.version,
            update_available: false,
            latest_version: None,
            latest_in_release_age_window: false,
            latest_publish_time: None,
            requires_dsh: None,
            compatible: None,
            name: p.name,
            spec: p.spec,
            managed: p.managed,
        })
        .collect();
    // 窗口判定的事实源：策略（profile yaml + 内置默认）读一次，发布时间只对
    // 确有更新的包多付一次 HTTP；宿主 dsh 版本探测一次，供兼容门禁判定
    let (age_minutes, age_excludes) = release_age_policy();
    let dsh_host = super::components::dsh_version();
    let now = time::OffsetDateTime::now_utc();
    let mut checked = 0usize;
    let mut failed = 0usize;
    let mut first_error: Option<String> = None;
    for info in infos
        .iter_mut()
        .filter(|i| !i.managed && i.installed_version.is_some())
    {
        checked += 1;
        match registry_latest(&info.name) {
            Ok(latest) => {
                info.update_available = is_newer(
                    &latest.version,
                    info.installed_version.as_deref().unwrap_or_default(),
                );
                // 兼容门禁：声明了最低 dsh 版本才判定（未声明 None = 不设门）
                info.requires_dsh = latest.requires_dsh;
                info.compatible = info
                    .requires_dsh
                    .as_ref()
                    .map(|req| meets_dsh_minimum(dsh_host.as_deref(), req));
                if info.update_available {
                    let publish = registry_publish_time(&info.name, &latest.version);
                    info.latest_in_release_age_window = in_release_age_window(
                        publish.as_deref(),
                        now,
                        age_minutes,
                        release_age_excluded(&age_excludes, &info.name, &latest.version),
                    );
                    info.latest_publish_time = publish;
                }
                info.latest_version = Some(latest.version);
            }
            Err(e) => {
                failed += 1;
                crate::logging::warn(
                    "[market] 单包更新检测失败",
                    &format!("{}: {}", info.name, e),
                );
                first_error.get_or_insert(e);
            }
        }
    }
    if checked > 0 && failed == checked {
        let e = first_error.unwrap_or_default();
        crate::logging::error("[market] 插件更新检测失败", &e);
        return Err(keyf(
            "Failed to check plugin updates: {error}",
            &[("error", e)],
        ));
    }
    Ok(infos)
}

pub(crate) fn installed_list_from_profile(
    path: &std::path::PathBuf,
) -> Result<Vec<InstalledPlugin>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| {
        crate::logging::warn("[market] 读取 profile package.json 失败", &e.to_string());
        keyf(
            "Failed to read web profile: {error}",
            &[("error", e.to_string())],
        )
    })?;
    let package: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        crate::logging::warn("[market] 解析 profile package.json 失败", &e.to_string());
        keyf(
            "Failed to parse web profile: {error}",
            &[("error", e.to_string())],
        )
    })?;
    let deps = package
        .get("dependencies")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "Web profile has no dependencies".to_string())?;
    // 启停事实：profile patch 的 disabled 覆盖行（缺失/畸形 = 全启用），
    // 判定范围 = 各包 claimed 的入口行
    let patch_states = path
        .parent()
        .and_then(|dir| std::fs::read_to_string(dir.join("cordis.patch.yml")).ok())
        .map(|raw| patch_row_states(&raw))
        .unwrap_or_default();
    Ok(deps
        .iter()
        .map(|(name, spec)| {
            let claimed = path
                .parent()
                .map(|dir| claimed_entry_rows(dir, name))
                .unwrap_or_default();
            let enabled = claimed
                .iter()
                .all(|(id, _)| patch_states.get(id).copied().unwrap_or(true));
            let spec = spec.as_str().unwrap_or_default().to_string();
            InstalledPlugin {
                name: name.clone(),
                version: installed_version_for_update(path.parent(), name, &spec),
                spec,
                managed: MANAGED_PLUGIN_PACKAGES.contains(&name.as_str()),
                enabled,
            }
        })
        .collect())
}

/// specifier / 包名白名单：npm 与 pnpm 的合法字符集。市场数据只经这两个
/// 参数进 dsh plugin 子命令（不经 shell），白名单挡的是写歪的目录数据与
/// 手改 IPC 的误用，而非注入
pub(crate) fn valid_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 214
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '.' | '_' | '-' | '#' | ':')
        })
        && !s.starts_with(['-', '#', ':', '/', '.'])
        && !s.contains("..")
}

/// npm 形态 specifier 的包名部分；带协议前缀的形态（github:/file:/npm: 等）
/// 返回 None（安装后的 dependencies 键名无法预知）。语义定义只有一份：
/// specifier_cases.json 测试向量驱动本函数与前端 packageNameFromSpecifier
/// 两侧实现，漂移在一侧测试立即失败
pub(crate) fn package_name_from_specifier(specifier: &str) -> Option<String> {
    // npm 包名不含 ':'，带即协议形态
    if specifier.contains(':') {
        return None;
    }
    let scope_start = if specifier.starts_with('@') {
        specifier.find('/')?
    } else {
        0
    };
    let at = specifier
        .rfind('@')
        .filter(|&i| i > scope_start)
        .unwrap_or(specifier.len());
    let name = &specifier[..at];
    (!name.is_empty()).then(|| name.to_string())
}

/// specifier → 目录条目的 name。目录条目与安装 specifier 同源于目录
/// install 命令串的 ` add ` 后缀：prefix 形态取最后一段
/// （github:owner/repo → repo），npm 形态即包名。语义定义见
/// specifier_cases.json（与前端 specifierToCatalogName 同一向量表）
pub(crate) fn specifier_to_catalog_name(specifier: &str) -> String {
    let last = specifier.rsplit('/').next().unwrap_or(specifier);
    package_name_from_specifier(last).unwrap_or_else(|| last.to_string())
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
                && identifier[e.len()..]
                    .chars()
                    .next()
                    .map_or(true, |c| c == '#' || c == '/'))
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
        keyf(
            "Failed to parse plugin policy: {error}",
            &[("error", e.to_string())],
        )
    })?;
    let Some(allowed) = policy.get("allowed") else {
        return Ok(None);
    };
    let arr = allowed
        .as_array()
        .ok_or_else(|| "Plugin policy field \"allowed\" must be an array".to_string())?;
    Ok(Some(
        arr.iter()
            .filter_map(|v| v.as_str())
            .map(str::to_string)
            .collect(),
    ))
}

/// 策略文件路径的唯一来源
fn plugin_policy_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::config::home_dir()?
        .join(".dsh-pro-max")
        .join("plugin-policy.json"))
}

fn load_policy_entries() -> Result<Option<Vec<String>>, String> {
    let path = plugin_policy_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        crate::logging::warn("[market] 读取插件策略失败", &e.to_string());
        keyf(
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
    Err(keyf(
        "Plugin install blocked by policy: {identifier} is not in the allowlist ({path})",
        &[("identifier", identifier.to_string()), ("path", path)],
    ))
}

/// 超时失败的文案：静态 key（无插值），前端 zh 词典按整句精确命中。不走
/// install_failure_message 的指纹加工——超时输出的指纹只是巧合，审批重跑
/// 不是「进程被杀」这一错误的去向
pub(crate) fn timeout_failure_message(action: &str) -> String {
    match action {
        "add" => {
            "Plugin install timed out and was terminated. Check your network and retry.".to_string()
        }
        _ => "Plugin removal timed out and was terminated.".to_string(),
    }
}

/// 用户取消（G2）的文案：静态 key，与超时文案同一形态。取消是用户决策，
/// 不是失败——文案只陈述事实，去向（重试按钮还在原位）由卡片状态机给出
fn cancelled_failure_message(action: &str) -> String {
    match action {
        "add" => "Plugin install was cancelled.".to_string(),
        _ => "Plugin removal was cancelled.".to_string(),
    }
}

// ---- G1：pnpm 失败分类（静态文案，动态细节留在卡片日志区与审计台账）----

const HINT_HOIST_DRIFT: &str = "The web profile's node_modules was created by a different pnpm major. Quit dsh, run \"pnpm install\" once in the profile directory to rebuild it, then retry.";
const HINT_UNEXPECTED_STORE: &str = "The profile's node_modules is linked to a different pnpm store than the current pnpm default, so pnpm refuses every install and uninstall. Run \"pnpm install --store-dir <the linked store>\" once in the profile directory (both paths are in the log detail below); quit dsh first if files are locked.";
const HINT_MISSING_INTEGRITY: &str = "A tarball dependency in the profile's pnpm-lock.yaml has no integrity hash, so pnpm refuses every install and uninstall. Delete the named entry from pnpm-lock.yaml and retry — do not delete the whole lockfile.";
const HINT_PATCH_FAILED: &str = "A pnpm patch in the profile no longer applies; the package installs unpatched and usually fails at the next dsh boot. Update or remove that patch file and its entry under \"pnpm.patchedDependencies\" in the profile's package.json.";
const HINT_RELEASE_AGE: &str = "pnpm's release-age protection blocked this change because a freshly published version is in the profile. Retry from the market to pin the exact version, or wait for the protection window to pass.";
const HINT_GIT_PREPARE: &str = "This git-hosted plugin needs to run a build script at install time, which pnpm blocks by default. Add the commit-pinned key printed in the log under \"allowBuilds\" in the profile's pnpm-workspace.yaml, then retry.";
const HINT_IGNORED_BUILDS: &str = "Some dependencies need to run build scripts, which pnpm blocks by default. Approve them via the build-script dialog, or add them under \"allowBuilds\" in the profile's pnpm-workspace.yaml, then retry.";
const HINT_FETCH_404: &str = "A dependency cannot be resolved from the registry, so pnpm refuses every install. It may be a ghost entry left by a failed operation (remove that line from the profile's package.json), or a private package needing credentials.";
const HINT_WINDOWS_FILE_LOCKED: &str = "Windows cannot replace files that are in use — the running dsh process holds them open. Quit dsh completely (not a page refresh), start it again, and retry. Native modules are only released when the process exits.";
const HINT_PNPM_MISSING: &str = "pnpm was not found. Install it once (\"corepack enable pnpm\" or \"npm install -g pnpm\") and restart dsh, then retry.";
const HINT_MISSING_LOCAL_DEP: &str = "A plugin installed from a local path no longer exists on disk, so pnpm refuses every install and uninstall. Remove that dependency from the profile's package.json and retry.";
const HINT_FETCH_TIMEOUT: &str = "The download timed out: this plugin ships a large package (GitHub sources download the whole repository) or the network is slow. Check your network and retry.";
const HINT_TRANSIENT_NETWORK: &str = "A transient network failure interrupted dependency fetching (installs replay the whole dependency tree). Please try again shortly.";

/// pnpm 失败指纹 → 静态用户文案（keyf 无插值形态，zh 词典整句命中）。A 经
/// dsh CLI 间接驱动 pnpm，只收录该形态实际可出现的失败族（B 方 dsh-market
/// 同源实测积累的裁剪版：`-w` 注入两类是 B 自身 bug 的提示，A 无此形态）。
/// 被拦构建脚本的文本形态不走这里——blocked_build_packages 命中时
/// install_decision 转审批对话框，display 不被消费；ERR_PNPM_IGNORED_BUILDS
/// 代码形态作为解析不出包名时的兜底。判定顺序：特定错误码在前，通用网络
/// 形态在后。动态细节（包名/路径/原始输出）不进文案：卡片日志区已有全文
pub(crate) fn pnpm_failure_hint(output: &str) -> Option<&'static str> {
    let lower = output.to_lowercase();
    const CODES: &[(&str, &str)] = &[
        ("err_pnpm_public_hoist_pattern_diff", HINT_HOIST_DRIFT),
        (
            "err_pnpm_virtual_store_dir_max_length_diff",
            HINT_HOIST_DRIFT,
        ),
        ("err_pnpm_unexpected_store", HINT_UNEXPECTED_STORE),
        ("err_pnpm_missing_tarball_integrity", HINT_MISSING_INTEGRITY),
        ("err_pnpm_patch_failed", HINT_PATCH_FAILED),
        ("err_pnpm_minimum_release_age_violation", HINT_RELEASE_AGE),
        ("err_pnpm_no_mature_matching_version", HINT_RELEASE_AGE),
        ("err_pnpm_git_dep_prepare_not_allowed", HINT_GIT_PREPARE),
        ("err_pnpm_ignored_builds", HINT_IGNORED_BUILDS),
        ("err_pnpm_fetch_404", HINT_FETCH_404),
        ("err_pnpm_eperm", HINT_WINDOWS_FILE_LOCKED),
    ];
    if let Some((_, hint)) = CODES.iter().find(|(code, _)| lower.contains(code)) {
        return Some(hint);
    }
    if lower.contains("eperm: operation not permitted, rename") {
        return Some(HINT_WINDOWS_FILE_LOCKED);
    }
    if lower.contains("pnpm not found on path") {
        return Some(HINT_PNPM_MISSING);
    }
    if lower.contains("enoent: no such file or directory, open")
        && lower.contains("while installing a direct dependency")
    {
        return Some(HINT_MISSING_LOCAL_DEP);
    }
    if lower.contains("operation was aborted due to timeout")
        || lower.contains("timeouterror")
        || lower.contains("error (23)")
    {
        return Some(HINT_FETCH_TIMEOUT);
    }
    const TRANSIENT: &[&str] = &[
        "err_pnpm_fetch_5",
        "err_pnpm_meta_fetch_fail",
        "fetcherror",
        "econnreset",
        "etimedout",
        "eai_again",
        "enetunreach",
        "socket hang up",
        "network timeout",
    ];
    if TRANSIENT.iter().any(|marker| lower.contains(marker)) {
        return Some(HINT_TRANSIENT_NETWORK);
    }
    None
}

/// 安装失败的文案加工：pnpm 失败指纹命中时给出静态的分类文案（G1，问题与
/// 下一步都有明确去向），否则保留上游原始错误。pnpm 10+ 的构建脚本拦截是
/// git 来源插件最常见的失败，识别后给出精确到文件的问题/下一步。拦截的
/// 自动化路径是 market_approve_builds（用户审批后写入 allowBuilds）
pub(crate) fn install_failure_message(action: &str, error: &str) -> String {
    if let Some(hint) = pnpm_failure_hint(error) {
        return hint.to_string();
    }
    if action != "add" {
        return keyf(
            "Failed to remove plugin: {error}",
            &[("error", error.to_string())],
        );
    }
    if error.contains("allowBuilds") || error.contains("Ignored build scripts") {
        let path = web_profile_dir()
            .map(|d| d.join("pnpm-workspace.yaml"))
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "~/.dsh/profiles/web/pnpm-workspace.yaml".to_string());
        return keyf(
            "Plugin build scripts were blocked by pnpm. Add the package name printed in the log under \"allowBuilds\" in {path}, then retry. Detail: {error}", &[("path", path), ("error", error.to_string())],
        );
    }
    keyf(
        "Failed to install plugin: {error}",
        &[("error", error.to_string())],
    )
}

/// 安装输出行事件（`market-install-log`）：specifier 锚定前端卡片（安装全局
/// 单飞，带上是防御错位），line 为 dsh/pnpm 子进程的展示行
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct MarketInstallLogEvent {
    pub specifier: String,
    pub line: String,
}

/// 失败输出的原始事实拼装（纯函数，便于测试）：pnpm 11 把
/// ERR_PNPM_IGNORED_BUILDS 等关键错误打到 stdout，stderr 只剩 dsh 的转发
/// 提示甚至为空——单看 stderr 会让 blocked_build_packages /
/// install_failure_message 的指纹检测漏检（审批对话框不弹的直接原因）。
/// stderr 在前（摘要性错误通常在这），stdout 在后；双空兜底一行通用事实
pub(crate) fn failure_raw(stdout: &str, stderr: &str, action: &str) -> String {
    let merged = [stderr, stdout]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if merged.is_empty() {
        format!("dsh plugin {action} failed")
    } else {
        merged
    }
}

/// 当前活跃 dsh plugin 子命令的取消令牌（G2）：market_cancel 置位即杀。
/// Mutex<Option> 空闲为 None；同一时刻至多一个活跃命令（前端单飞 busy 态
/// 保证，此处覆盖式写入只作防御——被顶掉的旧令牌孤儿化无害，置位杀的是
/// 已结束的命令）
static ACTIVE_PLUGIN_CMD: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// 执行 dsh plugin 子命令；每行输出经 on_line 实时回调（首行是执行命令本身，
/// 与实际 argv 同一拼装），Err 的 (raw, display) 中 raw 是本地化前的原始
/// 输出（stdout+stderr 合并，见 failure_raw；审计台账的可复述事实，不随
/// 界面语言漂移），display 是加工后的用户文案
fn run_plugin_cmd(
    action: &str,
    arg: &str,
    on_line: impl Fn(&str) + Send + Sync + 'static,
) -> Result<(), (String, String)> {
    if !valid_identifier(arg) {
        let raw = format!("invalid plugin identifier: {arg}");
        return Err((raw, "Invalid plugin identifier".to_string()));
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
    // 安装/移除共用此执行核，超时按动作区分；到点杀进程防 busy 态无限挂起。
    // 取消令牌注册进全局槽（market_cancel 据此置位），结束（含失败/取消/
    // 回滚）后仅当槽内仍是自己的令牌才清空——防误清后继命令的令牌
    let timeout = if action == "add" {
        PLUGIN_ADD_TIMEOUT
    } else {
        PLUGIN_REMOVE_TIMEOUT
    };
    let cancel = Arc::new(AtomicBool::new(false));
    *ACTIVE_PLUGIN_CMD.lock().unwrap_or_else(|p| p.into_inner()) = Some(cancel.clone());
    let outcome = run_capture_lines(&dsh, &argv, on_line, Some(timeout), Some(cancel.as_ref()));
    {
        let mut slot = ACTIVE_PLUGIN_CMD.lock().unwrap_or_else(|p| p.into_inner());
        if slot.as_ref().is_some_and(|t| Arc::ptr_eq(t, &cancel)) {
            *slot = None;
        }
    }
    match outcome {
        Ok((_, _, true, _)) => Ok(()),
        Ok((out, err, false, killed)) => {
            // 被杀路径复用超时的无 join 收尾；取消与超时凭令牌区分——令牌
            // 由本函数持有，外部无从置位（market_cancel 只作用于全局槽）
            let cancelled = killed && cancel.load(Ordering::Relaxed);
            let mut raw = failure_raw(&out, &err, action);
            let display = if cancelled {
                raw.push_str(&format!("\ndsh plugin {action} was cancelled"));
                crate::logging::warn(&format!("[market] plugin {action} 被用户取消"), &raw);
                cancelled_failure_message(action)
            } else if killed {
                raw.push_str(&format!(
                    "\ndsh plugin {action} timed out and was terminated"
                ));
                crate::logging::error(&format!("[market] plugin {action} 超时终止"), &raw);
                timeout_failure_message(action)
            } else {
                crate::logging::error(&format!("[market] plugin {action} 失败"), &raw);
                install_failure_message(action, &raw)
            };
            Err((raw, display))
        }
        Err(e) => {
            crate::logging::error(&format!("[market] plugin {action} 执行失败"), &e);
            Err((e.clone(), e))
        }
    }
}

/// 取消当前活跃的插件安装/移除（busy 态的取消按钮，G2）：置位取消令牌，
/// 执行核轮询到即杀进程走失败路径（display = 取消文案，审计台账记 raw）。
/// 无活跃命令返回 false——幂等，前端不必预判；护栏回滚期间的 remove 同样
/// 可被取消（其输出只进台账，不影响主流程错误文案）
#[tauri::command]
pub fn market_cancel() -> bool {
    let slot = ACTIVE_PLUGIN_CMD.lock().unwrap_or_else(|p| p.into_inner());
    match slot.as_ref() {
        Some(token) => {
            token.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

/// 从 pnpm/dsh 失败输出（stdout+stderr 合并）提取被拦构建脚本的包名。
/// pnpm 10 与 11/12 的错误形态不同但都含 `Ignored build scripts:` 行
/// （逗号分隔、带版本号；11.25 起该行落在 stdout）；scope 包剥版本
/// 用 rfind 保护 `@scope` 前缀。解析不出的脏数据被 valid_identifier 过滤，
/// 空结果 → 调用方回退普通失败文案
pub(crate) fn blocked_build_packages(output: &str) -> Vec<String> {
    let Some(line) = output
        .lines()
        .find(|l| l.contains("Ignored build scripts:"))
    else {
        return Vec::new();
    };
    let list = line
        .split("Ignored build scripts:")
        .nth(1)
        .unwrap_or_default();
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
    Ok(web_profile_dir()?.join("pnpm-workspace.yaml"))
}

/// web profile 目录（package.json 所在处）——patch、workspace yaml 等同级
/// 文件的唯一定位来源
fn web_profile_dir() -> Result<std::path::PathBuf, String> {
    web_profile_package_path()?
        .parent()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| "Web profile has no parent directory".to_string())
}

/// profile 的 cordis.patch.yml 路径（dsh loader 的用户覆盖层，启停开关的
/// 落盘位置）
fn profile_patch_path() -> Result<std::path::PathBuf, String> {
    Ok(web_profile_dir()?.join("cordis.patch.yml"))
}

/// 合并放行构建脚本到 profile 的 pnpm-workspace.yaml（上游 dsh 对 pnpm 10+
/// 拦截的官方姿势）。`allowBuilds: {pkg: true}`（pnpm 11+ 认）与
/// `onlyBuiltDependencies: [pkg]`（pnpm 10 认）双键同写；用户已有键与显式
/// false 不覆盖、只插入缺失项，幂等。pnpm 9 不拦脚本，不会走到这里
pub(crate) fn merge_allow_builds(
    path: &std::path::Path,
    packages: &[String],
) -> Result<(), String> {
    let yaml_invalid = || "Invalid pnpm workspace config".to_string();
    let mut root: serde_yaml::Value = if path.exists() {
        let raw = std::fs::read_to_string(path).map_err(|e| {
            crate::logging::warn("[market] 读取 pnpm-workspace.yaml 失败", &e.to_string());
            keyf(
                "Failed to read {path}: {error}",
                &[
                    ("path", path.display().to_string()),
                    ("error", e.to_string()),
                ],
            )
        })?;
        serde_yaml::from_str(&raw).map_err(|e| {
            crate::logging::warn("[market] 解析 pnpm-workspace.yaml 失败", &e.to_string());
            // 损坏时拒绝覆盖：宁可让用户手改，不可静默丢配置
            keyf(
                "Failed to parse {path}: {error}",
                &[
                    ("path", path.display().to_string()),
                    ("error", e.to_string()),
                ],
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
        let entry = allows_map.entry(serde_yaml::Value::from(p.as_str()));
        // 保留用户显式 false；覆盖 pnpm approve-builds 交互占位符等非布尔值
        match entry {
            serde_yaml::mapping::Entry::Occupied(mut e) => {
                if e.get().as_bool().is_none() {
                    e.insert(serde_yaml::Value::Bool(true));
                }
            }
            serde_yaml::mapping::Entry::Vacant(e) => {
                e.insert(serde_yaml::Value::Bool(true));
            }
        }
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
        keyf(
            "Failed to write {path}: {error}",
            &[
                ("path", path.display().to_string()),
                ("error", e.to_string()),
            ],
        )
    })
}

// ============ 启停开关（profile patch 的 disabled 覆盖行）============

/// 包的 claimed 入口行 (id, name)：包自带 cordis.patch.yml 的 insert 行携带
/// 入口 id 与入口名；无 bundle patch 或 patch 解析不出入口的普通插件以包名
/// 自claim。停用覆盖行的 name 必须是入口自身名——include patch 语义会跳过
/// name 不匹配的行，写包名会导致开关无效。
pub(crate) fn claimed_entry_rows(
    profile_dir: &std::path::Path,
    name: &str,
) -> Vec<(String, String)> {
    let self_claimed = || vec![(name.to_string(), name.to_string())];
    if !safe_package_name(name) {
        return self_claimed();
    }
    let raw = match std::fs::read_to_string(
        profile_dir
            .join("node_modules")
            .join(name)
            .join("cordis.patch.yml"),
    ) {
        Ok(raw) => raw,
        Err(_) => return self_claimed(),
    };
    let Ok(parsed) = serde_yaml::from_str::<serde_yaml::Value>(&raw) else {
        return self_claimed();
    };
    let mut rows = Vec::new();
    if let Some(items) = parsed.as_sequence() {
        for item in items {
            let Some(insert) = item.get("insert").and_then(serde_yaml::Value::as_sequence) else {
                continue;
            };
            for entry in insert {
                let Some(id) = entry
                    .get("id")
                    .and_then(serde_yaml::Value::as_str)
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                let entry_name = entry
                    .get("name")
                    .and_then(serde_yaml::Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(name);
                rows.push((id.to_string(), entry_name.to_string()));
            }
        }
    }
    if rows.is_empty() {
        self_claimed()
    } else {
        rows
    }
}

/// profile patch 原文 → bare 覆盖行的启用状态（入口 id → enabled）。bare
/// row = 不带 insert 键的顶层映射；`disabled: true` 即停用，其余启用（与
/// 官方 reader 同一语义）。畸形 YAML 按空层处理——patch 是覆盖层，缺席
/// 即默认全启用，其写入错误由拥有该文件的 CLI 暴露
pub(crate) fn patch_row_states(raw: &str) -> BTreeMap<String, bool> {
    let mut states = BTreeMap::new();
    let Ok(parsed) = serde_yaml::from_str::<serde_yaml::Value>(raw) else {
        return states;
    };
    let Some(items) = parsed.as_sequence() else {
        return states;
    };
    for item in items {
        if item.get("insert").is_some() {
            continue;
        }
        if let Some(id) = item.get("id").and_then(serde_yaml::Value::as_str) {
            let disabled = item
                .get("disabled")
                .and_then(serde_yaml::Value::as_bool)
                .unwrap_or(false);
            states.insert(id.to_string(), !disabled);
        }
    }
    states
}

/// patch 是否为空层：无字节，或 YAML 解析为空序列/Null。dsh 官方空层脚手
/// 架是注释头 + `[]`（PROFILE_PATCH_TEMPLATE），注释行不是顶层 item，flow
/// 空数组也不携带 item——都是合法空层。解析失败（真畸形）不算空层，交给
/// 顶层 item 检测报错
fn is_empty_patch(raw: &str) -> bool {
    if raw.trim().is_empty() {
        return true;
    }
    match serde_yaml::from_str::<serde_yaml::Value>(raw) {
        Ok(v) => v.as_sequence().is_some_and(|s| s.is_empty()) || v.is_null(),
        Err(_) => false,
    }
}

/// 启停写入（纯函数）：启用 = 删除匹配入口 id 的 bare 覆盖行（覆盖行缺席
/// 即启用，官方同款语义）；停用 = 更新或追加 `{id, name, disabled: true}`
/// 覆盖行。写入走行级编辑而不是 YAML 文档往返——serde_yaml 会静默剥掉
/// dsh loader 依赖的 `!!js` 表达式标签，行级只增删覆盖行、其余字节原样
/// 保留。落盘永远可解析为顶层数组：启用删空层时归一回官方脚手架形态
/// （注释头 + `[]`），纯注释残留会让 dsh 启动预检全灭。内容未变化返回
/// None（调用方免写盘）
pub(crate) fn set_entries_enabled(
    raw: &str,
    entries: &[(String, String)],
    enabled: bool,
) -> Result<Option<String>, String> {
    let mut lines: Vec<String> = raw.lines().map(str::to_string).collect();
    if is_empty_patch(raw) {
        // 空层：剥掉 `[]` 占位行、保留注释行——追加的覆盖行落在注释头之
        // 后，与 dsh 脚手架带 item 时的形态一致
        lines.retain(|l| l.trim() != "[]");
    }
    let item_ranges = top_level_item_ranges(&lines, raw)?;
    let mut changed = false;
    if enabled {
        // 启用：从尾部向前删除匹配的 bare 覆盖行，行号不因删除而漂移
        for (start, end, id, is_bare) in item_ranges.iter().rev() {
            if *is_bare && entries.iter().any(|(eid, _)| eid == id) {
                lines.drain(*start..*end);
                changed = true;
            }
        }
    } else {
        for (eid, ename) in entries {
            let hit = item_ranges
                .iter()
                .find(|(_, _, id, is_bare)| *is_bare && id == eid)
                .map(|(start, end, _, _)| (*start, *end));
            match hit {
                Some((start, end)) => {
                    // 已有覆盖行：disabled 行替换为 true，缺失则补一行
                    let already = (start..end)
                        .rev()
                        .find_map(|i| disabled_field_value(&lines[i]));
                    if already.as_deref() == Some("true") {
                        continue;
                    }
                    match (start..end).find(|i| disabled_field_value(&lines[*i]).is_some()) {
                        Some(i) => lines[i] = "  disabled: true".to_string(),
                        None => lines.insert(end, "  disabled: true".to_string()),
                    }
                    changed = true;
                }
                None => {
                    // 追加覆盖行到文档末尾（补齐结尾换行）
                    if let Some(last) = lines.last() {
                        if !last.is_empty() {
                            lines.push(String::new());
                        }
                    }
                    lines.push(format!("- id: {eid}"));
                    lines.push(format!("  name: {ename}"));
                    lines.push("  disabled: true".to_string());
                    changed = true;
                }
            }
        }
    }
    if !changed {
        return Ok(None);
    }
    let mut out = lines.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    if is_empty_patch(&out) {
        // 空层归一回官方脚手架形态（注释头 + `[]`）：纯注释文件 YAML 解析
        // 为 null，dsh loader 必拒（顶层必须是数组）——落盘永远可解析
        while out.ends_with('\n') {
            out.pop();
        }
        out.push_str("\n[]\n");
    }
    Ok(Some(out))
}

/// 顶层 item 的切分结果：(起始行, 结束行(不含), id 字段值, 是否 bare 行)。
/// 列 0 的 `- ` 开启新 item，直到下一个顶层 item 或 EOF；嵌套的 `    - `
/// 行（insert 序列项）不在列 0，天然排除。bare = 不含 insert 键（首行内联
/// 或两空格字段行）
fn top_level_item_ranges(
    lines: &[String],
    raw: &str,
) -> Result<Vec<(usize, usize, String, bool)>, String> {
    let mut starts: Vec<usize> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("- ") || line == "-" {
            starts.push(i);
        }
    }
    if starts.is_empty() {
        if is_empty_patch(raw) {
            return Ok(Vec::new());
        }
        return Err("Web profile patch must contain a top-level YAML array".to_string());
    }
    let mut ranges = Vec::new();
    for (n, &start) in starts.iter().enumerate() {
        let end = starts.get(n + 1).copied().unwrap_or(lines.len());
        let first = &lines[start];
        let is_bare = !first.starts_with("- insert:")
            && !lines[start + 1..end]
                .iter()
                .any(|l| l.starts_with("  insert:"));
        let id = first
            .strip_prefix("- ")
            .and_then(|rest| rest.strip_prefix("id:"))
            .map(|v| unquote(v.trim()))
            .or_else(|| {
                lines[start + 1..end]
                    .iter()
                    .find_map(|l| l.strip_prefix("  id:").map(|v| unquote(v.trim())))
            })
            .unwrap_or_default();
        ranges.push((start, end, id, is_bare));
    }
    Ok(ranges)
}

/// bare 行的 `  disabled:` 字段值（两空格字段行；我们只写这个形态）
fn disabled_field_value(line: &str) -> Option<String> {
    line.strip_prefix("  disabled:").map(|v| unquote(v.trim()))
}

/// YAML 简单标量的对称引号剥离（id/name 由我们或 dsh 写出，通常是裸词）
fn unquote(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2
        && ((v.starts_with('\'') && v.ends_with('\'')) || (v.starts_with('"') && v.ends_with('"')))
    {
        v[1..v.len() - 1].to_string()
    } else {
        v.to_string()
    }
}

// ============ 安装后护栏（预检 / 冲突对账 / 自动回滚）============

/// 安装护栏透出的事实。结构化载荷而非拼好的句子：语言由前端词典组装，
/// 不随 Rust 侧字符串漂移
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub enum InstallNotice {
    /// CLI 的 bundle 对账把组合树里已由 patch 行挂载的包重新加进
    /// dsh.profile.bundles，已把该条目剥回去（防下次启动重复挂载失败）
    #[serde(rename_all = "camelCase")]
    StrippedDuplicateBundle { name: String },
}

/// 护栏的层快照：dependencies 键 + `dsh.profile.bundles` + profile patch 的
/// bare 行 id。容错读取：文件缺失/畸形 = 空集（CLI 拥有这些文件的写入，
/// 其错误经 CLI 输出暴露，护栏不放大读取噪声）
pub(crate) struct ProfileLayer {
    pub(crate) dependencies: Vec<String>,
    pub(crate) bundles: Vec<String>,
    pub(crate) row_ids: Vec<String>,
}

fn capture_profile_layer() -> ProfileLayer {
    let manifest = web_profile_package_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    let dependencies = manifest
        .as_ref()
        .and_then(|v| v.get("dependencies"))
        .and_then(serde_json::Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let bundles = manifest
        .as_ref()
        .and_then(|v| v.pointer("/dsh/profile/bundles"))
        .and_then(serde_json::Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let row_ids = profile_patch_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|raw| patch_row_states(&raw))
        .unwrap_or_default()
        .into_keys()
        .collect();
    ProfileLayer {
        dependencies,
        bundles,
        row_ids,
    }
}

/// patch 原文 → 行挂载的包名（带启停判定）：bare 行取 name（启用行）、
/// insert 行取 name（其 id 未被 bare 覆盖行停用）。serde_yaml 只读判定
/// 不写盘，`!!js` 标签丢失无妨
pub(crate) fn row_mounted_names(raw: &str, disabled_ids: &BTreeMap<String, bool>) -> Vec<String> {
    let Ok(parsed) = serde_yaml::from_str::<serde_yaml::Value>(raw) else {
        return Vec::new();
    };
    let Some(items) = parsed.as_sequence() else {
        return Vec::new();
    };
    let mut mounted = Vec::new();
    for item in items {
        if let Some(insert) = item.get("insert").and_then(serde_yaml::Value::as_sequence) {
            for entry in insert {
                let Some(name) = entry
                    .get("name")
                    .and_then(serde_yaml::Value::as_str)
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                let disabled = entry
                    .get("id")
                    .and_then(serde_yaml::Value::as_str)
                    .and_then(|id| disabled_ids.get(id))
                    .copied()
                    == Some(false);
                if !disabled {
                    mounted.push(name.to_string());
                }
            }
        } else if let Some(name) = item
            .get("name")
            .and_then(serde_yaml::Value::as_str)
            .filter(|s| !s.is_empty())
        {
            let id = item
                .get("id")
                .and_then(serde_yaml::Value::as_str)
                .unwrap_or_default();
            if disabled_ids.get(id).copied() != Some(false) {
                mounted.push(name.to_string());
            }
        }
    }
    mounted
}

/// before 态组合已由 patch 行挂载的包名全集：profile patch 自身（bare 行 +
/// insert 行）加各依赖自带 bundle patch 的 insert 行。挂载判定的启停事实
/// 以 before patch 的 bare 行为准
fn before_row_mounted(before: &ProfileLayer) -> Vec<String> {
    let disabled_ids = profile_patch_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|raw| patch_row_states(&raw))
        .unwrap_or_default();
    let mut mounted = profile_patch_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|raw| row_mounted_names(&raw, &disabled_ids))
        .unwrap_or_default();
    if let Ok(profile_dir) = web_profile_dir() {
        for dep in &before.dependencies {
            let patch = profile_dir
                .join("node_modules")
                .join(dep)
                .join("cordis.patch.yml");
            if let Ok(raw) = std::fs::read_to_string(patch) {
                mounted.extend(row_mounted_names(&raw, &disabled_ids));
            }
        }
    }
    mounted
}

/// 剥离决策（纯函数）：after 相对 before 新增的 bundles 条目里，before 态
/// 已由 patch 行挂载的包名。用户既有条目与无行挂载的新条目都不剥
pub(crate) fn duplicate_mount_strips_of(
    before_bundles: &[String],
    after_bundles: &[String],
    mounted: &std::collections::BTreeSet<String>,
) -> Vec<String> {
    after_bundles
        .iter()
        .filter(|b| !before_bundles.contains(b) && mounted.contains(*b))
        .cloned()
        .collect()
}

/// B9 重复挂载防护：CLI 的 bundle 对账会把声明 `dsh.bundle` 的依赖重新加进
/// `dsh.profile.bundles`——包括组合树里已由 patch 行挂载的包，下次启动重复
/// 挂载必挂。只剥「本次新增且 before 态已由 patch 行挂载」的条目，用户既有
/// 条目一律不动。写回失败显式报错（宁可失败不可静默留下破坏下次启动的状态）
fn strip_duplicate_mounts(
    before: &ProfileLayer,
    after: &ProfileLayer,
) -> Result<Vec<InstallNotice>, String> {
    let mounted: std::collections::BTreeSet<String> =
        before_row_mounted(before).into_iter().collect();
    let strips = duplicate_mount_strips_of(&before.bundles, &after.bundles, &mounted);
    if strips.is_empty() {
        return Ok(Vec::new());
    }
    let path = web_profile_package_path()?;
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut package: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let Some(bundles) = package
        .pointer_mut("/dsh/profile/bundles")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return Ok(Vec::new());
    };
    bundles.retain(|b| {
        b.as_str()
            .map(|s| !strips.contains(&s.to_string()))
            .unwrap_or(true)
    });
    let out = serde_json::to_string_pretty(&package).map_err(|e| e.to_string())?;
    std::fs::write(&path, out + "\n").map_err(|e| {
        keyf(
            "Failed to write {path}: {error}",
            &[
                ("path", path.display().to_string()),
                ("error", e.to_string()),
            ],
        )
    })?;
    Ok(strips
        .into_iter()
        .map(|name| InstallNotice::StrippedDuplicateBundle { name })
        .collect())
}

/// B8 落盘校验：退出码 0 不是落盘证明。npm 形态的落盘键可预知，缺失且
/// before 也没有（非重装）即未生效；协议形态（github: 重装同键）以
/// 「出现新依赖或 spec 变化」为生效信号
pub(crate) fn verify_landed(
    specifier: &str,
    before: &ProfileLayer,
    after: &ProfileLayer,
) -> Result<(), String> {
    let landed = match package_name_from_specifier(specifier) {
        Some(name) => after.dependencies.contains(&name) || before.dependencies.contains(&name),
        None => before.dependencies != after.dependencies,
    };
    if !landed {
        return Err(keyf(
            "dsh plugin add reported success but nothing landed in the web profile (install did not take effect)",
            &[],
        ));
    }
    Ok(())
}

/// `dsh --profile web --dump-config` 组合预检（解析每个入口但不绑定端口）。
/// 成功返回 (stdout, stderr)——stdout 是组合后的 loader 条目清单（诊断 G7
/// 的事实源：dsh 自己输出的组合事实，诊断不复刻组合语义、随上游升级零
/// 漂移），stderr 携带孤儿 patch 行告警；失败返回合并输出（牵连性指纹匹配
/// 用）——超时被杀也走失败路径，已捕获的部分输出照样参与指纹匹配
fn dump_config_raw() -> Result<(String, String), String> {
    let dsh = resolve_dsh_bin()?.display().to_string();
    let (out, err, ok, timed_out) = run_capture_lines(
        &dsh,
        &["--profile", "web", "--dump-config"],
        |_| {},
        Some(DUMP_CONFIG_TIMEOUT),
        None,
    )?;
    if ok {
        return Ok((out, err));
    }
    let mut parts: Vec<String> = [err, out].into_iter().filter(|s| !s.is_empty()).collect();
    if timed_out {
        parts.push("(dump-config timed out and was terminated)".to_string());
    }
    Err(parts.join("\n"))
}

fn dump_config() -> Result<(), String> {
    dump_config_raw().map(|_| ())
}

/// owner-aware 回滚：经官方 remove 路径撤下新包（连带其 bundle 对账产物），
/// 现有插件的入口与启停状态不动。回滚失败在错误里给手动命令。恒返回给
/// 用户的错误文案（调用方包 Err 透传），审计记 rollback 行
fn rollback_install(app: &tauri::AppHandle, name: &str, reason: &str, specifier: &str) -> String {
    let outcome = run_plugin_cmd("remove", name, |_| {});
    append_audit(app, "rollback", specifier, Some(reason));
    let rolled_back = outcome.is_ok();
    let tail = outcome.err().map(|(raw, _)| raw).unwrap_or_default();
    keyf(
        if rolled_back {
            "{reason}; the new plugin was rolled back automatically. Detail: {detail}"
        } else {
            "{reason}; automatic rollback failed — run \"dsh plugin --profile web remove {name}\" manually. Detail: {detail}"
        },
        &[
            ("reason", reason.to_string()),
            ("name", name.to_string()),
            (
                "detail",
                if tail.is_empty() {
                    "-".to_string()
                } else {
                    tail
                },
            ),
        ],
    )
}

/// 安装 CLI 退出码 0 之后的护栏编排：落盘校验（B8）→ 重复挂载剥离（B9）→
/// 重复入口 id 回滚（B5，仅新增依赖）→ 启动预检（无条件）。护栏判定失败
/// 时已尽力回滚，返回 Err(display)；成功返回剥离事实 notices。对无法唯一
/// 定位回滚目标的形态（协议形态重装）只校验与预检、不自动回滚——回滚目标
/// 可能正是用户既有插件
fn post_install_guard(
    app: &tauri::AppHandle,
    specifier: &str,
    before: &ProfileLayer,
) -> Result<Vec<InstallNotice>, String> {
    let after = capture_profile_layer();
    verify_landed(specifier, before, &after)?;
    let notices = strip_duplicate_mounts(before, &after)?;
    let new_dep = after
        .dependencies
        .iter()
        .find(|n| !before.dependencies.contains(n))
        .cloned();
    // B5：新包 claimed 的入口 id 撞上既有占用（patch bare 行 + 其它依赖的
    // claimed 入口），下次启动必重复挂载失败。绝不写共享 disabled 行——
    // 那挡不住 loader 的重复检查还会误伤现有插件，回滚新包才是正解；无新
    // 增依赖（重装/升级/上次预检失败后的重试）时无回滚对象，跳过
    let claimed: Vec<String> = match &new_dep {
        Some(name) => {
            let profile_dir = web_profile_dir()?;
            let claimed_ids: Vec<String> = claimed_entry_rows(&profile_dir, name)
                .into_iter()
                .map(|(id, _)| id)
                .collect();
            let mut taken = after.row_ids.clone();
            for dep in &after.dependencies {
                if dep != name {
                    taken.extend(
                        claimed_entry_rows(&profile_dir, dep)
                            .into_iter()
                            .map(|(id, _)| id),
                    );
                }
            }
            let overlap: Vec<String> = claimed_ids
                .iter()
                .filter(|id| taken.contains(*id))
                .cloned()
                .collect();
            if !overlap.is_empty() {
                return Err(rollback_install(
                    app,
                    name,
                    &keyf(
                        "New plugin claims entry ids already held by existing plugins ({ids})",
                        &[("ids", overlap.join(", "))],
                    ),
                    specifier,
                ));
            }
            claimed_ids
        }
        None => Vec::new(),
    };
    // 启动预检（无条件执行，重装/升级/重试也照跑）：组合失败且输出牵连新包
    // （包名或其入口 id）→ 回滚；无关失败如实报告、不动任何东西。无新增
    // 依赖时恒为无关失败——在这里提前返回 Ok 会把存量损坏（正是上次无关
    // 预检失败后的重试场景）假报成安装成功
    if let Err(tail) = dump_config() {
        let implicated = new_dep
            .as_deref()
            .is_some_and(|name| tail.contains(name) || claimed.iter().any(|id| tail.contains(id)));
        if implicated {
            return Err(rollback_install(
                app,
                new_dep.as_deref().unwrap_or_default(),
                "Boot preflight failed",
                specifier,
            ));
        }
        return Err(keyf(
            "Boot preflight failed (unrelated to this install): {detail}",
            &[("detail", tail)],
        ));
    }
    Ok(notices)
}

// ============ 审计台账 ============

/// 台账行（JSONL 单行）：ts/action/identifier/result/error/两个版本号。
/// error 记本地化前的原始错误（子进程输出或内部原因），不随界面语言漂移——
/// 台账是"可复述"的最低形态：排错日志 2MB 轮转即删，装了什么必须另有所在
pub(crate) fn audit_line(
    action: &str,
    identifier: &str,
    dsh_version: Option<String>,
    error: Option<&str>,
) -> String {
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
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
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
/// 这条路）；差集不可用或为空时按 npm 包名定位（覆盖同键重装/升版）；
/// 协议形态重装（键已在 before，差集为空且包名解析不出）退到
/// protocol_installed_match 找既有落点。都无法唯一确定 → None，如实返回，不猜
pub(crate) fn install_receipt(
    specifier: &str,
    before: Option<Vec<String>>,
    list: &[InstalledPlugin],
    catalog_name: Option<&str>,
) -> Option<InstallReceipt> {
    if let Some(before) = before {
        let added: Vec<&InstalledPlugin> =
            list.iter().filter(|p| !before.contains(&p.name)).collect();
        if added.len() == 1 {
            return Some(InstallReceipt {
                name: added[0].name.clone(),
                spec: added[0].spec.clone(),
            });
        }
    }
    if let Some(name) = package_name_from_specifier(specifier) {
        return list
            .iter()
            .find(|p| p.name == name)
            .map(|p| InstallReceipt {
                name: p.name.clone(),
                spec: p.spec.clone(),
            });
    }
    protocol_installed_match(specifier, catalog_name?, list).map(|p| InstallReceipt {
        name: p.name.clone(),
        spec: p.spec.clone(),
    })
}

/// GitHub 仓库标识归一：github:owner/repo 与 pnpm 落盘的
/// git+https://github.com/owner/repo.git 等形态 → "owner/repo"（小写，
/// GitHub 仓库地址大小写不敏感）；#fragment（#ref/#path:）与 .git 后缀剥离。
/// 非 GitHub 仓库形态返回 None。只用于匹配，不碰落盘事实（spec 原样展示）。
/// 前端 githubRepoId 同一套语义，specifier_cases.json 的 githubRepoId 向量组
/// 两侧共同驱动，改一侧必须同步另一侧
pub(crate) fn github_repo_id(spec: &str) -> Option<String> {
    const PREFIXES: &[&str] = &[
        "github:",
        "git+https://github.com/",
        "https://github.com/",
        "git+ssh://git@github.com/",
        "ssh://git@github.com/",
        "git@github.com:",
    ];
    let rest = PREFIXES.iter().find_map(|p| spec.strip_prefix(p))?;
    let body = match rest.split_once('#') {
        Some((head, _)) => head,
        None => rest,
    };
    let body = body.strip_suffix(".git").unwrap_or(body);
    let (owner, repo) = body.split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some(format!("{owner}/{repo}").to_lowercase())
}

/// 协议形态安装的已装匹配（前端 protocolInstalledMatch 同一套语义，改一侧
/// 必须同步另一侧）：specifier 与落盘 spec 各自归一出 GitHub 仓库标识
/// （owner/repo，见 github_repo_id）等值命中——pnpm 会把无 fragment 的
/// github:owner/repo 落盘规范化为 git+https://github.com/owner/repo.git，
/// 字符串前缀认不出（dsh-at-file 卡片恒显未安装即此因）；等值比较同时消灭
/// 了前缀族的边界特判（dsh-relay 兄弟误撞）。再要求目录名在 spec 中出现
/// （specifier 与落盘键名不一致的唯一信号）双条件判定；命中数量唯一才采信
pub(crate) fn protocol_installed_match<'a>(
    specifier: &str,
    catalog_name: &str,
    list: &'a [InstalledPlugin],
) -> Option<&'a InstalledPlugin> {
    let repo = github_repo_id(specifier)?;
    let mut hits = list.iter().filter(|p| {
        github_repo_id(&p.spec).as_deref() == Some(repo.as_str()) && p.spec.contains(catalog_name)
    });
    let first = hits.next()?;
    if hits.next().is_some() {
        return None;
    }
    Some(first)
}

// ============ IPC ============

#[tauri::command]
pub async fn market_fetch(app: tauri::AppHandle) -> Result<MarketCatalog, String> {
    super::ipc_blocking(move || fetch_catalog(&app)).await
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

/// 安装结果的判定核（不碰进程/审计/AppHandle）：run_plugin_cmd 的成败即
/// InstallOutcome 的形态——成功带 before/after 列表算回执；失败按 pnpm 拦截
/// 指纹转审批请求或按加工后文案报错。返回错误形态 (raw, display) 由调用方
/// 记账（raw 进审计台账，display 给用户）
pub(crate) fn install_decision(
    specifier: &str,
    run: Result<(), (String, String)>,
    before: Option<Vec<String>>,
    after: Option<Vec<InstalledPlugin>>,
    workspace_yaml: Option<String>,
) -> Result<InstallOutcome, (String, String)> {
    match run {
        Ok(()) => {
            let receipt = after.and_then(|list| {
                install_receipt(
                    specifier,
                    before,
                    &list,
                    Some(&specifier_to_catalog_name(specifier)),
                )
            });
            Ok(InstallOutcome::Installed {
                receipt,
                notices: Vec::new(),
            })
        }
        Err((raw, display)) => {
            let packages = blocked_build_packages(&raw);
            if !packages.is_empty() {
                // 拦截不算安装失败：转审批请求（被拦包名 + 待写 yaml 路径）
                let workspace_yaml = workspace_yaml.ok_or_else(|| {
                    (
                        raw.clone(),
                        "Web profile has no parent directory".to_string(),
                    )
                })?;
                return Ok(InstallOutcome::NeedsApproval {
                    packages,
                    workspace_yaml,
                });
            }
            Err((raw, display))
        }
    }
}

/// 安装一键候选的执行体（market_install 的阻塞部分）：进程执行与审计台账
/// 在本壳，判定决策在 install_decision（审批分流附带回执/拦截原始事实，
/// 台账记原始子进程输出，不随判定层的加工漂移）。判定成功后过安装护栏
/// （预检/冲突对账/自动回滚），护栏拦截转失败、剥离事实附进结果
fn install_once(app: &tauri::AppHandle, specifier: &str) -> Result<InstallOutcome, String> {
    let before = installed_plugins()
        .ok()
        .map(|l| l.iter().map(|p| p.name.clone()).collect::<Vec<_>>());
    let before_layer = capture_profile_layer();
    let run = run_plugin_cmd("add", specifier, emit_install_line(app, specifier));
    let raw_failure = run.as_ref().err().map(|(raw, _)| raw.clone());
    let after = installed_plugins().ok();
    let workspace_yaml = workspace_yaml_path().ok().map(|p| p.display().to_string());
    match install_decision(specifier, run, before, after, workspace_yaml) {
        Ok(InstallOutcome::Installed { receipt, .. }) => {
            // 护栏在回执判定之后：它要跑 remove/dump-config 子进程，判定核
            // 保持纯决策。护栏拦截（已回滚或预检失败）转 Err，audit 记失败
            let notices = match post_install_guard(app, specifier, &before_layer) {
                Ok(notices) => notices,
                Err(display) => {
                    append_audit(app, "add", specifier, Some(&display));
                    return Err(display);
                }
            };
            append_audit(app, "add", specifier, None);
            Ok(InstallOutcome::Installed { receipt, notices })
        }
        Ok(outcome @ InstallOutcome::NeedsApproval { .. }) => {
            // 台账记请求本身：拦截的原始 stderr 是可复述事实
            append_audit(app, "needs-approval", specifier, raw_failure.as_deref());
            Ok(outcome)
        }
        Err((raw, display)) => {
            append_audit(app, "add", specifier, Some(&raw));
            Err(display)
        }
    }
}

/// 安装输出行的 emit 闭包（run_plugin_cmd 回调）：逐行推 `market-install-log`
fn emit_install_line(
    app: &tauri::AppHandle,
    specifier: &str,
) -> impl Fn(&str) + Send + Sync + 'static {
    let app = app.clone();
    let specifier = specifier.to_string();
    move |line| {
        let _ = app.emit(
            "market-install-log",
            MarketInstallLogEvent {
                specifier: specifier.clone(),
                line: line.to_string(),
            },
        );
    }
}

/// 安装一键候选（specifier 为 npm 包名/版本或 github:owner/repo 形态，由
/// 目录 install 命令串解析而来）；长操作（pnpm 下载依赖），UI 显示 busy。
/// 成功返回落盘回执（无法唯一定位落点时为 None）；被 pnpm 拦截构建脚本时
/// 返回 NeedsApproval（被拦包名 + 待写 yaml 路径），由前端弹窗征得用户
/// 审批后再经 market_approve_builds 放行。写入审计台账
#[tauri::command]
pub async fn market_install(
    app: tauri::AppHandle,
    specifier: String,
) -> Result<InstallOutcome, String> {
    super::ipc_blocking(move || install_once(&app, &specifier)).await
}

/// 用户审批放行构建脚本后的执行体（market_approve_builds 的阻塞部分）：
/// 写 allowBuilds → 重跑安装 → 过安装护栏（与市场安装同一预检/回滚路径），
/// 成功带回执与护栏事实
fn approve_builds_once(
    app: &tauri::AppHandle,
    specifier: &str,
    packages: Vec<String>,
) -> Result<InstallOutcome, String> {
    let before_layer = capture_profile_layer();
    let yaml = workspace_yaml_path()?;
    merge_allow_builds(&yaml, &packages)?;
    append_audit(
        app,
        "approve-builds",
        &format!("{specifier} allow={}", packages.join(",")),
        None,
    );
    let before = installed_plugins()
        .ok()
        .map(|l| l.iter().map(|p| p.name.clone()).collect::<Vec<_>>());
    match run_plugin_cmd("add", specifier, emit_install_line(app, specifier)) {
        Ok(()) => {
            let notices = match post_install_guard(app, specifier, &before_layer) {
                Ok(notices) => notices,
                Err(display) => {
                    append_audit(app, "add", specifier, Some(&display));
                    return Err(display);
                }
            };
            append_audit(app, "add", specifier, None);
            let receipt = installed_plugins().ok().and_then(|list| {
                install_receipt(
                    specifier,
                    before,
                    &list,
                    Some(&specifier_to_catalog_name(specifier)),
                )
            });
            Ok(InstallOutcome::Installed { receipt, notices })
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
) -> Result<InstallOutcome, String> {
    if !valid_identifier(&specifier)
        || packages.is_empty()
        || packages.iter().any(|p| !valid_identifier(p))
    {
        return Err("Invalid plugin identifier".to_string());
    }
    super::ipc_blocking(move || approve_builds_once(&app, &specifier, packages)).await
}

/// 启停执行体（market_set_plugin_enabled 的阻塞部分）：判定核在前，写盘
/// 与审计在本壳。内容未变化（重复启停）免写盘、不记台账——空操作如实
/// 也记一行 noop（结果区分 changed/noop），台账才说得出「有人点了但
/// 无事发生」
fn set_plugin_enabled_once(
    app: &tauri::AppHandle,
    name: &str,
    enabled: bool,
) -> Result<InstalledPlugin, String> {
    let list = installed_plugins()?;
    if list.iter().all(|p| p.name != name) {
        return Err(keyf(
            "Plugin not installed: {name}",
            &[("name", name.to_string())],
        ));
    }
    if list.iter().any(|p| p.name == name && p.managed) {
        return Err(
            "Managed plugins are managed by the launcher's repair flow and cannot be toggled here."
                .to_string(),
        );
    }
    let patch_path = profile_patch_path()?;
    let raw = std::fs::read_to_string(&patch_path).unwrap_or_default();
    let entries = claimed_entry_rows(&web_profile_dir()?, name);
    match set_entries_enabled(&raw, &entries, enabled)? {
        Some(updated) => {
            std::fs::write(&patch_path, updated).map_err(|e| {
                crate::logging::warn("[market] 写入 cordis.patch.yml 失败", &e.to_string());
                keyf(
                    "Failed to write {path}: {error}",
                    &[
                        ("path", patch_path.display().to_string()),
                        ("error", e.to_string()),
                    ],
                )
            })?;
            append_audit(
                app,
                "set-enabled",
                &format!("{name} enabled={enabled} changed"),
                None,
            );
        }
        None => {
            append_audit(
                app,
                "set-enabled",
                &format!("{name} enabled={enabled} noop"),
                None,
            );
        }
    }
    // 回执 = 重读 profile 后的落盘事实，与已装列表同源
    installed_plugins()?
        .into_iter()
        .find(|p| p.name == name)
        .ok_or_else(|| {
            keyf(
                "Plugin not installed: {name}",
                &[("name", name.to_string())],
            )
        })
}

/// 翻转插件的下次启动启用状态：写 profile cordis.patch.yml 的 disabled 覆盖
/// 行（dsh loader 启动时认读），对运行中的 dsh 无影响。受管授权插件不经此
/// 通道（由修复/卸载流程管理）。写入审计台账
#[tauri::command]
pub async fn market_set_plugin_enabled(
    app: tauri::AppHandle,
    name: String,
    enabled: bool,
) -> Result<InstalledPlugin, String> {
    if !valid_identifier(&name) {
        return Err("Invalid plugin identifier".to_string());
    }
    super::ipc_blocking(move || set_plugin_enabled_once(&app, &name, enabled)).await
}

/// 移除后清理孤儿 disabled 覆盖行（只动本插件 claimed 入口的覆盖形态，尽力
/// 而为）：留着会在重装同 id 插件时继承停用态。与启停写入同一判定核——
/// 「启用」语义就是删除覆盖行
fn strip_disabled_override_rows(entries: &[(String, String)]) {
    let Ok(patch_path) = profile_patch_path() else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(&patch_path) else {
        return;
    };
    let Ok(Some(updated)) = set_entries_enabled(&raw, entries, true) else {
        return;
    };
    if let Err(e) = std::fs::write(&patch_path, updated) {
        crate::logging::warn("[market] 清理孤儿停用覆盖行失败", &e.to_string());
    }
}

/// 移除插件的执行体（market_remove 的阻塞部分）
fn remove_once(app: &tauri::AppHandle, name: &str) -> Result<(), String> {
    // claimed 入口在移除前读：移除后 node_modules 消失，无法再定位
    let claimed = web_profile_dir()
        .ok()
        .map(|dir| claimed_entry_rows(&dir, name));
    match run_plugin_cmd("remove", name, |_| {}) {
        Ok(()) => {
            if let Some(entries) = claimed {
                strip_disabled_override_rows(&entries);
            }
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
    super::ipc_blocking(move || remove_once(&app, &name)).await
}

/// 更新检测：npm 形态已装插件比对 registry latest（进入市场页自动跑，
/// 已安装页可手动重跑）。更新本身不在此处——前端正常以 name@latest 重装；
/// latest 落在 pnpm minimumReleaseAge 窗口内（latest_in_release_age_window）
/// 时先弹供应链确认框，用户确认后才钉版本 name@latestVersion 重装，
/// 与安装同一 dsh 闸门、审计与审批路径
#[tauri::command]
pub async fn market_check_updates() -> Result<Vec<PluginUpdateInfo>, String> {
    super::ipc_blocking(check_updates_once).await
}

// ============ 发现页兼容性（G4）============

/// 发现页兼容性单条。requiresDsh 是 npm manifest 事实（磁盘缓存 24h），
/// compatible 按「当前宿主 dsh 版本」现算——结论不缓存，宿主升级后自然翻转
/// （B 方同语义：缓存事实、不缓存结论）
#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct DiscoveryCompat {
    pub name: String,
    /// 目标包最新版 manifest 声明的 dsh 最低版本（未声明为 None）
    pub requires_dsh: Option<String>,
    /// None = 未声明（前端不隐藏，避免误判）；false = 确认不兼容；
    /// true = 兼容
    pub compatible: Option<bool>,
}

/// 兼容事实缓存：与目录快照同目录，schema 区分契约（旧格式按无缓存处理）
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct CompatCacheFile {
    pub(crate) schema: String,
    pub(crate) entries: BTreeMap<String, CompatCacheEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CompatCacheEntry {
    /// unix 秒
    pub(crate) checked_at: i64,
    pub(crate) requires_dsh: Option<String>,
}

pub(crate) const COMPAT_CACHE_SCHEMA: &str = "market-compat-cache/v1";
/// manifest 兼容事实的缓存时效（B 方同值 24h）
const COMPAT_CACHE_TTL_SECS: i64 = 24 * 60 * 60;
/// 批量拉取并发上限（B 方同值 8）
const COMPAT_CONCURRENCY: usize = 8;
/// 单包拉取失败后的进程内冷却（秒）。不落盘——镜像抖动不能变成一整天的
/// 误报「未声明」；进程重启即重试
const COMPAT_FAILURE_COOLDOWN_SECS: i64 = 5 * 60;
/// 缓存条目硬上限（写时按 checkedAt 淘汰最旧）
pub(crate) const COMPAT_CACHE_MAX_ENTRIES: usize = 5000;

fn compat_cache_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|p| p.join("market-compat-cache.json"))
        .map_err(|e| e.to_string())
}

pub(crate) fn load_compat_cache_file(path: &std::path::Path) -> Result<CompatCacheFile, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let file: CompatCacheFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if file.schema != COMPAT_CACHE_SCHEMA {
        return Err("unsupported compat cache schema".to_string());
    }
    Ok(file)
}

pub(crate) fn write_compat_cache_file(
    path: &std::path::Path,
    entries: &BTreeMap<String, CompatCacheEntry>,
) -> Result<(), String> {
    // 硬上限裁剪：按 checkedAt 保留最新的一批，防长年膨胀（B 方同值 5000）
    let mut newest: Vec<(&String, &CompatCacheEntry)> = entries.iter().collect();
    newest.sort_by_key(|e| std::cmp::Reverse(e.1.checked_at));
    newest.truncate(COMPAT_CACHE_MAX_ENTRIES);
    let file = CompatCacheFile {
        schema: COMPAT_CACHE_SCHEMA.to_string(),
        entries: newest
            .into_iter()
            .map(|(k, v)| (k.clone(), (*v).clone()))
            .collect(),
    };
    std::fs::write(
        path,
        serde_json::to_string(&file).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// 单包失败冷却的进程内记账：name → 冷却到点的 unix 秒。BTreeMap 以保
/// const 初始化（进程全局态，无需懒初始化依赖）
static COMPAT_FAILURES: Mutex<BTreeMap<String, i64>> = Mutex::new(BTreeMap::new());

/// 发现页兼容性批量查询（market_discovery_compat 的阻塞部分）：新鲜缓存直出，
/// 其余按并发上限拉 registry /latest（与更新检测同一端点，零额外契约），
/// 失败进进程内冷却、不落盘、不进响应（前端按未知处理，冷却后自然重试）。
/// compatible 由宿主 dsh 版本现算。恒 Ok：部分失败不放大为整体失败——
/// 兼容性是浏览辅助，不是闸门（安装/更新的门禁另有 fail-closed 判定）
fn discovery_compat_once(
    names: Vec<String>,
    cache_path: Option<&std::path::Path>,
) -> Vec<DiscoveryCompat> {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let mut cache: BTreeMap<String, CompatCacheEntry> = cache_path
        .and_then(|p| load_compat_cache_file(p).ok())
        .map(|f| f.entries)
        .unwrap_or_default();
    // 待拉取 = 非新鲜 ∧ 不在失败冷却；命中即跳过（冷却后下次调用自然重试）
    let to_fetch: Vec<String> = names
        .iter()
        .filter(|n| {
            !cache
                .get(*n)
                .is_some_and(|e| now - e.checked_at < COMPAT_CACHE_TTL_SECS)
                && !COMPAT_FAILURES
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(*n)
                    .is_some_and(|&until| now < until)
        })
        .cloned()
        .collect();
    if !to_fetch.is_empty() {
        let fetched: Mutex<Vec<(String, Option<String>)>> = Mutex::new(Vec::new());
        let queue: Mutex<Vec<String>> = Mutex::new(to_fetch);
        if let Ok(client) = update_http_client() {
            std::thread::scope(|s| {
                for _ in 0..COMPAT_CONCURRENCY.min(queue.lock().map(|q| q.len()).unwrap_or(0)) {
                    s.spawn(|| loop {
                        let name = match queue.lock().unwrap_or_else(|p| p.into_inner()).pop() {
                            Some(n) => n,
                            None => return,
                        };
                        match registry_latest_with(&client, &name) {
                            Ok(latest) => fetched
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .push((name, latest.requires_dsh)),
                            Err(_) => {
                                // 冷却记账：失败不进响应也不进磁盘缓存
                                COMPAT_FAILURES
                                    .lock()
                                    .unwrap_or_else(|p| p.into_inner())
                                    .insert(name, now + COMPAT_FAILURE_COOLDOWN_SECS);
                            }
                        }
                    });
                }
            });
        }
        for (name, requires_dsh) in fetched.lock().unwrap_or_else(|p| p.into_inner()).drain(..) {
            cache.insert(
                name,
                CompatCacheEntry {
                    checked_at: now,
                    requires_dsh,
                },
            );
        }
        if let Some(p) = cache_path {
            if let Err(e) = write_compat_cache_file(p, &cache) {
                crate::logging::warn("[market] 兼容缓存写入失败", &e);
            }
        }
    }
    // 结论现算：宿主版本一次探测，全部条目共用
    let host = super::components::dsh_version();
    names
        .into_iter()
        .filter(|n| safe_package_name(n))
        .filter_map(|name| {
            let entry = cache.get(&name)?;
            let compatible = entry
                .requires_dsh
                .as_ref()
                .map(|req| meets_dsh_minimum(host.as_deref(), req));
            Some(DiscoveryCompat {
                name,
                requires_dsh: entry.requires_dsh.clone(),
                compatible,
            })
        })
        .collect()
}

/// 发现页兼容性批量查询：目录本身不携带 npm manifest（upstream 契约），
/// 前端对可见卡片的 npm 形态包名按需分批查询。恒 Ok（部分失败以缺席表达）
#[tauri::command]
pub async fn market_discovery_compat(
    app: tauri::AppHandle,
    names: Vec<String>,
) -> Result<Vec<DiscoveryCompat>, String> {
    super::ipc_blocking(move || {
        let path = compat_cache_path(&app).ok();
        Ok(discovery_compat_once(names, path.as_deref()))
    })
    .await
}

// ============ 更新说明（G5）============

/// 更新说明数据源：awesome-dsh-plugin 目录侧每日探针产物（与目录同域同源，
/// A 的目录即从此域拉取；B 方同款数据），按仓库 URL 键控
const UPDATES_URL: &str = "https://awesome-dsh-plugin.com/updates.json";
/// 说明是每日产物，1h 复查有界约束陈旧度（B 方同值）
const UPDATES_CACHE_TTL_SECS: u64 = 60 * 60;
/// 提交列表上限（对话框滚动展示；release body 全量透传，裁剪在前端）
pub(crate) const RELEASE_COMMITS_LIMIT: usize = 20;

/// 更新说明载荷：release 为探针未覆盖时的 None（小插件的常态，前端如实
/// 显示"暂无说明"而非报错）
#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct PluginReleaseNotes {
    pub release: Option<ReleaseNotesInfo>,
    pub commits: Vec<CommitNoteInfo>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct ReleaseNotesInfo {
    pub tag: Option<String>,
    pub name: Option<String>,
    pub published_at: Option<String>,
    pub url: Option<String>,
    /// GitHub release 正文原样透传（markdown，前端滚动展示）
    pub body: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct CommitNoteInfo {
    pub sha: String,
    pub message: String,
    pub date: Option<String>,
}

/// 仓库标识（owner/repo）校验：两段、每段非空、字符受限、无路径穿越。
/// 唯一用途是拼接 `https://github.com/{repo}` 查询键——updates.json 的键即
/// 该形态，绝不允许把别的协议/主机拼进去
pub(crate) fn valid_repo_id(repo: &str) -> bool {
    let mut parts = repo.split('/');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(o), Some(n), None) if !o.is_empty() && !n.is_empty() && !repo.contains("..")
    ) && repo
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-'))
}

fn updates_cache_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|p| p.join("market-updates-cache.json"))
        .map_err(|e| e.to_string())
}

/// 缓存新鲜度判定（纯函数，mtime 即时间戳——缓存文件就是 updates.json 原文，
/// 不另设 meta 侧车）。过期/缺失/读失败一律 None
pub(crate) fn fresh_updates_cache(
    path: &std::path::Path,
    now: std::time::SystemTime,
) -> Option<String> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    if modified.checked_add(Duration::from_secs(UPDATES_CACHE_TTL_SECS))? <= now {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// 更新说明查询（market_release_notes 的阻塞部分）：整包 JSON 落盘缓存，
/// 网络失败回退陈旧缓存——显示性数据，宁可旧不可空；无缓存且网络失败返回
/// None（前端如实显示"暂无说明"，不报错）
pub(crate) fn release_notes_once(
    repo: &str,
    cache_path: Option<&std::path::Path>,
) -> Option<PluginReleaseNotes> {
    let body = match cache_path.and_then(|p| fresh_updates_cache(p, std::time::SystemTime::now())) {
        Some(body) => body,
        None => {
            let resp = reqwest::blocking::Client::builder()
                .timeout(MARKET_FETCH_TIMEOUT)
                .user_agent(concat!("dsh-pro-max/", env!("CARGO_PKG_VERSION")))
                .build()
                .ok()?
                .get(UPDATES_URL)
                .send()
                .ok()?;
            let body = if resp.status().is_success() {
                resp.text().ok()?
            } else {
                // 非成功响应同样回退陈旧缓存
                cache_path.and_then(|p| std::fs::read_to_string(p).ok())?
            };
            if let Some(p) = cache_path {
                if let Err(e) = std::fs::write(p, &body) {
                    crate::logging::warn("[market] 更新说明缓存写入失败", &e.to_string());
                }
            }
            body
        }
    };
    let value: serde_json::Value = serde_json::from_str(&body).ok()?;
    let entry = value
        .get("updates")?
        .get(format!("https://github.com/{repo}"))?;
    let release = entry
        .get("release")
        .filter(|v| v.is_object())
        .map(|r| ReleaseNotesInfo {
            tag: r
                .get("tag")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            name: r
                .get("name")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            published_at: r
                .get("publishedAt")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            url: r
                .get("url")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            body: r
                .get("body")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
        });
    let commits = entry
        .get("commits")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let sha = c.get("sha").and_then(serde_json::Value::as_str)?;
                    Some(CommitNoteInfo {
                        sha: sha.to_string(),
                        message: c
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        date: c
                            .get("date")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string),
                    })
                })
                .take(RELEASE_COMMITS_LIMIT)
                .collect()
        })
        .unwrap_or_default();
    Some(PluginReleaseNotes { release, commits })
}

/// 更新说明查询：repo 来自前端（github: spec 或目录条目 url 派生，见
/// repoIdFromCatalogUrl），此处只信白名单形态。探针未覆盖 → Ok(None)
#[tauri::command]
pub async fn market_release_notes(
    app: tauri::AppHandle,
    repo: String,
) -> Result<Option<PluginReleaseNotes>, String> {
    if !valid_repo_id(&repo) {
        return Err("Invalid repository identifier".to_string());
    }
    super::ipc_blocking(move || {
        let path = updates_cache_path(&app).ok();
        Ok(release_notes_once(&repo, path.as_deref()))
    })
    .await
}

// ============ 诊断（G7）============

/// dump-config 组合输出的单条 loader 条目。层来自 `# == <bundle>` 注释行——
/// dsh 自己输出的组合事实，诊断只读输出、不复刻组合语义（随上游升级零漂移）
#[derive(Debug, PartialEq)]
pub(crate) struct DumpEntry {
    pub id: String,
    pub name: Option<String>,
    pub disabled: bool,
    pub layer: String,
}

/// dump-config stdout → 条目列表：`# == X` 注释切层，`- id: Y` 开新行，
/// 后续两空格字段行（name/disabled）归当前行。只认这两类行结构，config
/// 等其余字段不进诊断事实；畸形行（无 id）跳过
pub(crate) fn parse_dump_entries(stdout: &str) -> Vec<DumpEntry> {
    let mut entries: Vec<DumpEntry> = Vec::new();
    let mut layer = String::new();
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("# ==") {
            layer = rest.trim().to_string();
            continue;
        }
        if let Some(rest) = line.strip_prefix("- id:") {
            entries.push(DumpEntry {
                id: unquote(rest),
                name: None,
                disabled: false,
                layer: layer.clone(),
            });
            continue;
        }
        let Some(entry) = entries.last_mut() else {
            continue;
        };
        if let Some(rest) = line.strip_prefix("  name:") {
            entry.name = Some(unquote(rest));
        } else if let Some(rest) = line.strip_prefix("  disabled:") {
            entry.disabled = unquote(rest) == "true";
        }
    }
    entries
}

/// dump-config stderr → 孤儿 patch 行引用的入口 id：dsh loader 的原话
/// `patch: entry "X" not found`（本机即有真实案例）。诊断只采集不判词，
/// 修复去向（删覆盖行）由前端词典给出
pub(crate) fn parse_orphan_warnings(stderr: &str) -> Vec<String> {
    const MARKER: &str = "patch: entry \"";
    let mut out: Vec<String> = Vec::new();
    for line in stderr.lines() {
        let Some(i) = line.find(MARKER) else { continue };
        let rest = &line[i + MARKER.len()..];
        let Some(j) = rest.find("\" not found") else {
            continue;
        };
        let id = rest[..j].to_string();
        if !id.is_empty() && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// 诊断快照（dump-config 一次运行的组合事实）。结构化载荷：语言由前端
/// 词典组装，不随 Rust 字符串漂移
#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct MarketDiagnostics {
    pub entries: usize,
    /// disabled: true 的条目数（启停覆盖行生效中）
    pub disabled: usize,
    /// 重复 loader 入口 id（下次启动必挂的组合病；disabled 条目不豁免——
    /// loader 拒绝的是重复 id 本身，B 方同语义）
    pub duplicates: Vec<DiagnosticDuplicate>,
    /// 孤儿 patch 行引用的入口 id（dsh 启动时警告并跳过）
    pub orphans: Vec<String>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct DiagnosticDuplicate {
    pub id: String,
    pub count: usize,
    /// 出现该 id 的层（去重，保序）
    pub layers: Vec<String>,
}

/// 诊断判定核（纯函数，dump 输出 → 问题清单）：重复 id 聚类按首现 id 排序，
/// 层去重保序
pub(crate) fn diagnostics_from_dump(stdout: &str, stderr: &str) -> MarketDiagnostics {
    let entries = parse_dump_entries(stdout);
    let disabled = entries.iter().filter(|e| e.disabled).count();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut layers: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for e in &entries {
        *counts.entry(e.id.clone()).or_default() += 1;
        let slot = layers.entry(e.id.clone()).or_default();
        if !slot.contains(&e.layer) {
            slot.push(e.layer.clone());
        }
    }
    let duplicates = counts
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(id, count)| DiagnosticDuplicate {
            layers: layers.remove(&id).unwrap_or_default(),
            id,
            count,
        })
        .collect();
    MarketDiagnostics {
        entries: entries.len(),
        disabled,
        duplicates,
        orphans: parse_orphan_warnings(stderr),
    }
}

/// 诊断执行体（market_diagnostics 的阻塞部分）：dump-config 失败即 Err——
/// 组合跑不起来正是诊断要暴露的事实，错误原文（dsh 的失败输出）原样上报
fn diagnostics_once() -> Result<MarketDiagnostics, String> {
    let (stdout, stderr) = dump_config_raw()?;
    Ok(diagnostics_from_dump(&stdout, &stderr))
}

/// 深度诊断：组合层事实从 dsh 自己的 `--dump-config` 输出读取（重复入口
/// id / 孤儿 patch 行 / 禁用计数），零组合语义复刻。90s 硬超时（D1 同款）
#[tauri::command]
pub async fn market_diagnostics() -> Result<MarketDiagnostics, String> {
    super::ipc_blocking(diagnostics_once).await
}
