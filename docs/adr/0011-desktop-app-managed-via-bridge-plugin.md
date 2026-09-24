# 官方桌面应用经桥接插件纳管，不直写其 profile

dsh 的 `desktop` 运行档由官方 Electron 应用独占：CLI 对启动、`--dump-config`、`plugin` 一律按名字拒绝（`profile "desktop" is managed exclusively by the Electron application`）。本应用要纳管这个形态只有两条路——直写 `~/.dsh/profiles/desktop`（该目录技术上可写：应用启动时的 `initProfile` 从不覆盖既有文件，未知 bundle 只跳过不删），或者成为它加载的一个插件。**决定走插件路线**：向桌面应用投递一个桥接插件（用户在应用内 Plugins 页装一次，GitHub Release 的 tgz URL），由它调用桌面应用**自己的** Plugin Manager / Config Editor 服务。

**Considered Options**：

- 直写 `~/.dsh/profiles/desktop` —— 拒绝。会造出第二条插件安装实现（web 档走官方 `dsh plugin` 入口、desktop 档自建 pnpm 直写路径），而安装护栏最关键的一道——`--dump-config` 组合预检——对 desktop 物理不可执行。上游现为 `0.1.7-rc.1` + nightly 通道，profile 布局随时可动。
- 用 home 层补丁（`~/.dsh/cordis.patch.yml`）挂载桥接插件 —— 拒绝。那份文件被所有运行档读取；用共享状态表达单档意图，会让每个 profile 都背上一个不属于它的行，卸载后还留下悬空引用。
- 只做外部应用管理（打开/退出/版本检测） —— 被否决：能力与 web 档完全不对称。

**Consequences**：

- **一次性手工步骤**：用户必须在桌面应用内粘一次 tarball URL。这是换取「不造第二份实现」的代价。
- **我们的代码跑在用户进程里**：桥接插件必须永不产生未处理异常——未捕获异常会触发桌面应用的崩溃恢复，那条路径会重置 bundle 列表并禁用第三方插件（普通激活失败则被隔离，应用照常运行）。
- **不得接管 connection 服务**：桌面 shell 启动时要向宿主根路径要一次 `303 + set-cookie` 换取 host cookie，替换 connection 会让这条握手失败并直接进崩溃恢复。桥接只增路由。
- **token 认证是纵深防御而非安全边界**——同用户的本地进程本就能直写 `~/.dsh/profiles/desktop`（上游只拦 CLI，不拦文件系统）。
