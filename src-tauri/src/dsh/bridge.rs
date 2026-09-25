//! 通往官方桌面应用的桥接通道：与用户装在应用里的 `dsh-pro-max-bridge` 插件通信。
//!
//! 为什么不直写 `~/.dsh/profiles/desktop`：`desktop` 运行档由应用独占，直写会造出
//! 第二份插件安装实现，且安装护栏最关键的 `--dump-config` 组合预检对 desktop 物理不可
//! 执行。桥接插件调用应用**自己的** Plugin Manager / Config Editor，是同一个机制。见
//! ADR 0011。
//!
//! 本模块只管通道：状态探测与请求收发。桌面形态的外部能力（检测/打开/退出/更新）在
//! `desktop.rs`，它们不依赖桥接。

use serde::{Deserialize, Serialize};

use super::DESKTOP_PORT;
use crate::i18n::Message;

/// 桥接插件注册的路由前缀（`/api` 之外，不参与连接插件的 capability 裁决）
const BRIDGE_PREFIX: &str = "/dsh-pro-max-bridge";
/// 本应用期望的线协议代次，与桥接插件的 `PROTOCOL` 对应。
/// 桥接改了路由形状或字段语义时会 +1，那时这里同步跟上并按需改调用方。
const BRIDGE_PROTOCOL: u32 = 1;
/// 桥接插件的一次性安装地址。资产名不含版本号、走 `releases/latest`，所以发版不会
/// 让它失效——用户升级桥接粘的是同一条。
pub(crate) const BRIDGE_INSTALL_URL: &str =
    "https://github.com/sperictao/dsh-pro-max-bridge/releases/latest/download/dsh-pro-max-bridge.tgz";
/// 桥接应答里自报的身份，用来确认这个端点确实是我们的桥接而不是别的服务
const BRIDGE_IDENTITY: &str = "dsh-pro-max-bridge";
/// 读（GET）走本机回环，秒级就够。
const BRIDGE_READ_TIMEOUT_SECS: u64 = 30;
/// 写（POST）可能真的跑 pnpm：应用自己的默认是锁等待 2 分钟（lockWaitMs）、pnpm 静默
/// 10 分钟才终止（idleTimeoutMs），所以客户端超时必须比这两个都宽——否则会在应用仍在
/// 安装时报一个假失败，用户重试还可能撞上并发安装。
const BRIDGE_WRITE_TIMEOUT_SECS: u64 = 900;

/// 桥接的可用状态。界面按这四态给不同去向，不显示「失败」了事。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/shared/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum BridgeState {
    /// 桌面应用没在运行（或没装）：此时无从判断桥接，先让用户把应用打开
    AppUnavailable,
    /// 应用在跑，但那个端点不存在：桥接插件没装
    NotInstalled,
    /// 装了，但协议代次与本次期望不符：提示升级桥接
    Incompatible,
    /// 装了、代次也对，但插件自己没能就绪（没能建立 token）：能力路由一条都不注册，
    /// 报「未装」会把人引向重装，而重装解决不了
    NotReady,
    /// 可用
    Connected,
}

#[derive(Debug, Serialize, Clone, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct BridgeStatus {
    pub state: BridgeState,
    /// 桥接自报的协议代次（只有 ping 成功才拿得到）
    pub protocol: Option<u32>,
    /// 本应用期望的代次，便于界面直接说出「期望几、拿到几」
    pub expected_protocol: u32,
    /// 一次性安装步骤要粘进应用 Plugins 页的地址
    pub install_url: String,
}

#[tauri::command]
pub async fn desktop_bridge_status() -> Result<BridgeStatus, Message> {
    super::ipc_blocking(bridge_status_once).await
}

// ============ 桌面档的插件与配置 ============
//
// 以下是上游 PluginInfo / BundleInfo / ChangeResult 的 UI 子集，不是全量复刻：不认识
// 的字段 serde 直接忽略，上游加字段不会让这里崩；这里只取界面要显示与要寻址的部分。

/// 桌面档的一个插件行
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct PluginRow {
    /// 翻转启用状态要回传的标识（上游的品牌类型，必须原样带回）
    pub entry_id: String,
    pub module_name: String,
    pub enabled: bool,
    /// 有值才可经 profile 补丁翻转；否则 read_only_reason 说明为什么不行
    pub patch_id: Option<String>,
    pub read_only_reason: Option<String>,
}

/// 桌面档的一个 bundle（带 patch 层的插件包）
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct BundleRow {
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub enabled: bool,
    pub removable: bool,
    pub read_only_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct DesktopPlugins {
    pub plugins: Vec<PluginRow>,
    pub bundles: Vec<BundleRow>,
}

/// 一次管理操作的结果。上游把管理失败**折叠进返回值**而不是抛出，所以判断成败看
/// `application`，不是 HTTP 状态码也不是有没有 Err
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct ChangeOutcome {
    /// applied / restart-required / overridden / failed / cancelled
    pub application: String,
    /// 上游的错误码；failed 时才有
    pub error_code: Option<String>,
    pub error_diagnostic: Option<String>,
    /// 需要用户显式放行的构建脚本；非空时这次安装没完成，要拿它原样再调一次
    pub pending_builds: Vec<String>,
}

/// 活动 profile 里的一行配置
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct ConfigRow {
    /// 寻址用：编辑时原样回传
    pub id: String,
    pub name: String,
    /// 这一行现在生效的配置（该行没写 config 时为 None）。
    /// ts(type) 会整个覆盖 Option，所以 `| null` 要自己写上，否则生成出来的类型会撒谎
    #[ts(type = "import(\"./serde_json/JsonValue\").JsonValue | null")]
    pub current: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn desktop_bridge_plugins() -> Result<DesktopPlugins, Message> {
    super::ipc_blocking(plugins_once).await
}

#[tauri::command]
pub async fn desktop_bridge_install(
    spec: String,
    approved_builds: Option<Vec<String>>,
) -> Result<ChangeOutcome, Message> {
    super::ipc_blocking(move || {
        let mut body = serde_json::json!({ "spec": spec });
        // 只在有值时才带：上游按「给了就得是当前仍待批的包」校验，空数组会被拒
        if let Some(builds) = approved_builds {
            body["approvedBuilds"] = serde_json::json!(builds);
        }
        change_once("/plugins/install", body)
    })
    .await
}

#[tauri::command]
pub async fn desktop_bridge_remove(name: String) -> Result<ChangeOutcome, Message> {
    super::ipc_blocking(move || change_once("/plugins/remove", serde_json::json!({ "name": name }))).await
}

/// 翻转启用状态：插件行按 entryId、bundle 按包名，上游是两套开关所以这里也分两个参数
#[tauri::command]
pub async fn desktop_bridge_set_enabled(
    plugin_id: Option<String>,
    bundle_name: Option<String>,
    enabled: bool,
) -> Result<ChangeOutcome, Message> {
    super::ipc_blocking(move || change_once("/plugins/enable", enable_body(plugin_id, bundle_name, enabled)?)).await
}

#[tauri::command]
pub async fn desktop_bridge_config() -> Result<Vec<ConfigRow>, Message> {
    super::ipc_blocking(config_once).await
}

/// 写入一行的绝对 config。整份替换（不是合并）：上游的 edit 收到的就是下一份原始 config
#[tauri::command]
pub async fn desktop_bridge_config_edit(id: String, config: serde_json::Value) -> Result<(), Message> {
    super::ipc_blocking(move || {
        // 经 required_with 而不是裸 request：后者把「桥接不在」（连不上 / 404）返回成
        // Ok(None)，那是「这一步还没做」而不是成功——折叠掉它会让写失败静默报成功
        required_with::<serde_json::Value>(
            "/config/edit",
            serde_json::json!({ "id": id, "config": config }),
        )
        .map(|_| ())
    })
    .await
}

/// 翻转启用状态的请求体。插件行按 entryId、bundle 按包名——上游是两套开关，
/// 所以两者必须恰好给一个，两个都给或都不给都是调用方的错，不猜它想改哪个
fn enable_body(
    plugin_id: Option<String>,
    bundle_name: Option<String>,
    enabled: bool,
) -> Result<serde_json::Value, Message> {
    match (plugin_id, bundle_name) {
        (Some(id), None) => Ok(serde_json::json!({ "pluginId": id, "enabled": enabled })),
        (None, Some(name)) => Ok(serde_json::json!({ "bundleName": name, "enabled": enabled })),
        _ => Err(Message::key("Exactly one of pluginId or bundleName must be given")),
    }
}

fn plugins_once() -> Result<DesktopPlugins, Message> {
    let raw: UpstreamPlugins = required("/plugins")?;
    Ok(DesktopPlugins {
        plugins: raw
            .plugins
            .into_iter()
            .map(|row| PluginRow {
                entry_id: row.entry_id,
                module_name: row.module_name,
                enabled: row.enabled,
                patch_id: row.patch_id,
                read_only_reason: row.read_only_reason,
            })
            .collect(),
        bundles: raw
            .bundles
            .into_iter()
            .map(|row| BundleRow {
                name: row.name,
                version: row.version,
                description: row.description,
                enabled: row.enabled,
                removable: row.removable,
                read_only_reason: row.read_only_reason,
            })
            .collect(),
    })
}

fn config_once() -> Result<Vec<ConfigRow>, Message> {
    let rows: Vec<UpstreamConfigRow> = required("/config")?;
    Ok(rows
        .into_iter()
        .map(|row| ConfigRow {
            id: row.id,
            name: row.name,
            current: row.current,
        })
        .collect())
}

fn change_once(path: &str, body: serde_json::Value) -> Result<ChangeOutcome, Message> {
    let raw: UpstreamChange = required_with(path, body)?;
    let pending = raw.pending_builds.unwrap_or_default();
    Ok(ChangeOutcome {
        application: raw.application,
        error_code: raw.error.as_ref().map(|e| e.code.clone()),
        error_diagnostic: raw.error.and_then(|e| e.diagnostic),
        pending_builds: pending,
    })
}

/// 发请求并要求桥接确实给了 data：桥接不在或没装都是错误，管理操作没有「静默成功」这种结果
fn required<T: for<'de> Deserialize<'de>>(path: &str) -> Result<T, Message> {
    required_with(path, serde_json::Value::Null)
}

fn required_with<T: for<'de> Deserialize<'de>>(path: &str, body: serde_json::Value) -> Result<T, Message> {
    let method = if body.is_null() { "GET" } else { "POST" };
    let body = if body.is_null() { None } else { Some(body) };
    request::<T>(method, path, body)?
        .ok_or_else(|| Message::key("The bridge plugin is not running in DeepSeek Harness"))
}

/// 上游应答的字段名一律 camelCase；不认识的字段忽略，上游加字段不会让这里崩
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamPlugins {
    plugins: Vec<UpstreamPlugin>,
    bundles: Vec<UpstreamBundle>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamPlugin {
    entry_id: String,
    module_name: String,
    enabled: bool,
    patch_id: Option<String>,
    read_only_reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamBundle {
    name: String,
    version: Option<String>,
    description: Option<String>,
    enabled: bool,
    removable: bool,
    read_only_reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamChange {
    application: String,
    error: Option<UpstreamError>,
    pending_builds: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamError {
    code: String,
    diagnostic: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamConfigRow {
    id: String,
    name: String,
    current: Option<serde_json::Value>,
}


/// 探测桥接状态。只看本机：端口探测 + 一次本机回环 ping，不出公网。
fn bridge_status_once() -> Result<BridgeStatus, Message> {
    let (state, protocol) = if !super::process::port_listening(DESKTOP_PORT) {
        // 应用没跑就无从判断桥接在不在，不猜
        (BridgeState::AppUnavailable, None)
    } else {
        match ping() {
            // 端口活着但这个端点不存在：应用在跑、桥接没装
            None => (BridgeState::NotInstalled, None),
            // 代次先判：重装地址对代次不符和没就绪两种都是对的下一步
            Some((protocol, _)) if protocol != BRIDGE_PROTOCOL => (BridgeState::Incompatible, Some(protocol)),
            Some((protocol, false)) => (BridgeState::NotReady, Some(protocol)),
            Some((protocol, true)) => (BridgeState::Connected, Some(protocol)),
        }
    };
    Ok(BridgeStatus {
        state,
        protocol,
        expected_protocol: BRIDGE_PROTOCOL,
        install_url: BRIDGE_INSTALL_URL.to_string(),
    })
}

/// 桥接的 `GET /ping`：免 token（它不改任何东西），自报身份、协议代次与是否就绪
#[derive(Deserialize)]
struct Ping {
    bridge: String,
    protocol: u32,
    /// 插件自报就绪。缺省按就绪处理：不报这个字段的桥接版本一定有可用的能力路由
    #[serde(default = "ping_ready_default")]
    ready: bool,
}

fn ping_ready_default() -> bool {
    true
}

fn ping() -> Option<(u32, bool)> {
    let ping: Ping = request::<Ping>("GET", "/ping", None).ok()??;
    (ping.bridge == BRIDGE_IDENTITY).then_some((ping.protocol, ping.ready))
}

/// 桥接的统一应答外壳：`{ok, data}` / `{ok: false, error}`。
/// 业务结果在 data 里，HTTP 状态码只表达传输层语义——所以失败原因要读 error 而不是状态码
#[derive(Deserialize)]
struct Envelope<T> {
    ok: bool,
    data: Option<T>,
    error: Option<String>,
}

/// 发一次桥接请求并取出 data。
/// - `Ok(None)`：桥接不在（端点不存在）——调用方按「未安装」处理
/// - `Ok(Some(_))`：成功
/// - `Err(_)`：桥接在但拒绝了，或本机请求本身失败
fn request<T: for<'de> Deserialize<'de>>(
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<Option<T>, Message> {
    let url = format!("http://127.0.0.1:{DESKTOP_PORT}{BRIDGE_PREFIX}{path}");
    let timeout = if method == "GET" { BRIDGE_READ_TIMEOUT_SECS } else { BRIDGE_WRITE_TIMEOUT_SECS };
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout))
        .user_agent(concat!("dsh-pro-max/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| Message::key(e.to_string()))?;

    let mut req = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| Message::key(e.to_string()))?,
        &url,
    );
    // ping 免 token，其余一律带；不带就是 401，那是「桥接在但我们没被授权」
    if path != "/ping" {
        req = req.bearer_auth(read_token()?);
    }
    if let Some(body) = body {
        req = req.json(&body);
    }

    let resp = match req.send() {
        Ok(resp) => resp,
        // 连不上即视为桥接缺席：应用可能刚退出，这不是错误
        Err(_) => return Ok(None),
    };
    // 端点不存在 = 桥接没装。这是「还没做那一步」，不是失败
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let envelope: Envelope<T> = resp.json().map_err(|e| Message::key(e.to_string()))?;
    match (envelope.ok, envelope.data) {
        (true, Some(data)) => Ok(Some(data)),
        // ok 但没有 data：ping 之外的端点不该这样，按桥接版本不符处理
        (true, None) => Err(Message::key("Bridge returned no data")),
        (false, _) => Err(Message::key(
            envelope.error.unwrap_or_else(|| "Bridge rejected the request".to_string()),
        )),
    }
}

/// 桥接写入的 token（0600）。它是纵深防御而非安全边界——同用户的本地进程本就能直写
/// 那个 profile；它挡的是浏览器页面之类对回环端口的越权调用
fn read_token() -> Result<String, Message> {
    let path = crate::config::state_dir()?.join("bridge-token");
    let raw = std::fs::read_to_string(&path).map_err(|_| {
        Message::key("The bridge token is missing; reinstall the bridge plugin in DeepSeek Harness")
    })?;
    let token = raw.trim().to_string();
    if token.is_empty() {
        return Err(Message::key(
            "The bridge token is missing; reinstall the bridge plugin in DeepSeek Harness",
        ));
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_url_is_versionless_so_releases_do_not_move_it() {
        // 地址是让人手动粘进应用的一次性步骤，带版本号就意味着每次发版都要重粘
        assert!(BRIDGE_INSTALL_URL.contains("/releases/latest/download/"));
        assert!(BRIDGE_INSTALL_URL.ends_with("dsh-pro-max-bridge.tgz"));
    }

    /// 写操作的客户端超时必须比应用自己的预算更宽：锁等待 2 分钟 + pnpm 静默 10 分钟才
    /// 终止（应用内嵌 PluginManager 的 lockWaitMs / idleTimeoutMs 默认值）。窄了就会在应用
    /// 仍在安装时报假失败，用户重试还可能撞上并发安装。
    #[test]
    fn write_timeout_covers_the_apps_own_pnpm_budgets() {
        const LOCK_WAIT_SECS: u64 = 120;
        const PNPM_IDLE_SECS: u64 = 600;
        assert!(BRIDGE_WRITE_TIMEOUT_SECS > LOCK_WAIT_SECS + PNPM_IDLE_SECS);
        assert!(BRIDGE_READ_TIMEOUT_SECS < BRIDGE_WRITE_TIMEOUT_SECS);
    }

    #[test]
    fn bridge_prefix_stays_outside_the_api_prefix() {
        // /api 由替换连接插件按 capability 裁决；桥接自走 token，不能混进去
        assert!(!BRIDGE_PREFIX.starts_with("/api"));
    }

    #[test]
    fn envelope_requires_the_ok_flag() {
        // 业务结果在 data 里，失败原因是 error 文本——这条外壳是两侧唯一的约定
        let ok: Envelope<Ping> = serde_json::from_str(
            r#"{"ok":true,"data":{"bridge":"dsh-pro-max-bridge","protocol":1}}"#,
        )
        .unwrap();
        assert!(ok.ok);
        assert_eq!(ok.data.unwrap().protocol, 1);

        let bad: Envelope<Ping> = serde_json::from_str(r#"{"ok":false,"error":"unauthorized"}"#).unwrap();
        assert!(!bad.ok);
        assert_eq!(bad.error.as_deref(), Some("unauthorized"));
        assert!(bad.data.is_none());
    }

    /// 真机探针：应用在跑但桥接没装时必须报 NotInstalled 而不是失败
    #[test]
    #[ignore]
    fn probes_the_running_app() {
        let status = bridge_status_once().unwrap();
        println!("state={:?} protocol={:?}", status.state, status.protocol);
        assert_eq!(status.expected_protocol, BRIDGE_PROTOCOL);
    }

    /// 真机全通道探针：桥接装上后跑这一条，就能把整条通道验完而不必点界面。
    ///
    /// 桥接连着时拉一次插件列表与运行档配置——那正是我按上游 API 目录的声明写的
    /// `Upstream*` 结构要吃的真实 JSON。字段名若与声明不符，这里当场断，而不是等用户
    /// 点开界面才发现列表是空的。
    ///
    /// 用法：先在官方桌面应用的 Plugins 页装一次桥接
    /// （地址见 BRIDGE_INSTALL_URL），再跑
    /// `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture bridges_the_live_channel`
    #[test]
    #[ignore]
    fn bridges_the_live_channel() {
        let status = bridge_status_once().unwrap();
        println!("state={:?} protocol={:?}", status.state, status.protocol);
        if status.state != BridgeState::Connected {
            // 桥接没装时不假失败：这条探针的前提未满足，说清楚就够
            println!("跳过：桥接当前不可用（{}）", status.install_url);
            return;
        }

        let plugins = plugins_once().unwrap();
        println!(
            "插件 {} 行、bundle {} 行",
            plugins.plugins.len(),
            plugins.bundles.len()
        );
        for row in plugins.plugins.iter().take(5) {
            println!(
                "  插件 {} enabled={} 可改={}",
                row.module_name,
                row.enabled,
                row.patch_id.is_some()
            );
        }
        for row in plugins.bundles.iter().take(5) {
            println!("  包 {} v{:?} 可移除={}", row.name, row.version, row.removable);
        }
        // 桥接自己必须在这个列表里，否则「装上了」这件事本身就是假的
        assert!(
            plugins.bundles.iter().any(|row| row.name.contains("dsh-pro-max-bridge")),
            "桥接不在运行档的 bundle 列表里"
        );

        let config = config_once().unwrap();
        println!("运行档配置 {} 行", config.len());
        for row in config.iter().take(8) {
            println!("  {} <{}>", row.id, row.name);
        }
    }

    // —— 上游字段名核对 ——
    // 下面的样本按桌面应用内嵌 API 目录（typert 契约）里 PluginInventoryEntry /
    // BundleInfo / ChangeResult / PluginInfo 的声明逐字构造。这些测试的意义是：上游改
    // 字段名时在这里就断，而不是等到真机上一个字段静默变 None。

    #[test]
    fn maps_a_plugin_row_that_can_be_toggled() {
        let raw: UpstreamPlugins = serde_json::from_str(
            r#"{
                "plugins": [{
                    "entryId": "e1", "moduleName": "pkg", "enabled": true,
                    "fiberPhase": "active", "patchId": "row-1"
                }],
                "bundles": []
            }"#,
        )
        .unwrap();
        let row = &raw.plugins[0];
        assert_eq!(row.entry_id, "e1");
        assert_eq!(row.module_name, "pkg");
        assert!(row.enabled);
        assert_eq!(row.patch_id.as_deref(), Some("row-1"));
        assert!(row.read_only_reason.is_none());
    }

    /// 不可改的行是 patchId 缺席 + readOnlyReason 在场（上游的联合类型，另一支没有这俩字段）
    #[test]
    fn maps_a_read_only_plugin_row() {
        let raw: UpstreamPlugins = serde_json::from_str(
            r#"{
                "plugins": [{"entryId": "e2", "moduleName": "mgr", "enabled": true,
                             "fiberPhase": null, "readOnlyReason": "management-required"}],
                "bundles": []
            }"#,
        )
        .unwrap();
        assert!(raw.plugins[0].patch_id.is_none());
        assert_eq!(
            raw.plugins[0].read_only_reason.as_deref(),
            Some("management-required")
        );
    }

    #[test]
    fn maps_a_bundle_row() {
        let raw: UpstreamPlugins = serde_json::from_str(
            r#"{
                "plugins": [],
                "bundles": [{
                    "name": "@dsh-external/dsh-pro-max-bridge", "version": "0.1.0",
                    "description": "bridge", "enabled": true, "installed": true,
                    "optional": false, "removable": true, "rows": [], "overrides": []
                }]
            }"#,
        )
        .unwrap();
        let row = &raw.bundles[0];
        assert_eq!(row.name, "@dsh-external/dsh-pro-max-bridge");
        assert!(row.removable && row.enabled);
        assert_eq!(row.description.as_deref(), Some("bridge"));
    }

    /// 上游会省略可选字段而不是给 null；只认 camelCase，snake_case 不该碰巧命中
    #[test]
    fn tolerates_omitted_optional_fields_and_rejects_snake_case() {
        let raw: UpstreamPlugins =
            serde_json::from_str(r#"{"plugins":[{"entryId":"e","moduleName":"m","enabled":false}],"bundles":[]}"#)
                .unwrap();
        assert_eq!(raw.plugins[0].entry_id, "e");

        // 字段名写错必须报错，不能静默变 None——这正是这组测试要挡的
        assert!(
            serde_json::from_str::<UpstreamPlugins>(
                r#"{"plugins":[{"entry_id":"e","module_name":"m","enabled":false}],"bundles":[]}"#
            )
            .is_err()
        );
    }

    #[test]
    fn maps_a_failed_change_with_the_upstream_error_code() {
        let raw: UpstreamChange = serde_json::from_str(
            r#"{
                "changed": false, "application": "failed", "stage": "remove", "target": "b",
                "error": {"code": "not-removable", "diagnostic": "supplied by dsh"}
            }"#,
        )
        .unwrap();
        assert_eq!(raw.application, "failed");
        assert_eq!(raw.error.as_ref().unwrap().code, "not-removable");
        assert_eq!(
            raw.error.as_ref().unwrap().diagnostic.as_deref(),
            Some("supplied by dsh")
        );
        assert!(raw.pending_builds.is_none());
    }

    /// 待批构建脚本：非空表示这次安装没完成，要拿它原样再调一次
    #[test]
    fn maps_pending_builds_of_an_incomplete_install() {
        let raw: UpstreamChange = serde_json::from_str(
            r#"{
                "changed": false, "application": "failed", "stage": "install",
                "target": "spec", "pendingBuilds": ["pkg-a", "pkg-b"],
                "warnings": ["inactive entry left as is"]
            }"#,
        )
        .unwrap();
        assert_eq!(
            raw.pending_builds.as_deref(),
            Some(&["pkg-a".to_string(), "pkg-b".to_string()][..])
        );
    }

    #[test]
    fn enable_targets_exactly_one_of_the_two_switches() {
        let plugin = enable_body(Some("e1".into()), None, false).unwrap();
        assert_eq!(plugin["pluginId"], "e1");
        assert_eq!(plugin["enabled"], false);

        let bundle = enable_body(None, Some("b".into()), true).unwrap();
        assert_eq!(bundle["bundleName"], "b");
        assert_eq!(bundle["enabled"], true);

        // 两个都给或都不给：调用方的错，不猜它想改哪个
        assert!(enable_body(Some("e".into()), Some("b".into()), true).is_err());
        assert!(enable_body(None, None, true).is_err());
    }
}
