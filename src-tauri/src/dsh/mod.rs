//！共享常量与 IPC 数据结构在本文件；子模块条目统一 pub(crate)，跨模块引用一律显式 use super:: 点名。
//!
//! 远程访问架构：
//! ```text
//! 远程设备 (Tailscale 内网)
//!   ▼
//! https://<hostname>.ts.net   (tailscale serve, HTTPS 443)
//!   ▼
//! 127.0.0.1:3899              (dsh web + auth-capable Connection)
//! ```
//!
//! 安全边界：dsh 显式绑定 loopback；Tailscale Serve 注入调用者身份；
//! `dsh-client-connection-authz` 在 HTTP/WebSocket 入口消费
//! `dsh-auth-tailscale` 提供的 authorizer。Launcher 不改写 Host/Origin，也不伪造
//! loopback 身份。远程特权 API 需要调用方持有用户在设置里配置的管理 App
//! Capability（由 tailnet grants 下发），未授权的远程身份仍被拒绝。
//!
//! 跨平台：安装/检测走 CLI（npm / tailscale / node），
//! 插件从应用内置 tarball 安装，开机自启走 launchd(macOS) /
//! 启动文件夹 .vbs(Windows) / systemd --user(Linux)。
//!
//! 模块布局：process（CLI/进程）→ components（组件定位/插件）→ auth（远程授权配置）
//! → detect（状态检测）/ setup（远程一键启动）/ start（本地一键启动）/
//! update（更新与版本管理）/ probe（远程 URL 探测）/ autostart（开机自启）。
//! 共享常量与 IPC 数据结构在本文件；子模块条目统一 pub(crate)，经 glob 重导出互见。

use serde::Serialize;

mod auth;
mod autostart;
mod components;
mod detect;
mod market;
mod models;
mod probe;
mod process;
mod setup;
mod start;
mod update;

// 命令注册路径保持 dsh::xxx（main.rs 不动）：函数 + 宏生成的两个隐藏宏三件套重导出
pub use detect::dsh_detect;
pub use detect::__cmd__dsh_detect;
pub use detect::__tauri_command_name_dsh_detect;
pub use setup::dsh_setup;
pub use setup::__cmd__dsh_setup;
pub use setup::__tauri_command_name_dsh_setup;
pub use start::dsh_start_web;
pub use start::__cmd__dsh_start_web;
pub use start::__tauri_command_name_dsh_start_web;
pub use process::dsh_stop;
pub use process::__cmd__dsh_stop;
pub use process::__tauri_command_name_dsh_stop;
pub use autostart::dsh_set_autostart;
pub use autostart::__cmd__dsh_set_autostart;
pub use autostart::__tauri_command_name_dsh_set_autostart;
pub use update::dsh_update;
pub use update::__cmd__dsh_update;
pub use update::__tauri_command_name_dsh_update;
pub use update::dsh_remove_plugins;
pub use update::__cmd__dsh_remove_plugins;
pub use update::__tauri_command_name_dsh_remove_plugins;
pub use update::dsh_check_latest;
pub use update::__cmd__dsh_check_latest;
pub use update::__tauri_command_name_dsh_check_latest;
pub use update::dsh_install_version;
pub use update::__cmd__dsh_install_version;
pub use update::__tauri_command_name_dsh_install_version;
pub use market::market_fetch;
pub use market::__cmd__market_fetch;
pub use market::__tauri_command_name_market_fetch;
pub use market::market_installed;
pub use market::__cmd__market_installed;
pub use market::__tauri_command_name_market_installed;
pub use market::market_snapshot;
pub use market::__cmd__market_snapshot;
pub use market::__tauri_command_name_market_snapshot;
pub use market::market_install;
pub use market::__cmd__market_install;
pub use market::__tauri_command_name_market_install;
pub use market::market_approve_builds;
pub use market::__cmd__market_approve_builds;
pub use market::__tauri_command_name_market_approve_builds;
pub use market::market_remove;
pub use market::__cmd__market_remove;
pub use market::__tauri_command_name_market_remove;
pub use market::market_check_updates;
pub use market::__cmd__market_check_updates;
pub use market::__tauri_command_name_market_check_updates;
pub use models::model_config_load;
pub use models::__cmd__model_config_load;
pub use models::__tauri_command_name_model_config_load;
pub use models::model_config_save;
pub use models::__cmd__model_config_save;
pub use models::__tauri_command_name_model_config_save;

// ============ 共享常量 ============

/// dsh 包名与 Launcher 锁定的 dsh 版本线（版本闸门的唯一事实来源）。跟线
/// 升级时与 vendor 插件 pin、bundle tgz 文件名三处同步 bump（见
/// scripts/build-dsh-plugins.mjs 与 src-tauri/tauri.conf.json）。
const DSH_PACKAGE: &str = "@deepseek-ai/dsh";
const SUPPORTED_DSH_VERSION: &str = "0.1.2-alpha.2";
const CONNECTION_PLUGIN_PACKAGE: &str = "@dsh-external/dsh-client-connection-authz";
const AUTH_PLUGIN_PACKAGE: &str = "@dsh-external/dsh-auth-tailscale";
const CONNECTION_PLUGIN_TARBALL: &str = "dsh-client-connection-authz-11929472460d.tgz";
const AUTH_PLUGIN_TARBALL: &str = "dsh-auth-tailscale-57ca6cab6b3f.tgz";
const TAILSCALE_LOGIN_ENV: &str = "DSH_TAILSCALE_ALLOWED_LOGINS";
const LOCAL_ONLY_LOGIN: &str = "local-only@localhost.invalid";
/// 远程特权接口（settings/credentials/host 等 loopback authority）与普通远程
/// API/WS 各自所需的 App Capability 环境变量。capability 路径固定为
/// `/cap/dsh-admin` / `/cap/dsh`，域名由用户在设置页 DeepSeek Harness 分区配置；
/// 留空则不注入对应 env，行为回退（远程管理恒 403 / 普通访问只靠身份
/// allowlist）。三处必须同名：注入的 env、`tailscale serve --accept-app-caps`
/// 与 tailnet grants。
const ADMIN_CAP_ENV: &str = "DSH_TAILSCALE_ADMIN_CAPABILITY";
const USE_CAP_ENV: &str = "DSH_TAILSCALE_USE_CAPABILITY";
const ADMIN_CAP_PATH: &str = "/cap/dsh-admin";
const USE_CAP_PATH: &str = "/cap/dsh";

/// dsh web 端口。
const WEB_PORT: u16 = 3899;
/// 自启标签前缀（仅 macOS launchd 使用；Windows/Linux 用固定文件名）
#[cfg(target_os = "macos")]
const AUTOSTART_PREFIX: &str = "com.codexpromax.dsh";

// ============ 数据结构 ============

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DshStatus {
    pub node_available: bool,
    pub dsh_installed: bool,
    pub dsh_version: Option<String>,
    pub supported_version: String,
    pub dsh_compatible: bool,
    /// 实际版本高于 Launcher 验证过的锁定版本（仅兼容时才有意义）：
    /// 授权插件栈在更新版下未验证，UI 据此提示风险而不阻断流程
    pub dsh_version_above_supported: bool,
    pub plugins_installed: bool,
    pub dsh_running: bool,
    pub tailscale_installed: bool,
    pub tailscale_online: bool,
    pub hostname: Option<String>,
    /// 本机访问地址（dsh web 运行中即有，与授权插件无关）：优先 dsh 原生
    /// 带 launch token 的地址（浏览器打开换取持久 cookie），解析不到回退裸地址
    pub local_url: Option<String>,
    pub url: Option<String>,
    /// 当前 Mac 用同一个 tailnet HTTPS 地址访问时的真实路径状态。
    /// None 表示远程栈尚未形成 URL；ready / capability_denied /
    /// proxy_interference / endpoint_failure 分别表示可用、远程 capability
    /// 被拒、被本机代理截获、服务端链路失败。
    pub remote_url_access: Option<RemoteUrlAccess>,
    pub magic_dns_enabled: bool,
    pub serve_configured: bool,
    pub autostart_enabled: bool,
    /// 检测过程中的错误信息（无则 None）
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteUrlAccess {
    Ready,
    CapabilityDenied,
    ProxyInterference,
    EndpointFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteRpcAccess {
    Ready,
    Denied,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MacosHttpsProxy {
    server: String,
    port: u16,
    exceptions: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RemoteUrlProbe {
    access: RemoteUrlAccess,
    direct_https_ok: bool,
    direct_ws_ok: bool,
    remote_use_access: Option<RemoteRpcAccess>,
    remote_settings_access: Option<RemoteRpcAccess>,
}

/// 时间轴节点事件（dsh-step），由 dsh_setup 逐步发出
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StepEvent {
    pub index: usize,
    pub id: String,
    /// running | done | failed | skipped
    pub state: String,
    pub detail: Option<String>,
    /// 问题描述（失败节点展示）
    pub problem: Option<String>,
    /// 解决方案（失败节点展示）
    pub solution: Option<String>,
}

#[cfg(test)]
mod tests;
