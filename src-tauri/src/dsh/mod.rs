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

// 命令注册路径保持 dsh::xxx（main.rs 不动）：tauri 命令是「函数 + 宏生成的
// __cmd__<name> / __tauri_command_name_<name> 两个隐藏符号」三件套，paste 拼接
// 标识符，一个宏展开一组，删命令时只需删一行
macro_rules! reexport_commands {
    ($($module:ident :: $name:ident),* $(,)?) => {
        paste::paste! {
            $(
                pub use $module::$name;
                pub use $module::[<__cmd__ $name>];
                pub use $module::[<__tauri_command_name_ $name>];
            )*
        }
    };
}

reexport_commands! {
    detect::dsh_detect,
    setup::dsh_setup,
    setup::dsh_web_log,
    start::dsh_start_web,
    process::dsh_stop,
    autostart::dsh_set_autostart,
    update::dsh_update,
    update::dsh_remove_plugins,
    update::dsh_check_latest,
    update::dsh_install_version,
    market::market_fetch,
    market::market_installed,
    market::market_snapshot,
    market::market_install,
    market::market_approve_builds,
    market::market_remove,
    market::market_check_updates,
    market::market_set_plugin_enabled,
    market::market_cancel,
    market::market_discovery_compat,
    market::market_release_notes,
    market::market_diagnostics,
    models::model_config_load,
    models::model_config_save,
}

// ============ 共享常量 ============

/// dsh 域命令的统一 adapter 形态：命令体全是阻塞 I/O（子进程、文件、HTTP），
/// 直接跑在 async runtime 上会饿死执行器、冻结 WebView。统一丢进阻塞线程池，
/// 命令签名保持 async。market 路径首先落地此形态（pnpm 下载是首个真实痛点），
/// 现收敛为全模块唯一 adapter
pub(crate) async fn ipc_blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("ipc task failed: {e}"))?
}

/// dsh 包名与 Launcher 锁定的 dsh 版本线（版本闸门的唯一事实来源）。跟线
/// 升级时与 vendor 插件 pin、bundle tgz 文件名三处同步 bump（见
/// scripts/build-dsh-plugins.mjs 与 src-tauri/tauri.conf.json）。
const DSH_PACKAGE: &str = "@deepseek-ai/dsh";
const SUPPORTED_DSH_VERSION: &str = "0.1.2-alpha.4";
const CONNECTION_PLUGIN_PACKAGE: &str = "@dsh-external/dsh-client-connection-authz";
const AUTH_PLUGIN_PACKAGE: &str = "@dsh-external/dsh-auth-tailscale";
const CONNECTION_PLUGIN_TARBALL: &str = "dsh-client-connection-authz-8a27dc344a79.tgz";
const AUTH_PLUGIN_TARBALL: &str = "dsh-auth-tailscale-5958d1ed2651.tgz";
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

#[derive(Debug, Serialize, Clone, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
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
    /// 按本次检测推导的就绪时间轴（步骤序列 + 完成态）：前端未跑流程时的
    /// 初始视图直接渲染它，不再自行从状态布尔重推导步骤编排
    pub ready_timeline: Vec<StepEvent>,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/shared/bindings/")]
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

/// 时间轴节点事件（dsh-step），由 dsh_setup / dsh_start_web 逐步发出。
/// state 全集含 "pending"——派生时间轴（ready_timeline）与前端骨架用它，
/// 事件流自身只发 running/done/failed/skipped
#[derive(Debug, Serialize, Clone, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct StepEvent {
    pub index: usize,
    pub id: String,
    /// running | done | failed | skipped | pending（pending 只见于派生时间轴/前端骨架）
    #[ts(type = r#""running" | "done" | "failed" | "skipped" | "pending""#)]
    pub state: String,
    pub detail: Option<String>,
    /// 问题描述（失败节点展示）
    pub problem: Option<String>,
    /// 解决方案（失败节点展示）
    pub solution: Option<String>,
    /// 步骤标题的 i18n key（"step.<id>"）：骨架/派生时间轴节点携带，
    /// 前端零映射渲染；事件流节点为 None（标题已由骨架就位）
    pub title_key: Option<String>,
}

// ============ 步骤编排契约（前端不再持有步骤列表副本）============

/// 远程一键启动的步骤集（dsh_setup_once 的数组即它）
pub(crate) const SETUP_STEPS: [&str; 8] = [
    "node",
    "install",
    "plugins",
    "tailscale",
    "magicdns",
    "start",
    "serve",
    "verify",
];

/// 按访问模式的步骤序列（唯一事实来源）：local = start::LOCAL_STEPS，remote = SETUP_STEPS
pub(crate) fn steps(remote: bool) -> &'static [&'static str] {
    if remote {
        &SETUP_STEPS
    } else {
        &start::LOCAL_STEPS
    }
}

fn pending_step(index: usize, id: &str) -> StepEvent {
    StepEvent {
        index,
        id: id.to_string(),
        state: "pending".to_string(),
        detail: None,
        problem: None,
        solution: None,
        title_key: Some(step_title_key(id)),
    }
}

/// 步骤标题的 i18n key：稳定 schema 常量 "step.<id>"，前端 t() 查词典，
/// 词典缺失时 i18next 回退 key 原文（未覆盖的新步骤显示 "step.xxx"，可发现）
pub(crate) fn step_title_key(id: &str) -> String {
    format!("step.{id}")
}

/// 由检测结果推导「就绪时间轴」：已满足的步骤标 done，其余 pending。
/// 步骤序列来自 steps()，前端只渲染不重推导
pub(crate) fn ready_timeline(remote: bool, s: &DshStatus) -> Vec<StepEvent> {
    let done = |ok: bool, index: usize, id: &str| StepEvent {
        state: if ok { "done" } else { "pending" }.to_string(),
        ..pending_step(index, id)
    };
    let all_ready = s.node_available
        && s.dsh_installed
        && s.dsh_compatible
        && s.plugins_installed
        && s.dsh_running
        && s.tailscale_online
        && s.magic_dns_enabled
        && s.serve_configured
        && s.remote_url_access == Some(RemoteUrlAccess::Ready);
    if remote {
        steps(true)
            .iter()
            .enumerate()
            .map(|(index, id)| {
                let ok = match *id {
                    "node" => s.node_available,
                    "install" => s.dsh_installed && s.dsh_compatible,
                    "plugins" => s.plugins_installed,
                    "tailscale" => s.tailscale_installed && s.tailscale_online,
                    "magicdns" => s.magic_dns_enabled,
                    "start" => s.dsh_running,
                    "serve" => s.serve_configured,
                    "verify" => all_ready,
                    _ => false,
                };
                done(ok, index, id)
            })
            .collect()
    } else {
        steps(false)
            .iter()
            .enumerate()
            .map(|(index, id)| {
                let ok = match *id {
                    "node" => s.node_available,
                    "install" => s.dsh_installed && s.dsh_compatible,
                    "start" | "ready" => s.dsh_running,
                    _ => false,
                };
                done(ok, index, id)
            })
            .collect()
    }
}

/// 步骤 schema 命令：前端启动骨架与时间轴标题都以它为准。detect 附带
/// ready_timeline 供「未跑流程」的初始视图，schema 让「新流程开始」的骨架
/// 与「步骤标题」同样数据驱动（含未走 detect 的空状态路径）
#[tauri::command]
pub fn dsh_step_schema(remote: bool) -> Vec<StepEvent> {
    steps(remote)
        .iter()
        .enumerate()
        .map(|(index, id)| pending_step(index, id))
        .collect()
}

// dsh_step_schema 定义在本模块（不属任何子模块），三件套在模块根部就位，
// main.rs 以 dsh::dsh_step_schema 注册

#[cfg(test)]
mod tests;
