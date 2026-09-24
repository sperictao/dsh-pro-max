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
/// 桥接在应用进程内应答，本机来回；给足它跑一个服务调用，又不至于挂住界面
const BRIDGE_TIMEOUT_SECS: u64 = 30;

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

/// 探测桥接状态。只看本机：端口探测 + 一次本机回环 ping，不出公网。
fn bridge_status_once() -> Result<BridgeStatus, Message> {
    let (state, protocol) = if !super::process::port_listening(DESKTOP_PORT) {
        // 应用没跑就无从判断桥接在不在，不猜
        (BridgeState::AppUnavailable, None)
    } else {
        match ping_protocol() {
            // 端口活着但这个端点不存在：应用在跑、桥接没装
            None => (BridgeState::NotInstalled, None),
            Some(protocol) if protocol != BRIDGE_PROTOCOL => (BridgeState::Incompatible, Some(protocol)),
            Some(protocol) => (BridgeState::Connected, Some(protocol)),
        }
    };
    Ok(BridgeStatus {
        state,
        protocol,
        expected_protocol: BRIDGE_PROTOCOL,
        install_url: BRIDGE_INSTALL_URL.to_string(),
    })
}

/// 桥接的 `GET /ping`：免 token（它不改任何东西），只自报身份与协议代次
#[derive(Deserialize)]
struct Ping {
    bridge: String,
    protocol: u32,
}

fn ping_protocol() -> Option<u32> {
    let ping: Ping = request::<Ping>("GET", "/ping", None).ok()??;
    (ping.bridge == BRIDGE_IDENTITY).then_some(ping.protocol)
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
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(BRIDGE_TIMEOUT_SECS))
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
}
