//! 官方 DeepSeek Harness 桌面应用（Electron）的外部能力：检测安装与版本、检测运行、
//! 打开/聚焦、请求退出、新版本提示、日志目录。
//!
//! 这些能力不经过桥接插件，任何桥接态下都可用（见 ADR 0011）；插件与配置管理不属本模块。
//!
//! 平台：官方只发布 macOS arm64 与 Windows x64 两个构建（download.deepseek.com/dsh-desk
//! 的 feeds 下只有 mac-arm64 与 win-x64 两个目录），其余平台 supported() 为 false。
//!
//! 退出只有 macOS 有实现。Windows 上窗口的 close 被应用 preventDefault 成「隐藏到托盘」，
//! 窗口全关也不会 app.quit()，第三方进程没有可触发的正常退出入口；强杀又会跳过应用自己的
//! shutdown 流程。所以 Windows 不提供退出，由 can_quit 告知界面改走托盘菜单说明。
//! macOS 走 AppleScript 的标准 quit 事件，应用仍会弹它自己的退出确认框——与用户按 Cmd+Q
//! 完全一致：我们只发起请求，不代替用户决策。
//!
//! 平台差异一律走 `cfg!` 运行时分支而非 `#[cfg]`：两套实现因此始终参与编译，Windows 侧的
//! 解析逻辑在 macOS 上也能被单元测试覆盖，代价只是几百字节永不执行的分支。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use super::process::port_listening;
use super::DESKTOP_PORT;
use crate::i18n::Message;
use crate::version::is_newer;

/// macOS 应用包的 bundle id（Info.plist 的 CFBundleIdentifier）
const BUNDLE_ID: &str = "com.deepseek.dsh";
/// 产品名：macOS 应用包名与 Windows 安装目录名都由它派生
const PRODUCT_NAME: &str = "DeepSeek Harness";
/// 打开/聚焦用的协议 URL（应用注册的 dsh:// 只认这一条）
const OPEN_URL: &str = "dsh://open";
/// 应用自带的 electron-updater 配置文件名
const UPDATE_CONFIG_FILE: &str = "app-update.yml";
/// 更新源请求超时（取一个几行的 yml）
const UPDATE_FETCH_TIMEOUT_SECS: u64 = 10;

/// 桌面形态的外部状态。桥接态（插件是否已装、能否管理插件与配置）不在此结构里。
#[derive(Debug, Serialize, Clone, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub struct DesktopStatus {
    /// 当前平台是否存在官方构建
    pub supported: bool,
    pub installed: bool,
    /// 已安装版本；未安装为 None
    pub version: Option<String>,
    /// 应用内置服务端口在监听（即应用正在运行）
    pub running: bool,
    /// 能否请求退出：仅 macOS 为真（见模块头）
    pub can_quit: bool,
}

#[tauri::command]
pub async fn desktop_detect() -> Result<DesktopStatus, Message> {
    super::ipc_blocking(detect_once).await
}

/// 打开或聚焦应用：`dsh://open` 由应用自己注册，未运行时拉起、已在运行时聚焦主窗口
/// （两条路径都由宿主应用处理，这里只负责把 URL 交给系统）
#[tauri::command]
pub async fn desktop_open() -> Result<(), Message> {
    super::ipc_blocking(open_once).await
}

/// 请求应用退出。仅 macOS；can_quit 为假的平台界面不会给出入口
#[tauri::command]
pub async fn desktop_quit() -> Result<(), Message> {
    super::ipc_blocking(quit_once).await
}

/// 应用日志目录（Electron app.getPath('logs')），供界面上「打开日志目录」使用
#[tauri::command]
pub async fn desktop_log_dir() -> Result<String, Message> {
    super::ipc_blocking(log_dir_path).await.map(|p| p.to_string_lossy().to_string())
}

/// 更新检查的结论。**三态而不是 Option**：None 无法区分「已是最新」与「查不出来」，
/// 而把后者说成前者是对用户撒谎——未安装、版本读不出、更新源不是通用静态服务都查不出来
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export, export_to = "../../src/shared/bindings/")]
pub enum DesktopUpdate {
    /// 应用自带的更新源上确有更高版本
    Available { version: String },
    /// 查过了，没有更高版本
    UpToDate,
    /// 查不出来（未安装 / 版本读不出 / 更新源不是通用静态服务）；界面如实说不知道，不猜
    Unknown,
}

#[tauri::command]
pub async fn desktop_check_latest() -> Result<DesktopUpdate, Message> {
    super::ipc_blocking(check_latest_once).await
}

/// 当前平台是否存在官方桌面应用构建：macOS arm64 与 Windows x64
pub(crate) fn supported() -> bool {
    (cfg!(target_os = "macos") && cfg!(target_arch = "aarch64"))
        || (cfg!(target_os = "windows") && cfg!(target_arch = "x86_64"))
}

fn detect_once() -> Result<DesktopStatus, Message> {
    let app = app_location();
    Ok(DesktopStatus {
        supported: supported(),
        installed: app.is_some(),
        version: app.as_deref().and_then(installed_version),
        // 未安装却占着端口的只会是别的程序，不算「应用在跑」
        running: app.is_some() && port_listening(DESKTOP_PORT),
        can_quit: cfg!(target_os = "macos"),
    })
}

/// 已安装应用的位置：macOS 是 .app 包路径，Windows 是安装根目录。
/// 各平台都读自己的注册结果，不猜安装位置
fn app_location() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return macos_app_bundle();
    }
    if cfg!(target_os = "windows") {
        return windows_install_dir();
    }
    None
}

/// macOS：先看标准安装位置，再退回 LaunchServices 索引。
/// 索引会把**没装**的应用也算进来（例如下载目录里留着的那一份），而那种副本的版本与更新源
/// 都可能不是用户实际在用的那个——所以标准位置有就优先用它，索引只作「装在别处」的兜底
fn macos_app_bundle() -> Option<PathBuf> {
    let standard = Path::new("/Applications").join(format!("{PRODUCT_NAME}.app"));
    if standard.is_dir() {
        return Some(standard);
    }
    let out = Command::new("mdfind")
        .arg(format!("kMDItemCFBundleIdentifier == '{BUNDLE_ID}'"))
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && Path::new(line).is_dir())
        .map(PathBuf::from)
}

/// Windows：探 electron-builder 的 NSIS 安装根——默认「仅当前用户」装到
/// `%LOCALAPPDATA%\Programs\<产品名>`，选「所有用户」则落在 %ProgramFiles% 系。
/// 以 `resources\app.asar` 是否存在判定，比认 exe 名可靠。
/// 用户在安装器里手改过目录时找不到：宁可报「未安装」，也不去扫全盘。
fn windows_install_dir() -> Option<PathBuf> {
    [
        std::env::var_os("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join("Programs")),
        std::env::var_os("ProgramFiles").map(PathBuf::from),
        std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
    ]
    .into_iter()
    .flatten()
    .map(|root| root.join(PRODUCT_NAME))
    .find(|dir| resources_dir(dir).join("app.asar").is_file())
}

/// 应用包内的 Resources 目录：更新源配置与 asar 都在这下面
fn resources_dir(app: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        return app.join("Contents").join("Resources");
    }
    app.join("resources")
}

/// 已安装版本。两处来源都是打包时写死的产品版本，与更新源里的版本同源
fn installed_version(app: &Path) -> Option<String> {
    if cfg!(target_os = "macos") {
        return plist_value(&app.join("Contents").join("Info.plist"), "CFBundleShortVersionString");
    }
    asar_package_version(&resources_dir(app).join("app.asar"))
}

/// 读 Info.plist 里的一个键。`defaults read` 直接接受 .plist 路径，
/// 不必去解析可能是二进制格式的 plist
fn plist_value(plist: &Path, key: &str) -> Option<String> {
    let out = Command::new("defaults").arg("read").arg(plist).arg(key).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

/// 读 asar 归档的目录头，取根 package.json 的 version。
///
/// 布局：8 字节文件头 → 头块（4 字节头块长度 + 4 字节 JSON 长度 + JSON 目录）→ 数据区。
/// 目录里 `offset` 是十进制**字符串**、`size` 是数字（0.1.7 实测），
/// 数据区起点 = 8 + 头块长度。
fn asar_package_version(archive: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(archive).ok()?;
    let mut file_header = [0u8; 8];
    file.read_exact(&mut file_header).ok()?;
    let header_len = u32::from_le_bytes(file_header[4..8].try_into().ok()?) as usize;

    let mut header = vec![0u8; header_len];
    file.read_exact(&mut header).ok()?;
    let json_len = u32::from_le_bytes(header[4..8].try_into().ok()?) as usize;
    let dir: serde_json::Value = serde_json::from_slice(header.get(8..8 + json_len)?).ok()?;

    let entry = dir.get("files")?.get("package.json")?;
    let offset: u64 = entry.get("offset")?.as_str()?.parse().ok()?;
    let mut body = vec![0u8; entry.get("size")?.as_u64()? as usize];
    file.seek(SeekFrom::Start((8 + header_len) as u64 + offset)).ok()?;
    file.read_exact(&mut body).ok()?;

    serde_json::from_slice::<serde_json::Value>(&body)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

fn open_once() -> Result<(), Message> {
    // 无官方构建的平台 app_location 恒为 None，守卫在此挡下，下面的 else 只服务 Windows
    app_location().ok_or_else(|| Message::key(
            "DeepSeek Harness is not installed. Install it from the official channel; this app only detects and manages it.",
        ))?;
    let status = if cfg!(target_os = "macos") {
        Command::new("open").arg(OPEN_URL).status()
    } else {
        // start 的第一个参数是窗口标题，留空占位，否则 URL 会被当成标题吃掉
        Command::new("cmd").args(["/C", "start", "", OPEN_URL]).status()
    };
    let status = status
        .map_err(|e| Message::localized("Cannot open DeepSeek Harness: {{error}}", &[("error", e.to_string())]))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| Message::key("Cannot open DeepSeek Harness"))
}

fn quit_once() -> Result<(), Message> {
    if !cfg!(target_os = "macos") {
        // 与前端 t() 的 key 逐字相同：key 即英文原文，词典是唯一事实来源
        return Err(Message::key(
            "On this platform the DeepSeek Harness desktop app can only be quit from its own tray menu",
        ));
    }
    // 标准 quit 事件：应用自己决定是否弹确认框、自己跑完 shutdown
    let status = Command::new("osascript")
        .arg("-e")
        .arg(format!("tell application id \"{BUNDLE_ID}\" to quit"))
        .status()
        .map_err(|e| Message::localized("Cannot quit DeepSeek Harness: {{error}}", &[("error", e.to_string())]))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| Message::key("Cannot quit DeepSeek Harness"))
}

/// 应用日志目录：Electron app.getPath('logs') 在 macOS 是 ~/Library/Logs/<产品名>，
/// Windows 是 %APPDATA%\<产品名>\logs
fn log_dir_path() -> Result<PathBuf, Message> {
    // 同上：无官方构建的平台在此挡下，未安装时也没有日志可看
    app_location().ok_or_else(|| Message::key(
            "DeepSeek Harness is not installed. Install it from the official channel; this app only detects and manages it.",
        ))?;
    if cfg!(target_os = "macos") {
        return Ok(crate::config::home_dir()?.join("Library").join("Logs").join(PRODUCT_NAME));
    }
    let appdata = std::env::var_os("APPDATA")
        .ok_or_else(|| Message::key("Cannot locate the DeepSeek Harness log directory"))?;
    Ok(PathBuf::from(appdata).join(PRODUCT_NAME).join("logs"))
}

fn check_latest_once() -> Result<DesktopUpdate, Message> {
    let Some(app) = app_location() else {
        return Ok(DesktopUpdate::Unknown);
    };
    let Some(current) = installed_version(&app) else {
        return Ok(DesktopUpdate::Unknown);
    };
    let Some(latest) = fetch_latest_version(&resources_dir(&app))? else {
        return Ok(DesktopUpdate::Unknown);
    };
    Ok(if is_newer(&latest, &current) {
        DesktopUpdate::Available { version: latest }
    } else {
        DesktopUpdate::UpToDate
    })
}

/// 应用自带的 electron-updater 配置：provider/url/channel
#[derive(serde::Deserialize)]
struct UpdateConfig {
    provider: String,
    url: String,
    channel: String,
}

/// feed 文件里只需版本号
#[derive(serde::Deserialize)]
struct UpdateFeed {
    version: String,
}

/// 从应用自带的更新源取最新版本号。None = 没有可用的更新源信息
/// （更新源不是通用静态服务，或配置文件缺失）
fn fetch_latest_version(resources: &Path) -> Result<Option<String>, Message> {
    let config_file = resources.join(UPDATE_CONFIG_FILE);
    if !config_file.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&config_file).map_err(|e| check_latest_err(&e.to_string()))?;
    let config: UpdateConfig = serde_yaml::from_str(&raw).map_err(|e| check_latest_err(&e.to_string()))?;
    // 非通用静态服务的 feed 地址不是这样拼出来的，不猜
    if config.provider != "generic" {
        return Ok(None);
    }
    // electron-updater 的 feed 文件名约定：macOS 带 -mac 后缀，Windows 不带
    let feed = if cfg!(target_os = "macos") {
        format!("{}-mac.yml", config.channel)
    } else {
        format!("{}.yml", config.channel)
    };
    let url = format!("{}/{feed}", config.url.trim_end_matches('/'));

    let resp = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(UPDATE_FETCH_TIMEOUT_SECS))
        .user_agent(concat!("dsh-pro-max/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| check_latest_err(&e.to_string()))?
        .get(&url)
        .send()
        .map_err(|e| check_latest_err(&e.to_string()))?;
    if !resp.status().is_success() {
        return Err(check_latest_err(&format!("HTTP {}", resp.status().as_u16())));
    }
    let feed: UpdateFeed = serde_yaml::from_str(&resp.text().map_err(|e| check_latest_err(&e.to_string()))?)
        .map_err(|e| check_latest_err(&e.to_string()))?;
    Ok(Some(feed.version))
}

fn check_latest_err(detail: &str) -> Message {
    Message::localized(
        "Cannot check for a new DeepSeek Harness version: {{error}}",
        &[("error", detail.to_string())],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个最小 asar：目录里 package.json 的 offset 是字符串、size 是数字，
    /// 与官方产物一致（0.1.7 实测）
    fn write_asar(path: &Path, version: &str, offset_field: &str) {
        let body = format!("{{\"name\":\"@deepseek-ai/dsh-desktop\",\"version\":\"{version}\"}}");
        let dir = format!(
            "{{\"files\":{{\"package.json\":{{\"size\":{},\"offset\":\"{}\"}}}}}}",
            body.len(),
            offset_field
        );
        let mut header = Vec::new();
        header.extend_from_slice(&((dir.len() + 8) as u32).to_le_bytes());
        header.extend_from_slice(&(dir.len() as u32).to_le_bytes());
        header.extend_from_slice(dir.as_bytes());

        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&(header.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&header);
        bytes.extend_from_slice(body.as_bytes());
        std::fs::write(path, bytes).unwrap();
    }

    fn temp_asar(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("dsh-pro-max-{name}-{}.asar", std::process::id()))
    }

    #[test]
    fn asar_header_yields_the_packaged_version() {
        let path = temp_asar("version");
        write_asar(&path, "0.1.7-rc.1.20260924.1", "0");
        assert_eq!(
            asar_package_version(&path).as_deref(),
            Some("0.1.7-rc.1.20260924.1")
        );
        let _ = std::fs::remove_file(&path);
    }

    /// 偏移字段是数字（而非官方产物的字符串）时不猜：宁可返回 None
    #[test]
    fn asar_offset_must_be_the_declared_string_form() {
        let path = temp_asar("offset");
        write_asar(&path, "1.0.0", "0");
        let bytes = std::fs::read(&path).unwrap();
        let text = String::from_utf8_lossy(&bytes).replace("\"offset\":\"0\"", "\"offset\":0");
        std::fs::write(&path, text.as_bytes()).unwrap();
        assert_eq!(asar_package_version(&path), None);
        let _ = std::fs::remove_file(&path);
    }

    /// 非 asar 文件不能 panic，只能返回 None
    #[test]
    fn non_asar_input_is_rejected_without_panicking() {
        let path = temp_asar("garbage");
        std::fs::write(&path, b"not an asar archive at all").unwrap();
        assert_eq!(asar_package_version(&path), None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn desktop_port_is_the_one_the_app_hardcodes() {
        assert_eq!(DESKTOP_PORT, 19387);
    }

    /// 本机是 macOS arm64 之外的组合时这条断言自动反过来，故按 cfg 推导期望值
    #[test]
    fn unsupported_platforms_have_no_build() {
        let expected = (cfg!(target_os = "macos") && cfg!(target_arch = "aarch64"))
            || (cfg!(target_os = "windows") && cfg!(target_arch = "x86_64"));
        assert_eq!(supported(), expected);
    }
}
