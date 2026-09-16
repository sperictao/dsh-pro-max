//! Rust 侧的 i18n 残余面：语言解析与「模板 key + 参数」的消息类型。
//!
//! 过 IPC 的用户可见消息（Err / 状态载荷的 error / 时间轴的 detail 等）一律
//! 是 [`Message`]：key 即英文原文（可含 `{{name}}` 占位符），args 是插值值。
//! 前端是唯一解析点——命中词典即用 args 插成中文，miss 就用同一组 args 就地
//! 填出英文原文。Rust 侧不查词典（词典漂移从「静默双语混杂」变为前端可查的
//! key miss）。
//!
//! 这里不再提供「先把值插进句子」的旧 keyf：插值会让成品句子永远命不中
//! 词典里的模板 key，那正是中文界面下诊断恒为英文的成因。
//!
//! 托盘菜单是唯一例外：托盘由 Rust 直产（macOS 菜单标题必须本地化后交给
//! 系统），不经前端渲染，故 tray.rs 仍用 tr() 查本模块的 zh-CN 小表。

use std::collections::BTreeMap;

/// 消息参数值：普通文本，或一条可继续本地化的嵌套消息（如「回滚原因」本身
/// 也是一条诊断）。嵌套时前端递归解析，内层也走词典，不会被提前压成英文
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(untagged)]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub enum MessageArg {
    Text(String),
    Nested(Box<Message>),
}

impl From<String> for MessageArg {
    fn from(text: String) -> Self {
        MessageArg::Text(text)
    }
}

impl From<&str> for MessageArg {
    fn from(text: &str) -> Self {
        MessageArg::Text(text.to_string())
    }
}

impl From<Message> for MessageArg {
    fn from(message: Message) -> Self {
        MessageArg::Nested(Box::new(message))
    }
}

/// 过 IPC 的用户可见消息。
///
/// key 是本地化前的稳定英文原文；带 `{{name}}` 占位符时由 args 插值。
/// 技术性文案（路径、原始 stderr、无法模板化的整句）没有占位符，整串当 key
/// 传递、args 为空，与「原样显示英文」的旧行为逐字一致
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct Message {
    pub key: String,
    #[serde(default)]
    pub args: BTreeMap<String, MessageArg>,
}

impl Message {
    /// 无参数消息：整串即 key
    pub fn key(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            args: BTreeMap::new(),
        }
    }

    /// 模板消息：key 里的 `{{name}}` 由 args 插值（前端命中词典时插成译文）。
    /// 参数值可以是文本，也可以是另一条消息（嵌套解析）
    pub fn localized<V: Clone + Into<MessageArg>>(key: impl Into<String>, args: &[(&str, V)]) -> Self {
        Self {
            key: key.into(),
            args: args
                .iter()
                .map(|(name, value)| ((*name).to_string(), value.clone().into()))
                .collect(),
        }
    }

    /// 按英文原文做子串匹配。Rust 侧只有英文可查（词典在前端），故匹配的是
    /// [`Message::to_english`] 的结果；「这条消息是否提到某个包名」这类判定用它
    pub fn contains(&self, needle: &str) -> bool {
        self.to_english().contains(needle)
    }

    /// 英文原文：按 args 就地填充 `{{name}}`，嵌套消息先各自展开。Rust 侧日志
    /// 与测试用；界面渲染由前端完成（词典是唯一事实来源）
    pub fn to_english(&self) -> String {
        let mut text = self.key.clone();
        for (name, value) in &self.args {
            let rendered = match value {
                MessageArg::Text(text) => text.clone(),
                MessageArg::Nested(message) => message.to_english(),
            };
            text = text.replace(&format!("{{{{{name}}}}}"), &rendered);
        }
        text
    }
}

impl std::fmt::Display for Message {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_english())
    }
}

/// 技术性文案（io::Error、stderr 原文等）：整串当 key，原样显示
impl From<String> for Message {
    fn from(text: String) -> Self {
        Message::key(text)
    }
}

impl From<&str> for Message {
    fn from(text: &str) -> Self {
        Message::key(text)
    }
}

/// 让 `impl Into<Message>` 形参同时接受借用形态，省掉调用点的 `.clone()`
impl From<&Message> for Message {
    fn from(message: &Message) -> Self {
        message.clone()
    }
}

impl From<&String> for Message {
    fn from(text: &String) -> Self {
        Message::key(text.clone())
    }
}

/// 托盘菜单标题的本地化（Rust 直产，无前端解析点）。
/// en 原样返回 key；zh-CN 查托盘小表，缺失落回 key（与前端兜底语义一致）
pub fn tr(key: &str) -> String {
    match current() {
        "zh-CN" => tray_zh_cn(key).unwrap_or(key).to_string(),
        _ => key.to_string(),
    }
}

/// Rust 直产界面（托盘菜单、系统通知）的带参本地化：先查本模块的 zh-CN 小表，
/// 再按 `{name}` 占位符插值；en 界面原样返回填好参数的英文。
///
/// 与 [`Message`] 的分工按渲染点划，不按文案内容：
/// - 前端渲染的文案 → `Message`（key + args 过 IPC，前端词典解析）
/// - OS 直产、无前端渲染点的文案（托盘标题、系统通知标题）→ `trf`（Rust 必须
///   先变成成品字符串再交给系统 API，前端无从介入）
///
/// 小表占位符沿用单花括号 `{name}`，与词典的 `{{name}}` 区分
pub fn trf(key: &str, args: &[(&str, String)]) -> String {
    let mut text = tr(key);
    for (name, value) in args {
        text = text.replace(&format!("{{{name}}}"), value);
    }
    text
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
    fn message_ships_key_and_args_without_resolving_language() {
        // Rust 不插值也不查表：模板与参数分列过 IPC，中文由前端词典解析。
        // 旧 keyf 先把值插进句子，成品句子永远命不中词典里的模板 key
        let templated = Message::localized(
            "Path does not exist: {{path}}",
            &[("path", "/tmp/x".to_string())],
        );
        assert_eq!(templated.key, "Path does not exist: {{path}}");
        assert!(matches!(
            templated.args.get("path"),
            Some(MessageArg::Text(text)) if text == "/tmp/x"
        ));
        // 英文原文按参数就地填充，供 Rust 侧日志与测试
        assert_eq!(templated.to_english(), "Path does not exist: /tmp/x");

        set_current("zh-CN");
        assert_eq!(templated.to_english(), "Path does not exist: /tmp/x");
        set_current("en");

        // 无参数消息：整串即 key，技术性文案（原始 stderr 等）原样显示
        let plain: Message = "ENOENT: no such file".into();
        assert_eq!(plain.key, "ENOENT: no such file");
        assert!(plain.args.is_empty());
        assert_eq!(plain.to_english(), "ENOENT: no such file");
        assert_eq!(Message::key("Quit").to_english(), "Quit");
    }
}
