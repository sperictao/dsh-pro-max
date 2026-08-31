# AGENTS.md

## 设计理念

本项目的三条设计理念，按优先级从高到低。冲突时前列优先；它们不是并列偏好，而是互斥取舍时的裁决规则。

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

## 发布

- **打 tag 前必须先备齐 `release-notes/v<X.Y.Z>.md`**：`build-release.yml` 在构建完成后强制校验该文件，缺失则整个发布失败。正确顺序：版本号三处同步（`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`）→ release notes → release commit → tag → 推送。
- **打 tag 前跑 `pnpm run check:release -- --tag v<X.Y.Z>`**：校验版本号三处一致 + tag 与版本一致 + release notes 存在 + bundle resources 中 git 跟踪的源路径存在（gitignore 的构建产物如 `.artifacts/dsh-plugins/*.tgz` 不做存在性校验，CI validate 阶段尚未构建）。同一脚本在 CI `validate` job 中秒级运行（构建矩阵之前），本地先跑一遍可以零成本拦截发布失败。
- **bump vendored dsh 插件的 pin commit 时**：必须同步三处——submodule 指针、`scripts/build-dsh-plugins.mjs` 中的 pin 校验、`src-tauri/tauri.conf.json` 的 `bundle.resources` tgz 文件名（文件名内嵌 commit 短哈希），漏任何一处都会在打包或运行时断。且在此之前必须先把插件仓库的该 commit 推到其远端并 `git ls-remote` 验证可见——pin 指向仅存在于本地的 commit 会让 CI checkout（`submodules: recursive`）直接报 `not our ref` 全灭，本地 `check:release` 拦不住（v0.5.3 首次发布失败即此因）。
