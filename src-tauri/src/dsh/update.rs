//! 更新与版本管理：dsh 升级/卸载插件、web profile 兼容补丁、npm dist-tag 查询与版本安装。

use serde::Serialize;
use super::{AUTH_PLUGIN_PACKAGE, CONNECTION_PLUGIN_PACKAGE, LOCAL_ONLY_LOGIN, SUPPORTED_DSH_VERSION, WEB_PORT};
use super::auth::{resolve_auth_config, resolve_fqdn, resolve_tailscale_login};
use super::components::{dsh_dir, dsh_version, dsh_version_is_compatible, install_auth_plugins, install_supported_dsh, npm_bin, resolve_dsh_bin, resolve_node_bin, tailscale_path, web_profile_has_auth_plugins};
use super::process::{port_listening, run_capture};
use super::setup::{restart_dsh_web};
use crate::version::parse_version;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::path::{Path};

use std::time::Duration;


use crate::i18n::keyf;

// ============ 更新 ============

pub(crate) fn runtime_auth_context() -> (String, Option<String>) {
    let Some(ts) = tailscale_path() else {
        return (LOCAL_ONLY_LOGIN.to_string(), None);
    };
    match resolve_tailscale_login(&ts) {
        Ok(login) => (login, resolve_fqdn()),
        Err(_) => (LOCAL_ONLY_LOGIN.to_string(), None),
    }
}

/// 修复 Launcher 跟随的 dsh + 授权插件兼容栈；若 web 正在运行则重启。
#[tauri::command]
pub async fn dsh_update(app: tauri::AppHandle) -> Result<String, String> {
    super::ipc_blocking(move || dsh_update_once(&app)).await
}

fn dsh_update_once(app: &tauri::AppHandle) -> Result<String, String> {
    let was_running = port_listening(WEB_PORT);
    let version = install_supported_dsh()
        .map_err(|error| {
            log::error!("[dsh 修复] 安装 dsh 失败: {}", error);
            keyf("Repair failed: {error}", &[("error", error)])
        })?;
    install_auth_plugins(app)
        .map_err(|error| {
            log::error!("[dsh 修复] 安装授权插件失败: {}", error);
            keyf("Repair failed: {error}", &[("error", error)])
        })?;
    if was_running {
        let (login, fqdn) = runtime_auth_context();
        let auth = resolve_auth_config()?;
        restart_dsh_web(&login, fqdn.as_deref(), &auth)?;
    }
    Ok(version)
}


/// 安装新版 dsh 后重写 web profile 的 cordis.patch.yml：让 dsh CLI 自己
/// 把 profile 里的 dsh-* 依赖滚到与新 CLI 兼容的版本。authz 插件的依赖
/// 范围（如 ^0.1.2-alpha.2）不覆盖 dsh 下一条 x.y.z 预发布线，
/// 不重写则 boot 时 pnpm 解出旧版 attachment 崩（rc.6→rc.8 的教训）。
pub(crate) const WEB_PROFILE_COMPAT_ID_LINE: &str = "- id: dsh-pro-max-compat";

pub(crate) fn insert_web_profile_compat_entry(contents: &str, installed_version: &str) -> String {
    let newline = if contents.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = contents.lines().map(str::to_string).collect();
    let compat_index = lines
        .iter()
        .position(|line| line == WEB_PROFILE_COMPAT_ID_LINE);

    if let Some(compat_index) = compat_index {
        let mut comment_index = None;
        let mut end = compat_index + 1;
        while end < lines.len() {
            let line = &lines[end];
            if line.is_empty() || line.starts_with([' ', '\t']) {
                if line.starts_with("  # Launcher managed: installed dsh CLI is ") {
                    comment_index = Some(end);
                }
                end += 1;
            } else {
                break;
            }
        }
        if let Some(comment_index) = comment_index {
            lines[comment_index] = format!("  # Launcher managed: installed dsh CLI is {installed_version}");
        }
        // 修复旧实现可能留下的 `[]` + list item 非法组合。
        if let Some(empty_index) = lines[..compat_index]
            .iter()
            .rposition(|line| line == "[]")
        {
            lines.remove(empty_index);
        }
    } else {
        let entry = [
            WEB_PROFILE_COMPAT_ID_LINE.to_string(),
            "  name: '@deepseek-ai/dsh-attachment'".to_string(),
            "  config: {}".to_string(),
            format!("  # Launcher managed: installed dsh CLI is {installed_version}"),
        ];
        if let Some(empty_index) = lines.iter().position(|line| line == "[]") {
            lines.splice(empty_index..=empty_index, entry);
        } else {
            while lines.last().is_some_and(|line| line.is_empty()) {
                lines.pop();
            }
            lines.extend(entry);
        }
    }

    format!("{}{newline}", lines.join(newline))
}

pub(crate) fn remove_web_profile_compat_entry(contents: &str) -> String {
    let newline = if contents.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = contents.lines().map(str::to_string).collect();
    let Some(start) = lines
        .iter()
        .position(|line| line == WEB_PROFILE_COMPAT_ID_LINE)
    else {
        return contents.to_string();
    };
    let mut end = start + 1;
    while end < lines.len() {
        let line = &lines[end];
        if line.is_empty() || line.starts_with([' ', '\t']) {
            end += 1;
        } else {
            break;
        }
    }
    lines.drain(start..end);
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    if !lines.iter().any(|line| line.starts_with("- "))
        && !lines.iter().any(|line| line == "[]")
    {
        lines.push("[]".to_string());
    }
    format!("{}{newline}", lines.join(newline))
}

pub(crate) fn ensure_web_profile_compat_patch() -> Result<(), String> {
    let version =
        dsh_version().ok_or_else(|| "dsh installed but cannot be located in PATH".to_string())?;
    rewrite_web_profile_patch(&version)
}

pub(crate) fn rewrite_web_profile_patch(installed_version: &str) -> Result<(), String> {
    let patch_path = dsh_dir()?
        .join("profiles")
        .join("web")
        .join("cordis.patch.yml");
    rewrite_web_profile_patch_at(&patch_path, installed_version)
}

pub(crate) fn rewrite_web_profile_patch_at(
    patch_path: &Path,
    installed_version: &str,
) -> Result<(), String> {
    let contents = match fs::read_to_string(patch_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "[]\n".to_string(),
        Err(error) => {
            return Err(keyf(
                "Failed to read {path}: {error}", &[
                    ("path", patch_path.display().to_string()),
                    ("error", error.to_string()),
                ],
            ))
        }
    };
    let updated = insert_web_profile_compat_entry(&contents, installed_version);
    if updated == contents {
        return Ok(());
    }
    if let Some(parent) = patch_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            keyf(
                "Failed to create directory: {error}", &[("error", error.to_string())],
            )
        })?;
    }
    fs::write(patch_path, updated).map_err(|error| {
        keyf(
            "Failed to write {path}: {error}", &[
                ("path", patch_path.display().to_string()),
                ("error", error.to_string()),
            ],
        )
    })
}

/// 清掉 patch 里的 compat 条目（用户显式安装旧版 dsh 后调用，让下次
/// install_supported_dsh 重新写入）。幂等：无条目或文件不存在直接返回。
pub(crate) fn clear_web_profile_compat_entry() {
    let patch_path = match dsh_dir() {
        Ok(d) => d.join("profiles").join("web").join("cordis.patch.yml"),
        Err(_) => return,
    };
    let Ok(contents) = fs::read_to_string(&patch_path) else { return };
    let updated = remove_web_profile_compat_entry(&contents);
    if updated == contents {
        return;
    }
    if let Err(e) = fs::write(&patch_path, updated) {
        log::warn!("[dsh 安装] 清理 web profile patch compat 条目失败: {}", e);
    }
}

/// 从 web profile 移除授权插件（`dsh plugin --profile web remove`，pnpm 透传，
/// 同步清理 dependencies 与 bundles）；web 运行中则重启生效。幂等：未安装
/// 直接返回。卸载后远程授权链路失效，状态链如实停在「插件未安装」；
/// 纯本地访问不受影响（授权插件只服务远程链路）。
#[tauri::command]
pub async fn dsh_remove_plugins() -> Result<(), String> {
    super::ipc_blocking(dsh_remove_plugins_once).await
}

fn dsh_remove_plugins_once() -> Result<(), String> {
    // 幂等：profile 里两个插件条目都不存在时直接返回（plugin remove 是
    // pnpm 透传，remove 不存在的包虽不会报错，但会无意义地重写 lockfile）
    if !web_profile_has_auth_plugins() {
        return Ok(());
    }
    let dsh = resolve_dsh_bin()?.display().to_string();
    match run_capture(
        &dsh,
        &[
            "plugin",
            "--profile",
            "web",
            "remove",
            CONNECTION_PLUGIN_PACKAGE,
            AUTH_PLUGIN_PACKAGE,
        ],
    ) {
        Ok((_, _, true)) if !web_profile_has_auth_plugins() => {}
        Ok((_, err, true)) => {
            let e = keyf(
                "dsh plugin remove completed but auth plugins remain in the web profile: {error}", &[("error", err)],
            );
            log::error!("[dsh 插件] 卸载后残留: {}", e);
            return Err(e);
        }
        Ok((_, err, false)) => {
            let e = keyf(
                "Failed to remove dsh auth plugins: {error}", &[(
                    "error",
                    if err.is_empty() {
                        "dsh plugin remove failed".to_string()
                    } else {
                        err
                    },
                )],
            );
            log::error!("[dsh 插件] 卸载失败: {}", e);
            return Err(e);
        }
        Err(error) => {
            log::error!("[dsh 插件] 执行 dsh plugin remove 失败: {}", error);
            return Err(error);
        }
    }
    if port_listening(WEB_PORT) {
        let (login, fqdn) = runtime_auth_context();
        let auth = resolve_auth_config()?;
        restart_dsh_web(&login, fqdn.as_deref(), &auth)?;
    }
    Ok(())
}

/// 一个 dist-tag 的版本行（latest/next 等）
#[derive(Debug, Serialize, Clone, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct DshDistTag {
    /// dist-tag 名（latest / next / …）
    pub tag: String,
    /// 该 tag 当前指向的版本
    pub version: String,
    /// 本机已装版本即此版本
    pub is_installed: bool,
    /// 高于 Launcher 验证栈（授权插件未验证）
    pub above_supported: bool,
    /// 过不了版本闸门（跨线或低于插件栈下限，装上本地与远程一起失效）
    pub incompatible: bool,
}

/// dsh 版本检测结果（设置页版本卡）：全部 dist-tag + 本机安装版本
#[derive(Debug, Serialize, Clone, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct DshLatestInfo {
    /// registry 上所有 dist-tag（查询失败为空 vec）
    pub tags: Vec<DshDistTag>,
    /// 本机安装版本（未安装为 None）
    pub installed_version: Option<String>,
    /// 本机已装版本与内置插件栈兼容（同线且 ≥ 锁定版；未装/解析失败为 false）
    pub installed_compatible: bool,
    /// 本机已装版本高于验证栈（同线更新、插件未验证）
    pub installed_above_supported: bool,
    /// Launcher 验证过的最低兼容版本（插件栈锁定）
    pub supported_version: String,
    /// 查询失败原因（网络不通 / npm 不可用 / 输出无法解析）
    pub error: Option<String>,
}

/// 查询 npm registry 上 dsh 的所有 dist-tag（latest/next 各自指向的版本），
/// 按版本发布时间新→旧排序（缺时间的按解析顺序垫底）。
/// run_capture 无超时机制，npm view 走网络可能挂住，故放独立线程 + 超时回收；
/// 线程泄漏只发生在 npm 挂死路径（下次查询新建线程，进程退出即清）
#[tauri::command]
pub async fn dsh_check_latest() -> Result<DshLatestInfo, String> {
    super::ipc_blocking(dsh_check_latest_once).await
}

fn dsh_check_latest_once() -> Result<DshLatestInfo, String> {
    let installed = dsh_version();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = run_capture(&npm_bin(), &["view", "@deepseek-ai/dsh", "dist-tags", "time", "--json"]);
        let _ = tx.send(result);
    });
    let queried = match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok((out, _, true))) => parse_dist_tag_query(&out),
        Ok(Ok((_, err, false))) => Err(keyf(
            "npm query failed: {error}", &[(
                "error",
                if err.is_empty() {
                    "npm view exited non-zero".to_string()
                } else {
                    err
                },
            )],
        )),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("npm query timed out (15s); check your network or npm registry mirror".to_string()),
    };
    let (mut tag_pairs, publish_times, error) = match queried {
        Ok(q) => (q.tags, q.times, None),
        Err(e) => {
            log::warn!("[dsh 检测] 查询 npm dist-tags 失败: {}", e);
            (Vec::new(), HashMap::new(), Some(e))
        }
    };
    sort_tag_pairs_by_publish_time(&mut tag_pairs, &publish_times);
    let supported = parse_version(SUPPORTED_DSH_VERSION);
    let installed_parsed = installed.as_deref().and_then(parse_version);
    // 已装版本的兼容事实与 tags 行同源：兼容判定唯一走 dsh_version_is_compatible，
    // 前端只消费布尔值不做 semver 解析
    let installed_compatible = dsh_version_is_compatible(installed.as_deref());
    let installed_above_supported = match (&installed_parsed, &supported) {
        (Some(v), Some(min)) => v > min,
        _ => false,
    };
    let tags = tag_pairs
        .into_iter()
        .map(|(tag, version)| {
            let parsed = parse_version(&version);
                DshDistTag {
                    tag,
                    is_installed: installed_parsed.is_some() && parsed == installed_parsed,
                    above_supported: match (&parsed, &supported) {
                        (Some(v), Some(min)) => v > min,
                        _ => false,
                    },
                    incompatible: !dsh_version_is_compatible(Some(&version)),
                    version,
                }
        })
        .collect();
    Ok(DshLatestInfo {
        tags,
        installed_version: installed,
        installed_compatible,
        installed_above_supported,
        supported_version: SUPPORTED_DSH_VERSION.to_string(),
        error,
    })
}

/// npm view（dist-tags + time 组合字段）输出的解析产物
pub(crate) struct DistTagQuery {
    /// [(tag, version)]，保持解析顺序（发布时间排序是调用方职责）
    pub tags: Vec<(String, String)>,
    /// 版本 → 发布时间（RFC3339 原文）。单字段形态（只查 dist-tags）无时间信息
    pub times: HashMap<String, String>,
}

/// 解析 npm view 输出 → tags（解析顺序）+ 版本发布时间表。
/// 容忍三种形态（按出现顺序）：
///   1. 组合字段对象：{"dist-tags":{...},"time":{...}}（view dist-tags time --json）
///   2. 对象：{"latest":"x","next":"y"}（view dist-tags --json，macOS/Linux 的 npm）
///   3. 单元素数组：[{...}]（部分 Windows npm/shim 的 --json 输出——实机回归
///      v0.3.1；组合字段查询实测同样走此形态），
///      及上述形态带 UTF-8 BOM / 首尾空白（Windows cmd /c 包装）
///
/// tag 值过滤非 semver（防御 registry 返回杂质）；time 表的 created/modified
/// 等非版本键无需清理——只按 tag 指向的版本查表，永不命中
pub(crate) fn parse_dist_tag_query(out: &str) -> Result<DistTagQuery, String> {
    let cannot_parse = || {
        keyf(
            "Cannot parse npm dist-tags output: {output}", &[("output", out.chars().take(200).collect())],
        )
    };
    let cleaned = out.trim_start_matches('\u{feff}').trim();
    let value: serde_json::Value = serde_json::from_str(cleaned).map_err(|_| cannot_parse())?;
    // 统一为对象：数组形态取第一个对象元素
    let obj = match value {
        serde_json::Value::Object(m) => m,
        serde_json::Value::Array(mut a) if a.len() == 1 => match a.remove(0) {
            serde_json::Value::Object(m) => m,
            _ => return Err(cannot_parse()),
        },
        _ => return Err(cannot_parse()),
    };
    // 组合字段形态判定：dist-tags 键为对象即组合形态；否则整个对象就是
    // tag→version（单字段形态，无时间表）
    let (tag_value, time_value) = match obj.get("dist-tags") {
        Some(tags @ serde_json::Value::Object(_)) => (tags.clone(), obj.get("time").cloned()),
        _ => (serde_json::Value::Object(obj), None),
    };
    let serde_json::Value::Object(tag_map) = tag_value else {
        return Err(cannot_parse());
    };
    let times = match time_value {
        Some(serde_json::Value::Object(m)) => m
            .into_iter()
            .filter_map(|(version, t)| t.as_str().map(|t| (version, t.to_string())))
            .collect(),
        _ => HashMap::new(),
    };
    let tags = tag_map
        .into_iter()
        .filter_map(|(tag, v)| {
            let version = v.as_str()?.to_string();
            parse_version(&version).map(|_| (tag, version))
        })
        .collect();
    Ok(DistTagQuery { tags, times })
}

/// RFC3339 → OffsetDateTime。npm time 恒为 UTC ISO8601 但毫秒位可缺省，
/// 字典序比较会在同秒时间戳上错序，必须真解析；解析不了按缺时间处理
fn parse_npm_time(s: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()
}

/// tag 行按版本发布时间新→旧排序（设置页列表最新的在最上）：双方都有时间
/// 按时间降序；缺时间（registry 未给或解析失败）的一侧垫底；同缺/同刻保持
/// 解析顺序（sort_by 稳定，serde Map 语义与旧实现一致）
pub(crate) fn sort_tag_pairs_by_publish_time(tags: &mut [(String, String)], times: &HashMap<String, String>) {
    tags.sort_by(|a, b| {
        let ta = times.get(&a.1).and_then(|s| parse_npm_time(s));
        let tb = times.get(&b.1).and_then(|s| parse_npm_time(s));
        match (ta, tb) {
            (Some(x), Some(y)) => y.cmp(&x),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        }
    });
}

/// 安装指定版本的 dsh（设置页版本卡的「安装」按钮）：参数化的安装管道，
/// 与 install_supported_dsh 同构（npm install -g + 安装后版本校验），
/// 装完若 web 正在运行则重启。版本闸门拦截跨线版本；同线高于锁定的
/// 版本可装（above_supported 标记如实披露「未验证」状态）。
#[tauri::command]
pub async fn dsh_install_version(version: String) -> Result<String, String> {
    super::ipc_blocking(move || dsh_install_version_once(&version)).await
}

fn dsh_install_version_once(version: &str) -> Result<String, String> {
    if parse_version(version).is_none() {
        return Err(keyf("Invalid dsh version: {version}", &[("version", version.to_string())]));
    }
    // 设置页逐版本安装同样过版本闸门：跨线的 dsh 与 vendored 授权栈不
    // 兼容（如 0.1.3-alpha.1 会让本地与远程访问一起失效），装上即坏，直接拒绝
    if !dsh_version_is_compatible(Some(version)) {
        let min = SUPPORTED_DSH_VERSION;
        return Err(keyf(
            "dsh {version} is outside the supported line ({min} or newer of the same release line); install a compatible version instead", &[("version", version.to_string()), ("min", min.to_string())],
        ));
    }
    let was_running = port_listening(WEB_PORT);
    let package = format!("@deepseek-ai/dsh@{version}");
    resolve_node_bin()?;
    match run_capture(&npm_bin(), &["install", "-g", &package]) {
        Ok((_, _, true)) => {}
        Ok((_, err, false)) => {
            let error = if err.is_empty() {
                format!("npm install -g {package} failed")
            } else {
                err
            };
            log::error!("[dsh 安装] npm install -g {} 失败: {}", package, error);
            return Err(keyf("Install failed: {error}", &[("error", error)]));
        }
        Err(error) => {
            log::error!("[dsh 安装] 执行 npm install 失败: {}", error);
            return Err(error);
        }
    }
    let actual = dsh_version().ok_or_else(|| {
        let err = "dsh installed but cannot be located in PATH".to_string();
        log::error!("[dsh 安装] 安装后无法在 PATH 定位 dsh");
        err
    })?;
    if parse_version(&actual) != parse_version(version) {
        let err = keyf(
            "Installed dsh version {actual}, expected {expected}", &[("actual", actual), ("expected", version.to_string())],
        );
        log::error!("[dsh 安装] 版本校验失败: {}", err);
        return Err(err);
    }
    // 显式安装旧版后 patch 里的 compat 条目已过时，清掉让下次
    // install_supported_dsh 重新写入（幂等：无条目直接返回）
    clear_web_profile_compat_entry();
    if was_running {
        let (login, fqdn) = runtime_auth_context();
        let auth = resolve_auth_config()?;
        restart_dsh_web(&login, fqdn.as_deref(), &auth)?;
    }
    Ok(version.to_string())
}
