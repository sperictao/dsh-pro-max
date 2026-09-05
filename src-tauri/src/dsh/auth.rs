//! 远程授权配置：capability 域名校验、允许登录名解析、Tailscale serve 状态、loopback HTTP/RPC 探测。

use super::components::{magic_dns_info, resolve_host_and_url, tailscale_path};
use super::process::run_capture;
use super::{
    ADMIN_CAP_ENV, ADMIN_CAP_PATH, TAILSCALE_LOGIN_ENV, USE_CAP_ENV, USE_CAP_PATH, WEB_PORT,
};
use std::time::Duration;

use crate::config;
use crate::i18n::keyf;

// ============ 远程授权配置 ============

/// dsh 远程访问授权配置：由 `resolve_auth_config` 从设置解析，贯穿 spawn、
/// serve 与自启脚本三条注入路径。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct AuthConfig {
    /// 额外允许的 Tailscale 登录名（不含本机当前用户）
    pub(crate) extra_allowed_logins: Vec<String>,
    /// 完整 use capability（`<domain>/cap/dsh`）；None = 不注入
    pub(crate) use_capability: Option<String>,
    /// 完整 admin capability（`<domain>/cap/dsh-admin`）；None = 不注入
    pub(crate) admin_capability: Option<String>,
}

impl AuthConfig {
    /// 逗号拼接的完整 allowlist（本机当前登录 + 额外登录名，去重）。
    pub(crate) fn allowed_logins(&self, login: &str) -> String {
        let mut all = vec![login.to_string()];
        for extra in &self.extra_allowed_logins {
            if extra != login {
                all.push(extra.clone());
            }
        }
        all.join(",")
    }

    /// 需经 Serve 转发的 capability（0/1/2 个），按 use 在前、admin 在后的固定顺序。
    pub(crate) fn capabilities(&self) -> Vec<String> {
        [self.use_capability.clone(), self.admin_capability.clone()]
            .into_iter()
            .flatten()
            .collect()
    }

    /// spawn_detached 的 env 列表：allowed_logins 必注入，use/admin 仅在配置时注入。
    pub(crate) fn env_pairs<'a>(&'a self, login: &'a str) -> Vec<(&'a str, String)> {
        let mut envs = vec![(TAILSCALE_LOGIN_ENV, self.allowed_logins(login))];
        if let Some(cap) = &self.use_capability {
            envs.push((USE_CAP_ENV, cap.clone()));
        }
        if let Some(cap) = &self.admin_capability {
            envs.push((ADMIN_CAP_ENV, cap.clone()));
        }
        envs
    }
}

/// 校验 capability 的域名段（Tailscale `{domain}/{name}` 规则的域名部分）：
/// ASCII 字母数字、`-`、`.`，至少含一个 `.`，且不以 `-`/`.` 开头或结尾。
/// 合法返回 trim 后的域名；非法返回友好错误。
pub(crate) fn validate_cap_domain(domain: &str) -> Result<String, String> {
    let trimmed = domain.trim();
    let valid = !trimmed.is_empty()
        && trimmed.contains('.')
        && !trimmed.starts_with(['-', '.'])
        && !trimmed.ends_with(['-', '.'])
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    if valid {
        Ok(trimmed.to_string())
    } else {
        Err(keyf(
            "Invalid capability domain: {domain}. Use a domain you control (e.g. example.com)",
            &[("domain", domain.to_string())],
        ))
    }
}

/// 解析「额外允许的登录名」设置：逗号分隔、trim、去空、去重，
/// 并沿用 Tailscale 登录名的字符白名单校验。
pub(crate) fn parse_extra_logins(raw: &str) -> Result<Vec<String>, String> {
    let mut seen = Vec::new();
    for item in raw.split(',') {
        let login = item.trim();
        if login.is_empty() {
            continue;
        }
        if !login
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "@._+-".contains(c))
        {
            return Err("Tailscale login name contains unsupported characters".to_string());
        }
        if !seen.iter().any(|existing| existing == login) {
            seen.push(login.to_string());
        }
    }
    Ok(seen)
}

/// 从设置解析远程授权配置。域名非法时返回 Err（调用方在时间轴 fail 并给方案）。
pub(crate) fn resolve_auth_config() -> Result<AuthConfig, String> {
    let config = config::load_config()?;
    Ok(AuthConfig {
        extra_allowed_logins: parse_extra_logins(&config.dsh_extra_allowed_logins)?,
        use_capability: if config.dsh_use_cap_domain.trim().is_empty() {
            None
        } else {
            Some(format!(
                "{}{}",
                validate_cap_domain(&config.dsh_use_cap_domain)?,
                USE_CAP_PATH
            ))
        },
        admin_capability: if config.dsh_admin_cap_domain.trim().is_empty() {
            None
        } else {
            Some(format!(
                "{}{}",
                validate_cap_domain(&config.dsh_admin_cap_domain)?,
                ADMIN_CAP_PATH
            ))
        },
    })
}

pub(crate) fn tailscale_login_from_status_json(raw: &str) -> Result<String, String> {
    let status: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        let err = keyf(
            "Cannot parse Tailscale status: {error}",
            &[("error", e.to_string())],
        );
        log::error!("[dsh tailscale] 解析 status 失败: {}", err);
        err
    })?;
    let user_id = match status.pointer("/Self/UserID") {
        Some(serde_json::Value::Number(value)) => value.to_string(),
        Some(serde_json::Value::String(value)) if !value.trim().is_empty() => {
            value.trim().to_string()
        }
        _ => {
            let err = "Tailscale status does not contain the current user ID".to_string();
            log::error!("[dsh tailscale] {}", err);
            return Err(err);
        }
    };
    // Tailscale 客户端演进后 User 表的 key 与条目内 ID 字段不再一致
    // （实测 2026-08：Self.UserID 匹配的是条目的 ID 字段，不是表 key）。
    // 先按条目 ID 匹配；条目无 ID 字段的旧形态退回按表 key 匹配。
    let login = status
        .get("User")
        .and_then(serde_json::Value::as_object)
        .and_then(|users| {
            users
                .values()
                .find(|user| {
                    user.get("ID")
                        .map(|id| id.to_string().trim_matches('"') == user_id)
                        .unwrap_or(false)
                })
                .or_else(|| users.get(&user_id))
        })
        .and_then(|user| user.get("LoginName"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            let err = "Tailscale status does not contain the current login name".to_string();
            log::error!("[dsh tailscale] {}", err);
            err
        })?;
    if !login
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "@._+-".contains(character))
    {
        let err = "Tailscale login name contains unsupported characters".to_string();
        log::error!("[dsh tailscale] {}", err);
        return Err(err);
    }
    Ok(login.to_string())
}

pub(crate) fn resolve_tailscale_login(ts: &str) -> Result<String, String> {
    match run_capture(ts, &["status", "--json"]) {
        Ok((out, _, true)) => tailscale_login_from_status_json(&out),
        Ok((_, err, false)) => {
            let e = keyf(
                "Cannot read the current Tailscale identity: {error}",
                &[(
                    "error",
                    if err.is_empty() {
                        "tailscale status --json failed".to_string()
                    } else {
                        err
                    },
                )],
            );
            log::error!("[dsh tailscale] 读取身份失败: {}", e);
            Err(e)
        }
        Err(error) => {
            log::error!("[dsh tailscale] 执行 tailscale status 失败: {}", error);
            Err(error)
        }
    }
}

/// 只认可根路由直接指向 dsh web 端口的 Serve 配置。
pub(crate) fn serve_status_targets_web(status: &str) -> bool {
    let loopback = format!("http://127.0.0.1:{WEB_PORT}");
    let localhost = format!("http://localhost:{WEB_PORT}");
    status.lines().any(|line| {
        line.contains("proxy")
            && line.split_whitespace().any(|token| {
                let target = token.trim_end_matches('/');
                target == loopback || target == localhost
            })
    })
}

/// 解析 serve 是否已直接指向 dsh web。
pub(crate) fn serve_configured(ts: &str) -> bool {
    match run_capture(ts, &["serve", "status"]) {
        Ok((out, _, ok)) => ok && serve_status_targets_web(&out),
        Err(_) => false,
    }
}

/// 解析 tailnet 完全限定主机名（--trusted-host 用）：
/// 设备名 + MagicDNS 后缀，如 etmacminim4.taildde4.ts.net。
/// 后缀未知时省略：硬猜 `.ts.net` 可能是错的（实际后缀常是
/// taildde4.ts.net 之类）。
pub(crate) fn resolve_fqdn() -> Option<String> {
    let (host, _) = resolve_host_and_url();
    let host = host?;
    if host.contains('.') {
        return Some(host);
    }
    let suffix = tailscale_path().and_then(|ts| magic_dns_info(&ts).1);
    suffix.map(|s| format!("{}.{}", host, s))
}

/// tailscale 是否在线（tailscale status 成功即在线）
pub(crate) fn tailscale_online(ts: &str) -> bool {
    matches!(run_capture(ts, &["status"]), Ok((_, _, true)))
}

/// 极简 HTTP GET（本地验证用；不引网络库）
pub(crate) fn http_get(port: u16, host_header: &str, path: &str) -> Option<String> {
    use std::io::{Read, Write};
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
    let mut s = TcpStream::connect_timeout(
        &SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        Duration::from_secs(3),
    )
    .ok()?;
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        path, host_header
    );
    s.write_all(req.as_bytes()).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).ok()?;
    String::from_utf8_lossy(&buf)
        .lines()
        .next()
        .map(|l| l.to_string())
}

/// 状态码首行是否成功（200/3xx 均视为可达；dsh 根路径可能 302 到登录页）
pub(crate) fn http_ok(line: Option<&str>) -> bool {
    match line {
        Some(l) => {
            let status = l.split_whitespace().nth(1).unwrap_or("");
            status.starts_with('2') || status.starts_with('3')
        }
        None => false,
    }
}

/// 状态行是否为合法的三位状态码（不问语义）。本地模式的就绪判定用：
/// 无授权插件时裸 `/` 未带 token 的 401/404 是健康应答（浏览器经 token
/// URL 换 cookie 后才是 200），不能沿用 http_ok 的 2xx/3xx 门槛
pub(crate) fn any_http_status(line: Option<&str>) -> bool {
    line.and_then(|l| l.split_whitespace().nth(1))
        .map(|code| code.len() == 3 && code.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or(false)
}

/// 构造 JSON-RPC POST 请求（本地验证用）。Host 为 loopback、不带 Origin，
/// 专门验证「本机仍可访问特权 API」这条不变式。
pub(crate) fn rpc_body(method: &str) -> String {
    format!(
        r#"{{"type":"client-request","rpcId":"t1","method":"{}","payload":{{"args":{{}}}}}}"#,
        method
    )
}

pub(crate) fn rpc_request(method: &str) -> String {
    let body = rpc_body(method);
    format!(
        "POST /api/{} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        method,
        body.len(),
        body
    )
}

/// 极简 RPC POST（本地验证用）：POST JSON-RPC 到本地端口，响应含
/// `"ok":true` 即通过。
pub(crate) fn rpc_ok(port: u16, method: &str) -> bool {
    use std::io::{Read, Write};
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
    let mut s = match TcpStream::connect_timeout(
        &SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        Duration::from_secs(3),
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };
    if s.write_all(rpc_request(method).as_bytes()).is_err() {
        return false;
    }
    if s.set_read_timeout(Some(Duration::from_secs(5))).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    if s.read_to_end(&mut buf).is_err() {
        return false;
    }
    String::from_utf8_lossy(&buf).contains("\"ok\":true")
}
