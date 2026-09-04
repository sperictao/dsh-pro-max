# CONTEXT

## DeepSeek Harness 集成（DSH）

本应用的核心功能域：一键安装/启动 DeepSeek Harness（dsh）Web 服务，并经 Tailscale 提供带身份授权的远程 HTTPS 访问。

### 术语

- **dsh** — DeepSeek Harness CLI（`@deepseek-ai/dsh`，npm 全局安装），本应用 pin 支持版本（见 `src-tauri/src/dsh.rs` 的 `SUPPORTED_DSH_VERSION`），不兼容版本走修复流程重装。
- **Web Profile** — dsh 的 `--profile web` 运行档，本应用只管理这一档，本地绑定 `127.0.0.1:3899`。
- **授权插件（Auth Plugins）** — 两个 vendored npm 包（`vendor/dsh-client-connection-authz`、`vendor/dsh-auth-tailscale`），以 pin commit 的 tgz 打进安装包，运行时经 `dsh plugin --profile web add` 装入 web profile；连接鉴权 + Tailscale 身份授权都由它们承担。构建脚本为每个 tgz 产出同目录 `.sha256` 摘要并随 bundle resources 打包，装入前逐台复核（缺失或不符都按损坏拒绝）。
- **访问模式（Access Mode）** — 本地（仅 127.0.0.1）或远程（叠加 Tailscale Serve HTTPS）。持久化在 localStorage `dsh-access-mode`，默认本地。
- **Capability 域名（Capability Domain）** — 远程授权的应用能力域名（用户自有域名），拼成 `{domain}/cap/dsh-admin`（管理）与 `{domain}/cap/dsh`（使用）经环境变量注入 dsh 进程，并作为 `tailscale serve --accept-app-caps` 的值；空则不注入，远程特权接口恒 403。
- **允许登录名（Allowed Logins）** — 允许远程访问的 Tailscale 登录名集合；本机当前用户始终自动包含，额外登录名在配置中以逗号分隔。
- **步骤时间线（Step Timeline）** — 安装/设置流程经 `dsh-step` 事件推送到前端的 8 步进度（node → install → plugins → tailscale → magicdns → start → serve → verify），每步含状态与失败时的原因/下一步；verify 同时验证服务直连与本机浏览器代理路径，避免远端可用但本机同一 URL 被代理截获时误报就绪。

### 语义边界

- dsh 进程由本应用 spawn 但**不受管**：不经 ProcessManager，不随应用退出而停止；停止只有显式 Stop（按命令行模式匹配杀进程）。日志在 `~/.dsh/dsh-web.log`。
- dsh 的 credentials 写锁（`~/.dsh/.credentials.yaml.lock`，内容为持锁 PID）在持锁进程被强杀后成永久孤儿，dsh 自身不回收（其设计声明孤儿回收是 operator 动作）；Launcher 充当该 operator：启动前与强杀停止后按「持锁 PID 已死」判定清理，活锁（真实并发持有）不动。启动失败诊断对该锁超时指纹优先于插件链归因。
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

## 插件市场（Marketplace）

功能域：浏览社区插件目录，一键安装/移除/更新 web profile 插件。导航项「Plugins」，二级导航「发现 / 已安装」。

### 术语

- **插件目录（Catalog）** — awesome-dsh-plugin 的 curated 目录（默认 `https://awesome-dsh-plugin.com/plugins.json`，静态 JSON，双语文案由目录供应）在 Rust 侧拉取并投影后的精简列表；`screenshots`、`tarball`、`downloads` 等浏览与安装用不上的字段在解析时丢弃，原文不进 WebView。目录数据跨视图保留，切页不重拉；市场首开先直读本地快照秒级上屏，网络目录在后台刷新后整体替换。目录没有契约版本字段，按结构校验：`plugins` 投影不出非空列表即拒绝（不猜格式、不拿旧数据掩盖）。
- **目录源（Catalog Source）** — 目录的拉取地址，默认内置官方源；可经设置页配置为私有镜像（同一 plugins.json 契约，必须显式带 `https://`/`http://`），下次刷新生效。
- **目录快照（Catalog Snapshot）** — 最近一次成功拉取后落盘 app data dir 的投影目录（与前端消费同一份数据，亚 MB 级；不保存响应原文，旧契约快照按无快照处理、下次成功拉取自动重建）。市场首开直读快照秒显（`fromSnapshot` 如实标注、刷新进行中不出横幅），网络失败时继续展示快照并以横幅标注快照时间；快照自身损坏按无快照处理并回退原始网络错误（它不掩盖在线数据的问题）。
- **弃用标记（Deprecated）** — 目录侧的 `deprecated` / `replacement` 字段原样透传：弃用条目展示「已弃用」徽章，给出替代建议时一并展示「建议改用 X」。目录不提供验证/审计数据，Launcher 不伪造任何安全徽标。
- **一键安装（One-click Install）** — 安装标识从条目 `install` 命令串（如 `dsh plugin --profile web add <specifier>`）中解析 ` add ` 之后的 token，执行 `dsh plugin --profile web add <specifier>`（pnpm 转发，pnpm ≥10 默认拦截第三方生命周期脚本；该拦截被识别时错误文案给出精确到 `pnpm-workspace.yaml` allowBuilds 的指引，不改写文件）；解析不出合法 token 的条目只可浏览（Manual install only），安装前有内联二次确认。`install` 命令串是展示文本，绝不整条执行。
- **安装回执（Install Receipt）** — 安装成功后回读 web profile 落盘事实（dependencies 键 + spec），toast 展示；其持久形态是已装列表里常驻的 name + spec 行（含精确版本，随时可查）；`github:` 重装等无法唯一定位落点的场景如实不回执。
- **插件安装策略（Plugin Policy）** — `~/.dsh-pro-max/plugin-policy.json` 的白名单（`{"allowed": [...]}`，支持包名、`@scope/` 与 `github:owner/` 前缀、协议条目）。文件缺失或 `allowed` 缺席 = 不启用；`allowed` 存在即生效（空数组 = 全拒）。只约束安装，移除总能做；文件损坏按拒绝处理。
- **插件审计台账（Plugin Audit Log）** — 市场视图安装/移除操作的 append-only JSONL（`plugin-audit.jsonl`，app log dir，含时间/动作/标识符/结果/两侧版本号，error 记本地化前的原始错误）；受管授权插件由 Launcher 修复/卸载流程管理，不走市场路径、不入台账；尽力而为写入，失败不回滚操作。
- **受管插件（Managed Plugin）** — Launcher 自装的授权插件（`@dsh-external/*`），在已装列表中标记但不提供移除按钮，由 Launcher 的修复/卸载流程管理。
- **已装匹配（Installed Match）** — npm 形态 specifier 的包名部分与 web profile `package.json` dependencies 键比对；带协议前缀的形态（`github:`、`npm:`、`file:` 等）安装后的键名无法从目录预知，不参与匹配。
- **更新检测（Update Check）** — 已安装页对 npm 形态安装的非受管插件自动比对 registry latest（进入市场页即查，可手动重跑）：spec 能解析出具体版本（`pkg@1.2.3` / `npm:pkg@1.0.0` / 裸版本；范围 `^ ~` 与协议形态不可检）即逐包查 `registry.npmjs.org/<name>/latest` 语义版本比对，部分包查询失败不放大为整体失败（如实无 latest、不出按钮），全部可检包都失败才报错。更新动作 = 以 `name@latest` 重装，与一键安装同一 dsh 闸门、策略、审计与构建脚本审批路径；批量更新顺序执行（共享同一 profile，pnpm 并发会争锁），中途撞上审批挂起即停，剩余项待放行后重试。

### 语义边界

- 目录是社区数据：Launcher 不做分类/验证/排名的二次加工，只按目录原样展示与执行。弃用标记与安装是两件事——弃用插件同样可一键安装，徽章与替代建议让这一点可见。分类显示名取自目录原生双语表（en/zh），缺失时回退展示分类 id。
- 安装与移除是长操作（pnpm 下载依赖），UI 以 busy 态呈现，不做后台任务化。
- identifier 经字符白名单校验（npm/pnpm 合法字符集，拒绝相对路径与 `..`），挡写歪的目录数据与手改 IPC 的误用；安装本就只在 loopback 的 dsh profile 目录内进行。
- 快照、回执、审计、策略都是本机机制：无云控制面、无集中上报；审计台账与壳日志是两个文件、两种保留策略（日志轮转即删，台账保留全部）。

## 模型配置（Model Configuration）

功能域：编辑 `~/.dsh/settings.yaml` 的模型相关配置。导航项「Models」。

### 术语

- **模型域（Model Domain）** — settings.yaml 中 `agent-default-model`（默认模型选择）与 `llm-pi-ai.providers`（自定义提供商路由）两键；保存以 UI 状态整体重建这两键，其余顶层键（`llm-deepseek`、`agent-presets` 等）原样保留。
- **提供商路由（Provider Route）** — `llm-pi-ai.providers` 的一个键，承载 displayName / baseURL / api（wire 协议：openai-completions | openai-responses | anthropic-messages）/ apiKeyEnv / models 列表；UI 管理 5 个字段之外的高级字段经 `extra` 原样透传保存，`extra` 混入管理键时一律以 UI 为准丢弃。
- **凭据引用（Credential Ref）** — `apiKeyEnv` 只保存环境变量名，密钥值永不进配置文件（dsh 运行时经 credentials 机制逐请求解析）。
- **思考等级（Reasoning Effort）** — 默认模型的可选思考等级：off | minimal | low | medium | high | xhigh | max；不设置时从 settings.yaml 删除该字段。

### 语义边界

- 保存后需重启 dsh web 服务才生效（Launcher 直接改文件，不依赖 dsh 的 settings 热更新）。
- 默认模型 provider/model 必填：缺任一保存时移除整个 `agent-default-model` 键而非写半份配置；提供商列表为空时移除整个 `llm-pi-ai` 键（dsh schema 中空 dict 与缺席等价）。
- 本域不管理 `llm-deepseek`（内置 deepseek 路由的覆写，由 dsh 自身 UI/引导负责）。

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
