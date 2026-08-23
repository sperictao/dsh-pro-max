# CONTEXT

## DeepSeek Harness 集成（DSH）

本应用的核心功能域：一键安装/启动 DeepSeek Harness（dsh）Web 服务，并经 Tailscale 提供带身份授权的远程 HTTPS 访问。

### 术语

- **dsh** — DeepSeek Harness CLI（`@deepseek-ai/dsh`，npm 全局安装），本应用 pin 支持版本（见 `src-tauri/src/dsh.rs` 的 `SUPPORTED_DSH_VERSION`），不兼容版本走修复流程重装。
- **Web Profile** — dsh 的 `--profile web` 运行档，本应用只管理这一档，本地绑定 `127.0.0.1:3899`。
- **授权插件（Auth Plugins）** — 两个 vendored npm 包（`vendor/dsh-client-connection-authz`、`vendor/dsh-auth-tailscale`），以 pin commit 的 tgz 打进安装包，运行时经 `dsh plugin --profile web add` 装入 web profile；连接鉴权 + Tailscale 身份授权都由它们承担。
- **访问模式（Access Mode）** — 本地（仅 127.0.0.1）或远程（叠加 Tailscale Serve HTTPS）。持久化在 localStorage `dsh-access-mode`，默认本地。
- **Capability 域名（Capability Domain）** — 远程授权的应用能力域名（用户自有域名），拼成 `{domain}/cap/dsh-admin`（管理）与 `{domain}/cap/dsh`（使用）经环境变量注入 dsh 进程，并作为 `tailscale serve --accept-app-caps` 的值；空则不注入，远程特权接口恒 403。
- **允许登录名（Allowed Logins）** — 允许远程访问的 Tailscale 登录名集合；本机当前用户始终自动包含，额外登录名在配置中以逗号分隔。
- **步骤时间线（Step Timeline）** — 安装/设置流程经 `dsh-step` 事件推送到前端的 8 步进度（node → install → plugins → tailscale → magicdns → start → serve → verify），每步含状态与失败时的原因/下一步；verify 同时验证服务直连与本机浏览器代理路径，避免远端可用但本机同一 URL 被代理截获时误报就绪。

### 语义边界

- dsh 进程由本应用 spawn 但**不受管**：不经 ProcessManager，不随应用退出而停止；停止只有显式 Stop（按命令行模式匹配杀进程）。日志在 `~/.dsh/dsh-web.log`。
- 自启动（dsh web 开机自起）事实来源是 OS 注册项（launchd / 启动文件夹 / autostart desktop），本应用不在配置里存布尔值。
- 本应用不写 tailnet 侧任何配置：MagicDNS / HTTPS Certificates / Access Controls 都要求用户在 Tailscale 管理页自行配置，应用只检测并在失败步骤给出指引。
- 任何异机远程访问都要求 tailnet policy 从访问身份到 dsh 节点放行 `tcp:443`；App Capability 只传递应用权限，不会自动放行网络连接。配置 capability 时，同一 grant 必须同时包含 `"ip": ["tcp:443"]` 与同名 `app` 项。
- serve flag 与 tailnet grants 必须与所配 capability 同名——配置教程见 `docs/dsh-remote-access-setup.md`。
- authz replacement 的浏览器 `connection.isLoopback` 只表示“允许尝试 Host-authority RPC”，不是授权结论；本地旁路仍要求 loopback Host + loopback peer，远程每个特权请求仍由 Host authorizer 的 admin capability 独立裁决。客户端不得再用页面 hostname 建第二套权限事实。

## 界面多语言（i18n）

横切关注：壳 UI 与 Rust 侧所有用户可见字符串的多语言。

### 术语

- **界面语言（Display Language）** — 应用自身用户可见文本的语言。设置项三选一：跟随系统 / English / 中文。
- **跟随系统（Follow System）** — 默认取值。启动时按 OS 语言一次性解析：系统为中文则中文，其余一律英文。
- **默认语言（Default Language）** — 英文。跟随系统解析不到中文时的兜底，也是缺失翻译的兜底。
- **解析语言（Resolved Locale）** — 「跟随系统」经解析后得到的具体语言（en 或 zh-CN），启动时确定，改设置后立即重解析。

### 语义边界

- 覆盖壳 UI 与 Rust 侧字符串（托盘、错误消息）；vendored dsh 插件与 dsh 自身 UI 的语言不在此域。
- 切换即时生效：界面重渲染、托盘重建；已产生/已显示的消息不回溯重翻。
- 界面语言与文档语言无关：README、release notes 的双语是另一回事，不受此设置影响。

## 应用壳（Shell）

横切关注：Tauri 桌面壳的进程模型、生命周期与系统交互边界。

### 术语

- **单实例（Single Instance）** — 应用同时只允许一个实例运行；第二次启动不新建进程，转为激活已有实例并显示主窗口（若最小化在托盘则恢复）。
- **自启动（Autostart）** — 开机登录时静默启动到托盘，不显示主窗口。设置项默认关，与 `minimize_to_tray_on_close` 相互独立，不复用。
- **窗口状态记忆（Window State）** — 记忆主窗口尺寸/位置/最大化，启动时恢复；恢复位置落在所有显示器可视区之外时放弃恢复、改为居中。
- **壳通知（Shell Notification）** — 系统级通知，触发点仅限受管子进程的生命周期事故（意外退出、启动失败）。
- **壳日志（Shell Log）** — Rust 侧日志落盘于 app log dir，release 级别 Info，单文件上限 2MB，超限后轮转（旧文件直接删除，仅保留当前一份）；设置页提供「打开日志目录」入口。

### 语义边界

- 壳通知不覆盖 updater 流程（用户手动发起，UI 已覆盖进度与结果）。
- 日志只进文件不进 UI：消费方式是「出事再翻」，无应用内日志查看器，不告警、不上报。

## 界面主题（Theming）

横切关注：壳 UI 的色彩主题系统（tweakcn token 化）。

### 术语

- **主题族（Theme Family）** — 一个 tweakcn 预设的本地化实例，亮暗原生成对。由 `src/theme-families.ts`（构建脚本生成的 manifest）枚举，选择器中的可选项即 manifest 内容。
- **模式（Theme Mode）** — 三选一：跟随系统 / 亮 / 暗。与主题族正交。
- **解析主题（Resolved Theme）** — 族 × 模式解析出的主题名，命名约定 `<族id>-light|dark`，赋给 `<html data-theme>`，对应 `src/themes.css` 中同名 scoped token 块；跟随系统时随 OS 切换重解析。
- **默认族（Default Family）** — `vercel`，视觉基准。localStorage 中的族值不在 manifest 时静默回落默认族。
- **色板卡（Swatch Card）** — 主题族选择器项：卡面自身带 `data-theme` 局部生效，直接渲染该族亮主题的色板缩略。
- **主题构建脚本（Theme Build）** — `scripts/build-themes.mjs`：按写死的预设 id 列表从 tweakcn registry 拉取 token 与字体引用，生成 `src/themes.css`（scoped 块 + `@font-face`）与 `src/theme-families.ts`；生成物提交进 git、不手改，重跑脚本即主动跟随上游（上游新增预设不自动进入，id 列表是唯一事实来源）。
- **字体本地化（Local Fonts）** — 预设引用的 Google 字体 woff2 全部由构建脚本下载进 `assets/fonts/`，CSP 保持 `font-src 'self'`，主题字体完全离线可用。

### 语义边界

- 主题选择器只列亮族：用户不直接选暗色主题，暗面永远由命名约定的配对决定（「每主题适配亮暗」的唯一语义）。
- 主题持久化在 localStorage（`theme` 模式、`theme-family` 族），不进 LauncherConfig、不同步 Rust；语言在 LauncherConfig，两者互不影响。
- 视觉基准以默认族 vercel 为准：其余族是增值选项，组件样式不得为任何族写特例。
- 字体随族：各族的 font token 是该族外观的组成部分，产品不承诺单一品牌字体。
