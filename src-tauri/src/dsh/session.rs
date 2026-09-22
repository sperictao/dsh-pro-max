//! 本机会话：Launcher 以「本机身份」访问 dsh 特权面所走的第一方鉴权链路。
//!
//! 授权插件（`dsh-client-connection-authz`）在场时 loopback 请求由它直放；
//! 插件不在场时（本地模式不依赖授权插件、插件被卸载或安装失败、Windows 等原生
//! token 环境）dsh 用原生 launch token 鉴权：启动打印
//! `dsh web: http://127.0.0.1:3899/?token=<token>`，浏览器 GET 该地址换
//! 303 + 30 天 `dsh-auth-*` cookie；此后**所有** `/api` 请求都要带这个
//! cookie，裸请求一律 401（含 `credentials/*` 特权端点）。
//!
//! Launcher 自己发起的特权 RPC 走同一条原生链路，而不是另开一条旁路：
//! 从启动日志取当前实例的 token、换一次会话 cookie 并在进程内缓存，cookie
//! 被拒时失效重取一次。token 与 cookie 都不落盘——启动日志本身就是 Launcher
//! 交给浏览器的同一份凭据来源。

use std::sync::Mutex;
use std::time::Duration;

use super::components::dsh_dir;

/// 本机 HTTP 请求预算（会话换取与凭据 RPC 共用同一个 loopback 事实）
pub(crate) const LOOPBACK_HTTP_TIMEOUT_SECS: u64 = 5;

/// 启动日志里的访问地址前缀：只认 dsh 自己打印的这一行（授权插件在场时打印的
/// 是裸地址，不带 `?token=`，因此不会命中）。端口与换取、发请求用的是同一个，
/// 不给「日志里的服务」和「被调用的服务」留两套事实
fn token_line_prefix(port: u16) -> String {
    format!("dsh web: http://127.0.0.1:{port}/?token=")
}

/// token 是 base64url（32 随机字节 → 43 字符），`-`/`_` 必须收进字符集：
/// 按字母数字截断会把大部分 token 砍短，浏览器与 Launcher 都换不到 cookie
fn is_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'
}

/// 从启动日志内容解析最近一次打印的本机 launch token。
/// 日志只追加不轮转，取最后一条命中行；调用方按需圈定只看本次启动的区域
pub(crate) fn launch_token(contents: &str, port: u16) -> Option<&str> {
    let prefix = token_line_prefix(port);
    let token = contents
        .lines()
        .rfind(|line| line.contains(&prefix))?
        .split_once(&prefix)?
        .1;
    let end = token
        .find(|ch: char| !is_token_char(ch))
        .unwrap_or(token.len());
    (end > 0).then(|| &token[..end])
}

/// 浏览器打开的本机访问地址（dsh 原生方式：GET 该地址换持久 cookie）
pub(crate) fn local_access_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/?token={token}")
}

/// 启动日志里当前实例的 launch token；日志缺失/无可认行时 None
fn latest_launch_token(port: u16) -> Option<String> {
    let log = dsh_dir().ok()?.join("dsh-web.log");
    let contents = std::fs::read_to_string(log).ok()?;
    launch_token(&contents, port).map(str::to_string)
}

/// 进程内缓存的会话 cookie（`name=value`）。dsh 的签名密钥是持久的，cookie
/// 可以跨 dsh web 重启复用；被拒时由 [`invalidate_session_cookie`] 清掉
static SESSION_COOKIE: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn cached_session_cookie() -> Option<String> {
    SESSION_COOKIE.lock().ok().and_then(|slot| slot.clone())
}

pub(crate) fn invalidate_session_cookie() {
    if let Ok(mut slot) = SESSION_COOKIE.lock() {
        *slot = None;
    }
}

/// 会话 cookie：命中缓存即返回，否则用当前 launch token 换一次并缓存。
/// 拿不到 token（授权插件在场、web 由外部手工启动）或换取被拒时返回 None，
/// 调用方按「本机没有可用会话」处理
pub(crate) fn session_cookie(port: u16) -> Option<String> {
    if let Some(cookie) = cached_session_cookie() {
        return Some(cookie);
    }
    let token = latest_launch_token(port)?;
    let cookie = mint_session_cookie(port, &token)?;
    if let Ok(mut slot) = SESSION_COOKIE.lock() {
        *slot = Some(cookie.clone());
    }
    Some(cookie)
}

/// 用 launch token 换会话 cookie（dsh 原生 303 兑换）。
/// 重定向必须关掉：跟随 303 会去取 `/` 并丢掉非 2xx 的 Set-Cookie
fn mint_session_cookie(port: u16, token: &str) -> Option<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(LOOPBACK_HTTP_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/"))
        .query(&[("token", token)])
        .send()
        .ok()?;
    cookie_pair(
        response.status().as_u16(),
        response
            .headers()
            .get("set-cookie")
            .and_then(|value| value.to_str().ok()),
    )
}

/// 兑换成功的判据：303 + 一条 `Set-Cookie`；只取 `name=value` 段（属性对
/// 非浏览器客户端无意义）。token 过期时 dsh 回 401，自然判为换取失败
fn cookie_pair(status: u16, set_cookie: Option<&str>) -> Option<String> {
    if status != 303 {
        return None;
    }
    let pair = set_cookie?.split(';').next()?.trim();
    (!pair.is_empty()).then(|| pair.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsh::WEB_PORT;

    #[test]
    fn launch_token_keeps_the_full_base64url_alphabet() {
        // 回归：token 含 `-`/`_` 时按字母数字截断会得到换不到 cookie 的短 token
        let token = "zMRRuA4IEOA6ZH8lZ4tTkiIw66Jbse-NR1ao4afOJx0";
        let log = format!("dsh web: http://127.0.0.1:{WEB_PORT}/?token={token}\n");
        assert_eq!(launch_token(&log, WEB_PORT), Some(token));
        assert_eq!(
            local_access_url(WEB_PORT, launch_token(&log, WEB_PORT).expect("token")),
            format!("http://127.0.0.1:{WEB_PORT}/?token={token}")
        );
        let with_underscores = format!("dsh web: http://127.0.0.1:{WEB_PORT}/?token=A_b-C1\n");
        assert_eq!(launch_token(&with_underscores, WEB_PORT), Some("A_b-C1"));
        // 端口是同一个事实：别的端口打印的 token 行不算本服务的
        assert_eq!(launch_token(&log, WEB_PORT + 1), None);
    }

    #[test]
    fn launch_token_takes_the_last_line_and_ignores_bare_addresses() {
        let log = format!(
            "dsh web: http://127.0.0.1:{WEB_PORT}/?token=Old-1\nNode.js v26.0.0\ndsh web: http://127.0.0.1:{WEB_PORT}\ndsh web: http://127.0.0.1:{WEB_PORT}/?token=New_2 trailing\n"
        );
        assert_eq!(launch_token(&log, WEB_PORT), Some("New_2"));
        assert_eq!(
            launch_token(
                &format!("dsh web: http://127.0.0.1:{WEB_PORT}\n"),
                WEB_PORT
            ),
            None
        );
        assert_eq!(
            launch_token(
                &format!("dsh web: http://127.0.0.1:{WEB_PORT}/?token=\n"),
                WEB_PORT
            ),
            None
        );
        assert_eq!(launch_token("", WEB_PORT), None);
    }

    #[test]
    fn cookie_pair_requires_a_minted_303_with_a_set_cookie() {
        assert_eq!(
            cookie_pair(303, Some("dsh-auth-abc=v1.xyz; Max-Age=2592000; Path=/")).as_deref(),
            Some("dsh-auth-abc=v1.xyz")
        );
        // 授权插件在场时索引请求是 200，没有 cookie 可换
        assert_eq!(cookie_pair(200, Some("dsh-auth-abc=v1.xyz")), None);
        // token 过期：dsh 回 401
        assert_eq!(cookie_pair(401, None), None);
        assert_eq!(cookie_pair(303, None), None);
        assert_eq!(cookie_pair(303, Some("")), None);
    }

    #[test]
    fn mint_session_cookie_exchanges_the_launch_token_over_loopback() {
        let (port, request) = crate::test_http::one_shot(
            "HTTP/1.1 303 See Other\r\nlocation: /\r\nset-cookie: dsh-auth-Sig=v1.body.sig; Max-Age=2592000; Path=/; HttpOnly\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        );
        assert_eq!(
            mint_session_cookie(port, "Tok-en_1").as_deref(),
            Some("dsh-auth-Sig=v1.body.sig")
        );
        let request = request.recv().expect("request captured");
        assert!(
            request.starts_with("GET /?token=Tok-en_1 HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(
            request.to_ascii_lowercase().contains("host: 127.0.0.1:"),
            "{request}"
        );
    }

    #[test]
    fn mint_session_cookie_refuses_a_stale_token() {
        let (port, _request) = crate::test_http::one_shot(
            "HTTP/1.1 401 Unauthorized\r\ncontent-type: text/plain\r\ncontent-length: 62\r\nconnection: close\r\n\r\ndsh web authentication required; reopen the URL printed by dsh web.\n",
        );
        assert_eq!(mint_session_cookie(port, "stale"), None);
    }

    #[test]
    fn session_cookie_cache_round_trip() {
        invalidate_session_cookie();
        assert_eq!(cached_session_cookie(), None);
        if let Ok(mut slot) = SESSION_COOKIE.lock() {
            *slot = Some("dsh-auth-x=v1".to_string());
        }
        assert_eq!(cached_session_cookie().as_deref(), Some("dsh-auth-x=v1"));
        invalidate_session_cookie();
        assert_eq!(cached_session_cookie(), None);
    }
}
