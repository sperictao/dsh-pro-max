//! Rust 侧的 i18n 残余面：语言解析与「key 即英文原文」的插值器。
//!
//! 过 IPC 的用户可见字符串（Err / 状态载荷的 error / 托盘标题之外的界面
//! 文案）一律是本地化前的稳定 key：en 界面 key 即英文原文，zh-CN 由前端
//! 词典（唯一事实来源）解析。Rust 侧不再查词典（词典漂移从「静默双语混杂」
//! 变为前端可查的 key miss）。
//!
//! 托盘菜单是唯一例外：托盘由 Rust 直产（macOS 菜单标题必须本地化后交给
//! 系统），不经前端渲染，故 tray.rs 仍用 tr() 查本模块的 zh-CN 小表。

/// key 即英文原文的插值器：trf 的非查表形态。只按 {name} 占位符替换参数，
/// 不解析语言。Err/载荷里的用户可见文案全部经此产出——字符串稳定
/// （前端以同一 key 查词典），技术细节（路径/版本/原始 stderr）照常带入
pub fn keyf(key: &str, args: &[(&str, String)]) -> String {
    let mut s = key.to_string();
    for (k, v) in args {
        s = s.replace(&format!("{{{}}}", k), v);
    }
    s
}

/// 托盘菜单标题的本地化（Rust 直产，无前端解析点）。
/// en 原样返回 key；zh-CN 查托盘小表，缺失落回 key（与前端兜底语义一致）
pub fn tr(key: &str) -> String {
    match current() {
        "zh-CN" => tray_zh_cn(key).unwrap_or(key).to_string(),
        _ => key.to_string(),
    }
}

// —— 语言解析（进程全局态：单用户桌面应用同一时刻只有一种界面语言）——

use std::sync::RwLock;

static LANG: RwLock<&'static str> = RwLock::new("en");

/// 把设置值（"system" / "en" / "zh-CN"）解析成具体语言。
/// system：OS 语言以 zh 开头则中文，其余一律英文（英文是默认与兜底语言）
pub fn resolve_language(setting: &str) -> &'static str {
    match setting {
        "en" => "en",
        "zh-CN" => "zh-CN",
        _ => match sys_locale::get_locale() {
            Some(l) if l.to_lowercase().replace(['-', '_'], "").starts_with("zh") => "zh-CN",
            _ => "en",
        },
    }
}

/// 启动时/切换设置后更新当前解析语言
pub fn set_current(lang: &'static str) {
    if let Ok(mut l) = LANG.write() {
        *l = lang;
    }
}

/// 当前解析语言（"en" | "zh-CN"）
pub fn current() -> &'static str {
    LANG.read().map(|l| *l).unwrap_or("en")
}

/// 托盘域的 zh-CN 小表（仅此模块使用；界面文案词典在前端 en.ts/zh-CN.ts）
fn tray_zh_cn(key: &str) -> Option<&'static str> {
    Some(match key {
        "Show Main Window" => "显示主窗口",
        "One-click start dsh web" => "一键启动 dsh web",
        "One-click stop dsh web" => "一键关闭 dsh web",
        "One-click restart dsh web" => "一键重启 dsh web",
        "Quit" => "退出",
        "{name} failed" => "{name} 运行失败",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_setting_wins() {
        assert_eq!(resolve_language("en"), "en");
        assert_eq!(resolve_language("zh-CN"), "zh-CN");
    }

    #[test]
    fn unknown_setting_falls_back_to_system_or_en() {
        let r = resolve_language("fr");
        assert!(r == "en" || r == "zh-CN");
    }

    #[test]
    fn tray_table_hit_and_miss() {
        set_current("zh-CN");
        assert_eq!(tr("Quit"), "退出");
        assert_eq!(tr("Untranslated Key"), "Untranslated Key");
        set_current("en");
        assert_eq!(tr("Quit"), "Quit");
    }

    #[test]
    fn keyf_interpolates_without_resolving_language() {
        set_current("en");
        assert_eq!(
            keyf("Path does not exist: {path}", &[("path", "/tmp/x".to_string())]),
            "Path does not exist: /tmp/x"
        );
        // key 即英文原文：不查表，中文界面下 Rust 也只产 key（前端 tErr 解析）
        set_current("zh-CN");
        assert_eq!(
            keyf("Path does not exist: {path}", &[("path", "/tmp/y".to_string())]),
            "Path does not exist: /tmp/y"
        );
        set_current("en");
    }
}
