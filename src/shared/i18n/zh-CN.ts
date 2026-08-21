import type { I18nKey } from "./en";

// 中文词典：Record<I18nKey, string> 保证与英文词典编译期同步，漏 key 直接编译错误
export const zhCN: Record<I18nKey, string> = {
  // —— 导航与视图 ——
  "Settings": "设置",
  "Open": "打开",

  // —— 状态徽章 ——
  "Starting...": "启动中...",
  "Stopping...": "停止中...",

  // —— 设置：通用 ——
  "General": "通用",
  "Appearance": "外观",
  "Mode": "模式",
  "Theme": "主题",
  "Integrations": "集成",
  "About": "关于",
  "System Behavior": "系统行为",
  "Minimize to tray when closing window": "关闭窗口时最小化到托盘",
  "When enabled, the close button hides the window and the app keeps running in the system tray.": "启用后点击关闭按钮会隐藏窗口，应用继续驻留系统托盘。",
  "Launch at login": "登录时启动",
  "When enabled, the app starts silently in the system tray when you log in.": "启用后登录系统时应用静默启动并驻留系统托盘。",
  "Logs": "日志",
  "Open log folder": "打开日志目录",
  "Logs are written to files only; open the folder when something goes wrong.": "日志只写入文件，出问题时打开目录查看。",
  "Language": "语言",
  "English": "English",
  "中文": "中文",

  // —— 设置：外观 ——
  "Follow System": "跟随系统",
  "Light": "亮色",
  "Dark": "暗色",
  "Theme changes apply immediately. With Follow System, the theme switches automatically with the OS appearance.": "主题切换立即生效；选择“跟随系统”时会随系统外观自动切换。",

  // —— 设置：网络 ——

  // —— 设置：模式 ——

  // —— 设置：看守 ——

  // —— 设置：集成 ——
  "Detecting…": "检测中…",

  // —— 设置：关于 ——
  "App Version": "应用版本",
  "Checking...": "检查中...",
  "Configuration Help": "配置帮助",
  "Setup Guide": "配置指南",
  "Config Template": "配置模板",
  "Check for Updates": "检查更新",
  "Update Progress": "更新进度",
  "Updates": "更新",
  "Last checked {{at}}": "上次检查 {{at}}",
  "Open in Browser": "在浏览器中打开",
  "Save Settings": "保存配置",
  "Ready": "已就绪",

  // —— Skill 视图 ——

  // —— 看守视图 ——
  "Save": "保存",
  "Error": "错误",

  // —— 看守文件管理 ——
  "Update failed: {{error}}": "更新失败: {{error}}",

  // —— 配置与路径 ——
  "Settings saved": "配置已保存",
  "Save failed: {{error}}": "保存失败: {{error}}",

  // —— 启动/停止 ——
  "Stop failed: {{error}}": "停止失败: {{error}}",

  // —— 看守开关 ——

  // —— FastCtx ——
  "Working…": "处理中…",

  // —— DeepSeek Harness 远程访问 ——
  "DeepSeek Harness": "DeepSeek Harness",
  "Remote access to the dsh Web UI over Tailscale HTTPS: https://<hostname>.ts.net → dsh web :3899. Tailscale identity is authorized by bundled dsh plugins; remote privileged APIs stay denied.": "通过 Tailscale HTTPS 远程访问 dsh Web UI：https://<hostname>.ts.net → dsh web :3899。内置 dsh 插件校验 Tailscale 身份，远程特权 API 保持禁用。",
  "Remote access": "远程访问",
  "Switching the access mode only selects the setup/close flow; click Start or Stop below to apply it. It does not start or stop anything by itself.": "切换访问模式只会改变安装与关闭流程，不会自动执行任何启动或停止操作；请用下方的启动/关闭按钮执行。",
  "dsh web is running; stop it before switching the access mode.": "dsh web 正在运行；请先停止，再切换访问模式。",
  "App": "应用",
  "Source code, issue tracker, and release history.": "源代码、问题跟踪与历史版本。",
  "dsh is the DeepSeek Harness CLI; this app bundles a verified compatibility stack (CLI + authorization plugins) for one-click local & remote access.": "dsh 是 DeepSeek Harness CLI；本应用内置验证过的兼容栈（CLI + 授权插件），支持一键本地与远程访问。",
  "Local access to the dsh Web UI at http://127.0.0.1:3899.": "在 http://127.0.0.1:3899 本地访问 dsh Web UI。",
  "One-click start dsh web": "一键启动 dsh web",
  "One-click stop dsh web": "一键关闭 dsh web",
  "dsh web stopped": "dsh web 已停止",
  "dsh start failed: {{error}}": "dsh 启动失败: {{error}}",
  "Setup Progress": "安装进度",
  "Boot Auto-start": "开机自启",
  "Auto-start the authorized dsh web service in the background at login": "登录时后台自动启动带授权的 dsh Web 服务",
  "Keeps remote access available without opening this app. Tailscale serve is managed by the Tailscale app itself.": "无需打开本应用即可保持远程访问可用。Tailscale serve 由 Tailscale 应用自身托管。",
  "Remote access ready": "远程访问已就绪",
  "dsh detection failed: {{error}}": "dsh 检测失败: {{error}}",
  "Copy": "复制",
  "Address copied": "地址已复制",
  "Failed to copy: {{error}}": "复制失败: {{error}}",
  "URL won't open? Proxy tools (Shadowrocket / Clash / Surge) often hijack *.ts.net traffic — add a DIRECT rule for it on the client device.": "地址打不开？代理工具（Shadowrocket / Clash / Surge）常会拦截 *.ts.net 流量——需在访问端设备上把它配成 DIRECT 直连规则。",
  "Troubleshooting guide": "排障指南",
  "Auto-start enabled": "已开启开机自启",
  "Auto-start disabled": "已关闭开机自启",
  "Failed to change auto-start: {{error}}": "修改开机自启失败: {{error}}",
  "Repair dsh stack ({{version}})": "修复 dsh 兼容栈（{{version}}）",
  "dsh integration repaired for {{version}}": "dsh 集成已修复为 {{version}}",
  "dsh integration repair failed: {{error}}": "dsh 集成修复失败: {{error}}",
  "dsh integration check failed: {{error}}": "dsh 集成检查失败: {{error}}",
  "Remove authorization plugins": "卸载授权插件",
  "Authorization plugins removed": "授权插件已卸载",
  "Failed to remove authorization plugins: {{error}}": "卸载授权插件失败: {{error}}",
  "Newer than the verified stack ({{version}}); authorization plugins may be incompatible": "高于验证过的兼容栈（{{version}}），授权插件可能不兼容",
  "dsh Version": "dsh 版本",
  "Check Latest": "检测最新版",
  "Installed": "已安装",
  "Not installed": "未安装",
  "installed": "已安装",
  "unverified": "未验证",
  "Install": "安装",
  "dsh updated to {{version}}": "dsh 已更新到 {{version}}",
  "Install failed: {{error}}": "安装失败: {{error}}",
  "The verified stack is {{version}} — the dsh version this app's bundled authorization plugins are tested against. Versions marked unverified work for local access but remote authorization is untested.": "验证过的兼容栈是 {{version}}——本应用内置授权插件测试通过的 dsh 版本。标记「未验证」的版本可用于本地访问，但远程授权未经兼容性测试。",
  "Update to {{version}}": "更新到 {{version}}",
  "Remote authorization": "远程授权",
  "Admin capability domain": "管理 capability 域名",
  "Use capability domain": "普通使用 capability 域名",
  "Extra allowed logins": "额外允许的登录名",
  "Full capability: {{capability}}": "完整 capability：{{capability}}",
  "Empty = remote management (settings/credentials) stays unavailable": "留空 = 远程管理（settings/credentials）不可用",
  "Empty = plain remote access only needs identity allowlist": "留空 = 普通远程访问只需身份 allowlist",
  "Comma-separated; the current user on this machine is always allowed": "逗号分隔；本机当前用户始终允许",
  "Remote authorization saved": "远程授权已保存",

  // —— 更新 ——
  "Check failed: {{error}}": "检查失败: {{error}}",
  "Failed to open help: {{error}}": "打开帮助失败: {{error}}",
  "Failed to open: {{error}}": "打开失败: {{error}}",
  "Failed to open link: {{error}}": "打开链接失败: {{error}}",
  "Update Now": "立即更新",
  "Installation complete, restarting…": "安装完成，正在重启…",
  "Installing…": "正在安装…",
  "Download failed, retrying ({{attempt}}/{{max}})…": "下载失败，正在重试（{{attempt}}/{{max}}）…",
  "Downloading v{{version}}: {{percent}}%": "正在下载 v{{version}}：{{percent}}%",
  "Downloading v{{version}}: {{mb}} MB": "正在下载 v{{version}}：{{mb}} MB",
  "New version available: v{{version}}": "发现新版本: v{{version}}",
  "Already up to date": "当前已是最新版本",
  "Failed to check for updates: {{error}}": "检查更新失败: {{error}}",
  "Updating...": "更新中...",

  // —— 初始化 ——
  "Initialization failed: {{error}}": "初始化失败: {{error}}",
};
