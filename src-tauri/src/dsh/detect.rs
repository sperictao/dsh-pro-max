//! dsh 状态检测：聚合组件/插件/Tailscale/运行态与远程访问可达性（dsh_detect 命令）。





use super::{DshStatus, SUPPORTED_DSH_VERSION, WEB_PORT};
use super::auth::{resolve_auth_config, serve_configured, tailscale_online};
use super::autostart::{autostart_enabled};
use super::components::{auth_plugins_installed, bundled_plugin_specs, dsh_version, dsh_version_is_compatible, magic_dns_info, resolve_host_and_url, tailscale_path};
use super::probe::{probe_remote_url};
use super::process::{port_listening, which};
use crate::version::parse_version;




// ============ 检测 ============

#[tauri::command]
pub async fn dsh_detect(
    app: tauri::AppHandle,
    verify_remote_url: Option<bool>,
) -> Result<DshStatus, String> {
    let verify_remote_url = verify_remote_url.unwrap_or(false);
    let (hostname, url) = resolve_host_and_url();
    let ts = tailscale_path();
    let (magic, _) = match &ts {
        Some(p) => magic_dns_info(p),
        None => (false, None),
    };
    let version = dsh_version();
    let dsh_compatible = dsh_version_is_compatible(version.as_deref());
    let dsh_version_above_supported = dsh_compatible
        && match (
            version.as_deref().and_then(parse_version),
            parse_version(SUPPORTED_DSH_VERSION),
        ) {
            (Some(actual), Some(min)) => actual > min,
            _ => false,
        };
    let (plugins_installed, plugin_error) = match bundled_plugin_specs(&app) {
        Ok(specs) => (auth_plugins_installed(&specs), None),
        Err(error) => {
            log::warn!("[dsh 检测] 定位内置插件失败: {}", error);
            (false, Some(error))
        }
    };
    let dsh_running = port_listening(WEB_PORT);
    let serve_configured = ts.as_deref().map(serve_configured).unwrap_or(false);
    let stack_ready = dsh_running && dsh_compatible && plugins_installed;
    // 本地地址走 dsh 原生 token 访问（与授权插件无关）：web 在跑即可用，
    // 优先取日志里带 token 的地址，解析不到回退裸地址
    let local_url = dsh_running.then(|| {
        super::start::local_access_url().unwrap_or_else(|| format!("http://127.0.0.1:{WEB_PORT}"))
    });
    let url = if stack_ready && serve_configured {
        url
    } else {
        None
    };
    let remote_url_access = if verify_remote_url {
        let auth = resolve_auth_config()?;
        url.as_deref().map(|url| probe_remote_url(url, &auth).access)
    } else {
        None
    };
    Ok(DshStatus {
        node_available: which("node").is_some(),
        dsh_installed: version.is_some(),
        dsh_version: version,
        supported_version: SUPPORTED_DSH_VERSION.to_string(),
        dsh_compatible,
        dsh_version_above_supported,
        plugins_installed,
        dsh_running,
        tailscale_installed: ts.is_some(),
        tailscale_online: ts.as_deref().map(tailscale_online).unwrap_or(false),
        hostname,
        local_url,
        url,
        remote_url_access,
        magic_dns_enabled: magic,
        serve_configured,
        autostart_enabled: autostart_enabled(),
        error: plugin_error,
    })
}
