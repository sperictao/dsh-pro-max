# 官方桌面应用经桥接插件纳管，不直写其 profile

dsh 的 `desktop` 运行档由官方 Electron 应用独占：CLI 对启动、`--dump-config`、`plugin` 一律按名字拒绝（`profile "desktop" is managed exclusively by the Electron application`）。本应用要纳管这个形态只有两条路——直写 `~/.dsh/profiles/desktop`（该目录技术上可写：应用启动时的 `initProfile` 从不覆盖既有文件，未知 bundle 只跳过不删），或者成为它加载的一个插件。**决定走插件路线**：向桌面应用投递一个桥接插件（用户在应用内 Plugins 页装一次，npm 包 `@sperictao/dsh-pro-max-bridge`，钉本应用测过的精确版本），由它调用桌面应用**自己的** Plugin Manager / Config Editor 服务。

**Considered Options**：

- 直写 `~/.dsh/profiles/desktop` —— 拒绝。会造出第二条插件安装实现（web 档走官方 `dsh plugin` 入口、desktop 档自建 pnpm 直写路径），而安装护栏最关键的一道——`--dump-config` 组合预检——对 desktop 物理不可执行。上游现为 `0.1.7-rc.1` + nightly 通道，profile 布局随时可动。
- 用 home 层补丁（`~/.dsh/cordis.patch.yml`）挂载桥接插件 —— 拒绝。那份文件被所有运行档读取；用共享状态表达单档意图，会让每个 profile 都背上一个不属于它的行，卸载后还留下悬空引用。
- 只做外部应用管理（打开/退出/版本检测） —— 被否决：能力与 web 档完全不对称。

**Consequences**：

- **一次性手工步骤**：用户必须在桌面应用内粘一次包规格（`包名@精确版本`）。这是换取「不造第二份实现」的代价。
- **安装规格是 registry 包 + 精确版本，不是 tarball 地址**（2026-10-01 改，原为 `releases/latest` 的 tgz URL）。桌面应用内嵌的 pnpm（0.2.0-rc.2 时仍是 11.7.0）对远程 tarball 有缺陷：该地址的包已在本机 store 时，它复用缓存、写出缺 `integrity` 的 lockfile 条目，随即被自己的供应链检查拒掉（`ERR_PNPM_MISSING_TARBALL_INTEGRITY`）——卸载后重装同一地址必然复现，每次重试都一样；而 `latest` 地址在桥接发版后换了字节，就地升级又会撞 `ERR_PNPM_TARBALL_INTEGRITY` 硬失败。registry 包的 integrity 来自元数据，上述两种情形都实测通过。钉精确版本是因为 pnpm 11 默认拦截发布不满 24 小时的版本：精确版本照装，tag 与范围则静默解析到旧版还报成功。代价：桥接单独发版也要应用发版才能分发（钉住的恰是应用测过、协议代次对得上的那一版）；`check:release` 会确认钉住的版本已在 registry 上。另否决了 `file:` 指向本应用包内 tgz——本应用移动、更新或卸载即让桌面档的 pnpm 拒绝一切安装卸载——与 `github:` 规格（桥接的 `lib/` 需构建，git 依赖的构建脚本被 pnpm 拦下，而应用不认那个错误码、不弹审批）。
- **我们的代码跑在用户进程里**：桥接插件必须永不产生未处理异常——未捕获异常会触发桌面应用的崩溃恢复，那条路径会重置 bundle 列表并禁用第三方插件（普通激活失败则被隔离，应用照常运行）。
- **不得接管 connection 服务**：桌面 shell 启动时要向宿主根路径要一次 `303 + set-cookie` 换取 host cookie，替换 connection 会让这条握手失败并直接进崩溃恢复。桥接只增路由。
- **本决策的实现已在真机上验证**（2026-09-25 实测）：用户在官方应用 Plugins 页**直接粘 tgz URL** 即装成（该界面接受 tarball 规格，已实测；安装规格后已改为 registry 包，见上）。随后 `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture bridges_the_live_channel` 读到 **195 个插件行 + 12 个 bundle 行 + 192 行运行档配置，全部被按应用类型声明逐字写的结构解析，无字段名偏差**；桌面 tab 的连接态在真实 WKWebView 里渲染正确（含 `management-required` 与 `unaddressable` 两条 readOnlyReason 支路），复选框/配置框的计数与 Rust 侧数据精确吻合。
- **仍未验证两处**：① 装/卸/启停等**变更**操作——验它需要在用户的真机上真装真卸一个插件，未做；② `desktop_quit` 被用户取消时的报错行为——`desktop_quit` 的实际退出从未被触发过（会弹应用自己的确认框，无人值守时调用会留下一个没人应答的模态框）。
- **token 认证是纵深防御而非安全边界**——同用户的本地进程本就能直写 `~/.dsh/profiles/desktop`（上游只拦 CLI，不拦文件系统）。
