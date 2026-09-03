//! 跨平台进程与 CLI 辅助：引号转义、PATH 探测、spawn/存活/等待、按命令行模式匹配杀进程、dsh 停止。

use super::WEB_PORT;
// AUTOSTART_PREFIX 仅 macOS launchd 分支使用（常量本身 cfg(macos)）
#[cfg(target_os = "macos")]
use super::AUTOSTART_PREFIX;
use super::components::{tailscale_path};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use crate::config;
use crate::i18n::trf;

// ============ 跨平台 CLI 辅助 ============

/// Windows 命令行列转义（CommandLineToArgvW 规则的最小实现）。
/// 入参都是绝对路径/简单参数：无空格无引号原样返回；有空格则加引号，
/// 内嵌引号以反斜杠转义。反斜杠本身是字面量，绝不多写（否则 `C:\Program
/// Files\...` 会被翻倍成 `C:\\Program Files\\...` 而无法执行）。
/// 仅在 Windows 构建被 cli_command 使用；macOS/Linux 上保留给单元测试
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn win_quote(s: &str) -> String {
    if !s.contains([' ', '\t', '"']) {
        return s.to_string();
    }
    let escaped = s.replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

/// 拼一条 cmd /c 命令行。cmd 对 /c 后字符串的解析规则与 CreateProcess 不同：
/// 若字符串以引号开头，cmd 会剥掉首引号与行尾最后一个引号。因此必须把
/// 「已逐引号的程序+参数」整体再包一层引号（微软文档的标准做法）：
///   cmd /c ""C:\Program Files\Tailscale\tailscale.exe" status"
/// 若只让 std 自动引号程序路径，cmd 剥引号后会把带空格的路径拆碎。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn win_cmd_line(program: &str, args: &[&str]) -> String {
    let mut line = win_quote(program);
    for a in args {
        line.push(' ');
        line.push_str(&win_quote(a));
    }
    format!("\"{}\"", line)
}

/// Windows 上 npm/全局包是 .cmd 批处理，CreateProcess 不能直接执行，
/// 必须经 cmd /c 由 cmd 做 PATHEXT 解析，且不弹控制台窗口（同 fastctx.rs）
pub(crate) fn cli_command(program: &str, args: &[&str]) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut cmd = Command::new("cmd");
        // raw_arg 跳过 std 的自动引号（std 的 CommandLineToArgvW 引号会与
        // cmd 的 /c 解析规则打架），整个命令行按 win_cmd_line 手工构造
        cmd.raw_arg("/c").raw_arg(&win_cmd_line(program, args));
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd
    }
}

/// GUI 应用（Finder 启动）PATH 很薄，探测常见 CLI 位置补进 PATH
pub(crate) fn probe_path() -> String {
    // home 仅 macOS/Linux 用于拼接 npm 全局路径；Windows 走 APPDATA/LOCALAPPDATA
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let home = config::home_dir().unwrap_or_default();
    let mut parts: Vec<String> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        parts.push("/opt/homebrew/bin".to_string());
        parts.push("/usr/local/bin".to_string());
        if let Some(h) = home.to_str() {
            parts.push(format!("{}/.npm-global/bin", h));
        }
    }
    #[cfg(windows)]
    {
        // npm 全局前缀默认在 %APPDATA%\npm（Roaming），不是 LOCALAPPDATA
        if let Ok(roaming) = std::env::var("APPDATA") {
            parts.push(format!("{}\\npm", roaming));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            parts.push(format!("{}\\npm", local));
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            parts.push(format!("{}\\nodejs", pf));
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(h) = home.to_str() {
            parts.push(format!("{}/.local/bin", h));
            parts.push(format!("{}/.npm-global/bin", h));
        }
        parts.push("/usr/local/bin".to_string());
    }
    parts.push("/usr/bin".to_string());
    parts.push("/bin".to_string());
    #[cfg(windows)]
    if let Ok(sys) = std::env::var("SystemRoot") {
        parts.push(sys);
    }
    if let Ok(cur) = std::env::var("PATH") {
        parts.push(cur);
    }
    parts.join(if cfg!(windows) { ";" } else { ":" })
}

/// 跑命令并捕获 (stdout, stderr, 成功)。命令经 probe PATH 执行
pub(crate) fn run_capture(program: &str, args: &[&str]) -> Result<(String, String, bool), String> {
    run_capture_lines(program, args, |_| {})
}

/// 把一段流输出切成展示行：`\n` 分段后再按 `\r` 拆（pnpm 进度条用 \r 刷新
/// 同一行，不拆会积成一行巨文本），去空行去首尾空白
pub(crate) fn stream_chunk_lines(chunk: &str) -> Vec<String> {
    chunk
        .split('\n')
        .flat_map(|l| l.split('\r'))
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// 读尽一条管道：回调逐行输出（经 stream_chunk_lines 切行），同时返回拼接全文
fn collect_pipe_lines(
    pipe: impl std::io::Read + Send + 'static,
    on_line: std::sync::Arc<dyn Fn(&str) + Send + Sync>,
) -> std::thread::JoinHandle<String> {
    use std::io::BufRead;
    std::thread::spawn(move || {
        let mut collected = String::new();
        for chunk in std::io::BufReader::new(pipe).split(b'\n').flatten() {
            for line in stream_chunk_lines(&String::from_utf8_lossy(&chunk)) {
                on_line(&line);
                collected.push_str(&line);
                collected.push('\n');
            }
        }
        collected
    })
}

/// 跑命令并逐行回调输出（stdout/stderr 交错顺序不保证），仍返回与 run_capture
/// 相同的完整捕获。流式形态与 run_capture 唯一差异是回调：market 安装用它把
/// dsh/pnpm 输出实时推进前端。stdin 接 null 防子进程等输入（与 output() 一致）；
/// stdout/stderr 各一个读线程防单读堵塞；读尽再 wait，避免管道写满死锁
pub(crate) fn run_capture_lines(
    program: &str,
    args: &[&str],
    on_line: impl Fn(&str) + Send + Sync + 'static,
) -> Result<(String, String, bool), String> {
    let mut child = cli_command(program, args)
        .env("PATH", probe_path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            trf("Cannot execute {program}: {error}", &[
                ("program", program.to_string()),
                ("error", e.to_string()),
            ])
        })?;
    let on_line = std::sync::Arc::new(on_line);
    let stdout_pipe = child
        .stdout
        .take()
        .expect("stdout is piped, so take() always succeeds");
    let stderr_pipe = child
        .stderr
        .take()
        .expect("stderr is piped, so take() always succeeds");
    let out_handle = collect_pipe_lines(stdout_pipe, on_line.clone());
    let err_handle = collect_pipe_lines(stderr_pipe, on_line);
    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    let status = child.wait().map_err(|e| e.to_string())?;
    Ok((stdout.trim().to_string(), stderr.trim().to_string(), status.success()))
}

pub(crate) fn string_args(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

/// 在 probe PATH 中定位可执行文件（unix: command -v；windows: where）
pub(crate) fn which(program: &str) -> Option<String> {
    #[cfg(unix)]
    {
        let quoted = program.replace('\'', "'\\''");
        let out = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("command -v '{}'", quoted))
            .env("PATH", probe_path())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：GUI 应用拉起 cmd 不能闪控制台窗口
        // （v0.2.1 修过同一问题，dsh 模块新增时漏带，回归）
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let out = Command::new("cmd")
            .args(["/c", "where", program])
            .creation_flags(CREATE_NO_WINDOW)
            .env("PATH", probe_path())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        // where 返回全部匹配（按 PATH 顺序），每行一个。cmd /c 只能直接执行
        // .cmd/.bat/.exe——.ps1 经 cmd 执行会失败（实机回归：where dsh 返回
        // dsh.ps1 在前，run_capture 跑 dsh.ps1 --version 失败 → 误判未安装
        // → 一键启动装回锁定版本）。优先挑 cmd 可直接执行的扩展名
        let lines: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        let executable = |p: &str| {
            let lower = p.to_lowercase();
            lower.ends_with(".cmd") || lower.ends_with(".bat") || lower.ends_with(".exe")
        };
        lines
            .iter()
            .find(|p| executable(p))
            .or_else(|| lines.first())
            .cloned()
    }
}

/// 端口是否已有进程监听（dsh 运行状态的权威判断，跨平台）
pub(crate) fn port_listening(port: u16) -> bool {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
    TcpStream::connect_timeout(
        &SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        Duration::from_millis(400),
    )
    .is_ok()
}

/// 后台启动进程并立即返回（孤儿进程继续运行；日志重定向到文件）。
/// 返回子进程 PID，供启动等待期间探活（进程已死则提前失败，不干等超时）。
/// 说明：dsh web 是常驻服务，不能随启动器退出而被杀，
/// 这里不持有 Child 句柄，与 ProcessManager 的随窗停服务语义刻意不同
pub(crate) fn spawn_detached(program: &str, args: &[&str], envs: &[(&str, &str)], log: &Path) -> Result<u32, String> {
    let dir = log.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)
        .map_err(|e| {
            log::error!("[dsh 启动] 创建日志目录失败: {}", e);
            trf("Failed to create directory: {error}", &[("error", e.to_string())])
        })?;
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| {
            log::error!("[dsh 启动] 打开日志文件失败: {}", e);
            trf("Cannot open log file: {error}", &[("error", e.to_string())])
        })?;
    let mut cmd = cli_command(program, args);
    cmd.env("PATH", probe_path())
        .stdout(std::process::Stdio::from(file.try_clone().map_err(|e| {
            log::error!("[dsh 启动] 复制日志文件句柄失败: {}", e);
            e.to_string()
        })?))
        .stderr(std::process::Stdio::from(file));
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let child = cmd
        .spawn()
        .map_err(|e| {
            log::error!("[dsh 启动] 启动子进程失败: {}", e);
            trf("Cannot start process: {error}", &[("error", e.to_string())])
        })?;
    Ok(child.id())
}

/// 进程是否仍存活（unix: kill(pid,0)；windows: OpenProcess + 退出码 STILL_ACTIVE）
pub(crate) fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
            let mut code = 0u32;
            // STILL_ACTIVE = 259
            let alive = GetExitCodeProcess(h, &mut code).is_ok() && code == 259;
            let _ = CloseHandle(h);
            alive
        }
    }
}

/// 等待 dsh web 就绪：轮询端口绑定；子进程已退出则提前返回失败（配合日志诊断快速报错）。
/// 首启可能较慢（首次初始化 / 杀软扫描新装的 dsh 包），进程活着就继续等到超时
pub(crate) fn wait_web_start(pid: Option<u32>, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if port_listening(WEB_PORT) {
            return true;
        }
        if let Some(pid) = pid {
            if !process_alive(pid) {
                return false;
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    port_listening(WEB_PORT)
}

/// dsh web 进程命令行特征。ps/pgrep 按连续子串匹配：spawn_dsh_web 实际拉起的是
/// `dsh --profile web --host 127.0.0.1 --port 3899`，`--host 127.0.0.1` 插在
/// `profile web` 与 `--port 3899` 之间，连写 `"profile web --port 3899"` 永远
/// 命不中（v1.5.0 回归：一键启动后点停止无效）。用 ERE 让两侧顺序都可命中，
/// 并保留旧形态以覆盖更早版本遗留进程。
pub(crate) fn dsh_web_cmd_pattern() -> &'static str {
    "profile web.*--port 3899|--port 3899.*profile web"
}

/// 把最小 ERE 子集（`|` 分支、`.*` 任意段）翻译成 PowerShell -like 通配串，
/// 供 Windows 的进程匹配使用（dsh_web_pid / kill_by_pattern 一致性）。
/// 纯字面量（如 loopback-proxy.js）不含 `.*`，原样包上前后 `*`。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn ere_to_ps_wildcards(pattern: &str) -> Vec<String> {
    pattern
        .split('|')
        .map(|alt| format!("*{}*", alt.replace(".*", "*")))
        .collect()
}

/// PowerShell `$_.CommandLine -like '...'` 子句串（多个特征用 -or 连接）。
/// kill_by_pattern 与 dsh_web_pid 的 Windows 分支共用同一套进程匹配条件
#[cfg(windows)]
pub(crate) fn ps_commandline_clauses(pattern: &str) -> String {
    ere_to_ps_wildcards(pattern)
        .iter()
        .map(|w| format!("$_.CommandLine -like '{}'", w.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(" -or ")
}

/// 按命令行特征杀进程（unix: pkill；windows: powershell）
pub(crate) fn kill_by_pattern(pattern: &str) {
    #[cfg(unix)]
    {
        let _ = Command::new("pkill").arg("-f").arg(pattern).output();
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：停止/重启 dsh 时不能闪 powershell 控制台窗口
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let script = format!(
            "Get-CimInstance Win32_Process | Where-Object {{ {} }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}",
            ps_commandline_clauses(pattern)
        );
        let _ = Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

/// 按命令行特征找 dsh web 进程 PID（dsh_web_cmd_pattern() 的 ERE）。
/// Windows 上 dsh web 是 `node ...\dsh\dist\index.js --profile web --port 3899`
/// （npm 包布局），同一特征三平台都能命中；找不到返回 None
pub(crate) fn dsh_web_pid() -> Option<u32> {
    #[cfg(unix)]
    {
        let out = Command::new("pgrep")
            .arg("-f")
            .arg(dsh_web_cmd_pattern())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout).lines().next()?.trim().parse().ok()
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let script = format!(
            "Get-CimInstance Win32_Process | Where-Object {{ {} }} | Select-Object -First 1 -ExpandProperty ProcessId",
            ps_commandline_clauses(dsh_web_cmd_pattern())
        );
        let out = Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }
}
// ============ 停止 ============

/// 停止自启监管下的 dsh 服务（launchd / systemd --user）；best-effort。
/// 只停当前会话、不动开机自启配置：launchd 用不带 -w 的 unload（plist 保留，
/// 下次登录仍自启）；systemd stop ≠ disable，干净停止不触发 on-failure 重启。
/// Windows 自启是启动文件夹 .vbs（仅登录时跑一次，无 KeepAlive），无需处理
pub(crate) fn stop_supervised_services() {
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = config::home_dir() {
            let agents = home.join("Library/LaunchAgents");
            for name in ["web", "proxy"] {
                let plist = agents.join(format!("{}.{}.plist", AUTOSTART_PREFIX, name));
                if plist.exists() {
                    let _ = Command::new("launchctl").arg("unload").arg(&plist).output();
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("systemctl")
            .args(["--user", "stop", "dsh-remote-web.service", "dsh-remote-proxy.service"])
            .output();
    }
}

#[tauri::command]
pub fn dsh_stop() -> Result<(), String> {
    // 先停自启监管再杀进程，避免 KeepAlive/Restart 立即拉活。
    stop_supervised_services();
    // 兜底：未经自启机制、由一键启动直接拉起的游离进程。
    // 注意：Windows 上 dsh web 的进程命令行是
    // `node ...\dsh\dist\index.js --profile web --port 3899`（npm 包布局），
    // 不以 "dsh --profile" 开头；dsh_web_cmd_pattern() 的 ERE 在 macOS 直启
    // （--host 127.0.0.1 插在 profile web 与 --port 3899 之间）、launchd 与
    // Windows shim 三条路径都能命中，且不以 `-` 开头（pkill 不会误当选项）
    kill_by_pattern(dsh_web_cmd_pattern());
    // 迁移清理：旧 Launcher 可能留下运行中的 loopback 反代。
    kill_by_pattern("loopback-proxy.js");
    // 一并关闭 HTTPS Serve，避免远程 URL 指向已停止的 dsh。
    if let Some(ts) = tailscale_path() {
        let _ = run_capture(&ts, &["serve", "--https=443", "off"]);
    }
    Ok(())
}
