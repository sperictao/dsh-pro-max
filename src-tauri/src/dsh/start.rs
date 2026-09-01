//! 本地一键启动（4 步时间轴）：仅 loopback 的 dsh web 启动链（dsh_start_web 命令）。


use super::setup::{StepCtx};
use super::{LOCAL_ONLY_LOGIN, SUPPORTED_DSH_VERSION, WEB_PORT};
use super::auth::{AuthConfig};
use super::components::{dsh_dir, dsh_version, dsh_version_is_compatible, install_supported_dsh, resolve_node_bin};
use super::process::{dsh_web_pid, port_listening, wait_web_start};
use super::setup::{emit_step, restart_dsh_web, spawn_dsh_web, start_failure_diagnosis};
use std::fs;
use std::path::{PathBuf};

use std::time::Duration;


use crate::i18n::{tr, trf};

// ============ 一键启动 dsh（纯本地链路） ============

/// 本地一键启动的步骤集（与远程 dsh_setup 的 8 步不同，只含 node/install/start/ready）
pub(crate) const LOCAL_STEPS: [&str; 4] = ["node", "install", "start", "ready"];

/// 从 dsh-web.log 内容解析最近一次启动打印的本机访问地址。dsh 原生方式：
/// 无授权插件的 web 以 launch token 鉴权，启动时把带 token 的地址打印进
/// 日志，浏览器打开后以 303 换取持久 cookie。只认带 ?token= 的行（授权
/// 插件在场时 dsh 打印的是裸地址，无 token 也可访问，不必返回）；多次
/// 启动追加日志，取最后一次。纯函数供测试
pub(crate) fn local_access_url_from_log_contents(contents: &str) -> Option<String> {
    let prefix = format!("dsh web: http://127.0.0.1:{WEB_PORT}/?token=");
    contents
        .lines()
        .rfind(|line| line.contains(&prefix))
        .and_then(|line| {
            let rest = line.split_once(&prefix)?.1;
            let token: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            (!token.is_empty()).then(|| format!("http://127.0.0.1:{WEB_PORT}/?token={token}"))
        })
}

/// 读取 dsh-web.log 解析本机访问地址；日志缺失/无 token 行返回 None。
/// offset 为本次启动动作前记录的日志末尾：日志只追加不轮转，旧实例的
/// token 行会一直留在文件里，重启后 web 换 token，若把旧行当成本次地址
/// 返回，浏览器拿死 token 访问必然 401——因此只解析 offset 之后追加的区域
pub(crate) fn local_access_url(offset: usize) -> Option<String> {
    let log = dsh_dir().ok()?.join("dsh-web.log");
    let contents = fs::read_to_string(log).ok()?;
    local_access_url_from_log_contents(fresh_log_region(&contents, offset))
}

/// 只取 offset 之后追加的日志区域。offset 越界（日志被清空/轮转）按空区域
/// 处理：等待超时后走裸地址回退，也不该把来历不明的旧行交出去；offset 恰好
/// 落在多字节字符中间（文件被替换成不同内容）回退整份日志，保证不 panic
pub(crate) fn fresh_log_region(contents: &str, offset: usize) -> &str {
    contents.get(offset.min(contents.len())..).unwrap_or(contents)
}

/// 记录本次启动动作前的日志末尾偏移，供 local_access_url 圈定解析区域
fn dsh_web_log_len() -> usize {
    dsh_dir()
        .ok()
        .and_then(|dir| fs::read_to_string(dir.join("dsh-web.log")).ok())
        .map(|contents| contents.len())
        .unwrap_or(0)
}

/// 本地访问地址（dsh_start_web 的返回值）：启动后 dsh 已把带 token 的地址
/// 打进日志，但打印与端口就绪的先后无保证，短重试兜底时序差；解析不到
/// （如 web 由外部手工启动、其 token 只落在终端，日志新区域里没有 token 行）
/// 回退裸地址，由 dsh 自己的 401 页面提示重新打开
fn wait_local_access_url(offset: usize) -> String {
    for _ in 0..20 {
        if let Some(url) = local_access_url(offset) {
            return url;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    format!("http://127.0.0.1:{WEB_PORT}")
}

/// 一键启动 dsh web 并返回本机访问地址（不碰 Tailscale Serve）。
/// 本地访问遵循 dsh 原生方式：不安装授权插件，用不可能命中的远程登录名
/// 启动；web 以 dsh 自身的 launch token 鉴权，启动时把带 token 的地址打印
/// 进 dsh-web.log，这里解析出该地址交给前端打开——浏览器经 token 换取
/// 持久 cookie 后即为 dsh 原生的已登录会话（web 重启会换 token，需重新
/// 从本应用打开）。与 dsh_setup 一样按 LOCAL_STEPS 逐步发出 dsh-step 事件，
/// 前端时间轴据此显示本地模式安装进度
#[tauri::command]
pub async fn dsh_start_web(app: tauri::AppHandle) -> Result<String, String> {
    let steps = LOCAL_STEPS;
    let remaining_after = |cur: usize| -> Vec<(&'static str, usize)> {
        steps
            .iter()
            .enumerate()
            .filter(|(index, _)| *index > cur)
            .map(|(index, id)| (*id, index))
            .collect()
    };

    {
        let ctx = StepCtx {
            app: &app,
            index: 0,
            id: steps[0],
        };
        ctx.running(&tr("Checking Node.js & npm…"));
        match resolve_node_bin() {
            Ok(_) => ctx.done(&tr("Node.js is available")),
            Err(error) => {
                return ctx.fail_err(
                    &error,
                    &tr("Install Node.js 18+ from https://nodejs.org, then restart this app and retry"),
                    &remaining_after(0),
                )
            }
        }
    }

    {
        let ctx = StepCtx {
            app: &app,
            index: 1,
            id: steps[1],
        };
        let current = dsh_version();
        if dsh_version_is_compatible(current.as_deref()) {
            // 显示实际版本而非锁定版本（同 dsh_setup 的修复）
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
                    return ctx.fail_err(&error, &tr("Check your network and npm settings, then retry"), &remaining_after(1))
                }
            }
        }
    }

    if port_listening(WEB_PORT) {
        if dsh_web_pid().is_none() {
            let ctx = StepCtx {
                app: &app,
                index: 2,
                id: steps[2],
            };
            let err = tr("Port 3899 is occupied by another process");
            return ctx.fail_err(&err, &tr("Stop the process listening on 127.0.0.1:3899"), &remaining_after(2));
        }
        // 已在跑：本地访问不依赖 trusted-host，直接用。若刚才装了新 dsh 则重启生效
        // 锚点须在重启动作前记录：重启会换 token，只有重启之后打印的
        // token 行才是活实例的
        let log_offset = dsh_web_log_len();
        {
            let ctx = StepCtx {
                app: &app,
                index: 2,
                id: steps[2],
            };
            ctx.running(&tr("Restarting dsh web…"));
            if let Err(error) = restart_dsh_web(LOCAL_ONLY_LOGIN, None, &AuthConfig::default()) {
                return ctx.fail_err(&error, &tr("Check the log at ~/.dsh/dsh-web.log"), &remaining_after(2));
            }
            ctx.done(&tr("dsh web is running on 127.0.0.1:3899"));
        }
        emit_step(
            &app,
            3,
            steps[3],
            "done",
            Some(tr("Local access is ready")),
            None,
            None,
        );
        return Ok(wait_local_access_url(log_offset));
    }

    let start_idx = 2;
    let ctx = StepCtx {
        app: &app,
        index: start_idx,
        id: steps[start_idx],
    };
    ctx.running(&tr("Starting dsh web on 127.0.0.1:3899…"));
    let log_offset = dsh_web_log_len();
    let pid = match spawn_dsh_web(LOCAL_ONLY_LOGIN, None, &AuthConfig::default()) {
        Ok(pid) => pid,
        Err((problem, solution)) => {
            return ctx.fail_err(&problem, &solution, &remaining_after(start_idx));
        }
    };
    if !wait_web_start(Some(pid), Duration::from_secs(60)) {
        let log = dsh_dir()
            .map(|d| d.join("dsh-web.log"))
            .unwrap_or_else(|_| PathBuf::from("dsh-web.log"));
        let (problem, solution) = start_failure_diagnosis(&log);
        return ctx.fail_err(&problem, &solution, &remaining_after(start_idx));
    }
    ctx.done(&tr("dsh web is running on 127.0.0.1:3899"));

    let ctx = StepCtx {
        app: &app,
        index: 3,
        id: steps[3],
    };
    ctx.done(&tr("Local access is ready"));
    Ok(wait_local_access_url(log_offset))
}
