# 企业级应用软件的插件模块设计——面向 dsh-pro-max 的一手资料调研

> 调研日期：2026-09-01
> 仓库快照：本地 `main` 在 `af3c677`（2026-09-01 13:41 +0800）。工作区另有三处未提交修改（`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`，均为版本号 0.5.5→0.5.6 的 bump），本文引用的行号来自当前工作区状态。
> 目的：回答"作为一款企业级应用软件，插件模块应该怎么设计"，并映射到本仓库插件市场模块（`src-tauri/src/dsh/market.rs` + `src/features/market/`），给出可落地的分阶段演进建议。

## 1. 方法与边界

只把以下内容当事实来源：

1. 本仓库当前工作区的代码、配置与文档；
2. 上游 `@deepseek-ai/dsh` 的 npm registry 元数据与其 GitHub 仓库（`deepseek-ai/deepseek-harness`，默认分支 `master`）源码；
3. `https://api.dshmk.com/` 目录 API 的第一方返回（2026-09-01 快照）；
4. Microsoft（VS Code）、JetBrains、Google（Chrome）、Mozilla（Firefox/Obsidian 之外的 AMO 签名文档站 extensionworkshop.com）、Obsidian（docs.obsidian.md）、HashiCorp（Terraform）、SLSA、Sigstore、TUF、Uptane、pnpm、npm、Eclipse Open VSX 的官方文档/规范/官方发布说明。

"来源事实"与"对 dsh-pro-max 的推论/建议"分开表述。Chrome 官方的 CRX 自托管页面当前以希伯来语呈现，本文只引用其中可直接核对的事实（密钥生成、ID 与公钥的派生关系、更新密钥连续性），不引用无法核对的细节。

## 2. 术语与现状盘点

术语（授权插件、插件目录、已验证、一键安装、受管插件）见 [CONTEXT.md](../../CONTEXT.md) 的"插件市场"一节。以下为本仓库代码事实：

### 2.1 目录浏览

- 目录数据源是硬编码常量 `https://api.dshmk.com/`，无鉴权（`src-tauri/src/dsh/market.rs:15`）；Rust 侧 reqwest blocking 拉取，慢网总超时 90s，注释标明目录约 27MB / gzip 约 3MB（`market.rs:16-17`）。
- 第一方 API 实测（2026-09-01 05:52 UTC 快照，`https://api.dshmk.com/` 响应头与正文）：`content-length: 29004231`，`access-control-allow-origin: *`，无任何鉴权头；正文为 `{"schemaVersion":1,"generatedAt":"2026-09-01T05:39:58.058Z","source":{"label":"GitHub Topic","topic":"dsh-plugin",...},"stats":{"fetched":7594,"verified":4133,...},"validationStatuses":{"verified":4133,"capability-pending":58,"sandbox-failed":2130,"security-review":207,"expired":85,"retrying":852,...}}`。即：目录是按 GitHub topic `dsh-plugin` 爬取的全量快照，收录全部验证状态（含 2130 个 sandbox-failed），并非只收录通过项。
- Rust 侧解析投影：只保留浏览/安装所需字段，`starTrend` 历史点等大字段丢弃，原文不进 WebView（`market.rs:6-7`、`market.rs:139-143`）。
- 「已验证」徽标唯一判定依据是 `validation.overall == "verified"`（`market.rs:97`）；CONTEXT.md 明确它"不等于安全审计或官方背书"（CONTEXT.md:50）。
- 一键安装候选只取 `install.candidate.action == "add"` 的 `specifier`，并规范化剥掉 `npm:` 前缀——注释：pnpm 12+ 把裸 `npm:` 前缀当 package-manager spec 解析致 404（`market.rs:69-77`）。
- **重要精确化**（对流传说法的修正）：目录并非"只收录 candidate+verified 状态的插件"。收录是全量的；`candidate` 只决定"有没有一键安装候选"（`market.rs:66-77`），`verified` 只决定徽标。且前端安装按钮条件是 `installSpecifier && installExecutable`（`src/features/market/MarketView.tsx:208`），**verified 不是安装的前置条件**——未验证插件同样可一键安装。

### 2.2 安装 / 移除

- 安装与移除都收敛到一个入口 `run_plugin_cmd`，执行 `dsh plugin --profile web add|remove <标识符>`（`market.rs:196-224`）。
- 标识符先过字符白名单 `valid_identifier`：非空、≤214 字符、只允许 npm/pnpm 合法字符（字母数字与 `@ / . _ - # :`）、拒绝 `- # : / .` 开头与 `..`（`market.rs:187-194`）。注释说明白名单挡的是"写歪的目录数据与手改 IPC 的误用，而非注入"（`market.rs:184-186`）。
- 调用链不经字符串拼 shell：Unix 上 `Command::new(program).args(args)` 直连；Windows 上因 npm 全局包是 `.cmd` 批处理必须经 `cmd /c`，但参数逐个 `win_quote` 手工引号、`raw_arg` 跳过 std 自动引号（`src-tauri/src/dsh/process.rs:48-66`）。
- 错误路径：非零退出时把 dsh 的 stderr（或兜底文案）经 i18n 模板返回前端，同时写 Rust 日志（`market.rs:210-222`）。
- 前端有内联二次确认（Install → Confirm 两段式），长操作以 busy 态呈现，无可安装候选时显示 "Manual install only"（`MarketView.tsx:207-257`）。

### 2.3 上游 dsh 的真实行为（源码核实）

- `dsh plugin --profile <name> <args...>` 在上游源码中自述为 "thin pnpm forwarder"：首次使用初始化 profile，然后在 profile 目录 `spawnSync('pnpm', args, { shell: process.platform === 'win32' })` 裸转发参数，退出码 0 时把 `dsh.profile.bundles` 层列表与已安装状态对账；声明了 `dsh.bundle.patch` 的依赖加入层栈（来源：[apps/cli/src/plugin.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/plugin.ts)，master 分支）。
- 同文件明确 pnpm ≥10 的脚本拦截：失败提示写着"git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in <profile>/pnpm-workspace.yaml"。注意 Windows 上 pnpm 经 `.cmd` shim 必须走 `shell: true`（源码注释引 CVE-2024-27980 加固）——因此**链路末端在 Windows 上确实过 shell**，这正是本仓库 `valid_identifier` 字符集排除空格与 shell 元字符的实际意义（`market.rs:191`）。
- npm registry 元数据（2026-09-01，`npm view @deepseek-ai/dsh`）：`dist-tags: { latest: "0.1.1-rc.2", next: "0.1.1-rc.2", alpha: "0.1.2-alpha.3" }`；本仓库现 pin `0.1.2-alpha.4`（alpha 线，`src-tauri/src/dsh/mod.rs:103`）。
- 插件兼容承诺机制存在于上游生态：本仓库 vendored 插件的 `package.json` 声明 `dsh.bundle.patch`（指向 `cordis.patch.yml`）、`engines` 与 `peerDependencies`（`vendor/dsh-client-connection-authz/package.json`、`vendor/dsh-auth-tailscale/package.json`）。

### 2.4 内置（受管）插件的打包链

- 两个 vendored 插件经 git submodule（`.gitmodules`，`vendor/dsh-auth-tailscale` 与 `vendor/dsh-client-connection-authz`）固定 commit：构建脚本 `assertPinnedSource` 校验 `git rev-parse HEAD` 必须等于 pin commit，且工作树必须干净，否则拒绝打包（`scripts/build-dsh-plugins.mjs:14-25`、`:90-100`）。
- 产物 tgz 文件名内嵌 commit 短哈希（如 `dsh-client-connection-authz-11929472460d.tgz`），作为 `bundle.resources` 打进安装包（`src-tauri/tauri.conf.json:42-45`）；运行时以 `file:` spec 经 `dsh plugin --profile web add` 装入（`src-tauri/src/dsh/components.rs:28-31`、`:133-167`）。
- 宿主 CLI 有版本闸门：`version_within_supported_line` 要求实际版本 ≥ `SUPPORTED_DSH_VERSION` 且同一条 x.y.z 演进线，跨线一律不兼容（`components.rs:252-274`；测试见 `src-tauri/src/dsh/tests.rs:149-158`）。
- 应用自身更新器有签名基础设施但未配置：`"pubkey": ""`、`"endpoints": []`（`tauri.conf.json:51-59`）。

### 2.5 缺口证据（确认"没有"）

以下能力在本仓库**不存在**，逐条给出核查方式：

| 缺口 | 核查证据 |
| --- | --- |
| 市场插件的版本兼容检查 | `market.rs` 全文无任何版本比较；安装 specifier 直接来自目录（含 `@latest` 类浮动形式，见 `market.rs:238-239` 注释），不读插件 `engines`/`peerDependencies`。版本闸门只对宿主 dsh CLI 存在（`components.rs:252-274`） |
| 目录/安装包签名校验 | `market.rs` 无签名/校验和代码；目录仅 HTTPS 明文拉取。全仓 `grep -i "signature|sigstore|cosign|slsa"` 只命中 updater（应用自更新）与文案 |
| 权限/能力模型 | 安装即把插件挂入 `dsh.profile.bundles` 层栈获得全量 patch 能力（上游 plugin.ts 对账逻辑 + `vendor/dsh-client-connection-authz/package.json` 的 `dsh.bundle.patch`）；UI 只展示 verified 徽标（`MarketView.tsx:224`），无权限声明、无授予界面 |
| 企业配置入口 | 目录 URL 是编译期常量（`market.rs:15`）；无 allowlist/denylist 策略文件；`grep -i "allowlist|permission"` 只命中 Tailscale 登录名 allowlist（远程访问域，与插件无关，`src-tauri/src/dsh/auth.rs:30`） |
| 审计日志 | 安装/移除成功只有返回值与排错日志（`market.rs:216`），无"何时装了什么、什么版本、结果如何"的持久记录；壳日志定位是"出事再翻"且 2MB 轮转直接删旧文件（CONTEXT.md:88-93） |

## 3. 业界插件系统架构模式

每个模式按"机制 → 解决什么 → 代价 → 来源"陈述，全部取自官方一手资料。

### 3.1 进程外扩展宿主（VS Code Extension Host）

- **机制**：扩展不进主进程。"The Extension Host is responsible for running extensions"，按本地 Node.js、浏览器 WebWorker、远程容器/SSH 等多种宿主运行；宿主隔离的目的写明是防止扩展 "Impacting startup performance / Slowing down UI operations / Modifying the UI"；扩展声明 Activation Events 懒加载（来源：[VS Code 扩展宿主文档](https://code.visualstudio.com/api/advanced-topics/extension-host)）。API 面分稳定 API 与 proposed API，后者只在 Insiders 可用、"should not be used in published extensions"，作为 API 稳定前的迭代沙盒（来源：[proposed API 文档](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)）。
- **解决什么**：扩展崩溃/卡顿不拖垮宿主 UI；API 演进不破坏已发布扩展（"once we introduce an API, we cannot easily change it anymore"）。
- **代价**：多进程/多运行时通信复杂度；扩展能力受宿主 API 面约束；每个宿主一份运行时资源。

### 3.2 声明式清单 + 权限模型（Chrome MV3）

- **机制**：扩展意图在 manifest 声明——`permissions`（已知字符串，装时警告）、`optional_permissions`（运行时授予）、`host_permissions`/`optional_host_permissions`（主机匹配模式）。安全动机原文："Permissions help to limit damage if your extension is compromised by malware"；官方建议"Consider using optional permissions wherever the functionality of your extension permits"，把授予推迟到运行时由用户知情决定（来源：[Chrome 声明权限文档](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)）。
- **解决什么**：最小权限、损害上限、用户知情同意。
- **代价**：作者声明与适配成本；权限警告疲劳；平台 API 面受限。

### 3.3 签名分发（Chrome CRX / Firefox AMO / JetBrains Marketplace）

- **机制**：
  - Chrome：打包时生成密钥对（`.crx` + `.pem`），扩展 ID 由公钥哈希派生，更新包必须同一私钥签名（否则成为不同 ID），商店分发的 CRX 由 Chrome Web Store 再签以检测篡改；Windows/macOS 上外部安装的 `update_URL` 必须指向 Chrome Web Store，本地 CRX 外部安装仅剩 Linux（来源：[install-extensions](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)、[linux_hosting](https://developer.chrome.com/docs/extensions/mv3/linux_hosting)）。
  - Firefox：release/beta 版 Firefox 强制签名——"Add-ons need to be signed before they can be installed into release and beta versions of Firefox"；未签名扩展仅 Developer Edition/Nightly/ESR 在关闭 `xpinstall.signatures.required` 后可装；自分发走 AMO "unlisted" 通道，同样经过签名与自动校验，"All add-ons, including self-distributed ones, are subject to be manually reviewed at any time"（来源：[Mozilla extensionworkshop 签名与分发总览](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)）。
  - JetBrains：2021.2 起插件签名，作者私钥签 + JetBrains Marketplace 再签（"the file will be signed twice – first by the plugin author, then by JetBrains Marketplace"）；JetBrains CA 为信任根，IDE 的 Java TrustStore 内置其公钥，Marketplace 侧验签，未签名安装时 IDE 弹警告（来源：[JetBrains 插件签名文档](https://plugins.jetbrains.com/docs/intellij/plugin-signing.html)）。
- **解决什么**：分发管道防篡改、作者身份连续性（密钥即身份）、平台侧集中治理。
- **代价**：密钥管理与轮换；发布流程强制化；企业/高级用户需要显式例外通道（Firefox ESR 偏好开关即为此设计）。

### 3.4 版本兼容矩阵（三家的三种表达）

- **VS Code**：`engines.vscode` 声明兼容区间，"You can use the engines.vscode property to ensure the extension only gets installed for clients that contain the API you depend on"——旧客户端根本收不到/装不上该版本（来源：[发布扩展文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)）。
- **JetBrains**：插件描述符 `since-build` / `until-build` 区间（`232.*` 表示整条 2023.2 分支），不写 `until-build` 意味着承诺兼容所有未来版本（"This includes future, yet unreleased versions and possibly new IDEs, which might impact compatibility later"）；建议面向最低支持版本构建（来源：[Build Number Ranges](https://plugins.jetbrains.com/docs/intellij/build-number-ranges.html)）。
- **Obsidian**：manifest 必填 `minAppVersion`（最低宿主版本）与 `isDesktopOnly`（来源：[Obsidian Manifest 规范](https://docs.obsidian.md/Reference/Manifest)）。
- **解决什么**：把"插件 × 宿主"的组合爆炸变成可声明的区间，让不兼容在**安装前**失败而不是运行时炸。
- **代价**：作者要维护区间与最低版本构建；平台要执行区间语义。

### 3.5 进程外能力插件 + 已签分发（Terraform Provider）

- **机制**：provider 是独立二进制，"executed as a separate process and communicate with the main Terraform binary over an RPC interface"；`terraform init` 按配置里的版本约束选版（"compares them to the configuration's version constraints and chooses a version for each plugin"）。Registry 协议在下载元数据中带 `shasums_url`（SHA256SUMS 文档）、`shasums_signature_url`（对校验和文档的分离 GPG 签名）与 `signing_keys.gpg_public_keys`（允许签名的公钥列表，内嵌 ascii-armor），"At least one element must be included, representing the key that produced the signature"；协议版本字段 `protocols` 让 CLI "avoid downloading a package that will not be compatible"（来源：[Terraform 插件架构](https://developer.hashicorp.com/terraform/plugin/how-terraform-works)、[Provider Registry 协议](https://developer.hashicorp.com/terraform/internals/provider-registry-protocol)）。
- **解决什么**：core 与 provider 的故障/生命周期隔离；分发完整性可验证；兼容性在下载前拒绝。
- **代价**：分发体积、协议版本化负担、GPG 公钥分发与信任引导。

### 3.6 内嵌脚本 + 人工审核（Obsidian）

- **机制**：插件就是进应用进程的 `main.js`；上架要求 GitHub 源码可访问供审核——"To review your plugin, we need to access to the source code on GitHub"，"Once we've reviewed and published your plugin, users can install it directly from within Obsidian"；**只需提交初始版本**，后续更新由用户直接从 GitHub release 拉取（来源：[Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)）；审核要点含禁 `innerHTML` 等安全守则（来源：[Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)）。
- **解决什么**：低门槛生态 + 人工审核兜底 + 最低宿主版本声明。
- **代价**：人工审核是瓶颈且只覆盖提交时点；更新不再审；无密码学签名（信任=审核时点的快照）。

### 3.7 更新框架与供应链证明（TUF / Uptane / SLSA / Sigstore）

- **TUF**：针对软件更新系统的攻击分类与韧性设计——任意软件安装、回滚、快进、无限冻结、无尽数据、混搭（mix-and-match）、密钥沦陷等；设计原则包括"Trust should not be granted forever"（信任要过期）、分区化信任、密钥沦陷韧性（快速撤销/更换、在线密钥低权、多钥阈值签名）（来源：[TUF Security 官方页](https://theupdateframework.io/security/)）。
- **Uptane**：TUF 理念在汽车 OTA 的行业化，自述 "the first software update security system for the automotive industry"，目标是即使是 nation-state 级攻击者也只造成有限损害（来源：[uptane.org](https://uptane.org/)）。
- **SLSA provenance**：证明"特定构建平台产出了一组软件工件"——`subject`（产物）、`builder.id`（"intended to be the sole determiner of the SLSA Build level"，信任基）、`resolvedDependencies`（构建期依赖，如源码 commit）；消费方验证"MUST accept only specific signer-builder pairs"（来源：[SLSA v1.1 Provenance 规范](https://slsa.dev/spec/v1.1/provenance)）。
- **Sigstore/cosign**：keyless 签名——短期密钥（"Signatures are generated with ephemeral signing keys so there's no need to manage keys"）、Fulcio 按 OIDC 身份签短期证书、签名事件入 Rekor 不可变透明日志（"an immutable, append-only ledger"，公开可审计）；验证三步：签名→证书身份→信任根+Rekor 包含证明（来源：[Sigstore 官方概览](https://docs.sigstore.dev/about/overview/)）。
- **解决什么**：仓库/密钥沦陷后的韧性、构建来源可验证、签名事件可审计。
- **代价**：基础设施（CA、透明日志、密钥阈值）与验证方实现成本，是所有模式里最重的。

### 3.8 npm/pnpm 生态的脚本风险（与本仓库直接相关）

- **npm**：生命周期脚本经 shell 执行——"Scripts are run by passing the line as a script argument to /bin/sh on POSIX systems or cmd.exe on Windows"；`prepare` 在 git 来源安装时先装其依赖再构建（来源：[npm scripts 文档](https://docs.npmjs.com/cli/v11/using-npm/scripts)）。
- **pnpm 10 起**：依赖的生命周期脚本**默认不执行**——"Lifecycle scripts of dependencies are not executed during installation by default! This is a breaking change aimed at increasing security."，需列入 `pnpm.onlyBuiltDependencies` 才放行（来源：[pnpm v10.0.0 官方 release notes](https://github.com/pnpm/pnpm/releases/tag/v10.0.0)）。
- **与 dsh 的交叉点**：`dsh plugin add` 即 pnpm 裸转发，因此 (a) 第三方市场插件的构建脚本被 pnpm 默认拦下，git 来源插件的 `prepare` 失败时上游会指引把键加进 profile 的 `pnpm-workspace.yaml` allowBuilds（上游 plugin.ts，见 §2.3）；(b) pnpm 自身的版本差异（`npm:` 前缀解析、脚本拦截行为）成为本仓库的隐式运行时依赖（`market.rs:71-73` 注释即一例）。

### 3.9 企业私有分发（VS Code Private Marketplace / Open VSX）

- **VS Code 企业能力**：私有市场可 "self-host and distribute extensions within their organization to meet security and compliance requirements"，支持把公共扩展 rehost 到 "air-gapped environments"，以组策略分发；`extensions.allowed` 设置控制可装清单（"only listed extensions can be installed, and unlisted extensions are blocked"），支持逐版本 pin、按平台后缀、`"*": false` 全拒，且"已装被禁"时扩展被禁用而非卸载；组织可用 AllowedExtensions 策略集中覆写用户设置（来源：[VS Code 企业扩展文档](https://code.visualstudio.com/docs/enterprise/extensions)、[扩展市场文档](https://code.visualstudio.com/docs/editor/extension-marketplace)）。VSIX 手动安装天然离线，且 "When you install an extension via VSIX, auto update for that extension is disabled by default"。
- **Open VSX**：Eclipse 基金会的 "vendor-neutral open-source alternative to the Visual Studio Marketplace"，提供可自托管的服务端应用（数据库 + Web 应用 + `ovsx` 发布 CLI），镜像发布到 ghcr.io（来源：[eclipse-openvsx/openvsx 官方 README](https://github.com/eclipse-openvsx/openvsx)）。
- **解决什么**：企业对源头、内容、时点的控制权（气隙、审批、固定集合）。
- **代价**：企业要运营一个分发基础设施；上游生态更新不再自动到达。

## 4. 企业级诉求 × 业界做法 × 本仓库现状 × 缺口

先说结论性的观察（推论）：企业级与消费级插件模块的差别不在功能多少，而在三件事——**可复述**（装了什么、从哪来、什么版本，事后说得清）、**可治理**（装什么、装不装、何时装由策略决定）、**可验证**（内容与来源的完整性可以校验而不是信任）。业界所有模式都是围绕这三件事的组合。

| # | 诉求 | 业界做法 | 本仓库现状 | 缺口 |
| --- | --- | --- | --- | --- |
| 1 | 私有源/私有市场 | VS Code Private Marketplace、`extensions.allowed`（§3.9）；Open VSX 自托管 | 目录 URL 编译期常量（`market.rs:15`），无任何配置入口 | 无私有目录、无安装策略面 |
| 2 | 离线/气隙安装 | VSIX 离线装 + rehosting（§3.9）；Firefox unlisted 自分发 | 内置插件链路本身离线可用（submodule→tgz→`file:` 安装，§2.4）；市场浏览必须在线（90s 超时后失败，`market.rs:108-130`），目录无本地快照 | 断网即整个市场不可用；无"带目录出去"的形态 |
| 3 | 版本兼容矩阵 | `engines.vscode` / `since-until` / `minAppVersion` / Terraform `protocols`（§3.4、§3.5） | 宿主 dsh CLI 有严格版本闸门（`components.rs:252-274`）；市场插件**零兼容检查**，`@latest` 类浮动 specifier 原样转发 | 插件与 dsh 版本的组合不受控，装完靠运行时炸 |
| 4 | 签名与信任链 | CRX/AMO/JetBrains 双签（§3.3）；Sigstore/SLSA/TUF（§3.7）；Terraform signed SHA256SUMS（§3.5） | 目录 HTTPS 明文无签名无校验和；应用 updater 签名基础设施空置（`tauri.conf.json:56`）；内置插件链有"pin commit + 干净树"构建闸门（`build-dsh-plugins.mjs:90-100`）但 tarball 无签名，完整性验证仅靠文件名内嵌 commit 短哈希（`tauri.conf.json:42-45`） | 除内置插件 pin 闸门外，无任何内容验证；且现有 pin 校验只发生在**构建机**，装到用户机器后无复核 |
| 5 | 权限与能力治理 | MV3 声明式权限 + 运行时授予（§3.2）；VS Code API 面 + proposed API 沙盒（§3.1） | 插件安装即获 `dsh.profile.bundles` 全量 patch 能力（§2.5）；UI 无权限信息，verified 徽标且**不拦安装**（§2.1） | 权限契约归上游 dsh（`dsh.bundle`），Launcher 单方面无法建立；现状连"展示"都没有 |
| 6 | 审计 | Rekor 透明日志公开可审计（§3.7）；企业策略集中管理（§3.9） | 安装/移除无持久记录（§2.5 最后一行） | 无法回答"这台机器什么时候装过什么" |
| 7 | 灰度与回滚 | `extensions.allowed` 版本 pin + 禁用（§3.9）；VSIX 装默认关自动更新；TUF 防回滚（§3.7） | 移除即重跑 `dsh plugin remove`（`market.rs:246-248`）；无版本固定、无通道、无禁用语义 | 装了 `@latest` 之后无法复现当时状态；无组织级灰度 |
| 8 | 供应链（脚本风险） | pnpm 10 默认拦脚本 + allowlist（§3.8） | 继承 pnpm 拦截（上游转发）；git 来源失败时上游有 allowBuilds 指引（§2.3）；`npm:` 前缀已做规范化规避 pnpm 12 行为（`market.rs:69-77`） | **现状相对最好的一项**，但 pnpm 版本差异是隐式依赖，且 allowBuilds 键落在 profile 目录由用户手工维护，无 Launcher 视角 |
| 9 | 隔离（崩溃/资源） | 进程外宿主（§3.1）；Terraform 独立进程（§3.5） | 插件是 dsh 进程内的 cordis patch 层 | 归上游架构，Launcher 无杠杆，本报告不展开 |

## 5. 分阶段演进方案建议

原则：每条都落到具体文件/机制，符合 Clean（单一事实来源、不留兼容层）/ Friendly（失败有原因与下一步）/ Freedom（不锁死未来路径）；依赖上游配合的项明确标注依赖，上游不动就不假装做了。

### 阶段一：可复述（让已发生的事说得清；零外部依赖）

**1.1 安装回执：把"装了什么"回显给用户**

- 动机：现在安装成功只有 busy 态消失；`github:` 安装的落盘键名无法预知（CONTEXT.md:53），用户与企业都无法复述安装结果。这是企业级"可复述"的最低形态。
- 改动：`market_install`（`market.rs:241-243`）成功后复用 `installed_list_from_profile`（`market.rs:158-182`）回读 profile `package.json`，把新落的 `name + spec` 一并返回；`MarketView.tsx` 在安装完成态展示该 spec（含精确版本）。目录数据仍是唯一事实来源，回执只是**落盘事实**的展示，不构成第二真相。
- 验证：`installed_list_from_profile` 已是纯函数可单测；新增安装回执的 Rust 单测 + `MarketView.test.tsx` 断言。
- 明确不做：不做安装历史数据库、不做 diff 视图。

**1.2 目录快照缓存：断网时市场降级可用并如实标注**

- 动机：目录是静态 JSON 快照且响应头带 `etag` 与 `cache-control: public, max-age=300`（§2.1 第一方实测）；现在断网=整个 Plugins 页失效。企业环境的代理/气隙场景里这是第一个断点。
- 改动：`fetch_catalog`（`market.rs:108-150`）把最近一次成功响应原文（含 `generatedAt`）落盘到 app 数据目录；网络失败时回退快照并在 UI 标注"目录快照时间"，拉新失败的原因照现有 `problem/solution` 文案路径给出（i18n 走 `src-tauri/src/i18n.rs`）。快照只是同一事实来源的本地副本，带 `generatedAt` 即无分叉。
- 验证：失败回退路径单测（模拟非 2xx）；i18n key 检查脚本（`pnpm run check:i18n`）。
- 明确不做：不做目录镜像服务、不做后台定时刷新（安装与浏览都是用户动作驱动，CONTEXT.md:58 的既有边界）。

**1.3 安装/移除审计记录：最小 append-only 台账**

- 动机：缺口表 #6。企业排查"谁在何时装了什么"今天只能翻 2MB 即轮转的排错日志。
- 改动：在 `run_plugin_cmd`（`market.rs:196-224`）的成功/失败路径追加一条 JSONL（时间、动作、标识符、dsh 版本、Launcher 版本、结果）到 app log dir 下独立文件（如 `plugin-audit.jsonl`）；复用壳日志目录入口（设置页"打开日志目录"已存在，CONTEXT.md:88）。
- 权衡（如实陈述）：这与"壳日志只进文件不进 UI、不告警"（CONTEXT.md:93）是同一消费模型，不算第二套日志机制；但确实新增一个文件，若认为多余可并入选择——本报告建议独立文件，因为排错日志轮转策略（2MB 删旧）不适合台账语义，台账需要自己的保留策略。
- 验证：单测覆盖成功/失败两条路径的行格式。
- 明确不做：不做上传/集中收集（无控制面，硬造即违背 Freedom——没有企业后端时上报没有去处）。

### 阶段二：可治理（给企业一个入口；全部是本仓库自有机制）

**2.1 目录源可配置（私有镜像入口）**

- 动机：缺口表 #1。企业要的是"从我的内网拿目录"，而不是"信 api.dshmk.com"。
- 改动：`MARKET_CATALOG_URL`（`market.rs:15`）从常量变为 LauncherConfig 可选项（默认值不变），设置页加一个高级项；私有镜像的契约就是 `schemaVersion` 兼容的同一份静态 JSON（目录 API 已自带 `schemaVersion:1`，§2.1）——版本不匹配时拒绝并给出原因/下一步，而不是猜格式。
- 验证：配置读取与 schemaVersion 校验单测；UI 手动回归。
- 明确不做：**不做多目录聚合/合并排序**（第二份真相，Clean 红线）；不做鉴权目录（企业镜像靠内网可达性，做 token 鉴权是为一纸假想需求建基础设施）。

**2.2 安装策略文件（allow/deny）**

- 动机：缺口表 #1/#7 的治理面。对标 VS Code `extensions.allowed`（"only listed extensions can be installed, and unlisted extensions are blocked"，§3.9），但按本仓库规模取最小子集。
- 改动：新增一个用户/企业可编辑的策略文件（如 `~/.dsh-pro-max/plugin-policy.json`：允许的包名精确/前缀列表），在 `run_plugin_cmd` 的 `valid_identifier` 之后、执行之前校验；拒绝时走现有 `problem/solution` 错误模板（`market.rs:201-207` 的 fail_key 模式）说明命中了哪条策略。CONTEXT.md 与 i18n 同步。
- 验证：策略匹配单测（精确/前缀/空策略=全允许的默认语义要写死在测试里）。
- 明确不做：不做签名式策略文件（本机文件可改——它的定位是"防误装 + 组织下发基线"，不是对抗本机管理员；假装防不住的威胁是造假承诺）；不做按 star/分类的策略（目录数据不具备权威性，CONTEXT.md:57）。

**2.3 内置插件 tarball 的装机后完整性复核**

- 动机：`build-dsh-plugins.mjs:90-100` 的 pin+干净树校验只保护**构建机**；tgz 落到用户机器后（`bundle.resources`），没有任何机制确认内容仍与 commit 对应。企业要的"可验证"从构建端延伸到安装端。
- 改动：构建脚本为每个 tgz 产出 sha256（`.artifacts/dsh-plugins/` 内同名校验文件，随 `bundle.resources` 一起打包，`tauri.conf.json:42-45` 同步加两行）；`bundled_plugin_tarball`（`components.rs:33-56`）命中文件后先验校验和，不符走既有缺失分支的报错文案（"Bundled dsh plugin is missing"扩为"corrupted"）。校验和清单由 CI 产出单一事实，手改即破——与主题 token 生成物同一纪律。
- 验证：单测覆盖校验和不符分支；release CI 中校验文件存在性纳入 `check:release`（`scripts/` 下既有 release 校验脚本扩展）。
- 明确不做：不做 cosign/Sigstore 签名基础设施（密钥托管+透明日志验证方成本是阶段三之后的事，见 3.1；先有"可校验的摘要"再谈"可归因的签名"，顺序不能反）。

### 阶段三：可验证与兼容（部分依赖上游；不配合就不做）

**3.1 上游目录签名后再校验（依赖 dsh-plugins-store）**

- 动机：缺口表 #4 的市场侧。Terraform Registry 的形态是现成模板：校验和文档 + 分离签名 + 公钥随元数据分发（§3.5）。
- 改动（前置条件）：先给 dsh-plugins-store 提 signed shasums（GPG 或 Sigstore 均可）；之后 `fetch_catalog` 增加验签路径。
- **明确不做（这条本身就是承诺）**：上游不提供签名前，Launcher 不自行发明"客户端校验"——目录不签，客户端无物可验；造一个只校验 HTTPS 的伪"安全检查"违背 Friendly（给用户假安心）与 Clean（第二套无根信任）。在目录侧落地前，本项保持"未做"而不是"做了一半"。

**3.2 市场插件兼容信息的最小展示（依赖目录数据）**

- 动机：缺口表 #3。业界三家都把兼容做成安装前声明（§3.4）；本仓库目录 API 的 per-repository 数据里是否已有可用的兼容/验证细分字段，决定能走多快。
- 改动（前置条件）：先核实目录 per-repository `validation` 子字段（`market.rs:97` 只取了 `overall`；`validationStatuses` 直方图里有 `security-review` 等状态，§2.1，但逐仓库字段结构未逐项核实——列入 §7）。若有，透传展示目录原生状态（展示 ≠ 加工，不违背 CONTEXT.md:57）；若无，跳过本项，等目录有数据再做。
- 明确不做：不做 Launcher 侧的兼容矩阵推导（读插件 `engines`/`peerDependencies` 需要先下载包，而安装后的失败已由 pnpm peer 语义兜底；为展示目的预先全量下载是目录该干的活，不是客户端的）。

**3.3 把 pnpm 允许清单纳入管理面（依赖上游 dsh 的 profile 所有权）**

- 动机：缺口表 #8 的收尾。allowBuilds 键在 profile 目录的 `pnpm-workspace.yaml`，由用户手工维护（上游 plugin.ts 失败指引）；git 来源插件是市场里的真实品类，这条路每个企业用户都要踩一遍。
- 改动（前置条件）：与上游 dsh 对齐 profile 管理权。若上游接受，Launcher 在安装失败的错误路径上检测 allowBuilds 类失败并给出一键修复（改写该文件）；若上游认为 profile 是用户领地，则 Launcher 只把指引文案透传（现状已够）。
- 明确不做：不做绕过 pnpm 拦截的安装路径（`--ignore-scripts` 类全局放行等于放弃 pnpm 10 的安全默认，§3.8——方向反了）。

### 不做清单（全局）

- **不引入插件进程隔离**：插件运行形态是上游 dsh 的 cordis patch 层，Launcher 无杠杆；真实需求出现时正确路径是推上游，不是在 Launcher 造半套沙盒。
- **不建权限模型**：`dsh.bundle` 契约归上游；在客户端展示上游没有的能力声明等于编造。
- **不做云控制面/RBAC/集中上报**：无企业后端与客户验证（既有调研基线 [commercial-product-evolution-primary-sources.md](commercial-product-evolution-primary-sources.md) §2.4 已确认无 fleet/entitlement 面）；先落"文件形态的策略 + 本地台账"，控制面等第一个企业设计伙伴。
- **不为旧目录格式留兼容分支**：`schemaVersion` 不匹配即拒绝并说明（§2.1 契约），符合全局破坏性升级默认。

## 6. 参考来源汇总

本仓库：

- `src-tauri/src/dsh/market.rs`（目录拉取/安装/白名单/IPC）
- `src-tauri/src/dsh/components.rs`（内置插件 `file:` 安装、宿主版本闸门）
- `src-tauri/src/dsh/process.rs`、`src-tauri/src/dsh/mod.rs`、`src-tauri/src/dsh/auth.rs`
- `src-tauri/tauri.conf.json`（bundle resources、updater 空 pubkey）
- `scripts/build-dsh-plugins.mjs`（pin 校验）、`.gitmodules`、`vendor/*/package.json`
- `src/features/market/MarketView.tsx`（确认流/安装条件/徽标）
- `CONTEXT.md`（插件市场术语与语义边界）、`src-tauri/src/i18n.rs`
- 既有基线：[docs/research/commercial-product-evolution-primary-sources.md](commercial-product-evolution-primary-sources.md)

外部（均为官方文档/规范/官方仓库/官方发布说明，另有第一方 API 实测）：

- 目录 API 第一方快照：<https://api.dshmk.com/>（2026-09-01，响应头 + 正文统计）
- 上游 dsh 源码：<https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/plugin.ts>；npm 元数据 `npm view @deepseek-ai/dsh`（2026-09-01）
- VS Code：<https://code.visualstudio.com/api/advanced-topics/extension-host> · <https://code.visualstudio.com/api/advanced-topics/using-proposed-api> · <https://code.visualstudio.com/api/working-with-extensions/publishing-extension> · <https://code.visualstudio.com/docs/editor/extension-marketplace> · <https://code.visualstudio.com/docs/enterprise/extensions>
- JetBrains：<https://plugins.jetbrains.com/docs/intellij/plugin-signing.html> · <https://plugins.jetbrains.com/docs/intellij/build-number-ranges.html>
- Chrome：<https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions> · <https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions> · <https://developer.chrome.com/docs/extensions/mv3/linux_hosting>
- Firefox：<https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/>
- Obsidian：<https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin> · <https://docs.obsidian.md/Reference/Manifest> · <https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines>
- Terraform：<https://developer.hashicorp.com/terraform/plugin/how-terraform-works> · <https://developer.hashicorp.com/terraform/internals/provider-registry-protocol>
- SLSA：<https://slsa.dev/spec/v1.1/provenance>；Sigstore：<https://docs.sigstore.dev/about/overview/>；TUF：<https://theupdateframework.io/security/>；Uptane：<https://uptane.org/>
- pnpm：<https://github.com/pnpm/pnpm/releases/tag/v10.0.0>；npm：<https://docs.npmjs.com/cli/v11/using-npm/scripts>
- Open VSX：<https://github.com/eclipse-openvsx/openvsx>

## 7. 本次调研未覆盖/需后续验证

1. **pnpm 12 对裸 `npm:` 前缀的实际行为**：`market.rs:71-73` 的规避注释是仓库内断言，本次未到 pnpm 官方文档/issue 复核该解析行为，也未实测。
2. **allowBuilds vs onlyBuiltDependencies 的关系**：上游 plugin.ts 失败指引写 `allowBuilds`（pnpm-workspace.yaml），pnpm 10 release notes 写 `pnpm.onlyBuiltDependencies`（package.json）。两者是否为同一机制在不同版本/位置的命名，未深查 pnpm 文档确认。
3. **目录 API per-repository 的 `validation` 子字段结构**：只核实了 `validation.overall` 的消费点与顶层 `validationStatuses` 直方图；`security-review` 等状态是否逐仓库可见、结构是否稳定，决定 §5 阶段三 3.2 的可行性，未逐项核实。
4. **Chrome CRX3 二进制签名格式与浏览器内核验签细节**：官方面向用户的页面只覆盖打包/密钥/ID 绑定/商店再签，更低层的验证步骤未查（需要 Chromium 源码级资料）。
5. **JetBrains 生态的企业私有分发/离线方案**（如私有镜像、exportPlugin 等）：本次未调研，不排除存在与本报告 §5 阶段二对标的更贴切模式。
6. **Uptane 的部署模式（full/partial/shadow）**：仅确认定位与目标，细节未展开（对本仓库当前诉求非必需）。
7. **Firefox ESR 策略（Extensions 策略语法）**：签名例外通道确认了偏好开关，企业策略的完整形态未查 enterprise policies 官方页。
8. **dsh plugin 子命令的完整命令面**（list/update 等）：plugin.ts 是任意参数转发器，本次只核实了 add/remove 语义与对账逻辑，未枚举上游文档宣称的完整用法。
9. **Open VSX 官方站点（open-vsx.org / eclipse.org）页面**：抓取失败，事实取自其官方 GitHub README；Eclipse 基金会官网的产品页表述未核对。
10. **实机行为**：dsh→pnpm 在三平台实际安装 git 来源市场插件时的脚本拦截表现、以及 Windows `cmd /c` 链路下白名单字符集的端到端验证，均为源码推断，未做实机回归。

## 8. 实施状态（2026-09-01，三个演进阶段落地记录）

本节记录 §5 三个阶段的最终实施结果。其中阶段三 3.1 按方案定义保持"未实现"，上游前置条件的核证证据如下。

### 8.1 阶段一「可复述」——已实现

- **1.1 安装回执**：`market_install` 成功后回读 web profile，优先取 before/after 差集唯一新键（`github:` 首装），回退 npm 包名定位（同键重装/升版）；无法唯一定位（`github:` 重装）返回 `null` 不猜。前端 toast 携带 `name (spec)`，已装列表常驻展示落盘 spec。实现：`src-tauri/src/dsh/market.rs` 的 `install_receipt` / `InstallReceipt`；`src/shared/store.ts` 的 `installMarketPlugin`。
- **1.2 目录快照缓存**：每次成功拉取的响应原文落盘 app data dir（`market-catalog-snapshot.json`）；网络/响应体失败降级读快照，`MarketCatalog.fromSnapshot` 标注 + 前端横幅展示快照时间。契约版本不符（`schemaVersion != 1`）属结构性拒绝，**不**适用快照降级。实现：`fetch_catalog` / `catalog_from_raw` / `CatalogLoadError`。
- **1.3 审计台账**：安装/移除成功与失败各追加一行 JSONL 到 app log dir 的 `plugin-audit.jsonl`（`ts`/`action`/`identifier`/`result`/`error`/`dshVersion`/`launcherVersion`），与 2MB 轮转的壳日志分文件、分保留策略。写入尽力而为：失败只落排错日志，不回滚操作、不改变返回值。实现：`audit_line` / `append_audit`。

### 8.2 阶段二「可治理」——已实现

- **2.1 目录源可配置**：`LauncherConfig.market_catalog_url`（默认空 = 内置官方源；非空必须显式带协议），设置页 General 分区输入项；`schemaVersion != 1` 一律拒绝并给出升级/修镜像两条下一步。未做多目录聚合（Clean 红线）与鉴权目录（一纸假想需求）。
- **2.2 安装策略文件**：`~/.dsh-pro-max/plugin-policy.json`，契约 `{"allowed": [...]}`——文件/键缺席 = 不启用，`allowed` 存在即生效（空数组 = 全拒），匹配规则四条（全等、`/` 结尾前缀、npm 包名、协议条目前缀且边界为 `#`/`/`，见 `policy_allows` 注释）。只约束安装；损坏 fail closed。未做签名式策略文件（防误装与组织基线，不对抗本机管理员）。
- **2.3 内置插件装机后校验和**：`build-dsh-plugins.mjs` 为每个 tgz 产出同目录 `.sha256`（随 `bundle.resources` 打进安装包），`bundled_plugin_tarball` 装入前复核，缺失或不符一律按损坏拒绝（fail closed）。产物已用 `shasum -a 256` 独立核对一致。**对 §5 原文的偏离**：原文建议把校验文件存在性纳入 `check:release`，实际未采纳——`.artifacts/` 是 gitignore 的构建产物，按仓库发布约定（AGENTS.md）本就不做存在性校验，CI validate 阶段尚未构建；运行时 fail-closed 复核已覆盖同一风险。

### 8.3 阶段三「可验证」——3.1 保持未实现（前置不满足），3.2/3.3 已实现

- **3.1 目录签名：保持未实现，上游前置条件经一手核证不满足**。2026-09-01 对 `https://api.dshmk.com/` 的实测：正文顶层键仅 `generatedAt / repositories / schemaVersion / source / stats`，无任何 shasums/signature 字段；响应头仅标准 Cloudflare 项（`etag`/`cache-control: public, max-age=300, stale-while-revalidate=3600` 等），无签名基础设施。按 §5 3.1 的承诺：目录不签，客户端无物可验，本项保持"未做"而不是"做了一半"。后续路径：给 dsh-plugins-store 提供 signed shasums（形态可参照 §3.5 Terraform Registry 的 shasums_url + 分离签名），之后客户端再加验签路径。
- **3.2 兼容信息最小展示：已实现（透传，非推导）**。§7 第 3 条的待核实项已补：per-repository `validation` 子字段实测齐全（`overall`/`label`/`dshVersion`/`stages` 等，8 种非 verified 状态均可见；且 7594 仓库中 1457 个带一键安装候选的仓库 `validation.overall != "verified"`——透传展示的必要性坐实）。实现：`MarketPlugin` 新增 `validationStatus`（`validation.overall` 原样）与 `validatedDshVersion`（`validation.dshVersion` 原样）；非 verified 条目展示目录原生状态 raw token，verified 徽章语义不变。目录数据零加工。
- **3.3 allowBuilds 管理面：已实现识别与指引，未做一键改写**。安装失败 stderr 含 `allowBuilds` / `Ignored build scripts` 时，错误文案给出精确到 `<profile>/pnpm-workspace.yaml` 的问题/下一步（`install_failure_message`）。按 §5 3.3 的前置条件：profile 文件的所有权归上游 dsh，Launcher 只指路不改写；上游明确移交管理权之前，"一键修复"不做。

### 8.4 验证

- `cargo test` 71 通过（原 49，新增 22）、`cargo clippy -- -D warnings` 无警告；
- `pnpm test` 28 通过（新增快照横幅 / 状态透传 / 安装回执 toast 用例）、`tsc` 与生产构建通过、`pnpm run check:i18n` 前后端 key 无缺失；
- e2e（mock IPC smoke）通过。实机三平台回归（pnpm 脚本拦截文案、Windows 链路）仍属 §7 第 10 条待办。
