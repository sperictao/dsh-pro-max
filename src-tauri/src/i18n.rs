//! Rust 侧极简多语言：key 即英文原文，en 原样返回 key，
//! zh-CN 查表，缺失落回 key（与前端 i18next 的兜底语义一致）。
//! 当前解析语言是进程全局态——单用户桌面应用同一时刻只有一种界面语言。

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

/// 翻译单条字符串
pub fn tr(key: &str) -> String {
    match current() {
        "zh-CN" => zh_cn(key).unwrap_or(key).to_string(),
        _ => key.to_string(),
    }
}

/// 翻译带插值的字符串：占位符形如 `{name}`，按名替换。
/// 各语言可自行调整占位符位置（语序差异）
pub fn trf(key: &str, args: &[(&str, String)]) -> String {
    let mut s = tr(key);
    for (k, v) in args {
        s = s.replace(&format!("{{{}}}", k), v);
    }
    s
}

/// zh-CN 词典。返回 None 表示缺失（调用处落回英文 key）
fn zh_cn(key: &str) -> Option<&'static str> {
    Some(match key {
        // —— 托盘菜单（main.rs）——
        "Show Main Window" => "显示主窗口",
        "Quit" => "退出",

        // —— 进程事故通知（main.rs）——
        "{name} failed" => "{name} 运行失败",

        // —— 环境与工具检测（main.rs）——
        "Cannot get HOME environment variable" => "无法获取 HOME 环境变量",
        "Cannot get USERPROFILE environment variable" => "无法获取 USERPROFILE 环境变量",

        // —— 配置文件（config.rs）——
        "Failed to read config file: {error}" => "读取配置文件失败: {error}",
        "Failed to parse config file: {error}" => "解析配置文件失败: {error}",
        "Failed to create config directory: {error}" => "创建配置目录失败: {error}",
        "Failed to serialize config: {error}" => "序列化配置失败: {error}",
        "Failed to write config file: {error}" => "写入配置文件失败: {error}",

        // —— 应用更新（updater.rs）——
        "Update source not configured; set updater endpoints and pubkey in tauri.conf.json" => "更新源未配置，请在 tauri.conf.json 中设置 updater 的 endpoints 与 pubkey",
        "Update URL must use https" => "更新地址必须使用 https 协议",
        "Update source not configured or unavailable: {error}" => "更新源未配置或不可用: {error}",
        "Failed to check for updates: {error}" => "检查更新失败: {error}",
        " (retried automatically)" => "（已自动重试）",
        "Download failed{note}: {error}" => "下载更新失败{note}: {error}",
        "Updater guide files not found; please run this feature from the source repository" => "未找到 updater 指南文件，请在源码仓库中运行该功能",
        "Updater configuration is ready" => "updater 配置已就绪",
        "Update available" => "发现可用更新",
        "Already up to date; nothing to install" => "当前已是最新版本，无需安装",
        "Failed to install update: {error}" => "安装更新失败: {error}",

        // —— dsh 远程访问（dsh.rs）——
        "Bundled dsh plugin is missing: {plugin}" => "应用内置 dsh 插件缺失: {plugin}",
        "dsh plugin install completed but the web profile is incomplete: {error}" => "dsh 插件安装已结束，但 web profile 不完整: {error}",
        "Failed to install dsh auth plugins: {error}" => "安装 dsh 授权插件失败: {error}",
        "Installed dsh version {actual}, but this Launcher requires {expected}" => "已安装 dsh {actual}，但当前 Launcher 需要 {expected}",
        "Cannot parse Tailscale status: {error}" => "无法解析 Tailscale 状态: {error}",
        "Tailscale status does not contain the current user ID" => "Tailscale 状态中没有当前用户 ID",
        "Tailscale status does not contain the current login name" => "Tailscale 状态中没有当前登录名",
        "Tailscale login name contains unsupported characters" => "Tailscale 登录名包含不支持的字符",
        "Cannot read the current Tailscale identity: {error}" => "无法读取当前 Tailscale 身份: {error}",
        "Compatible dsh is installed: {version}" => "已安装兼容的 dsh: {version}",
        "Installing the pinned dsh ({version})…" => "正在安装锁定的 dsh（{version}）…",
        "Check your network and npm settings, then run npm install -g {package}@{version} and retry" => "请检查网络与 npm 设置，然后运行 npm install -g {package}@{version} 并重试",
        "dsh {version} is outside the supported line ({min} or newer of the same release line); install a compatible version instead" => "dsh {version} 不在受支持的版本线内（需 {min} 或同一版本线的更新 rc），请安装兼容版本",
        "Authorization plugins are installed" => "授权插件已安装",
        "Installing bundled dsh authorization plugins…" => "正在安装内置 dsh 授权插件…",
        "Reinstall this Launcher if its bundled dsh plugins are missing, then retry" => "如果内置 dsh 插件缺失，请重新安装本 Launcher 后重试",
        "Authorization plugins installed" => "授权插件安装完成",
        "Checking Tailscale identity…" => "正在检查 Tailscale 身份…",
        "Install Tailscale and sign in, then run tailscale up and retry" => "请安装并登录 Tailscale，然后运行 tailscale up 并重试",
        "Run tailscale up and sign in with the account allowed to access dsh" => "请运行 tailscale up，并登录允许访问 dsh 的账号",
        "Update Tailscale, sign in again, and verify tailscale status --json" => "请更新 Tailscale、重新登录，并检查 tailscale status --json",
        "Online · authorized identity: {login}" => "在线 · 已授权身份: {login}",
        "Open https://login.tailscale.com/admin/dns and enable MagicDNS and HTTPS Certificates, then retry" => "请打开 https://login.tailscale.com/admin/dns 启用 MagicDNS 与 HTTPS Certificates，然后重试",
        "Restarting dsh web with authorization plugins…" => "正在使用授权插件重启 dsh Web…",
        "Check the log at ~/.dsh/dsh-web.log" => "请查看 ~/.dsh/dsh-web.log",
        "Starting dsh web on 127.0.0.1:3899…" => "正在 127.0.0.1:3899 启动 dsh Web…",
        "Configuring Tailscale Serve directly to dsh…" => "正在把 Tailscale Serve 直接指向 dsh…",
        "Run tailscale up first to sign in, then retry" => "请先运行 tailscale up 登录，然后重试",
        "dsh web is not responding on 127.0.0.1:3899" => "dsh Web 在 127.0.0.1:3899 无响应",
        "The dsh authorization plugin profile is incomplete" => "dsh 授权插件 profile 不完整",
        "Tailscale Serve is not targeting 127.0.0.1:3899" => "Tailscale Serve 未指向 127.0.0.1:3899",
        "HTTPS endpoint is not responding: {url}" => "HTTPS 端点无响应: {url}",
        "WebSocket handshake failed: {url}/api/remote.mux" => "WebSocket 握手失败: {url}/api/remote.mux",
        "Remote use capability was denied; grant {capability} to this identity for the dsh node in tailnet grants, then run one-click setup again" => "远程 use capability 被拒绝；请在 tailnet grants 中把 {capability} 授给当前身份到此 dsh 节点的连接，然后重新一键启动",
        "Remote provider API is not responding: {url}/api/llm/listProviders" => "远程提供方 API 无响应: {url}/api/llm/listProviders",
        "Remote admin capability was denied; grant {capability} to this identity for the dsh node in tailnet grants, then run one-click setup again" => "远程 admin capability 被拒绝；请在 tailnet grants 中把 {capability} 授给当前身份到此 dsh 节点的连接，然后重新一键启动",
        "Remote settings API is not responding: {url}/api/settings/describe" => "远程设置 API 无响应: {url}/api/settings/describe",
        "The local proxy is intercepting the Tailscale address: {url}" => "本机代理正在拦截 Tailscale 地址: {url}",
        "Add {host} to this machine's proxy bypass / skip-proxy list, then retry" => "请把 {host} 加入本机代理的绕过列表（Shadowrocket：通用 → 跳过代理 / skip-proxy），然后重试",
        "Local privileged API access failed on 127.0.0.1:3899" => "127.0.0.1:3899 上的本地特权 API 访问失败",
        "Repair failed: {error}" => "修复失败: {error}",
        "npm query failed: {error}" => "npm 查询失败: {error}",
        "npm query timed out (15s); check your network or npm registry mirror" => "npm 查询超时（15 秒）；请检查网络或 npm registry 镜像配置",
        "Cannot parse npm dist-tags output: {output}" => "无法解析 npm dist-tags 输出: {output}",
        "Invalid dsh version: {version}" => "无效的 dsh 版本: {version}",
        "Installed dsh version {actual}, expected {expected}" => "已安装 dsh {actual}，与目标版本 {expected} 不符",
        "Failed to create directory: {error}" => "创建目录失败: {error}",
        "Failed to read {path}: {error}" => "读取 {path} 失败: {error}",
        "Failed to write {path}: {error}" => "写入 {path} 失败: {error}",
        "Failed to remove dsh auth plugins: {error}" => "卸载 dsh 授权插件失败: {error}",
        "dsh plugin remove completed but auth plugins remain in the web profile: {error}" => "dsh 插件卸载完成但 web profile 仍有残留: {error}",
        "dsh web did not release port 3899" => "dsh Web 未释放 3899 端口",
        "Cannot execute {program}: {error}" => "无法执行 {program}: {error}",
        "Cannot open log file: {error}" => "无法打开日志文件: {error}",
        "Cannot start process: {error}" => "无法启动进程: {error}",
        "Node.js is not available; please install Node.js 18+ and restart this app" => "未检测到 Node.js，请安装 Node.js 18+ 后重启本应用",
        "Cannot locate the dsh CLI; install it with npm install -g @deepseek-ai/dsh" => "无法定位 dsh CLI，请先 npm install -g @deepseek-ai/dsh",
        "Install Node.js 18+ from https://nodejs.org, then restart this app and retry" => "请从 https://nodejs.org 安装 Node.js 18+，然后重启本应用后重试",
        "Checking Node.js & npm…" => "正在检测 Node.js 与 npm…",
        "Node.js is available" => "Node.js 可用",
        "Installed {version}" => "安装完成 {version}",
        "dsh installed but cannot be located in PATH" => "dsh 已安装但 PATH 中找不到",
        "Install failed: {error}" => "安装失败: {error}",
        "Check your network and npm settings, then retry" => "请检查网络与 npm 设置，然后重试",
        "Install dsh first, then retry" => "请先安装 dsh 再重试",
        "Port 3899 may be occupied; stop the process using it and retry" => "端口 3899 可能被占用，请先停止占用该端口的进程后重试",
        "dsh web failed to start; log says:\n{log}" => "dsh Web 启动失败，日志显示：\n{log}",
        "dsh web failed to start (no log output; port 3899 may be occupied)" => "dsh Web 启动失败（无日志输出；端口 3899 可能被占用）",
        "dsh could not create symlinks; on Windows enable Developer Mode (Settings → Privacy & security → For developers), then retry" => "dsh 无法创建符号链接；Windows 请开启开发者模式（设置 → 隐私和安全性 → 开发者选项）后重试",
        "A newer dsh rewrote ~/.dsh/.credentials.yaml into an incompatible format; open it and keep only the KEY: value lines (drop the version:/refs: wrapper), then retry" => "更新版本的 dsh 曾把 ~/.dsh/.credentials.yaml 重写为不兼容格式；请打开该文件，只保留 KEY: value 各行（去掉 version:/refs: 包装层）后重试",
        "Check the log at ~/.dsh/dsh-web.log; port 3899 may be occupied or the dsh CLI may need a newer Node.js" => "请查看 ~/.dsh/dsh-web.log；端口 3899 可能被占用，或 dsh CLI 需要更新的 Node.js",
        "dsh web is running on 127.0.0.1:3899" => "dsh Web 已运行在 127.0.0.1:3899",
        "Restarting dsh web…" => "正在重启 dsh Web…",
        "Local access is ready" => "本地访问已就绪",
        "Tailscale is not installed" => "未检测到 Tailscale",
        "Tailscale is not connected" => "Tailscale 未连接",
        "Checking MagicDNS…" => "正在检测 MagicDNS…",
        "MagicDNS is not enabled" => "MagicDNS 未启用",
        "MagicDNS enabled" => "MagicDNS 已启用",
        "HTTPS serve ready: {url}" => "HTTPS Serve 就绪: {url}",
        "HTTPS serve ready" => "HTTPS Serve 就绪",
        "Serve is not enabled or failed: {error}" => "Serve 未启用或配置失败: {error}",
        "Open the authorization link in the error output to enable Serve for this tailnet (https://login.tailscale.com/f/serve), then retry" => "请打开错误信息中的授权链接为该 tailnet 启用 Serve（https://login.tailscale.com/f/serve），然后重试",
        "Tailscale 1.92+ is required to forward App Capabilities; update Tailscale, then retry" => "转发 App Capability 需要 Tailscale 1.92+；请更新 Tailscale 后重试",
        "Invalid capability domain: {domain}. Use a domain you control (e.g. example.com)" => "无效的 capability 域名: {domain}。请使用你控制的域名（如 example.com）",
        "Fix the remote authorization settings in Settings → DeepSeek Harness, then retry" => "请在设置页的 DeepSeek Harness 分区修正远程授权设置后重试",
        "Verifying remote access ({url})…" => "正在验证远程访问（{url}）…",
        "Remote access is ready: {url}" => "远程访问已就绪: {url}",
        "Verification failed; some components are not ready" => "验证失败，部分组件未就绪",
        "Port 3899 is occupied by another process" => "端口 3899 被其他进程占用",
        "Stop the process listening on 127.0.0.1:3899" => "请先停止监听 127.0.0.1:3899 的进程",
        "Stop the process listening on 127.0.0.1:3899, then retry" => "请先停止监听 127.0.0.1:3899 的进程，然后重试",
        "MagicDNS or HTTPS Certificates may not be enabled; open https://login.tailscale.com/admin/dns and enable MagicDNS and HTTPS Certificates, then retry" => "MagicDNS 或 HTTPS Certificates 可能未启用；请打开 https://login.tailscale.com/admin/dns 启用 MagicDNS 与 HTTPS Certificates 后重试",
        "Cannot register launchd agent: {error}" => "无法注册 launchd 自启项: {error}",
        "Cannot locate the Windows Startup folder (APPDATA is missing)" => "无法定位 Windows 启动文件夹（缺少 APPDATA 环境变量）",
        "Cannot enable systemd unit: {error}" => "无法启用 systemd 服务: {error}",

        // —— 插件市场（dsh/market.rs）——
        "Cannot initialize HTTP client: {error}" => "无法初始化 HTTP 客户端: {error}",
        "Failed to fetch plugin catalog: {error}" => "拉取插件目录失败: {error}",
        "Failed to fetch plugin catalog: HTTP {status}" => "拉取插件目录失败: HTTP {status}",
        "Failed to parse plugin catalog: {error}" => "解析插件目录失败: {error}",
        "Failed to read web profile: {error}" => "读取 web profile 失败: {error}",
        "Failed to parse web profile: {error}" => "解析 web profile 失败: {error}",
        "Web profile has no dependencies" => "web profile 没有依赖条目",
        "Invalid plugin identifier" => "插件标识不合法",
        "Failed to install plugin: {error}" => "安装插件失败: {error}",
        "Failed to remove plugin: {error}" => "移除插件失败: {error}",

        // —— 模型配置（dsh/models.rs）——
        "Failed to read settings.yaml: {error}" => "读取 settings.yaml 失败: {error}",
        "Failed to parse settings.yaml: {error}" => "解析 settings.yaml 失败: {error}",
        "Failed to serialize settings.yaml: {error}" => "序列化 settings.yaml 失败: {error}",
        "Failed to write settings.yaml: {error}" => "写入 settings.yaml 失败: {error}",
        "Model provider advanced fields must be an object" => "模型提供商高级字段必须是对象",
        "Provider route key cannot be empty" => "提供商路由键不能为空",

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
        // 未识别取值与 "system" 同路径，结果只能是两个合法值之一
        let r = resolve_language("fr");
        assert!(r == "en" || r == "zh-CN");
    }

    #[test]
    fn zh_table_hit_and_miss() {
        set_current("zh-CN");
        assert_eq!(tr("Quit"), "退出");
        assert_eq!(tr("Untranslated Key"), "Untranslated Key");
        set_current("en");
        assert_eq!(tr("Quit"), "Quit");
    }

    #[test]
    fn trf_replaces_named_placeholders() {
        set_current("en");
        assert_eq!(
            trf(
                "Path does not exist: {path}",
                &[("path", "/tmp/x".to_string())]
            ),
            "Path does not exist: /tmp/x"
        );
    }
}
