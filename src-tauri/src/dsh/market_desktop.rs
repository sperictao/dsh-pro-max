//! 桌面档的插件市场操作（ADR 0012）：与 web 档共用安装策略、审计台账与更新检测核，
//! 写入只经桥接、走桌面应用自己的 Plugin Manager（ADR 0011）。IPC 入口与 web 档是同一
//! 套命令（market.rs 按形态分派到这里），本模块只放 desktop 档的实现。
//!
//! 与 web 档的差别都来自「这是应用自己的 profile」：
//! - web 档安装护栏里的 `--dump-config` 组合预检对桌面档物理不可执行（CLI 按名字拒绝
//!   desktop），组合校验由应用自己的 Plugin Manager 承担
//! - 构建脚本放行由应用自己记录，Launcher 不写任何文件（审批结果的 workspace_yaml 为 None）
//! - 拿不到安装 spec：bundle 行只有包名与版本，所以更新只按包名查 registry，更新动作
//!   一律钉精确版本（tag 与范围会被 pnpm 的发布冷却静默解析到旧版，见 ADR 0011）

use serde::Serialize;

use super::bridge::{self, BundleRow, ChangeOutcome, BRIDGE_PACKAGE};
use super::market::{
    audit_line, check_updates_with, enforce_install_policy, package_name_from_specifier,
    write_audit, InstallNotice, InstallOutcome, InstallReceipt, PluginUpdateInfo,
    UpdateCandidate,
};
use super::ChangeApplication;
use crate::config::DshSurface;
use crate::i18n::Message;

/// 桌面档的 dsh 版本由这个内置 bundle 自报（兼容门禁与台账用）
const DESKTOP_BASE_BUNDLE: &str = "@deepseek-ai/dsh-base";

/// 桌面档的一个已装插件：只列用户装的（可移除的）bundle——内置 bundle 不进已装列表，
/// 与 web 档只列 package.json 依赖对齐；内置 bundle 的启停留在桌面应用 tab
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct DesktopInstalledPlugin {
    pub name: String,
    pub version: Option<String>,
    pub enabled: bool,
    /// 桥接插件本身：显示，但不给移除与停用——停了它本应用就失去通往桌面档的通道
    pub managed: bool,
}

pub(crate) fn installed_from(bundles: Vec<BundleRow>) -> Vec<DesktopInstalledPlugin> {
    bundles
        .into_iter()
        .filter(|row| row.removable)
        .map(|row| DesktopInstalledPlugin {
            managed: row.name == BRIDGE_PACKAGE,
            name: row.name,
            version: row.version,
            enabled: row.enabled,
        })
        .collect()
}

fn dsh_version_from(bundles: &[BundleRow]) -> Option<String> {
    bundles
        .iter()
        .find(|row| row.name == DESKTOP_BASE_BUNDLE)
        .and_then(|row| row.version.clone())
}

/// 结果附带的提示：生效即无话可说，其余两种各给一句去向
fn notices_of(application: ChangeApplication) -> Vec<InstallNotice> {
    match application {
        ChangeApplication::RestartRequired => vec![InstallNotice::DesktopRestartRequired],
        ChangeApplication::Overridden => vec![InstallNotice::DesktopOverridden],
        ChangeApplication::Applied | ChangeApplication::Cancelled | ChangeApplication::Unchanged => Vec::new(),
    }
}

/// 安装回执：本次新出现的唯一用户 bundle；不是新增（同名重装/升版）就按包名定位。
/// 都定位不到如实为 None，不猜。spec 位记安装落定的版本——桌面档没有落盘 spec 可读
pub(crate) fn desktop_receipt(
    specifier: &str,
    before: &[DesktopInstalledPlugin],
    after: &[DesktopInstalledPlugin],
) -> Option<InstallReceipt> {
    let added: Vec<&DesktopInstalledPlugin> = after
        .iter()
        .filter(|p| before.iter().all(|b| b.name != p.name))
        .collect();
    let hit = if added.len() == 1 {
        Some(added[0])
    } else {
        let name = package_name_from_specifier(specifier)?;
        after.iter().find(|p| p.name == name)
    }?;
    Some(InstallReceipt {
        name: hit.name.clone(),
        spec: hit.version.clone().unwrap_or_default(),
    })
}

fn audit(app: &tauri::AppHandle, dsh: Option<String>, action: &str, identifier: &str, error: Option<&str>) {
    write_audit(app, &audit_line(DshSurface::Desktop, action, identifier, dsh, error));
}

/// 装进桌面档。approved 有值即放行这批构建脚本后的重装（与 web 档同一审批流程：列出
/// 包名 → 用户放行 → 带着它再调一次）。入参校验在命令入口（market_install）
pub(crate) fn install_once(
    app: &tauri::AppHandle,
    specifier: &str,
    approved: Option<Vec<String>>,
) -> Result<InstallOutcome, Message> {
    // 先读一次：桥接不在就没有可装的地方；读到的列表同时是回执的 before 与台账的版本
    let bundles = bridge::plugins_once()?.bundles;
    let dsh = dsh_version_from(&bundles);
    let before = installed_from(bundles);
    if let Err(display) = enforce_install_policy(specifier) {
        audit(app, dsh, "add", specifier, Some(&format!("policy blocked: {specifier}")));
        return Err(display);
    }
    if let Some(keys) = &approved {
        audit(app, dsh.clone(), "approve-builds", &format!("{specifier} allow={}", keys.join(",")), None);
    }
    let outcome = match bridge::install(specifier, approved.as_deref()) {
        Ok(outcome) => outcome,
        Err(e) => {
            audit(app, dsh, "add", specifier, Some(&e.to_english()));
            return Err(e);
        }
    };
    // 待批构建脚本先于 application 判定：上游此时报 failed，但这不是失败，是一个用户决策点
    if !outcome.pending_builds.is_empty() {
        audit(app, dsh, "needs-approval", specifier, outcome.error_diagnostic.as_deref());
        return Ok(InstallOutcome::NeedsApproval {
            packages: outcome.pending_builds,
            workspace_yaml: None,
        });
    }
    let application = match outcome.application() {
        Ok(ChangeApplication::Cancelled) => {
            audit(app, dsh, "add", specifier, Some("cancelled by the desktop app"));
            return Err(Message::key("DeepSeek Harness cancelled the install."));
        }
        Ok(application) => application,
        Err(display) => {
            audit(app, dsh, "add", specifier, Some(&display.to_english()));
            return Err(display);
        }
    };
    audit(app, dsh, "add", specifier, None);
    let receipt = bridge::plugins_once()
        .ok()
        .and_then(|after| desktop_receipt(specifier, &before, &installed_from(after.bundles)));
    Ok(InstallOutcome::Installed {
        receipt,
        notices: notices_of(application),
    })
}

/// 移除与启停的共同前提：目标是用户装的、非受管的 bundle。入参校验在命令入口
fn change_user_bundle(
    app: &tauri::AppHandle,
    name: &str,
    action: &str,
    identifier: &str,
    change: impl FnOnce() -> Result<ChangeOutcome, Message>,
) -> Result<ChangeApplication, Message> {
    let bundles = bridge::plugins_once()?.bundles;
    let dsh = dsh_version_from(&bundles);
    match installed_from(bundles).into_iter().find(|p| p.name == name) {
        None => {
            return Err(Message::localized("Plugin not installed: {{name}}", &[("name", name.to_string())]));
        }
        Some(p) if p.managed => {
            return Err(Message::key(
                "The bridge plugin is how this app reaches DeepSeek Harness; manage it from the app itself.",
            ));
        }
        Some(_) => {}
    }
    let result = change().and_then(|outcome| outcome.application());
    match &result {
        Ok(ChangeApplication::Cancelled) => audit(app, dsh, action, identifier, Some("cancelled by the desktop app")),
        Ok(_) => audit(app, dsh, action, identifier, None),
        Err(e) => audit(app, dsh, action, identifier, Some(&e.to_english())),
    }
    result
}

pub(crate) fn remove_once(app: &tauri::AppHandle, name: &str) -> Result<ChangeApplication, Message> {
    change_user_bundle(app, name, "remove", name, || bridge::remove(name))
}

pub(crate) fn set_enabled_once(
    app: &tauri::AppHandle,
    name: &str,
    enabled: bool,
) -> Result<ChangeApplication, Message> {
    let identifier = format!("{name} enabled={enabled}");
    change_user_bundle(app, name, "set-enabled", &identifier, || bridge::set_bundle_enabled(name, enabled))
}

pub(crate) fn check_updates_once() -> Result<Vec<PluginUpdateInfo>, Message> {
    let bundles = bridge::plugins_once()?.bundles;
    let dsh = dsh_version_from(&bundles);
    let candidates = installed_from(bundles)
        .into_iter()
        .map(|p| UpdateCandidate {
            name: p.name,
            spec: None,
            managed: p.managed,
            installed_version: p.version,
            // 拿不到安装 spec，就没有可信的上游仓库：只按包名查 registry
            upstream_repo: None,
        })
        .collect();
    // 发布冷却窗口不适用：桌面档的更新一律钉精确版本，那正是 pnpm 认的知情通道，
    // 不存在 web 档「@latest 被静默解析回旧版」的假成功，也就不需要那道确认
    check_updates_with(candidates, (0, Vec::new()), dsh)
}

// ============ IPC ============

/// 桌面档已装插件。桥接不可用时报错——那是「不知道」，前端据此显示未知角标，
/// 而不是空列表（空列表会被读成「没装」）
#[tauri::command]
pub async fn market_desktop_installed() -> Result<Vec<DesktopInstalledPlugin>, Message> {
    super::ipc_blocking(|| Ok(installed_from(bridge::plugins_once()?.bundles))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(name: &str, version: &str, removable: bool) -> BundleRow {
        BundleRow {
            name: name.to_string(),
            version: Some(version.to_string()),
            description: None,
            enabled: true,
            removable,
            read_only_reason: None,
        }
    }

    /// 内置 bundle 不进已装列表；桥接自己在列、但是受管（实测：桌面档的用户 bundle 正是
    /// removable 的那些，内置的 @deepseek-ai/* 一律不可移除）
    #[test]
    fn lists_only_user_bundles_and_marks_the_bridge_managed() {
        let list = installed_from(vec![
            bundle(DESKTOP_BASE_BUNDLE, "0.2.0-rc.2", false),
            bundle("dsh-context", "0.56.2", true),
            bundle(BRIDGE_PACKAGE, "0.1.5", true),
        ]);
        let names: Vec<&str> = list.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["dsh-context", BRIDGE_PACKAGE]);
        assert!(!list[0].managed);
        assert!(list[1].managed);
    }

    #[test]
    fn reads_the_desktop_dsh_version_from_its_base_bundle() {
        let bundles = vec![bundle("x", "1.0.0", true), bundle(DESKTOP_BASE_BUNDLE, "0.2.0-rc.2", false)];
        assert_eq!(dsh_version_from(&bundles).as_deref(), Some("0.2.0-rc.2"));
        assert_eq!(dsh_version_from(&[]), None);
    }

    #[test]
    fn notices_tell_where_a_change_went() {
        assert!(notices_of(ChangeApplication::Applied).is_empty());
        assert!(matches!(
            notices_of(ChangeApplication::RestartRequired).as_slice(),
            [InstallNotice::DesktopRestartRequired]
        ));
        assert!(matches!(
            notices_of(ChangeApplication::Overridden).as_slice(),
            [InstallNotice::DesktopOverridden]
        ));
    }

    fn plugin(name: &str, version: &str) -> DesktopInstalledPlugin {
        DesktopInstalledPlugin {
            name: name.to_string(),
            version: Some(version.to_string()),
            enabled: true,
            managed: false,
        }
    }

    /// 真机全链路探针：对正在运行、桥接已连接的桌面应用跑一遍本模块与模型域的真实路径
    /// （装 → 停用 → 启用 → 卸载、更新检测、模型域写一个探针提供商再撤掉）。会改动
    /// `~/.dsh/profiles/desktop`，结束时撤回；跑之前先备份，跑完核对补丁文件逐字节复原。
    /// `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture desktop_paths_on_the_live_app`
    #[test]
    #[ignore]
    fn desktop_paths_on_the_live_app() {
        use crate::dsh::models::{load_model_config, save_model_config, ModelConfig, ModelEntry, ProviderConfig};
        const PROBE: &str = "dsh-chat-toc";
        const PROBE_SPEC: &str = "dsh-chat-toc@0.5.1";

        let before = installed_from(bridge::plugins_once().expect("bridge connected").bundles);
        assert!(before.iter().any(|p| p.name == BRIDGE_PACKAGE && p.managed), "桥接应在列且受管");
        assert!(before.iter().all(|p| p.name != PROBE), "探针包已装着，先手动卸掉再跑");

        let installed = bridge::install(PROBE_SPEC, None).unwrap();
        println!("install: {:?}", installed.application);
        assert!(installed.pending_builds.is_empty());
        let application = installed.application().unwrap();
        let after = installed_from(bridge::plugins_once().unwrap().bundles);
        let receipt = desktop_receipt(PROBE_SPEC, &before, &after).expect("回执");
        println!("receipt: {} {} ({application:?})", receipt.name, receipt.spec);
        assert_eq!(receipt.name, PROBE);

        let updates = check_updates_once().unwrap();
        let probe = updates.iter().find(|u| u.name == PROBE).expect("探针在更新检测里");
        println!("update: {:?} → {:?} available={}", probe.installed_version, probe.latest_version, probe.update_available);
        assert!(probe.latest_version.is_some());
        assert!(!probe.latest_in_release_age_window, "桌面档一律钉版本，不出窗口确认");
        assert!(updates.iter().all(|u| u.name != BRIDGE_PACKAGE || u.managed));

        for enabled in [false, true] {
            let outcome = bridge::set_bundle_enabled(PROBE, enabled).unwrap().application().unwrap();
            let now = installed_from(bridge::plugins_once().unwrap().bundles);
            let row = now.iter().find(|p| p.name == PROBE).unwrap();
            println!("enabled={enabled}: {outcome:?}");
            assert_eq!(row.enabled, enabled);
        }
        let removed = bridge::remove(PROBE).unwrap().application().unwrap();
        println!("remove: {removed:?}");
        let gone = installed_from(bridge::plugins_once().unwrap().bundles);
        assert!(gone.iter().all(|p| p.name != PROBE));

        // 模型域：读到的是补丁层；原样存回不产生任何写入；加一个探针提供商写进去、
        // 读回来、再撤掉（撤 = 回写继承值），补丁层回到原样
        let original = load_model_config(DshSurface::Desktop).unwrap();
        println!("desktop model config: {} providers, default {:?}/{:?}",
            original.providers.len(), original.default_provider, original.default_model);
        save_model_config(DshSurface::Desktop, &original).unwrap();
        let mut probed: ModelConfig = original.clone();
        probed.providers.push(ProviderConfig {
            route: "dsh-pro-max-probe".into(),
            display_name: Some("Probe".into()),
            base_url: Some("https://probe.invalid/v1".into()),
            api: Some("openai-completions".into()),
            api_key_env: Some("DSH_PRO_MAX_PROBE_KEY".into()),
            // 应用的 schema 要求目录不认识的路由必须列出模型（实测：空列表被拒，原因原样回报）
            models: vec![ModelEntry {
                id: "probe-model".into(),
                name: None,
                context_window: None,
                max_tokens: None,
                input: None,
                reasoning_efforts: None,
                extra: serde_json::Value::Null,
            }],
            headers: None,
            timeout_ms: None,
            reasoning: None,
            extra: serde_json::Value::Null,
        });
        save_model_config(DshSurface::Desktop, &probed).expect("应用的 schema 接受我们写出的形状");
        let reread = load_model_config(DshSurface::Desktop).unwrap();
        assert!(reread.providers.iter().any(|p| p.route == "dsh-pro-max-probe" && p.base_url.as_deref() == Some("https://probe.invalid/v1")));
        save_model_config(DshSurface::Desktop, &original).unwrap();
        let restored = load_model_config(DshSurface::Desktop).unwrap();
        assert_eq!(restored.providers.len(), original.providers.len());
        assert!(restored.providers.iter().all(|p| p.route != "dsh-pro-max-probe"));
    }

    #[test]
    fn receipt_names_the_new_bundle_or_the_reinstalled_one() {
        let before = vec![plugin("a", "1.0.0")];
        // 新增：差集里唯一的那个，哪怕 specifier 是协议形态
        let after = vec![plugin("a", "1.0.0"), plugin("b", "2.0.0")];
        let r = desktop_receipt("github:o/b", &before, &after).unwrap();
        assert_eq!((r.name.as_str(), r.spec.as_str()), ("b", "2.0.0"));
        // 同名升版：没有新增，按包名定位，版本是落定的那个
        let after = vec![plugin("a", "1.1.0")];
        let r = desktop_receipt("a@1.1.0", &before, &after).unwrap();
        assert_eq!((r.name.as_str(), r.spec.as_str()), ("a", "1.1.0"));
        // 协议形态的重装定位不到：如实为 None
        assert!(desktop_receipt("github:o/a", &before, &before).is_none());
    }
}
