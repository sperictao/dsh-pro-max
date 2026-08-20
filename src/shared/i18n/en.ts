// 英文词典：key 即英文原文，en 为恒等映射（显式维护供缺失扫描与类型检查）
export const en = {
  // —— 导航与视图 ——
  "Settings": "Settings",
  "Open": "Open",

  // —— 状态徽章 ——
  "Starting...": "Starting...",
  "Stopping...": "Stopping...",

  // —— 设置：通用 ——
  "General": "General",
  "Appearance": "Appearance",
  "Mode": "Mode",
  "Theme": "Theme",
  "Integrations": "Integrations",
  "About": "About",
  "System Behavior": "System Behavior",
  "Minimize to tray when closing window": "Minimize to tray when closing window",
  "When enabled, the close button hides the window and the app keeps running in the system tray.": "When enabled, the close button hides the window and the app keeps running in the system tray.",
  "Launch at login": "Launch at login",
  "When enabled, the app starts silently in the system tray when you log in.": "When enabled, the app starts silently in the system tray when you log in.",
  "Logs": "Logs",
  "Open log folder": "Open log folder",
  "Logs are written to files only; open the folder when something goes wrong.": "Logs are written to files only; open the folder when something goes wrong.",
  "Language": "Language",
  "English": "English",
  "中文": "中文",

  // —— 设置：外观 ——
  "Follow System": "Follow System",
  "Light": "Light",
  "Dark": "Dark",
  "Theme changes apply immediately. With Follow System, the theme switches automatically with the OS appearance.": "Theme changes apply immediately. With Follow System, the theme switches automatically with the OS appearance.",

  // —— 设置：网络 ——

  // —— 设置：模式 ——

  // —— 设置：看守 ——

  // —— 设置：集成 ——
  "Detecting…": "Detecting…",

  // —— 设置：关于 ——
  "App Version": "App Version",
  "Checking...": "Checking...",
  "Configuration Help": "Configuration Help",
  "Setup Guide": "Setup Guide",
  "Config Template": "Config Template",
  "Check for Updates": "Check for Updates",
  "Update Progress": "Update Progress",
  "Updates": "Updates",
  "Last checked {{at}}": "Last checked {{at}}",
  "Open in Browser": "Open in Browser",
  "Save Settings": "Save Settings",
  "Ready": "Ready",

  // —— Skill 视图 ——

  // —— 看守视图 ——
  "Save": "Save",
  "Error": "Error",

  // —— 看守文件管理 ——
  "Update failed: {{error}}": "Update failed: {{error}}",

  // —— 配置与路径 ——
  "Settings saved": "Settings saved",
  "Save failed: {{error}}": "Save failed: {{error}}",

  // —— 启动/停止 ——
  "Stop failed: {{error}}": "Stop failed: {{error}}",

  // —— 看守开关 ——

  // —— FastCtx ——
  "Working…": "Working…",

  // —— DeepSeek Harness 远程访问 ——
  "DeepSeek Harness": "DeepSeek Harness",
  "Remote access to the dsh Web UI over Tailscale HTTPS: https://<hostname>.ts.net → dsh web :3899. Tailscale identity is authorized by bundled dsh plugins; remote privileged APIs stay denied.": "Remote access to the dsh Web UI over Tailscale HTTPS: https://<hostname>.ts.net → dsh web :3899. Tailscale identity is authorized by bundled dsh plugins; remote privileged APIs stay denied.",
  "Remote access": "Remote access",
  "Switching the access mode only selects the setup/close flow; click Start or Stop below to apply it. It does not start or stop anything by itself.": "Switching the access mode only selects the setup/close flow; click Start or Stop below to apply it. It does not start or stop anything by itself.",
  "Local access to the dsh Web UI at http://127.0.0.1:3899.": "Local access to the dsh Web UI at http://127.0.0.1:3899.",
  "One-click start dsh web": "One-click start dsh web",
  "One-click stop dsh web": "One-click stop dsh web",
  "dsh web stopped": "dsh web stopped",
  "dsh start failed: {{error}}": "dsh start failed: {{error}}",
  "Setup Progress": "Setup Progress",
  "Boot Auto-start": "Boot Auto-start",
  "Auto-start the authorized dsh web service in the background at login": "Auto-start the authorized dsh web service in the background at login",
  "Keeps remote access available without opening this app. Tailscale serve is managed by the Tailscale app itself.": "Keeps remote access available without opening this app. Tailscale serve is managed by the Tailscale app itself.",
  "Remote access ready": "Remote access ready",
  "dsh detection failed: {{error}}": "dsh detection failed: {{error}}",
  "Copy": "Copy",
  "Address copied": "Address copied",
  "Failed to copy: {{error}}": "Failed to copy: {{error}}",
  "URL won't open? Proxy tools (Shadowrocket / Clash / Surge) often hijack *.ts.net traffic — add a DIRECT rule for it on the client device.": "URL won't open? Proxy tools (Shadowrocket / Clash / Surge) often hijack *.ts.net traffic — add a DIRECT rule for it on the client device.",
  "Troubleshooting guide": "Troubleshooting guide",
  "Auto-start enabled": "Auto-start enabled",
  "Auto-start disabled": "Auto-start disabled",
  "Failed to change auto-start: {{error}}": "Failed to change auto-start: {{error}}",
  "Repair dsh stack ({{version}})": "Repair dsh stack ({{version}})",
  "dsh integration repaired for {{version}}": "dsh integration repaired for {{version}}",
  "dsh integration repair failed: {{error}}": "dsh integration repair failed: {{error}}",
  "dsh integration check failed: {{error}}": "dsh integration check failed: {{error}}",
  "Update to {{version}}": "Update to {{version}}",
  "Remote authorization": "Remote authorization",
  "Admin capability domain": "Admin capability domain",
  "Use capability domain": "Use capability domain",
  "Extra allowed logins": "Extra allowed logins",
  "Full capability: {{capability}}": "Full capability: {{capability}}",
  "Empty = remote management (settings/credentials) stays unavailable": "Empty = remote management (settings/credentials) stays unavailable",
  "Empty = plain remote access only needs identity allowlist": "Empty = plain remote access only needs identity allowlist",
  "Comma-separated; the current user on this machine is always allowed": "Comma-separated; the current user on this machine is always allowed",
  "Remote authorization saved": "Remote authorization saved",

  // —— 更新 ——
  "Check failed: {{error}}": "Check failed: {{error}}",
  "Failed to open help: {{error}}": "Failed to open help: {{error}}",
  "Update Now": "Update Now",
  "Installation complete, restarting…": "Installation complete, restarting…",
  "Installing…": "Installing…",
  "Download failed, retrying ({{attempt}}/{{max}})…": "Download failed, retrying ({{attempt}}/{{max}})…",
  "Downloading v{{version}}: {{percent}}%": "Downloading v{{version}}: {{percent}}%",
  "Downloading v{{version}}: {{mb}} MB": "Downloading v{{version}}: {{mb}} MB",
  "New version available: v{{version}}": "New version available: v{{version}}",
  "Already up to date": "Already up to date",
  "Failed to check for updates: {{error}}": "Failed to check for updates: {{error}}",
  "Updating...": "Updating...",

  // —— 初始化 ——
  "Initialization failed: {{error}}": "Initialization failed: {{error}}",
};

export type I18nKey = keyof typeof en;
