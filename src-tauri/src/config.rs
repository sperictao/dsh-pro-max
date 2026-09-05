use crate::i18n::keyf;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 启动器配置，持久化到 ~/.dsh-pro-max/config.json
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct LauncherConfig {
    /// 关闭窗口时是否最小化到系统托盘（false 则退出应用）
    #[serde(default)]
    pub minimize_to_tray_on_close: bool,

    /// 界面语言："system"（跟随系统）/ "en" / "zh-CN"
    #[serde(default = "default_language")]
    pub language: String,

    /// dsh 远程管理 capability 的域名部分（完整为 `{domain}/cap/dsh-admin`）。
    /// 空 = 不注入 DSH_TAILSCALE_ADMIN_CAPABILITY，远程管理接口恒 403。
    #[serde(default)]
    pub dsh_admin_cap_domain: String,

    /// dsh 远程普通使用 capability 的域名部分（完整为 `{domain}/cap/dsh`）。
    /// 空 = 不注入 DSH_TAILSCALE_USE_CAPABILITY；
    /// 普通远程访问仍需身份 allowlist 与 tailnet TCP 443 grant。
    #[serde(default)]
    pub dsh_use_cap_domain: String,

    /// 额外允许访问 dsh 的 Tailscale 登录名（逗号分隔）；本机当前用户始终自动包含。
    #[serde(default)]
    pub dsh_extra_allowed_logins: String,

    /// 插件市场目录源（企业内网镜像）。空 = 内置官方源；
    /// 非空必须是 https:// 或 http:// 地址，且返回同一 JSON 契约（schemaVersion 1）
    #[serde(default)]
    pub market_catalog_url: String,
}

fn default_language() -> String {
    "system".to_string()
}

impl Default for LauncherConfig {
    fn default() -> Self {
        Self {
            minimize_to_tray_on_close: false,
            language: default_language(),
            dsh_admin_cap_domain: String::new(),
            dsh_use_cap_domain: String::new(),
            dsh_extra_allowed_logins: String::new(),
            market_catalog_url: String::new(),
        }
    }
}

/// 跨平台获取用户主目录
pub fn home_dir() -> Result<PathBuf, String> {
    // Unix 使用 HOME，Windows 使用 USERPROFILE
    #[cfg(unix)]
    {
        std::env::var("HOME").map(PathBuf::from).map_err(|e| {
            crate::logging::fail("读取 HOME 环境变量", &e.to_string());
            keyf("Cannot get HOME environment variable", &[])
        })
    }
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .map_err(|e| {
                crate::logging::fail("读取 USERPROFILE 环境变量", &e.to_string());
                keyf("Cannot get USERPROFILE environment variable", &[])
            })
    }
}

/// 获取配置文件路径
pub fn config_file_path() -> Result<PathBuf, String> {
    let home = home_dir()?;
    Ok(home.join(".dsh-pro-max").join("config.json"))
}

/// 剥掉 Windows `\\?\` 扩展路径前缀。
/// Tauri resource_dir 内部 canonicalize 的副作用；CreateProcess 的工作目录参数
/// 不认这个前缀，Node 拿到也别扭，统一剥成普通路径
pub fn strip_unc(s: &str) -> String {
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", rest);
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    s.to_string()
}

/// 加载配置文件，不存在则返回默认值
pub fn load_config() -> Result<LauncherConfig, String> {
    let path = config_file_path()?;
    if !path.exists() {
        return Ok(LauncherConfig::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| {
        crate::logging::warn("读取配置文件", &e.to_string());
        keyf(
            "Failed to read config file: {error}",
            &[("error", e.to_string())],
        )
    })?;
    let config: LauncherConfig = serde_json::from_str(&content).map_err(|e| {
        crate::logging::warn("解析配置文件", &e.to_string());
        keyf(
            "Failed to parse config file: {error}",
            &[("error", e.to_string())],
        )
    })?;
    Ok(config)
}

/// 用新设置字段更新现有配置
pub fn merge_settings(current: &mut LauncherConfig, settings: &LauncherConfig) {
    current.minimize_to_tray_on_close = settings.minimize_to_tray_on_close;
    current.language = settings.language.clone();
    current.dsh_admin_cap_domain = settings.dsh_admin_cap_domain.clone();
    current.dsh_use_cap_domain = settings.dsh_use_cap_domain.clone();
    current.dsh_extra_allowed_logins = settings.dsh_extra_allowed_logins.clone();
    current.market_catalog_url = settings.market_catalog_url.clone();
}

/// 保存配置文件
pub fn save_config(config: &LauncherConfig) -> Result<(), String> {
    let path = config_file_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            crate::logging::error("创建配置目录", &e.to_string());
            keyf(
                "Failed to create config directory: {error}",
                &[("error", e.to_string())],
            )
        })?;
    }
    let content = serde_json::to_string_pretty(config).map_err(|e| {
        crate::logging::error("序列化配置", &e.to_string());
        keyf(
            "Failed to serialize config: {error}",
            &[("error", e.to_string())],
        )
    })?;
    std::fs::write(&path, content).map_err(|e| {
        crate::logging::error("写入配置文件", &e.to_string());
        keyf(
            "Failed to write config file: {error}",
            &[("error", e.to_string())],
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_settings_updates_all_setting_fields() {
        let mut current = LauncherConfig::default();

        let settings = LauncherConfig {
            minimize_to_tray_on_close: true,
            language: "zh-CN".to_string(),
            dsh_admin_cap_domain: "admin.example.com".to_string(),
            dsh_use_cap_domain: "use.example.com".to_string(),
            dsh_extra_allowed_logins: "alice@example.com,bob@example.com".to_string(),
            market_catalog_url: "https://mirror.example.com/catalog.json".to_string(),
        };

        merge_settings(&mut current, &settings);

        assert!(current.minimize_to_tray_on_close);
        assert_eq!(current.language, "zh-CN");
        assert_eq!(current.dsh_admin_cap_domain, "admin.example.com");
        assert_eq!(current.dsh_use_cap_domain, "use.example.com");
        assert_eq!(
            current.dsh_extra_allowed_logins,
            "alice@example.com,bob@example.com"
        );
        assert_eq!(
            current.market_catalog_url,
            "https://mirror.example.com/catalog.json"
        );
    }
}
