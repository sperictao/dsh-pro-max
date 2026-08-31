//! 远程一键启动（8 步时间轴）：dsh web 拉起、Tailscale serve、失败诊断与重启编排（dsh_setup 命令）。

use super::{StepEvent};
use super::{DSH_PACKAGE, RemoteRpcAccess, RemoteUrlAccess, SUPPORTED_DSH_VERSION, WEB_PORT};
use super::auth::{AuthConfig, http_get, http_ok, resolve_auth_config, resolve_fqdn, resolve_tailscale_login, rpc_ok, serve_configured, tailscale_online};
use super::autostart::{autostart_enabled, autostart_impl};
use super::components::{auth_plugins_installed, bundled_plugin_specs, dsh_dir, dsh_version, dsh_version_is_compatible, install_auth_plugins, install_supported_dsh, magic_dns_info, npm_bin, resolve_dsh_bin, resolve_host_and_url, resolve_node_bin, tailscale_path, web_profile_has_auth_plugins};
use super::probe::{probe_remote_url, proxy_bypass_host};
use super::process::{cli_command, dsh_web_cmd_pattern, dsh_web_pid, kill_by_pattern, port_listening, run_capture, spawn_detached, stop_supervised_services, wait_web_start};
use super::update::{ensure_web_profile_compat_patch};
use std::fs;
use std::path::{Path, PathBuf};

use std::time::Duration;
use tauri::{Emitter};


use crate::i18n::{tr, trf};

// ============ 一键启动（时间轴事件流） ============

pub(crate) fn emit_step(
    app: &tauri::AppHandle,
    index: usize,
    id: &str,
    state: &str,
    detail: Option<String>,
    problem: Option<String>,
    solution: Option<String>,
) {
    let _ = app.emit(
        "dsh-step",
        StepEvent {
            index,
            id: id.to_string(),
            state: state.to_string(),
            detail,
            problem,
            solution,
        },
    );
}

pub(crate) struct StepCtx<'a> {
    pub(crate) app: &'a tauri::AppHandle,
    pub(crate) index: usize,
    pub(crate) id: &'static str,
}

impl StepCtx<'_> {
    pub(crate) fn running(&self, detail: &str) {
        emit_step(self.app, self.index, self.id, "running", Some(detail.to_string()), None, None);
    }
    pub(crate) fn done(&self, detail: &str) {
        emit_step(self.app, self.index, self.id, "done", Some(detail.to_string()), None, None);
    }
    /// 失败：发出 failed 节点 + 把后续步骤标记 skipped，再返回 Err（时间轴即展示面）
    pub(crate) fn fail(&self, problem: &str, solution: &str, remaining: &[(&'static str, usize)]) -> Result<(), String> {
        self.emit_fail(problem, solution, remaining);
        Err(problem.to_string())
    }
    /// 同 fail，但返回 `Result<String, String>`：供返回 `String` 的命令
    /// （如 dsh_start_web 返回本地 URL）直接 `return ctx.fail_err(...)`
    pub(crate) fn fail_err(&self, problem: &str, solution: &str, remaining: &[(&'static str, usize)]) -> Result<String, String> {
        self.emit_fail(problem, solution, remaining);
        Err(problem.to_string())
    }
    pub(crate) fn emit_fail(&self, problem: &str, solution: &str, remaining: &[(&'static str, usize)]) {
        log::error!("[dsh 一键配置] 步骤 {} 失败: {}", self.id, problem);
        emit_step(self.app, self.index, self.id, "failed", None, Some(problem.to_string()), Some(solution.to_string()));
        for (id, idx) in remaining {
            emit_step(self.app, *idx, id, "skipped", None, None, None);
        }
    }
}

/// 后台启动 dsh web 进程：显式绑定 loopback，并把 Tailscale 登录名与按配置
/// 解析出的 use/admin App Capability 交给授权插件。不等待端口就绪，返回子进程
/// PID 供启动等待探活；
/// 失败返回 (problem, solution) 供时间轴与更新流程分别展示针对性排障提示。
/// dsh_setup 与 dsh_update 共用
pub(crate) fn spawn_dsh_web(login: &str, fqdn: Option<&str>, auth: &AuthConfig) -> Result<u32, (String, String)> {
    if web_profile_has_auth_plugins() {
        ensure_web_profile_compat_patch().map_err(|error| {
            log::error!("[dsh 启动] 修复 web profile patch 失败: {}", error);
            (error, tr("Check the log at ~/.dsh/dsh-web.log"))
        })?;
    }
    let dsh_bin = match resolve_dsh_bin() {
        Ok(b) => b,
        Err(e) => {
            log::error!("[dsh 启动] 定位 dsh CLI 失败: {}", e);
            return Err((e, tr("Install dsh first, then retry")));
        }
    };
    let mut args: Vec<String> = vec![
        "--profile".into(),
        "web".into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        WEB_PORT.to_string(),
        // dsh web 默认启动后自动打开浏览器；浏览器打开统一由前端控制
        // （一键启动成功后才 openUrl），否则一次启动会打开两个标签页
        "--no-open".into(),
    ];
    if let Some(fqdn) = fqdn.filter(|value| !value.is_empty()) {
        args.push("--trusted-host".into());
        args.push(fqdn.to_string());
    }
    let log = dsh_dir()
        .map(|d| d.join("dsh-web.log"))
        .unwrap_or_else(|_| PathBuf::from("dsh-web.log"));
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let env_pairs = auth.env_pairs(login);
    let envs: Vec<(&str, &str)> = env_pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
    spawn_detached(&dsh_bin.display().to_string(), &arg_refs, &envs, &log).map_err(|e| {
        log::error!("[dsh 启动] 拉起 dsh web 进程失败: {}", e);
        (
            e,
            tr("Port 3899 may be occupied; stop the process using it and retry"),
        )
    })
}

/// 读取日志末尾若干非空行（失败诊断用）；文件缺失/为空返回 None
pub(crate) fn read_log_tail(path: &Path, max_lines: usize) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(max_lines);
    let tail = lines[start..].join("\n");
    if tail.trim().is_empty() { None } else { Some(tail) }
}

/// 启动失败诊断：把 dsh-web.log 尾部的真实错误带进时间轴（进程崩溃时这里就是
/// 堆栈），并按常见崩溃原因给出针对性方案。只读日志，不修改任何状态
pub(crate) fn start_failure_diagnosis(log: &Path) -> (String, String) {
    let tail = read_log_tail(log, 40);
    let problem = match &tail {
        Some(t) => {
            // 问题区只取前 8 行，避免长堆栈淹没时间轴
            let short: Vec<&str> = t.lines().take(8).collect();
            trf("dsh web failed to start; log says:\n{log}", &[("log", short.join("\n"))])
        }
        None => tr("dsh web failed to start (no log output; port 3899 may be occupied)"),
    };
    let solution = match &tail {
        // Windows 首启最典型崩溃：healProfilesModuleFallback 建符号链接被拒
        Some(t) if t.contains("EPERM") || t.contains("symlink") => {
            tr("dsh could not create symlinks; on Windows enable Developer Mode (Settings → Privacy & security → For developers), then retry")
        }
        // 装过跨线 dsh（如 0.1.3-alpha.1）的机器：它把 credentials 重写成了
        // 新格式，锁定线的 CLI 读不了；引导用户手动还原为扁平 KEY: value
        Some(t) if t.contains(".credentials.yaml") && t.contains("must be a string") => {
            tr("A newer dsh rewrote ~/.dsh/.credentials.yaml into an incompatible format; open it and keep only the KEY: value lines (drop the version:/refs: wrapper), then retry")
        }
        _ => tr("Check the log at ~/.dsh/dsh-web.log; port 3899 may be occupied or the dsh CLI may need a newer Node.js"),
    };
    (problem, solution)
}

/// tailscale serve 命令（按配置转发 use/admin App Capability 到 dsh），供
/// dsh_setup 与测试共用。没有配置任何 capability 时不带 --accept-app-caps。
pub(crate) fn serve_command(auth: &AuthConfig) -> Vec<String> {
    let mut args = vec![
        "serve".to_string(),
        "--https=443".to_string(),
        "--bg".to_string(),
    ];
    let caps = auth.capabilities();
    if !caps.is_empty() {
        args.push(format!("--accept-app-caps={}", caps.join(",")));
    }
    args.push(WEB_PORT.to_string());
    args
}

/// serve 配置失败时的针对性方案：错误文本含 TLS 证书类提示（教程 3.3 强调
/// HTTPS Certificates 是与 MagicDNS 独立的开关）→ 指向 admin/dns；否则 →
/// serve 首次启用授权链接
pub(crate) fn serve_failure_solution(err: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("accept-app-caps") || e.contains("unknown flag") || e.contains("app cap") {
        tr("Tailscale 1.92+ is required to forward App Capabilities; update Tailscale, then retry")
    } else if e.contains("tls cert") || e.contains("does not support") || e.contains("certificate") {
        tr("MagicDNS or HTTPS Certificates may not be enabled; open https://login.tailscale.com/admin/dns and enable MagicDNS and HTTPS Certificates, then retry")
    } else {
        tr("Open the authorization link in the error output to enable Serve for this tailnet (https://login.tailscale.com/f/serve), then retry")
    }
}

#[tauri::command]
pub async fn dsh_setup(app: tauri::AppHandle) -> Result<(), String> {
    let steps: [&'static str; 8] = [
        "node",
        "install",
        "plugins",
        "tailscale",
        "magicdns",
        "start",
        "serve",
        "verify",
    ];
    let remaining_after = |cur: usize| -> Vec<(&'static str, usize)> {
        steps
            .iter()
            .enumerate()
            .filter(|(index, _)| *index > cur)
            .map(|(index, id)| (*id, index))
            .collect()
    };

    // 授权配置解析（域名/登录名校验）放在最前面，配置非法时立刻在首步失败，
    // 而不是等装好 dsh/Tailscale 之后才报。解析结果贯穿 start / serve 两步。
    let auth = {
        let ctx = StepCtx { app: &app, index: 0, id: steps[0] };
        match resolve_auth_config() {
            Ok(auth) => auth,
            Err(error) => {
                return ctx.fail(
                    &error,
                    &tr("Fix the remote authorization settings in Settings → DeepSeek Harness, then retry"),
                    &remaining_after(0),
                )
            }
        }
    };

    {
        let ctx = StepCtx {
            app: &app,
            index: 0,
            id: steps[0],
        };
        ctx.running(&tr("Checking Node.js & npm…"));
        let node = match resolve_node_bin() {
            Ok(node) => node,
            Err(error) => return ctx.fail(
                &error,
                &tr("Install Node.js 18+ from https://nodejs.org, then restart this app and retry"),
                &remaining_after(0),
            ),
        };
        let (npm_version, _, npm_ok) = run_capture(&npm_bin(), &["--version"]).unwrap_or_default();
        let node_version = cli_command(&node, &["--version"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default();
        let mut detail = format!("Node {}", node_version.trim());
        if npm_ok {
            detail.push_str(&format!(" · npm {}", npm_version.trim()));
        }
        ctx.done(&detail);
    }

    {
        let ctx = StepCtx {
            app: &app,
            index: 1,
            id: steps[1],
        };
        let current = dsh_version();
        if dsh_version_is_compatible(current.as_deref()) {
            // 显示实际版本而非锁定版本：同线未来 rc/稳定版也可能兼容，
            // 显示 SUPPORTED_DSH_VERSION 会让用户误以为被装回了旧版
            ctx.done(&trf(
                "Compatible dsh is installed: {version}",
                &[("version", current.clone().unwrap_or_default())],
            ));
        } else {
            ctx.running(&trf(
                "Installing the pinned dsh ({version})…",
                &[("version", SUPPORTED_DSH_VERSION.to_string())],
            ));
            match install_supported_dsh() {
                Ok(version) => ctx.done(&trf("Installed {version}", &[("version", version)])),
                Err(error) => {
                    return ctx.fail(
                        &error,
                        &trf(
                            "Check your network and npm settings, then run npm install -g {package}@{version} and retry",
                            &[
                                ("package", DSH_PACKAGE.to_string()),
                                ("version", SUPPORTED_DSH_VERSION.to_string()),
                            ],
                        ),
                        &remaining_after(1),
                    )
                }
            }
        }
    }

    {
        let ctx = StepCtx {
            app: &app,
            index: 2,
            id: steps[2],
        };
        let already_installed = bundled_plugin_specs(&app)
            .map(|specs| auth_plugins_installed(&specs))
            .unwrap_or(false);
        if already_installed {
            ctx.done(&tr("Authorization plugins are installed"));
        } else {
            ctx.running(&tr("Installing bundled dsh authorization plugins…"));
            if let Err(error) = install_auth_plugins(&app) {
                return ctx.fail(
                    &error,
                    &tr("Reinstall this Launcher if its bundled dsh plugins are missing, then retry"),
                    &remaining_after(2),
                );
            }
            ctx.done(&tr("Authorization plugins installed"));
        }
    }

    let tailscale = {
        let ctx = StepCtx {
            app: &app,
            index: 3,
            id: steps[3],
        };
        ctx.running(&tr("Checking Tailscale identity…"));
        let ts = match tailscale_path() {
            Some(ts) => ts,
            None => {
                return ctx.fail(
                    &tr("Tailscale is not installed"),
                    &tr("Install Tailscale and sign in, then run tailscale up and retry"),
                    &remaining_after(3),
                )
            }
        };
        if !tailscale_online(&ts) {
            return ctx.fail(
                &tr("Tailscale is not connected"),
                &tr("Run tailscale up and sign in with the account allowed to access dsh"),
                &remaining_after(3),
            );
        }
        let login = match resolve_tailscale_login(&ts) {
            Ok(login) => login,
            Err(error) => {
                return ctx.fail(
                    &error,
                    &tr("Update Tailscale, sign in again, and verify tailscale status --json"),
                    &remaining_after(3),
                )
            }
        };
        ctx.done(&trf(
            "Online · authorized identity: {login}",
            &[("login", login.clone())],
        ));
        (ts, login)
    };

    {
        let ctx = StepCtx {
            app: &app,
            index: 4,
            id: steps[4],
        };
        ctx.running(&tr("Checking MagicDNS…"));
        let (enabled, _) = magic_dns_info(&tailscale.0);
        if !enabled {
            return ctx.fail(
                &tr("MagicDNS is not enabled"),
                &tr("Open https://login.tailscale.com/admin/dns and enable MagicDNS and HTTPS Certificates, then retry"),
                &remaining_after(4),
            );
        }
        ctx.done(&tr("MagicDNS enabled"));
    }

    {
        let ctx = StepCtx {
            app: &app,
            index: 5,
            id: steps[5],
        };
        let fqdn = resolve_fqdn();
        if port_listening(WEB_PORT) && dsh_web_pid().is_none() {
            return ctx.fail(
                &tr("Port 3899 is occupied by another process"),
                &tr("Stop the process listening on 127.0.0.1:3899, then retry"),
                &remaining_after(5),
            );
        }
        if port_listening(WEB_PORT) {
            ctx.running(&tr("Restarting dsh web with authorization plugins…"));
            if let Err(error) = restart_dsh_web(&tailscale.1, fqdn.as_deref(), &auth) {
                return ctx.fail(
                    &error,
                    &tr("Check the log at ~/.dsh/dsh-web.log"),
                    &remaining_after(5),
                );
            }
        } else {
            ctx.running(&tr("Starting dsh web on 127.0.0.1:3899…"));
            let pid = match spawn_dsh_web(&tailscale.1, fqdn.as_deref(), &auth) {
                Ok(pid) => pid,
                Err((problem, solution)) => {
                    return ctx.fail(&problem, &solution, &remaining_after(5))
                }
            };
            if !wait_web_start(Some(pid), Duration::from_secs(60)) {
                let log = dsh_dir()
                    .map(|dir| dir.join("dsh-web.log"))
                    .unwrap_or_else(|_| PathBuf::from("dsh-web.log"));
                let (problem, solution) = start_failure_diagnosis(&log);
                return ctx.fail(&problem, &solution, &remaining_after(5));
            }
        }
        ctx.done(&tr("dsh web is running on 127.0.0.1:3899"));
    }

    {
        let ctx = StepCtx {
            app: &app,
            index: 6,
            id: steps[6],
        };
        ctx.running(&tr("Configuring Tailscale Serve directly to dsh…"));
        let serve_args = serve_command(&auth);
        let serve_refs: Vec<&str> = serve_args.iter().map(|s| s.as_str()).collect();
        let result = run_capture(&tailscale.0, &serve_refs);
        match result {
            Ok((_, _, true)) if serve_configured(&tailscale.0) => {
                let (_, url) = resolve_host_and_url();
                match url {
                    Some(url) => ctx.done(&trf("HTTPS serve ready: {url}", &[("url", url)])),
                    None => ctx.done(&tr("HTTPS serve ready")),
                }
            }
            Ok((_, err, _)) => {
                let error = if err.is_empty() {
                    "tailscale serve failed".to_string()
                } else {
                    err
                };
                return ctx.fail(
                    &trf(
                        "Serve is not enabled or failed: {error}",
                        &[("error", error.clone())],
                    ),
                    &serve_failure_solution(&error),
                    &remaining_after(6),
                );
            }
            Err(error) => {
                return ctx.fail(
                    &error,
                    &tr("Run tailscale up first to sign in, then retry"),
                    &remaining_after(6),
                )
            }
        }
    }

    {
        let ctx = StepCtx {
            app: &app,
            index: 7,
            id: steps[7],
        };
        let (_, url) = resolve_host_and_url();
        let url_text = url
            .clone()
            .unwrap_or_else(|| "https://<hostname>.ts.net".to_string());
        ctx.running(&trf(
            "Verifying remote access ({url})…",
            &[("url", url_text.clone())],
        ));
        let web_ok = http_ok(http_get(WEB_PORT, "127.0.0.1", "/").as_deref());
        let plugins_ok = bundled_plugin_specs(&app)
            .map(|specs| auth_plugins_installed(&specs))
            .unwrap_or(false);
        let serve_ok = serve_configured(&tailscale.0);
        let remote_probe = url.as_deref().map(|url| probe_remote_url(url, &auth));
        let https_ok = remote_probe
            .as_ref()
            .map(|probe| probe.direct_https_ok)
            .unwrap_or(false);
        let ws_ok = remote_probe
            .as_ref()
            .map(|probe| probe.direct_ws_ok)
            .unwrap_or(false);
        let remote_use_access = remote_probe
            .as_ref()
            .and_then(|probe| probe.remote_use_access);
        let remote_settings_access = remote_probe
            .as_ref()
            .and_then(|probe| probe.remote_settings_access);
        let remote_use_ok = remote_use_access
            .map(|access| access == RemoteRpcAccess::Ready)
            .unwrap_or(true);
        let remote_settings_ok = remote_settings_access
            .map(|access| access == RemoteRpcAccess::Ready)
            .unwrap_or(true);
        let remote_url_access = remote_probe.map(|probe| probe.access);
        let local_privileged_ok = rpc_ok(WEB_PORT, "settings/describe");

        let remote_stack_ok = web_ok
            && plugins_ok
            && serve_ok
            && https_ok
            && ws_ok
            && remote_use_ok
            && remote_settings_ok
            && local_privileged_ok;
        if remote_stack_ok && remote_url_access == Some(RemoteUrlAccess::ProxyInterference) {
            let host = url
                .as_deref()
                .and_then(proxy_bypass_host)
                .unwrap_or("<hostname>.ts.net");
            return ctx.fail(
                &trf(
                    "The local proxy is intercepting the Tailscale address: {url}",
                    &[("url", url_text)],
                ),
                &trf(
                    "Add {host} to this machine's proxy bypass / skip-proxy list, then retry",
                    &[("host", host.to_string())],
                ),
                &remaining_after(7),
            );
        }

        if remote_stack_ok && remote_url_access == Some(RemoteUrlAccess::Ready) {
            ctx.done(&trf("Remote access is ready: {url}", &[("url", url_text)]));
        } else {
            let mut checks = Vec::new();
            if !web_ok {
                checks.push(tr("dsh web is not responding on 127.0.0.1:3899"));
            }
            if !plugins_ok {
                checks.push(tr("The dsh authorization plugin profile is incomplete"));
            }
            if !serve_ok {
                checks.push(tr("Tailscale Serve is not targeting 127.0.0.1:3899"));
            }
            if !https_ok {
                checks.push(trf(
                    "HTTPS endpoint is not responding: {url}",
                    &[("url", url_text.clone())],
                ));
            }
            if !ws_ok {
                checks.push(trf(
                    "WebSocket handshake failed: {url}/api/remote.mux",
                    &[("url", url_text.clone())],
                ));
            }
            match remote_use_access {
                Some(RemoteRpcAccess::Denied) => checks.push(trf(
                    "Remote use capability was denied; grant {capability} to this identity for the dsh node in tailnet grants, then run one-click setup again",
                    &[(
                        "capability",
                        auth.use_capability
                            .clone()
                            .unwrap_or_else(|| "<domain>/cap/dsh".to_string()),
                    )],
                )),
                Some(RemoteRpcAccess::Failed) => checks.push(trf(
                    "Remote provider API is not responding: {url}/api/llm/listProviders",
                    &[("url", url_text.clone())],
                )),
                _ => {}
            }
            match remote_settings_access {
                Some(RemoteRpcAccess::Denied) => checks.push(trf(
                    "Remote admin capability was denied; grant {capability} to this identity for the dsh node in tailnet grants, then run one-click setup again",
                    &[(
                        "capability",
                        auth.admin_capability
                            .clone()
                            .unwrap_or_else(|| "<domain>/cap/dsh-admin".to_string()),
                    )],
                )),
                Some(RemoteRpcAccess::Failed) => checks.push(trf(
                    "Remote settings API is not responding: {url}/api/settings/describe",
                    &[("url", url_text.clone())],
                )),
                _ => {}
            }
            if !local_privileged_ok {
                checks.push(tr("Local privileged API access failed on 127.0.0.1:3899"));
            }
            if remote_url_access == Some(RemoteUrlAccess::ProxyInterference) {
                checks.push(trf(
                    "The local proxy is intercepting the Tailscale address: {url}",
                    &[("url", url_text.clone())],
                ));
            }
            return ctx.fail(
                &tr("Verification failed; some components are not ready"),
                &format_verification_checks(&checks),
                &remaining_after(7),
            );
        }
    }

    if autostart_enabled() {
        autostart_impl(true).map_err(|e| {
            log::error!("[dsh 一键配置] 使能自启失败: {}", e);
            e
        })?;
    }
    Ok(())
}

/// 把验证项按行列出，避免 URL 与下一项拼接成不可读的链接。
pub(crate) fn format_verification_checks(checks: &[String]) -> String {
    checks.join("\n")
}

/// 重启 dsh web，确保新 profile 和授权环境生效。
pub(crate) fn restart_dsh_web(login: &str, fqdn: Option<&str>, auth: &AuthConfig) -> Result<(), String> {
    stop_supervised_services();
    kill_by_pattern(dsh_web_cmd_pattern());
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while port_listening(WEB_PORT) && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(300));
    }
    if port_listening(WEB_PORT) {
        let err = tr("dsh web did not release port 3899");
        log::error!("[dsh 重启] {}", err);
        return Err(err);
    }
    let pid = spawn_dsh_web(login, fqdn, auth).map_err(|(problem, _)| {
        log::error!("[dsh 重启] 启动 dsh web 失败: {}", problem);
        problem
    })?;
    if !wait_web_start(Some(pid), Duration::from_secs(60)) {
        let log = dsh_dir()
            .map(|d| d.join("dsh-web.log"))
            .unwrap_or_else(|_| PathBuf::from("dsh-web.log"));
        let problem = start_failure_diagnosis(&log).0;
        log::error!("[dsh 重启] 等待 dsh web 就绪超时: {}", problem);
        return Err(problem);
    }
    Ok(())
}
