//! 远程 URL 探测：直连/经代理的 HTTPS 与 WebSocket 可达性、macOS 系统代理解析、RPC 鉴权分类。

use super::{MacosHttpsProxy, RemoteRpcAccess, RemoteUrlAccess, RemoteUrlProbe};
use super::auth::{AuthConfig, rpc_body};
use super::process::{run_capture, string_args, which};

pub(crate) const REMOTE_WS_PATH: &str = "/api/remote.mux";

pub(crate) fn curl_direct_args(url: &str) -> Vec<String> {
    let null_dev = if cfg!(windows) { "NUL" } else { "/dev/null" };
    [
        "-sk",
        "--noproxy",
        "*",
        "--connect-timeout",
        "3",
        "--max-time",
        "6",
        "-o",
        null_dev,
        "-w",
        "%{http_code}",
        url,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub(crate) fn curl_remote_rpc_args(url: &str, method: &str) -> Vec<String> {
    vec![
        "-sk".to_string(),
        "--noproxy".to_string(),
        "*".to_string(),
        "--connect-timeout".to_string(),
        "3".to_string(),
        "--max-time".to_string(),
        "6".to_string(),
        "-H".to_string(),
        "Content-Type: application/json".to_string(),
        "--data-binary".to_string(),
        rpc_body(method),
        "-w".to_string(),
        "\n%{http_code}".to_string(),
        format!("{}/api/{method}", url.trim_end_matches('/')),
    ]
}

pub(crate) fn classify_remote_rpc_response(output: &str, command_ok: bool) -> RemoteRpcAccess {
    if !command_ok {
        return RemoteRpcAccess::Failed;
    }
    let Some((body, status)) = output.rsplit_once('\n') else {
        return RemoteRpcAccess::Failed;
    };
    let rpc_ok = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|response| {
            response
                .pointer("/result/ok")
                .and_then(serde_json::Value::as_bool)
        })
        == Some(true);
    match status.trim() {
        "401" | "403" => RemoteRpcAccess::Denied,
        code if code.starts_with('2') && rpc_ok => RemoteRpcAccess::Ready,
        _ => RemoteRpcAccess::Failed,
    }
}

pub(crate) fn remote_rpc_access(url: &str, method: &str) -> RemoteRpcAccess {
    let args = curl_remote_rpc_args(url, method);
    match run_capture("curl", &string_args(&args)) {
        Ok((out, _, ok)) => classify_remote_rpc_response(&out, ok),
        Err(_) => RemoteRpcAccess::Failed,
    }
}

pub(crate) fn curl_proxy_args(url: &str, proxy: &MacosHttpsProxy) -> Vec<String> {
    let null_dev = if cfg!(windows) { "NUL" } else { "/dev/null" };
    [
        "-sk".to_string(),
        "--proxy".to_string(),
        format!("http://{}:{}", proxy.server, proxy.port),
        "--connect-timeout".to_string(),
        "2".to_string(),
        "--max-time".to_string(),
        "4".to_string(),
        "-o".to_string(),
        null_dev.to_string(),
        "-w".to_string(),
        "%{http_code}".to_string(),
        url.to_string(),
    ]
    .into_iter()
    .collect()
}

/// 真实 HTTPS 端点检查：显式绕过代理后请求本机自己的 tailnet 域名。
/// Windows 10 1803+ 自带 curl.exe；macOS/Linux 标配 curl。
/// 返回是否拿到 2xx/3xx 响应。
pub(crate) fn https_endpoint_ok(url: &str) -> bool {
    let args = curl_direct_args(url);
    match run_capture("curl", &string_args(&args)) {
        Ok((out, _, ok)) => {
            let code = out.trim();
            ok && (code.starts_with('2') || code.starts_with('3'))
        }
        Err(_) => false,
    }
}

pub(crate) fn https_endpoint_ok_via_proxy(url: &str, proxy: &MacosHttpsProxy) -> bool {
    let args = curl_proxy_args(url, proxy);
    match run_capture("curl", &string_args(&args)) {
        Ok((out, _, ok)) => {
            let code = out.trim();
            ok && (code.starts_with('2') || code.starts_with('3'))
        }
        Err(_) => false,
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn parse_macos_https_proxy(output: &str) -> Option<MacosHttpsProxy> {
    let mut enabled = false;
    let mut server = None;
    let mut port = None;
    let mut exceptions = Vec::new();
    let mut in_exceptions = false;

    for raw in output.lines() {
        let line = raw.trim();
        if line.starts_with("ExceptionsList : <array>") {
            in_exceptions = true;
            continue;
        }
        if in_exceptions {
            if line == "}" {
                in_exceptions = false;
                continue;
            }
            if let Some((index, value)) = line.split_once(" : ") {
                if index.chars().all(|c| c.is_ascii_digit()) {
                    exceptions.push(value.trim().to_string());
                }
            }
            continue;
        }
        if line == "HTTPSEnable : 1" {
            enabled = true;
        } else if let Some(value) = line.strip_prefix("HTTPSProxy : ") {
            server = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("HTTPSPort : ") {
            port = value.trim().parse::<u16>().ok();
        }
    }

    if !enabled {
        return None;
    }
    Some(MacosHttpsProxy {
        server: server.filter(|value| !value.is_empty())?,
        port: port?,
        exceptions,
    })
}

pub(crate) fn proxy_bypasses_host(host: &str, exceptions: &[String]) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    exceptions.iter().any(|entry| {
        let entry = entry.trim().trim_end_matches('.').to_ascii_lowercase();
        if entry == host {
            return true;
        }
        let suffix = entry.strip_prefix("*.").or_else(|| entry.strip_prefix('.'));
        suffix.is_some_and(|suffix| host == suffix || host.ends_with(&format!(".{suffix}")))
    })
}

pub(crate) fn remote_url_host(url: &str) -> Option<&str> {
    url.strip_prefix("https://")?
        .split(['/', ':'])
        .next()
        .filter(|host| !host.is_empty())
}

#[cfg(target_os = "macos")]
pub(crate) fn active_macos_https_proxy() -> Option<MacosHttpsProxy> {
    let (out, _, ok) = run_capture("/usr/sbin/scutil", &["--proxy"]).ok()?;
    ok.then(|| parse_macos_https_proxy(&out)).flatten()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn active_macos_https_proxy() -> Option<MacosHttpsProxy> {
    None
}

pub(crate) fn classify_remote_url_access(
    direct_https_ok: bool,
    direct_ws_ok: bool,
    remote_rpc_access: Option<RemoteRpcAccess>,
    uses_proxy: bool,
    proxied_https_ok: bool,
    proxied_ws_ok: bool,
) -> RemoteUrlAccess {
    if !direct_https_ok {
        RemoteUrlAccess::EndpointFailure
    } else if remote_rpc_access == Some(RemoteRpcAccess::Denied) {
        RemoteUrlAccess::CapabilityDenied
    } else if remote_rpc_access == Some(RemoteRpcAccess::Failed) || !direct_ws_ok {
        RemoteUrlAccess::EndpointFailure
    } else if uses_proxy && (!proxied_https_ok || !proxied_ws_ok) {
        RemoteUrlAccess::ProxyInterference
    } else {
        RemoteUrlAccess::Ready
    }
}

/// WebSocket 握手探测脚本（node 一段式，net/tls 裸 upgrade——不依赖 v22+ 内置
/// WebSocket，Node 18+ 均可用；实测 ws/wss 成功、无监听、非 101 三类路径）。
/// 教程第七步的纠错：curl 默认 HTTP/2 禁 Upgrade 头，测 WS 握手会拿到假 426——
/// 必须发真实 upgrade 握手。拿到 HTTP/1.1 101 即 exit 0，否则/超时 exit 1
pub(crate) const WS_PROBE_JS: &str = r"const net=require('net'),tls=require('tls');
const url=new URL(process.argv[1]);
const port=url.port?Number(url.port):(url.protocol==='wss:'?443:80);
const opts={host:url.hostname,port:port};
if(url.protocol==='wss:'){opts.rejectUnauthorized=false;if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)){opts.servername=url.hostname;}}
const sock=url.protocol==='wss:'?tls.connect(opts):net.connect(port,url.hostname);
const key='dGhlIHNhbXBsZSBub25jZQ==';
let done=false,sent=false,buf='';
function finish(c){if(done)return;done=true;try{sock.destroy();}catch(e){}process.exit(c);}
function send(){if(sent)return;sent=true;sock.write('GET '+url.pathname+' HTTP/1.1\r\nHost: '+url.host+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n');}
sock.on('connect',send);
sock.on('secureConnect',send);
sock.on('data',function(d){buf+=d.toString('utf8');if(buf.indexOf('HTTP/1.1 ')!==0){return;}finish(buf.indexOf('HTTP/1.1 101')===0?0:1);});
sock.on('error',function(){finish(1);});
sock.on('close',function(){finish(1);});
setTimeout(function(){finish(1);},6000).unref();";

/// 用 node 跑 WS 探测脚本。ws:// 走纯 TCP，wss:// 走 TLS。
/// node 不可用时跳过（视为通过）——setup 第 0 步已确认 node。
pub(crate) fn ws_probe_ok(node: &str, ws_url: &str) -> bool {
    matches!(run_capture(node, &["-e", WS_PROBE_JS, ws_url]), Ok((_, _, true)))
}

/// 真实 WebSocket 链路检查：经 Tailscale Serve 直接到 dsh，对
/// /api/remote.mux 做 WS upgrade 握手。
pub(crate) fn ws_endpoint_ok(url: &str) -> bool {
    let Some(node) = which("node") else { return true };
    let ws_url = format!("{}{}", url.replacen("https://", "wss://", 1), REMOTE_WS_PATH);
    ws_probe_ok(&node, &ws_url)
}

pub(crate) fn ws_endpoint_ok_via_proxy(url: &str, proxy: &MacosHttpsProxy) -> bool {
    let endpoint = format!("{}{}", url.trim_end_matches('/'), REMOTE_WS_PATH);
    let proxy_url = format!("http://{}:{}", proxy.server, proxy.port);
    let args = [
        "-sk",
        "--http1.1",
        "--proxy",
        proxy_url.as_str(),
        "--connect-timeout",
        "2",
        "--max-time",
        "4",
        "-D",
        "-",
        "-o",
        if cfg!(windows) { "NUL" } else { "/dev/null" },
        "-H",
        "Connection: Upgrade",
        "-H",
        "Upgrade: websocket",
        "-H",
        "Sec-WebSocket-Version: 13",
        "-H",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        endpoint.as_str(),
    ];
    match run_capture("curl", &args) {
        Ok((out, _, _)) => out
            .lines()
            .any(|line| line.trim_start().starts_with("HTTP/1.1 101")),
        Err(_) => false,
    }
}

pub(crate) fn probe_remote_url(url: &str, auth: &AuthConfig) -> RemoteUrlProbe {
    let direct_https_ok = https_endpoint_ok(url);
    let direct_ws_ok = ws_endpoint_ok(url);
    let remote_use_access = (direct_https_ok && auth.use_capability.is_some())
        .then(|| remote_rpc_access(url, "llm/listProviders"));
    let remote_use_ready = matches!(remote_use_access, None | Some(RemoteRpcAccess::Ready));
    let remote_settings_access = (direct_https_ok
        && remote_use_ready
        && auth.admin_capability.is_some())
        .then(|| remote_rpc_access(url, "settings/describe"));
    let remote_rpc_access = if remote_use_access == Some(RemoteRpcAccess::Denied)
        || remote_settings_access == Some(RemoteRpcAccess::Denied)
    {
        Some(RemoteRpcAccess::Denied)
    } else if remote_use_access == Some(RemoteRpcAccess::Failed)
        || remote_settings_access == Some(RemoteRpcAccess::Failed)
    {
        Some(RemoteRpcAccess::Failed)
    } else if remote_use_access.is_some() || remote_settings_access.is_some() {
        Some(RemoteRpcAccess::Ready)
    } else {
        None
    };
    let direct_access = classify_remote_url_access(
        direct_https_ok,
        direct_ws_ok,
        remote_rpc_access,
        false,
        false,
        false,
    );
    if direct_access != RemoteUrlAccess::Ready {
        return RemoteUrlProbe {
            access: direct_access,
            direct_https_ok,
            direct_ws_ok,
            remote_use_access,
            remote_settings_access,
        };
    }
    let Some(proxy) = active_macos_https_proxy() else {
        return RemoteUrlProbe {
            access: RemoteUrlAccess::Ready,
            direct_https_ok,
            direct_ws_ok,
            remote_use_access,
            remote_settings_access,
        };
    };
    let Some(host) = remote_url_host(url) else {
        return RemoteUrlProbe {
            access: RemoteUrlAccess::EndpointFailure,
            direct_https_ok,
            direct_ws_ok,
            remote_use_access,
            remote_settings_access,
        };
    };
    let uses_proxy = !proxy_bypasses_host(host, &proxy.exceptions);
    let (proxied_https_ok, proxied_ws_ok) = if uses_proxy && direct_https_ok && direct_ws_ok {
        let https_ok = https_endpoint_ok_via_proxy(url, &proxy);
        let ws_ok = https_ok && ws_endpoint_ok_via_proxy(url, &proxy);
        (https_ok, ws_ok)
    } else {
        (false, false)
    };
    RemoteUrlProbe {
        access: classify_remote_url_access(
            direct_https_ok,
            direct_ws_ok,
            remote_rpc_access,
            uses_proxy,
            proxied_https_ok,
            proxied_ws_ok,
        ),
        direct_https_ok,
        direct_ws_ok,
        remote_use_access,
        remote_settings_access,
    }
}

pub(crate) fn proxy_bypass_host(url: &str) -> Option<&str> {
    remote_url_host(url)
}
