# AGENTS.md

## 设计理念

本项目的三条设计理念，按优先级从高到低。冲突时前列优先；它们不是并列偏好，而是互斥取舍时的裁决规则。

需求中的明确约束（如"本地模式无需安装授权插件"）是硬边界：当它与上游行为冲突时，改用能满足约束的机制（如 dsh 原生 token 访问），不得放宽或绕开约束本身；拿不准先实测上游行为再下结论。

### Clean — 干净

代码、配置与产物只保留一处事实来源，无冗余分叉。任何改动不得引入第二份真相：
- 同一事实只允许一个权威表示（DRY），禁止"留一份旧的在边上"的兼容层、回滚分支或 dual-write。
- 删除旧实现即删除，不留 deprecated 标记、不留"以后可能用得上"的保留路径。
- 界面/文档/字符串的语言资源单一来源，翻译不漂移（主题 token 生成物只由构建脚本产出，手改即破）。

### Friendly — 友好

面向用户与后续开发者，只暴露必要复杂度：
- UI 上用户不直接操作内部机制（如服务端口、capability 注入细节）；一切以开关/按钮/状态呈现。
- 失败路径有明确去向：错误有原因与下一步（dsh 步骤时间线的 problem/solution），不弹窗打断正常流程，不把内部异常裸抛给用户。
- 新成员/代理能靠文档（CONTEXT.md 术语 + 语义边界）理解行为，无需逆向代码。

### Freedom — 自由

长期演进不被历史决定锁死，今天的设计不限制明天的路径：
- 模块边界按领域划，集成点（如 dsh CLI、vendor submodule）只通过自己拥有的入口交互，不渗透内部状态。
- 升级/替换是破坏性默认：新实现直接取代旧实现，调用方统一收敛到新路径（见全局兼容策略）。
- 配置持久化独立：UI 状态（主题、访问模式等 localStorage 项）与落盘配置（capability、语言）分离，互不牵制。
- 可枚举的（如主题族）由 manifest 单一事实驱动，上游新增不自动进入，id 列表是唯一事实来源。

## 验证

- 修改前端代码后运行 `pnpm run lint`，并修复 lint 错误；warning 也不得在新代码中无理由增加。
- 业务 UI 必须优先复用 `src/shared/lib/ui.ts` 的共享配方和 `DESIGN.md` 定义的语义 token。禁止在业务 TSX 中引入原始调色板颜色、非布局 arbitrary value 或 JSX inline style。
- `src/shared/components/**` 与 `src/shared/lib/ui.ts` 属于设计系统实现层；仅这里允许规则配置中声明的必要实现例外，业务层不得复制这些例外。
- 交互层 UI 改动（导航、事件绑定、a11y 层）tsc/lint/vitest/e2e 全绿**不算完成**：e2e 跑在无 Tauri IPC 的浏览器进程，覆盖不了 WKWebView 真机行为（2026-09-16 导航改版在 Chrome/WebKit 双引擎复现全过、真机顶栏 onClick 失效，整体回退）。必须在 `pnpm tauri dev` 真机点过关键路径后才算验证完成。
- 交互层改动**两个引擎都要跑**：`pnpm run test:e2e`（Chromium）加 `pnpm run test:e2e:webkit`。WebKit 是 Tauri 在 macOS 上真正用的引擎家族，能挡掉一部分引擎差异问题——但它仍是无 IPC 的浏览器进程，**不能替代**上面那条真机要求。
- **修 bug 的测试要先证明它抓得住那个 bug**：写完把修复临时退回去跑一次，必须失败。只断言「顺手能观察到的部分」会写出装饰性测试（实测：桌面 tab 的收起测试只断言了导航栏、没断言内容，退回修复照样通过，而真缺陷正是「内容还在渲染、tab 却不存在」）。**桩也要忠实**：`mockResolvedValue` 每次返回同一个对象引用，React 会跳过重渲染，从而掩盖「重拉把用户编辑冲掉」这类问题——真要模拟一次 HTTP 返回就用 `mockImplementation` 每次给新对象（实测：同一处 bug 的第一版复现测试因桩不忠实而假过）。
- **可枚举的集合别把数目写进名字或标题**：计数会随增删失真，而失真后没人知道该改哪里。实测栽过两次：CONTEXT.md 的「桥接三态」在代码变成四态后仍在说谎，「三条硬约束」在一节变成四条后仍在说谎。写成「桥接状态」「硬约束」，让枚举自己说话。
- 判定命令成败看 `PIPESTATUS[0]`（或别接管道），不要看管道末端的退出码：`cargo check … | tail` 的 `$?` 是 `tail` 的，会把失败读成通过。
- **Windows 目标在本机无法编译检查**：`cargo check --target x86_64-pc-windows-msvc` 必然失败在 `ring` 的 C 代码（`fatal error: 'assert.h' file not found`）——交叉编译 MSVC 需要 Windows SDK 头文件，装了 rustup target 也不改变。Windows 分支的首次真实检查只能发生在 CI 的 `windows-latest` 上；因此要么让平台差异走 `cfg!` 运行时分支（两套实现随 mac 构建一起编译，可被单元测试覆盖），要么明确标注该分支未经编译验证。
- **被导出结构体引用到的每个类型都要指明导出位置**，否则 ts-rs 会另生一份到默认位置 `src-tauri/bindings/`，而引用方的 import 指向那个游离路径（实测：只给 `BridgeStatus` 标了导出、`BridgeState` 没标，`BridgeStatus.ts` 就 import 了 `../../../src-tauri/bindings/BridgeState`）。两种写法：自己的类型加 `#[ts(export, export_to = "../../src/shared/bindings/")]`；外部/内建类型（如 `serde_json::Value`）沿用既有的 `#[ts(type = "import(\"./serde_json/JsonValue\").JsonValue")]`。**`cargo test` 后凭空多出 `src-tauri/bindings/` 目录即是漏标**，修完删掉该目录再重跑导出。注意 `ts(type = ...)` 会整个覆盖 `Option`，可空字段要自己写上 `| null`。

## 发布

- **打 tag 前必须先备齐 `release-notes/v<X.Y.Z>.md`**：`build-release.yml` 在构建完成后强制校验该文件，缺失则整个发布失败。正确顺序：版本号四处同步（`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock`——最后一项由 cargo 在任意命令里就地改写，bump 前三处后跑一次 `cargo check` 再一并提交）→ release notes → release commit → tag → 推送。
- **打 tag 前跑 `pnpm run check:release -- --tag v<X.Y.Z>`**：校验版本号四处一致（含 `Cargo.lock`，漏同步会让之后每次 `cargo test` 都留下假脏 diff）+ tag 与版本一致 + release notes 存在 + bundle resources 中 git 跟踪的源路径存在（gitignore 的构建产物如 `.artifacts/dsh-plugins/*.tgz` 不做存在性校验，CI validate 阶段尚未构建）。同一脚本在 CI `validate` job 中秒级运行（构建矩阵之前），本地先跑一遍可以零成本拦截发布失败。
- **bump vendored dsh 插件的 pin commit 时**：必须同步三处——submodule 指针、`scripts/build-dsh-plugins.mjs` 中的 pin 校验、`src-tauri/tauri.conf.json` 的 `bundle.resources` tgz 文件名（文件名内嵌 commit 短哈希），漏任何一处都会在打包或运行时断。且在此之前必须先把插件仓库的该 commit 推到其远端并 `git ls-remote` 验证可见——pin 指向仅存在于本地的 commit 会让 CI checkout（`submodules: recursive`）直接报 `not our ref` 全灭，本地 `check:release` 拦不住（v0.5.3 首次发布失败即此因）。
