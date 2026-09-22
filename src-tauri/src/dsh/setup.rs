//! 远程一键启动（8 步时间轴）：dsh web 拉起、Tailscale serve、失败诊断与重启编排（dsh_setup 命令）。

use super::auth::{
    any_http_status, http_get, resolve_auth_config, resolve_fqdn, resolve_tailscale_login, rpc_ok,
    serve_configured, tailscale_online, AuthConfig,
};
use super::autostart::{autostart_enabled, autostart_impl};
use super::compat::done_detail_with_preflight;
use super::components::{
    auth_plugins_installed, bundled_plugin_specs, decide_pinned_dsh, dsh_dir, dsh_version,
    install_auth_plugins, install_supported_dsh, magic_dns_info, npm_bin, resolve_dsh_bin,
    resolve_host_and_url, resolve_node_bin, tailscale_path, PinnedDshDecision,
};
use super::probe::{probe_remote_url, proxy_bypass_host};
use super::process::{
    clear_stale_credentials_lock, cli_command, dsh_web_cmd_pattern, dsh_web_pid, kill_by_pattern,
    port_listening, run_capture, spawn_detached, stop_supervised_services, wait_web_start,
};
use super::session;
use super::update::clear_web_profile_compat_entry;
use super::StepEvent;
use super::{
    RemoteRpcAccess, RemoteUrlAccess, AUTH_PLUGIN_PACKAGE, CONNECTION_PLUGIN_PACKAGE, DSH_PACKAGE,
    SUPPORTED_DSH_VERSION, WEB_PORT,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use std::time::Duration;
use tauri::Emitter;

use crate::i18n::{Message, MessageArg};

// ============ 一键启动（时间轴事件流） ============

// 8 个参数是 StepEvent 的天然字段宽度（步骤定位 3 + 四态文本 4 + 标题键 1），
// 全部调用点经 StepCtx 转发同构数据，为 lint 拆结构体不值
#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_step(
    app: &tauri::AppHandle,
    index: usize,
    id: &str,
    state: &str,
    detail: Vec<Message>,
    problem: Option<Message>,
    solution: Option<Message>,
    action_plugin: Option<String>,
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
            action_plugin,
            title_key: None, // 事件流节点的标题已由骨架就位，不重复携带
        },
    );
}

pub(crate) struct StepCtx<'a> {
    pub(crate) app: &'a tauri::AppHandle,
    pub(crate) index: usize,
    pub(crate) id: &'static str,
}

impl StepCtx<'_> {
    pub(crate) fn running(&self, detail: impl Into<Message>) {
        emit_step(
            self.app,
            self.index,
            self.id,
            "running",
            vec![detail.into()],
            None,
            None,
            None,
        );
    }
    pub(crate) fn done(&self, detail: impl Into<Message>) {
        emit_step(
            self.app,
            self.index,
            self.id,
            "done",
            vec![detail.into()],
            None,
            None,
            None,
        );
    }
    /// done 附带插件动作披露：peer 兼容预检发现失配插件时，节点 detail 追加
    /// 失配清单并携带 action_plugin，前端在成功节点上同样渲染「禁用并重试」
    pub(crate) fn done_noting(&self, detail: Vec<Message>, action_plugin: Option<String>) {
        emit_step(
            self.app,
            self.index,
            self.id,
            "done",
            detail,
            None,
            None,
            action_plugin,
        );
    }
    /// 失败：发出 failed 节点 + 把后续步骤标记 skipped，再返回 Err（时间轴即展示面）
    pub(crate) fn fail(
        &self,
        problem: impl Into<Message>,
        solution: impl Into<Message>,
        remaining: &[(&'static str, usize)],
    ) -> Result<(), Message> {
        let problem = problem.into();
        self.emit_fail(problem.clone(), solution.into(), remaining);
        Err(problem)
    }
    /// 同 fail，但返回 `Result<String, Message>`：供返回 `String` 的命令
    /// （如 dsh_start_web 返回本地 URL）直接 `return ctx.fail_err(...)`
    pub(crate) fn fail_err(
        &self,
        problem: impl Into<Message>,
        solution: impl Into<Message>,
        remaining: &[(&'static str, usize)],
    ) -> Result<String, Message> {
        let problem = problem.into();
        self.emit_fail(problem.clone(), solution.into(), remaining);
        Err(problem)
    }
    /// 启动失败诊断入时间轴：失败节点额外携带 actionPlugin（可一键禁用
    /// 重试的第三方插件）时，前端在节点上渲染对应按钮
    pub(crate) fn fail_diagnosis(
        &self,
        failure: &StartFailureDiagnosis,
        remaining: &[(&'static str, usize)],
    ) -> Result<(), Message> {
        self.emit_fail_diagnosis(failure, remaining);
        Err(failure.problem.clone())
    }
    /// 同 fail_diagnosis，返回 `Result<String, Message>`（同 fail_err 之于 fail）
    pub(crate) fn fail_err_diagnosis(
        &self,
        failure: &StartFailureDiagnosis,
        remaining: &[(&'static str, usize)],
    ) -> Result<String, Message> {
        self.emit_fail_diagnosis(failure, remaining);
        Err(failure.problem.clone())
    }
    pub(crate) fn emit_fail(
        &self,
        problem: impl Into<Message>,
        solution: impl Into<Message>,
        remaining: &[(&'static str, usize)],
    ) {
        self.emit_fail_diagnosis(
            &StartFailureDiagnosis {
                problem: problem.into(),
                solution: solution.into(),
                action_plugin: None,
                repairable: false,
            },
            remaining,
        );
    }
    fn emit_fail_diagnosis(
        &self,
        failure: &StartFailureDiagnosis,
        remaining: &[(&'static str, usize)],
    ) {
        log::error!("[dsh 一键配置] 步骤 {} 失败: {}", self.id, failure.problem);
        emit_step(
            self.app,
            self.index,
            self.id,
            "failed",
            Vec::new(),
            non_empty(&failure.problem),
            non_empty(&failure.solution),
            failure.action_plugin.clone(),
        );
        for (id, idx) in remaining {
            emit_step(self.app, *idx, id, "skipped", Vec::new(), None, None, None);
        }
    }
}

/// 空消息不是消息：验证项一条都没命中时 solution 是空 key，前端不该为它渲染
/// 空白块（旧 `Option<String>` 形态下空串是假值，同样不展示）
fn non_empty(message: &Message) -> Option<Message> {
    if message.key.is_empty() {
        None
    } else {
        Some(message.clone())
    }
}

/// 后台启动 dsh web 进程：显式绑定 loopback，并把 Tailscale 登录名（有身份
/// 才注入；无 = 授权插件默认拒绝全部远程登录）与按配置解析出的 use/admin
/// App Capability 交给授权插件。不等待端口就绪，返回子进程
/// PID 供启动等待探活；
/// 失败返回 (problem, solution) 供时间轴与更新流程分别展示针对性排障提示。
/// dsh_setup 与 dsh_update 共用
pub(crate) fn spawn_dsh_web(
    login: Option<&str>,
    fqdn: Option<&str>,
    auth: &AuthConfig,
) -> Result<u32, (Message, Message)> {
    // 孤儿 credentials 写锁会让 boot 在锁等待上超时崩溃（持锁进程被强杀后
    // dsh 永不回收）；持锁 PID 已死才清，活锁是真实并发不碰
    clear_stale_credentials_lock(Duration::ZERO);
    // 清理历史版本写入的 compat 条目（幂等，无存量时零成本），每次启动顺路过一遍
    clear_web_profile_compat_entry();
    let dsh_bin = match resolve_dsh_bin() {
        Ok(b) => b,
        Err(e) => {
            log::error!("[dsh 启动] 定位 dsh CLI 失败: {}", e);
            return Err((e, "Install dsh first, then retry".into()));
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
            "Port 3899 may be occupied; stop the process using it and retry".into(),
        )
    })
}

/// 读取日志末尾若干非空行（失败诊断用）；文件缺失/为空返回 None
pub(crate) fn read_log_tail(path: &Path, max_lines: usize) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(max_lines);
    let tail = lines[start..].join("\n");
    if tail.trim().is_empty() {
        None
    } else {
        Some(tail)
    }
}

/// 一条 loader 链的最内层归因：条目 id、条目名（插件包名或宿主包名）与
/// 根因报错。链上全是内置节点时（include 导入失败）entry_id 为空，name
/// 取根因文本引号里的缺失模块名
struct LoaderCulprit {
    entry_id: String,
    name: String,
    error: String,
}

/// 解析一行 loader 链 `failed to {stage} loader entry {id} ({name}): {inner}`：
/// 链可多层嵌套（内置 include → 真插件），最内层非 `cordis:` 的链接即归因
/// 对象。行内无完整链则 None
fn loader_entry_culprit(line: &str) -> Option<LoaderCulprit> {
    let mut last: Option<(String, String)> = None;
    let mut saw_chain = false;
    let mut rest = line;
    while let Some(pos) = rest.find("loader entry ") {
        saw_chain = true;
        rest = &rest[pos + "loader entry ".len()..];
        let (entry_id, after_id) = rest.split_once(" (")?;
        let (entry_name, detail) = after_id.split_once("): ")?;
        if !entry_name.starts_with("cordis:") {
            last = Some((entry_id.to_string(), entry_name.to_string()));
        }
        rest = detail;
    }
    if !saw_chain {
        return None;
    }
    match last {
        Some((entry_id, name)) => Some(LoaderCulprit {
            entry_id,
            name,
            error: rest.trim().to_string(),
        }),
        None => {
            let (_, quoted) = rest.split_once('\'')?;
            let (module, _) = quoted.split_once('\'')?;
            Some(LoaderCulprit {
                entry_id: String::new(),
                name: module.to_string(),
                error: rest.trim().to_string(),
            })
        }
    }
}

/// 从日志尾提取插件加载失败的归因输入。门控是致命标记——`plugin tree
/// failed to load`（boot 断言）或 `fatal load failure`（fail-loud 横幅）：
/// 非致命的插件告警（allSettled 软失败转储、probe warn）不得被误判成死因。
/// 多条链时取最后一处（越靠后越接近最终致命现场）。纯函数：最内层是宿主包
/// （@deepseek-ai/*）时 plugin 为 None、entry_id 带条目 id——「某 bundle 层
/// 配置的条目炸在宿主服务构造上」，真正的肇事者由调用方持 profile 目录反查
/// （bundle_declarer_of_entry），本函数不碰文件系统
#[derive(Debug, PartialEq)]
pub(crate) struct PluginFailure {
    /// 肇事插件包名；None = 最内层是宿主包（不可禁用，需归因反查）
    pub(crate) plugin: Option<String>,
    pub(crate) entry_id: String,
    pub(crate) error: String,
}

pub(crate) fn plugin_failure_from_log_tail(tail: &str) -> Option<PluginFailure> {
    if !tail.contains("plugin tree failed to load") && !tail.contains("fatal load failure") {
        return None;
    }
    let culprit = tail.lines().rev().find_map(loader_entry_culprit)?;
    let plugin = if culprit.name.starts_with("@deepseek-ai/") {
        None
    } else {
        Some(culprit.name)
    };
    Some(PluginFailure {
        plugin,
        entry_id: culprit.entry_id,
        error: culprit.error,
    })
}

/// 启动失败诊断：problem/solution 进时间轴；action_plugin 是可一键禁用
/// 重试的第三方插件包名（受管授权插件不提供此动作——它的既定恢复路径是
/// Repair dsh stack，由 solution 文案指引）。repairable 标记该失败属于
/// 修复核可自愈的类别（保留名预设冲突）：重试编排据此自动修复并重试一次
#[derive(Debug, Clone)]
pub(crate) struct StartFailureDiagnosis {
    pub(crate) problem: Message,
    pub(crate) solution: Message,
    pub(crate) action_plugin: Option<String>,
    pub(crate) repairable: bool,
}

/// 保留名预设冲突的诊断：修复核的 force 重试会自动剥离并重启，禁用动作
/// 留作自愈失败后的手动兜底；归因失败（查不到肇事 bundle）时只报错误
/// 本体，不产出无效的禁用动作
fn reserved_preset_diagnosis(plugin: Option<String>, error: String) -> StartFailureDiagnosis {
    let managed = |p: &str| p == AUTH_PLUGIN_PACKAGE || p == CONNECTION_PLUGIN_PACKAGE;
    match plugin {
        Some(plugin) => StartFailureDiagnosis {
            problem: Message::localized("dsh web failed to start; {{plugin}} configures permission presets reserved by this dsh version:\n{{error}}",
                &[("plugin", plugin.clone()), ("error", error)]),
            solution: Message::localized("The launcher strips reserved presets and retries automatically; if the next start still fails, update or disable {{plugin}} on the Plugins page",
                &[("plugin", plugin.clone())]),
            action_plugin: (!managed(&plugin)).then_some(plugin),
            repairable: true,
        },
        None => StartFailureDiagnosis {
            problem: Message::localized("dsh web failed to start; a plugin configures permission presets reserved by this dsh version:\n{{error}}",
                &[("error", error)]),
            solution: Message::key("The launcher strips reserved presets and retries automatically; if the next start still fails, update or disable the plugin that adds permission presets on the Plugins page"),
            action_plugin: None,
            repairable: true,
        },
    }
}

/// 从日志尾部内容诊断启动失败（决策核）：插件加载失败优先点名具体插件与
/// 根因报错（致命标记门控在提取函数内），非受管插件附带给一键禁用重试；
/// 其余按日志里的常见崩溃指纹（EPERM/symlink、credentials 格式）给针对性
/// 方案。`profile` 是 web profile 目录（归因反查用）：None 时不做任何文件
/// 访问——最内层为宿主包的失败一律走「归因失败」分支，测试据此保持纯度
pub(crate) fn diagnose_start_failure_from_tail(
    tail: Option<&str>,
    profile: Option<&Path>,
) -> StartFailureDiagnosis {
    // 锁超时指纹优先于插件链归因：孤儿 credentials 写锁让 boot 崩在内置
    // connection 插件的锁等待上，按插件链点名会指引用户去 Plugins 页移除一个
    // 不可移除的内置插件；真实解法是删掉孤儿锁（Launcher 启动路径已自动清理
    // 持锁 PID 已死的锁，走到这里说明持锁者活着或清理失败）
    if let Some(t) = tail {
        if t.contains("timed out waiting for the writer lock")
            && t.contains(".credentials.yaml.lock")
        {
            return StartFailureDiagnosis {
                problem: "dsh web failed to start: the credentials writer lock ~/.dsh/.credentials.yaml.lock is held by another dsh process or was left behind by a killed one".into(),
                solution: "If no other dsh command is running, delete ~/.dsh/.credentials.yaml.lock, then retry".into(),
                action_plugin: None,
                repairable: false,
            };
        }
    }
    if let Some(failure) = tail.and_then(plugin_failure_from_log_tail) {
        // 内层是宿主包：肇事者是配置了该条目的 bundle 层，持 profile 反查
        let mut plugin = failure.plugin;
        if plugin.is_none() && !failure.entry_id.is_empty() {
            plugin =
                profile.and_then(|p| super::repair::bundle_declarer_of_entry(p, &failure.entry_id));
        }
        // 保留名指纹优先于通用插件归因：修复核能自动剥离并重试（repairable），
        // 禁用动作留作自愈失败后的手动兜底
        if failure
            .error
            .contains(super::repair::RESERVED_NAME_FINGERPRINT)
        {
            return reserved_preset_diagnosis(plugin, failure.error);
        }
        if let Some(plugin) = plugin {
            let managed = plugin == AUTH_PLUGIN_PACKAGE || plugin == CONNECTION_PLUGIN_PACKAGE;
            return StartFailureDiagnosis {
                problem: Message::localized("dsh web failed to start; plugin {{plugin}} failed to load:\n{{error}}", &[("plugin", plugin.clone()), ("error", failure.error)],
                ),
                solution: Message::localized("Remove or update the plugin {{plugin}} on the Plugins page, then retry; launcher-managed authorization plugins are restored by Repair dsh stack", &[("plugin", plugin.clone())],
                ),
                action_plugin: (!managed).then_some(plugin),
                repairable: false,
            };
        }
        // 内层是宿主包且归因失败：错误本体照报，不给禁用动作（宿主包不可
        // 禁用；近期新装插件的配置层是首要嫌疑）
        return StartFailureDiagnosis {
            problem: Message::localized("dsh web failed to start; the profile's plugin tree failed to load:\n{{error}}",
                &[("error", failure.error)]),
            solution: Message::key("Check the log at ~/.dsh/dsh-web.log; a recently added plugin's configuration is the likely cause"),
            action_plugin: None,
            repairable: false,
        };
    }
    let problem = match tail {
        Some(t) => {
            // 问题区只取前 8 行，避免长堆栈淹没时间轴
            let short: Vec<&str> = t.lines().take(8).collect();
            Message::localized("dsh web failed to start; log says:\n{{log}}",
                &[("log", short.join("\n"))],
            )
        }
        None => "dsh web failed to start (no log output; port 3899 may be occupied)".into(),
    };
    let solution = match tail {
        // Windows 首启最典型崩溃：healProfilesModuleFallback 建符号链接被拒
        Some(t) if t.contains("EPERM") || t.contains("symlink") => {
            "dsh could not create symlinks; on Windows enable Developer Mode (Settings → Privacy & security → For developers), then retry".into()
        }
        // 装过跨线 dsh（如 0.1.3-alpha.1）的机器：它把 credentials 重写成了
        // 新格式，锁定线的 CLI 读不了；引导用户手动还原为扁平 KEY: value
        Some(t) if t.contains(".credentials.yaml") && t.contains("must be a string") => {
            "A newer dsh rewrote ~/.dsh/.credentials.yaml into an incompatible format; open it and keep only the KEY: value lines (drop the version:/refs: wrapper), then retry".into()
        }
        _ => "Check the log at ~/.dsh/dsh-web.log; port 3899 may be occupied or the dsh CLI may need a newer Node.js".into(),
    };
    StartFailureDiagnosis {
        problem,
        solution,
        action_plugin: None,
        repairable: false,
    }
}

/// 启动失败诊断：把 dsh-web.log 尾部的真实错误带进时间轴（进程崩溃时这里就是
/// 堆栈），并按常见崩溃原因给出针对性方案。读日志 + 归因反查（宿主包内层
/// 的条目归因到肇事 bundle 层），不修改任何状态
pub(crate) fn start_failure_diagnosis(log: &Path) -> StartFailureDiagnosis {
    let profile = super::repair::web_profile_dir();
    diagnose_start_failure_from_tail(read_log_tail(log, 40).as_deref(), profile.as_deref())
}

/// dsh-web.log 尾部（前端在失败节点「查看日志」里内嵌展示）。只读不改状态；
/// 文件缺失/为空返回空串，由前端显示占位文案。尾部 200 行足以覆盖一次
/// 崩溃输出，又不会把超长日志整份塞进 webview
#[tauri::command]
pub async fn dsh_web_log() -> Result<String, Message> {
    super::ipc_blocking(|| {
        let log = dsh_dir()
            .map(|d| d.join("dsh-web.log"))
            .unwrap_or_else(|_| PathBuf::from("dsh-web.log"));
        Ok(read_log_tail(&log, 200).unwrap_or_default())
    })
    .await
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
        "Tailscale 1.92+ is required to forward App Capabilities; update Tailscale, then retry"
            .to_string()
    } else if e.contains("tls cert") || e.contains("does not support") || e.contains("certificate")
    {
        "MagicDNS or HTTPS Certificates may not be enabled; open https://login.tailscale.com/admin/dns and enable MagicDNS and HTTPS Certificates, then retry".to_string()
    } else {
        "Open the authorization link in the error output to enable Serve for this tailnet (https://login.tailscale.com/f/serve), then retry".to_string()
    }
}

#[tauri::command]
pub async fn dsh_setup(app: tauri::AppHandle) -> Result<(), Message> {
    // 全程阻塞 I/O（npm/pnpm 安装、tailscale 子进程、curl 探测、60s 启动等待）：
    // 走统一 adapter，事件经 move 进去的 AppHandle 照常 emit
    super::ipc_blocking(move || dsh_setup_once(&app)).await
}

fn dsh_setup_once(app: &tauri::AppHandle) -> Result<(), Message> {
    // 步骤序列的唯一事实来源是 mod.rs 的 SETUP_STEPS（dsh_step_schema 同源）
    let steps = super::SETUP_STEPS;
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
        let ctx = StepCtx {
            app,
            index: 0,
            id: steps[0],
        };
        match resolve_auth_config() {
            Ok(auth) => auth,
            Err(error) => return ctx.fail(
                &error,
                "Fix the remote authorization settings in Settings → DeepSeek Harness, then retry",
                &remaining_after(0),
            ),
        }
    };

    {
        let ctx = StepCtx {
            app,
            index: 0,
            id: steps[0],
        };
        ctx.running("Checking Node.js & npm…");
        let node =
            match resolve_node_bin() {
                Ok(node) => node,
                Err(error) => return ctx.fail(
                    &error,
                    "Install Node.js 18+ from https://nodejs.org, then restart this app and retry",
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
            app,
            index: 1,
            id: steps[1],
        };
        let current = dsh_version();
        match decide_pinned_dsh(current.as_deref()) {
            PinnedDshDecision::KeepCurrent => {
                // 显示实际版本而非锁定版本：同线未来 rc/稳定版也可能兼容，
                // 显示 SUPPORTED_DSH_VERSION 会让用户误以为被装回了旧版
                ctx.done(Message::localized("Compatible dsh is installed: {{version}}",
                    &[("version", current.clone().unwrap_or_default())],
                ));
            }
            PinnedDshDecision::KeepCrossLine => {
                // 跨线但高于下限：保留用户装过的更新版本，不降级；远程授权
                // 靠 plugins 栈，跨线可能失配，如实披露插件风险而非悄悄装回
                ctx.done(Message::localized("{{version}} is newer than the verified stack; authorization plugins may be incompatible",
                    &[("version", current.clone().unwrap_or_default())],
                ));
            }
            PinnedDshDecision::InstallPinned => {
                ctx.running(Message::localized("Installing the pinned dsh ({{version}})…",
                    &[("version", SUPPORTED_DSH_VERSION.to_string())],
                ));
                match install_supported_dsh() {
                    Ok(version) => ctx.done(Message::localized("Installed {{version}}", &[("version", version)])),
                    Err(error) => {
                        return ctx.fail(
                            &error,
                            Message::localized("Check your network and npm settings, then run npm install -g {{package}}@{{version}} and retry", &[
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
    }

    {
        let ctx = StepCtx {
            app,
            index: 2,
            id: steps[2],
        };
        let already_installed = bundled_plugin_specs(app)
            .map(|specs| auth_plugins_installed(&specs))
            .unwrap_or(false);
        if already_installed {
            ctx.done("Authorization plugins are installed");
        } else {
            ctx.running("Installing bundled dsh authorization plugins…");
            if let Err(error) = install_auth_plugins(app) {
                return ctx.fail(
                    &error,
                    "Reinstall this Launcher if its bundled dsh plugins are missing, then retry",
                    &remaining_after(2),
                );
            }
            ctx.done("Authorization plugins installed");
        }
    }

    let tailscale = {
        let ctx = StepCtx {
            app,
            index: 3,
            id: steps[3],
        };
        ctx.running("Checking Tailscale identity…");
        let ts = match tailscale_path() {
            Some(ts) => ts,
            None => {
                return ctx.fail(
                    "Tailscale is not installed",
                    "Install Tailscale and sign in, then run tailscale up and retry",
                    &remaining_after(3),
                )
            }
        };
        if !tailscale_online(&ts) {
            return ctx.fail(
                "Tailscale is not connected",
                "Run tailscale up and sign in with the account allowed to access dsh",
                &remaining_after(3),
            );
        }
        let login = match resolve_tailscale_login(&ts) {
            Ok(login) => login,
            Err(error) => {
                return ctx.fail(
                    &error,
                    "Update Tailscale, sign in again, and verify tailscale status --json",
                    &remaining_after(3),
                )
            }
        };
        ctx.done(Message::localized("Online · authorized identity: {{login}}",
            &[("login", login.clone())],
        ));
        (ts, login)
    };

    {
        let ctx = StepCtx {
            app,
            index: 4,
            id: steps[4],
        };
        ctx.running("Checking MagicDNS…");
        let (enabled, _) = magic_dns_info(&tailscale.0);
        if !enabled {
            return ctx.fail(
                "MagicDNS is not enabled",
                "Open https://login.tailscale.com/admin/dns and enable MagicDNS and HTTPS Certificates, then retry",
                &remaining_after(4),
            );
        }
        ctx.done("MagicDNS enabled");
    }

    {
        let ctx = StepCtx {
            app,
            index: 5,
            id: steps[5],
        };
        let fqdn = resolve_fqdn();
        // 修复核先于启动/重启（幂等）：远程链路与本地一键启动同一 profile，
        // 同样的陈旧状态同样会拒启；自愈重试只在本地冷启路径，这里只修不重试
        let repair = super::repair::repair_web_profile(false);
        if port_listening(WEB_PORT) && dsh_web_pid().is_none() {
            return ctx.fail(
                "Port 3899 is occupied by another process",
                "Stop the process listening on 127.0.0.1:3899, then retry",
                &remaining_after(5),
            );
        }
        if port_listening(WEB_PORT) {
            ctx.running("Restarting dsh web with authorization plugins…");
            if let Err(error) = restart_dsh_web(Some(&tailscale.1), fqdn.as_deref(), &auth) {
                return ctx.fail(
                    &error,
                    "Check the log at ~/.dsh/dsh-web.log",
                    &remaining_after(5),
                );
            }
        } else {
            ctx.running("Starting dsh web on 127.0.0.1:3899…");
            let pid = match spawn_dsh_web(Some(&tailscale.1), fqdn.as_deref(), &auth) {
                Ok(pid) => pid,
                Err((problem, solution)) => {
                    return ctx.fail(&problem, &solution, &remaining_after(5))
                }
            };
            if !wait_web_start(Some(pid), Duration::from_secs(60)) {
                let log = dsh_dir()
                    .map(|dir| dir.join("dsh-web.log"))
                    .unwrap_or_else(|_| PathBuf::from("dsh-web.log"));
                let failure = start_failure_diagnosis(&log);
                return ctx.fail_diagnosis(&failure, &remaining_after(5));
            }
        }
        let (detail, action) =
            done_detail_with_preflight("dsh web is running on 127.0.0.1:3899", &repair);
        ctx.done_noting(detail, action);
    }

    {
        let ctx = StepCtx {
            app,
            index: 6,
            id: steps[6],
        };
        ctx.running("Configuring Tailscale Serve directly to dsh…");
        let serve_args = serve_command(&auth);
        let serve_refs: Vec<&str> = serve_args.iter().map(|s| s.as_str()).collect();
        let result = run_capture(&tailscale.0, &serve_refs);
        match result {
            Ok((_, _, true)) if serve_configured(&tailscale.0) => {
                let (_, url) = resolve_host_and_url();
                match url {
                    Some(url) => ctx.done(Message::localized("HTTPS serve ready: {{url}}", &[("url", url)])),
                    None => ctx.done("HTTPS serve ready"),
                }
            }
            Ok((_, err, _)) => {
                let error = if err.is_empty() {
                    "tailscale serve failed".to_string()
                } else {
                    err
                };
                return ctx.fail(
                    Message::localized("Serve is not enabled or failed: {{error}}",
                        &[("error", error.clone())],
                    ),
                    serve_failure_solution(&error),
                    &remaining_after(6),
                );
            }
            Err(error) => {
                return ctx.fail(
                    &error,
                    "Run tailscale up first to sign in, then retry",
                    &remaining_after(6),
                )
            }
        }
    }

    {
        let ctx = StepCtx {
            app,
            index: 7,
            id: steps[7],
        };
        let (_, url) = resolve_host_and_url();
        let url_text = url
            .clone()
            .unwrap_or_else(|| "https://<hostname>.ts.net".to_string());
        ctx.running(Message::localized("Verifying remote access ({{url}})…",
            &[("url", url_text.clone())],
        ));
        // 裸 `/` 无 token 时的 401/404 是健康应答：授权插件不在场（被卸载/未
        // 加载）时 dsh 对本机也要求会话 cookie，浏览器经 token 地址换 cookie
        // 才是 200——不能沿用 2xx/3xx 门槛（与本地 ready 步同一判据）
        let web_ok = any_http_status(http_get(WEB_PORT, "127.0.0.1", "/").as_deref());
        let plugins_ok = bundled_plugin_specs(app)
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
        // 本机特权面可达性：授权插件在场时裸请求直放；插件不在场（被卸载或
        // 装了但没加载）时 dsh 对 /api 要会话 cookie，先换本机会话再问一次。
        // 判据是「Launcher 能不能以本机身份访问特权 API」，不是「裸请求能不能
        // 过」——与凭据桥走同一套原生链路
        let local_privileged_ok = rpc_ok(WEB_PORT, "settings/describe", None)
            || session::session_cookie(WEB_PORT)
                .is_some_and(|cookie| rpc_ok(WEB_PORT, "settings/describe", Some(&cookie)));

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
                Message::localized("The local proxy is intercepting the Tailscale address: {{url}}",
                    &[("url", url_text)],
                ),
                Message::localized("Add {{host}} to this machine's proxy bypass / skip-proxy list, then retry",
                    &[("host", host.to_string())],
                ),
                &remaining_after(7),
            );
        }

        if remote_stack_ok && remote_url_access == Some(RemoteUrlAccess::Ready) {
            ctx.done(Message::localized("Remote access is ready: {{url}}", &[("url", url_text)]));
        } else {
            let mut checks: Vec<Message> = Vec::new();
            if !web_ok {
                checks.push("dsh web is not responding on 127.0.0.1:3899".into());
            }
            if !plugins_ok {
                checks.push("The dsh authorization plugin profile is incomplete".into());
            }
            if !serve_ok {
                checks.push("Tailscale Serve is not targeting 127.0.0.1:3899".into());
            }
            if !https_ok {
                checks.push(Message::localized("HTTPS endpoint is not responding: {{url}}",
                    &[("url", url_text.clone())],
                ));
            }
            if !ws_ok {
                checks.push(Message::localized("WebSocket handshake failed: {{url}}/api/remote.mux",
                    &[("url", url_text.clone())],
                ));
            }
            match remote_use_access {
                Some(RemoteRpcAccess::Denied) => checks.push(Message::localized("Remote use capability was denied; grant {{capability}} to this identity for the dsh node in tailnet grants, then run one-click setup again", &[(
                        "capability",
                        auth.use_capability
                            .clone()
                            .unwrap_or_else(|| "<domain>/cap/dsh".to_string()),
                    )],
                )),
                Some(RemoteRpcAccess::Failed) => checks.push(Message::localized("Remote provider API is not responding: {{url}}/api/llm/listProviders", &[("url", url_text.clone())],
                )),
                _ => {}
            }
            match remote_settings_access {
                Some(RemoteRpcAccess::Denied) => checks.push(Message::localized("Remote admin capability was denied; grant {{capability}} to this identity for the dsh node in tailnet grants, then run one-click setup again", &[(
                        "capability",
                        auth.admin_capability
                            .clone()
                            .unwrap_or_else(|| "<domain>/cap/dsh-admin".to_string()),
                    )],
                )),
                Some(RemoteRpcAccess::Failed) => checks.push(Message::localized("Remote settings API is not responding: {{url}}/api/settings/describe", &[("url", url_text.clone())],
                )),
                _ => {}
            }
            if !local_privileged_ok {
                checks.push("Local privileged API access failed on 127.0.0.1:3899".into());
            }
            if remote_url_access == Some(RemoteUrlAccess::ProxyInterference) {
                checks.push(Message::localized("The local proxy is intercepting the Tailscale address: {{url}}",
                    &[("url", url_text.clone())],
                ));
            }
            return ctx.fail(
                "Verification failed; some components are not ready",
                format_verification_checks(&checks),
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

/// 把验证项合成一条消息：每条检查各自是一个词典 key（独立本地化），容器 key
/// 只负责按行拼接。Rust 侧不查词典，故容器 key 无需在词典中——前端 miss 时按
/// `{{checkN}}` 就地填入**已渲染**的嵌套消息，缺词典也不会把占位符露给用户。
/// 不先拼成成品句子：整句一旦成品就再也命不中词典里的模板 key
pub(crate) fn format_verification_checks(checks: &[Message]) -> Message {
    let mut key = String::new();
    let mut args = BTreeMap::new();
    for (index, check) in checks.iter().enumerate() {
        if index > 0 {
            key.push('\n');
        }
        key.push_str(&format!("{{{{check{index}}}}}"));
        args.insert(
            format!("check{index}"),
            MessageArg::Nested(Box::new(check.clone())),
        );
    }
    Message { key, args }
}

/// 重启 dsh web，确保新 profile 和授权环境生效。成功返回新进程 PID
/// （供启动后的就绪验证探活）。
pub(crate) fn restart_dsh_web(
    login: Option<&str>,
    fqdn: Option<&str>,
    auth: &AuthConfig,
) -> Result<u32, Message> {
    stop_supervised_services();
    kill_by_pattern(dsh_web_cmd_pattern());
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while port_listening(WEB_PORT) && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(300));
    }
    if port_listening(WEB_PORT) {
        let err = "dsh web did not release port 3899".to_string();
        log::error!("[dsh 重启] {}", err);
        return Err(err.into());
    }
    let pid = spawn_dsh_web(login, fqdn, auth).map_err(|(problem, _)| {
        log::error!("[dsh 重启] 启动 dsh web 失败: {}", problem);
        problem
    })?;
    if !wait_web_start(Some(pid), Duration::from_secs(60)) {
        let log = dsh_dir()
            .map(|d| d.join("dsh-web.log"))
            .unwrap_or_else(|_| PathBuf::from("dsh-web.log"));
        let problem = start_failure_diagnosis(&log).problem;
        log::error!("[dsh 重启] 等待 dsh web 就绪超时: {}", problem);
        return Err(problem);
    }
    Ok(pid)
}
