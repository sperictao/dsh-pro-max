//! 本地一键启动（4 步时间轴）：仅 loopback 的 dsh web 启动链（dsh_start_web 命令）。

use super::auth::{any_http_status, http_get, AuthConfig};
use super::components::{
    dsh_dir, dsh_version, dsh_version_is_compatible, install_supported_dsh, resolve_node_bin,
};
use super::process::{dsh_web_pid, port_listening, process_alive, wait_web_start};
use super::setup::StepCtx;
use super::setup::{restart_dsh_web, spawn_dsh_web, start_failure_diagnosis};
use super::{LOCAL_ONLY_LOGIN, SUPPORTED_DSH_VERSION, WEB_PORT};
use std::fs;
use std::path::PathBuf;

use std::time::Duration;

use crate::i18n::keyf;

// ============ 一键启动 dsh（纯本地链路） ============

/// 本地一键启动的步骤集（与远程 dsh_setup 的 8 步不同，只含 node/install/start/ready）。
/// 步骤编排序列的唯一事实来源：super::steps() 供派生时间轴与前端 schema 共用
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
    contents
        .get(offset.min(contents.len())..)
        .unwrap_or(contents)
}

/// 记录本次启动动作前的日志末尾偏移，供 local_access_url 圈定解析区域
fn dsh_web_log_len() -> usize {
    dsh_dir()
        .ok()
        .and_then(|dir| fs::read_to_string(dir.join("dsh-web.log")).ok())
        .map(|contents| contents.len())
        .unwrap_or(0)
}

/// 本地访问地址的等待编排（dsh_start_web 返回值的决策核）：probe 模拟一次日志
/// 解析尝试，sleep 模拟一轮等待间隔。重试预算、间隔与裸地址回退全部在这一个
/// 函数里，真实 fs/时钟停在调它的薄壳上（编排 bug 的实测面）
pub(crate) fn resolve_local_access_url(
    mut probe: impl FnMut() -> Option<String>,
    mut sleep: impl FnMut(),
) -> String {
    for _ in 0..20 {
        if let Some(url) = probe() {
            return url;
        }
        sleep();
    }
    format!("http://127.0.0.1:{WEB_PORT}")
}

/// 本地访问地址（dsh_start_web 的返回值）：启动后 dsh 已把带 token 的地址
/// 打进日志，但打印与端口就绪的先后无保证，短重试兜底时序差；解析不到
/// （如 web 由外部手工启动、其 token 只落在终端，日志新区域里没有 token 行）
/// 回退裸地址，由 dsh 自己的 401 页面提示重新打开
fn wait_local_access_url(offset: usize) -> String {
    resolve_local_access_url(
        || local_access_url(offset),
        || std::thread::sleep(Duration::from_millis(500)),
    )
}

// ============ ready 步验证：端口绑定 ≠ 可用 ============

/// ready 步等待的判定结果。
pub(crate) enum LocalReady {
    /// dsh 对 loopback HTTP 已应答（任何状态码）：浏览器可访问
    Responding,
    /// 进程已死：boot 后崩溃，dsh-web.log 里有具体报错
    Dead,
    /// 进程活着但始终不应答
    Unresponsive,
}

/// 本地就绪的等待编排（决策核，probe 模拟一轮探测）。两个阶段：
/// ①等待首次 HTTP 应答（probes × 间隔），应答前进程死亡即判 Dead；
/// ②应答后的稳定观察（soak 轮）：首次应答不代表 boot 完成——dsh 的插件树
/// 激活发生在服务开始应答之后，激活崩溃会把「已就绪」变成秒死的死页
/// （本机 dsh-tui/agent-teams 事故实测：token 已打印、页面已可访问，数秒后
/// 进程死掉，界面却全绿无报错）。观察期内死亡或停止应答都判 Dead，把日志
/// 诊断带进时间轴。纯函数供测试
pub(crate) fn poll_local_ready(
    mut http: impl FnMut() -> bool,
    mut alive: impl FnMut() -> bool,
    mut sleep: impl FnMut(),
    probes: usize,
    soak: usize,
) -> LocalReady {
    let answered = 'first: {
        for _ in 0..probes {
            if http() {
                break 'first true;
            }
            if !alive() {
                return LocalReady::Dead;
            }
            sleep();
        }
        break 'first http();
    };
    if !answered {
        if !alive() {
            return LocalReady::Dead;
        }
        return LocalReady::Unresponsive;
    }
    for _ in 0..soak {
        sleep();
        if !alive() {
            return LocalReady::Dead;
        }
        if !http() {
            return LocalReady::Dead;
        }
    }
    LocalReady::Responding
}

/// dsh 是否对本机 HTTP 请求给出了状态行。本地模式裸 `/` 未带 token 时
/// 401/404 是健康应答（浏览器经 token URL 换 cookie 后才是 200），不沿用
/// http_ok 的 2xx/3xx 门槛
fn local_http_responding() -> bool {
    any_http_status(http_get(WEB_PORT, "127.0.0.1", "/").as_deref())
}

/// ready 步的等待薄壳：首次应答预算 20 × 500ms，应答后再观察 6 × 500ms
/// （健康 dsh 绑端口后 1s 内应答，插件激活崩溃在其后数秒内现形）
fn wait_local_ready(pid: u32) -> LocalReady {
    poll_local_ready(
        local_http_responding,
        || process_alive(pid),
        || std::thread::sleep(Duration::from_millis(500)),
        20,
        6,
    )
}

/// ready 步（本地访问就绪）的验证编排，两条启动路径（冷启 / 已在跑重启）共用：
/// 验证通过才返回访问地址；进程死亡以日志诊断失败（具体报错进时间轴），
/// 不应答超时同样失败——「端口绑定过」不构成就绪
fn verify_local_ready(
    app: &tauri::AppHandle,
    steps: [&'static str; 4],
    pid: u32,
    log_offset: usize,
) -> Result<String, String> {
    let ctx = StepCtx {
        app,
        index: 3,
        id: steps[3],
    };
    ctx.running("Verifying local access…");
    match wait_local_ready(pid) {
        LocalReady::Responding => {
            ctx.done("Local access is ready");
            Ok(wait_local_access_url(log_offset))
        }
        LocalReady::Dead => {
            let log = dsh_dir()
                .map(|d| d.join("dsh-web.log"))
                .unwrap_or_else(|_| PathBuf::from("dsh-web.log"));
            let (problem, solution) = start_failure_diagnosis(&log);
            ctx.fail_err(&problem, &solution, &[])
        }
        LocalReady::Unresponsive => ctx.fail_err(
            "dsh web started but is not responding on 127.0.0.1:3899",
            "Check the log at ~/.dsh/dsh-web.log",
            &[],
        ),
    }
}

/// 一键启动 dsh web 并返回本机访问地址（不碰 Tailscale Serve）。
/// 本地访问遵循 dsh 原生方式：不安装授权插件，用不可能命中的远程登录名
/// 启动；web 以 dsh 自身的 launch token 鉴权，启动时把带 token 的地址打印
/// 进 dsh-web.log，这里解析出该地址交给前端打开——浏览器经 token 换取
/// 持久 cookie 后即为 dsh 原生的已登录会话（web 重启会换 token，需重新
/// 从本应用打开）。与 dsh_setup 一样按 LOCAL_STEPS 逐步发出 dsh-step 事件，
/// 前端时间轴据此显示本地模式安装进度。ready 步是真实就绪验证（HTTP 应答
/// + 进程存活），boot 后崩溃会以失败节点带上日志里的具体报错
#[tauri::command]
pub async fn dsh_start_web(app: tauri::AppHandle) -> Result<String, String> {
    // 全程阻塞 I/O（npm 安装、进程拉起、最长 60s 端口等待 + 10s token 轮询）：
    // 走统一 adapter，事件经 move 进去的 AppHandle 照常 emit
    super::ipc_blocking(move || dsh_start_web_once(&app)).await
}

fn dsh_start_web_once(app: &tauri::AppHandle) -> Result<String, String> {
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
            app,
            index: 0,
            id: steps[0],
        };
        ctx.running("Checking Node.js & npm…");
        match resolve_node_bin() {
            Ok(_) => ctx.done("Node.js is available"),
            Err(error) => {
                return ctx.fail_err(
                    &error,
                    "Install Node.js 18+ from https://nodejs.org, then restart this app and retry",
                    &remaining_after(0),
                )
            }
        }
    }

    {
        let ctx = StepCtx {
            app,
            index: 1,
            id: steps[1],
        };
        let current = dsh_version();
        if dsh_version_is_compatible(current.as_deref()) {
            // 显示实际版本而非锁定版本（同 dsh_setup 的修复）
            ctx.done(&keyf(
                "Compatible dsh is installed: {version}",
                &[("version", current.clone().unwrap_or_default())],
            ));
        } else {
            ctx.running(&keyf(
                "Installing the pinned dsh ({version})…",
                &[("version", SUPPORTED_DSH_VERSION.to_string())],
            ));
            match install_supported_dsh() {
                Ok(version) => ctx.done(&keyf("Installed {version}", &[("version", version)])),
                Err(error) => {
                    return ctx.fail_err(
                        &error,
                        "Check your network and npm settings, then retry",
                        &remaining_after(1),
                    )
                }
            }
        }
    }

    if port_listening(WEB_PORT) {
        if dsh_web_pid().is_none() {
            let ctx = StepCtx {
                app,
                index: 2,
                id: steps[2],
            };
            let err = "Port 3899 is occupied by another process".to_string();
            return ctx.fail_err(
                &err,
                "Stop the process listening on 127.0.0.1:3899",
                &remaining_after(2),
            );
        }
        // 已在跑：本地访问不依赖 trusted-host，直接用。若刚才装了新 dsh 则重启生效
        // 锚点须在重启动作前记录：重启会换 token，只有重启之后打印的
        // token 行才是活实例的
        let log_offset = dsh_web_log_len();
        let pid = {
            let ctx = StepCtx {
                app,
                index: 2,
                id: steps[2],
            };
            ctx.running("Restarting dsh web…");
            match restart_dsh_web(LOCAL_ONLY_LOGIN, None, &AuthConfig::default()) {
                Ok(pid) => {
                    ctx.done("dsh web is running on 127.0.0.1:3899");
                    pid
                }
                Err(error) => {
                    return ctx.fail_err(
                        &error,
                        "Check the log at ~/.dsh/dsh-web.log",
                        &remaining_after(2),
                    );
                }
            }
        };
        return verify_local_ready(app, steps, pid, log_offset);
    }

    let start_idx = 2;
    let ctx = StepCtx {
        app,
        index: start_idx,
        id: steps[start_idx],
    };
    ctx.running("Starting dsh web on 127.0.0.1:3899…");
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
    ctx.done("dsh web is running on 127.0.0.1:3899");
    verify_local_ready(app, steps, pid, log_offset)
}
