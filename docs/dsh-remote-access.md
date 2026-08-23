# dsh 远程访问与授权插件

DSH Pro Max 不再使用 3898 回环反代，也不会改写 `Host` / `Origin` 或伪造
`SSH_CONNECTION`。当前链路是：

```text
远程浏览器
  → https://<hostname>.ts.net  (Tailscale Serve，TLS + 身份头)
  → 127.0.0.1:3899            (dsh web，显式 loopback 绑定)
  → dsh-client-connection-authz
  → dsh-auth-tailscale
```

## 固定兼容栈

Launcher 把以下三部分当成一个不可拆分的兼容单元：

- DeepSeek Harness `0.1.0-rc.6`；
- [dsh-client-connection-authz](https://github.com/sperictao/dsh-client-connection-authz)；
- [dsh-auth-tailscale](https://github.com/sperictao/dsh-auth-tailscale)。

两个插件以固定 commit 的 Git submodule 进入源码树，构建时生成本地 `.tgz` 并作为
Tauri resource 打进安装包。运行时通过
`dsh plugin --profile web add file:<bundled-plugin>.tgz` 安装，所以不需要 Git、
GitHub 登录或运行时网络下载插件。

Connection 替代包会精确禁用内置
`@deepseek-ai/dsh-client-connection`，插入保留官方 HTTP、RPC、WebSocket 和浏览器
行为的完整替代实现，并要求注入 `connectionRequestAuthorizer`。Tailscale 插件提供
这个接口；缺插件、身份解析失败或授权配置为空时都会 fail closed。

## 身份与权限边界

一键远程访问会从 `tailscale status --json` 中把 `Self.UserID` 映射到对应的
`User[*].LoginName`，再作为精确 allowlist 传给插件。Serve 会清除客户端伪造的同名
身份头，再把真实 Tailscale 身份注入本地后端。

- dsh 只监听 `127.0.0.1:3899`，不能从 LAN 或公网绕过 Serve 直连。
- 普通远程 HTTP、RPC 与 WebSocket 必须同时通过 tailnet `tcp:443` 网络授权与插件的
  Tailscale 身份授权。
- 本机请求仍需同时满足 loopback TCP peer 与 loopback Host，才能走真实本地旁路。
- Launcher 按集成卡片远程模式里配置的两类域名注入 capability（见下节）；
  域名留空就不注入对应 capability，远程特权接口（settings、credentials、宿主
  文件等）保持拒绝，普通远程访问仍需身份 allowlist 与 tailnet `tcp:443` grant。
  本机特权接口始终可用。
- 只使用私有 Tailscale Serve，不使用 Funnel，也不把 dsh 绑定到 `0.0.0.0`。

## 远程授权配置（集成卡片 → 远程模式）

远程访问的授权策略由三个设置项组成（均在集成卡片切到远程模式后内联编辑，默认全空）：

| 设置 | 注入的 env | 默认空语义 |
| --- | --- | --- |
| 管理 capability 域名 | `DSH_TAILSCALE_ADMIN_CAPABILITY` = `<域名>/cap/dsh-admin` | 远程管理接口（settings/credentials）恒 403 |
| 普通使用 capability 域名 | `DSH_TAILSCALE_USE_CAPABILITY` = `<域名>/cap/dsh` | 普通远程 API/WS 不要求 capability，仍需身份 allowlist 与 tailnet `tcp:443` grant |
| 额外允许的登录名 | 追加进 `DSH_TAILSCALE_ALLOWED_LOGINS`（本机当前用户始终自动包含） | 只有本机当前用户可访问 |

capability 名需在 **Launcher 注入的 env**、**`tailscale serve --accept-app-caps`** 与
**tailnet grants** 三处同名。Launcher 已自动完成前两者：dsh_setup 会把非空的
capability 以 `--accept-app-caps=<use>,<admin>` 传给 serve，并把解析出的完整
capability 与 allowlist 注入 dsh web / 自启脚本。剩下的一环是 tailnet policy：
它必须独立放行 HTTPS 网络连接；若配置了 capability，再在同一 grant 下发对应能力：

```json
{
  "grants": [
    {
      "src": ["group:dsh-admins"],
      "dst": ["tag:dsh-host"],
      "ip": ["tcp:443"],
      "app": {
        "example.com/cap/dsh": [{}],
        "example.com/cap/dsh-admin": [{}]
      }
    }
  ]
}
```

`ip` 是所有异机远程访问都必需的网络授权；`app` 只传递应用能力，不会隐式开放
TCP 443。两个 capability 都留空时可以省略 `app`，但不能省略
`"ip": ["tcp:443"]`。配置任一 capability 时，`ip` 与 `app` 必须放在匹配同一
`src` / `dst` 的 grant 中。

`dst` 需匹配运行 dsh 的节点（若未打 tag，可改用该节点身份或 `autogroup:member`）；
`src` 填你允许远程访问/管理的账号或组。capability 名必须与你在卡片里配置的域名
一致（普通用户给 `<域名>/cap/dsh`，管理员再加 `<域名>/cap/dsh-admin`）。capability
名必须使用你控制的域名，不能落入 `tailscale.com`/`tailscale.io` 保留命名空间。
转发 App Capability 需要 Tailscale 1.92+；旧版本 serve 会报
`unknown flag: --accept-app-caps`。

开启或关闭自启时，Launcher 会卸载并删除旧版自己生成的 proxy plist/unit/cmd/desktop
和 `start-proxy.*`，并停止遗留的 `loopback-proxy.js` 进程；不会删除用户目录中的
`~/.dsh/loopback-proxy.js` 或其它用户文件。

## 状态检查

一键配置时间轴应依次通过：

1. Node.js 与 npm；
2. 锁定版本的 dsh；
3. 两个授权插件；
4. Tailscale 在线与当前登录身份；
5. MagicDNS / HTTPS Certificates；
6. dsh 监听 `127.0.0.1:3899`；
7. Tailscale Serve 直接指向 3899；
8. 本地 HTTP、宿主侧远程 HTTPS/WSS、本机浏览器代理路径和本地特权 API 验证。

第 8 步只能证明服务、Serve 与宿主本机路径正常，不能替代另一台 tailnet 设备的
`src` / `dst` / `tcp:443` policy 验证。配置 Access Controls 后，必须从另一台设备
实际打开远程地址；Tailscale ping 成功也不代表 TCP 443 已放行。

手动排查可使用：

```bash
dsh --version
tailscale status --json
tailscale serve status
```

`tailscale serve status` 的根路由应显示
`proxy http://127.0.0.1:3899`。设置页出现“修复 dsh 兼容栈”时，说明核心版本或
profile 中的插件 tarball 与 Launcher 锁定值不一致；点击修复会重新安装整个兼容单元。

## 访问端代理工具拦截

如果本机或另一台设备打不开 `https://<hostname>.ts.net`，但关闭代理后可用，原因是
Shadowrocket、Clash、Surge 或系统代理抢走了 tailnet 流量。Launcher 会分别验证
直连和本机代理路径。

宿主 Mac 上使用 Shadowrocket 时，必须让 macOS 在流量进入 Shadowrocket 之前跳过
HTTP/HTTPS 代理。出现“本机代理需要配置绕过主机”时，把 Launcher 显示的精确主机名
加入 Shadowrocket 的“通用 → 跳过代理（skip-proxy）”，例如：

```text
<hostname>.<tailnet>.ts.net
```

保存后可用 `scutil --proxy` 确认该主机已进入 `ExceptionsList`，然后点击“复查并打开”。
仅添加 Shadowrocket 内部的 `DOMAIN,...,DIRECT` 规则并不足以保证宿主 Mac 可用，因为
该流量仍可能留在 Shadowrocket 的 Packet Tunnel 内，无法交给本机 Tailscale 路由。

另一台访问端设备若同时运行代理工具和 Tailscale，可先添加精确 DIRECT 规则：

```text
DOMAIN,<hostname>.<tailnet>.ts.net,DIRECT
```

需要为访问端整个 tailnet 配置通用规则时再使用较宽的范围：

```text
DOMAIN-SUFFIX,ts.net,DIRECT
IP-CIDR,100.64.0.0/10,DIRECT
```

Clash / Mihomo 可放在 `rules:` 最前面：

```yaml
rules:
  - DOMAIN-SUFFIX,ts.net,DIRECT
  - IP-CIDR,100.64.0.0/10,DIRECT,no-resolve
```

Surge 使用同名 `[Rule]` 项。macOS / Windows 的手工系统代理可把精确主机或
`*.ts.net` 加入 bypass。PAC、Shadowrocket 等 Network Extension 的规则是各自配置
的事实来源，Launcher 只给出精确主机名，不会静默改写它们。iOS 通常只能
同时运行一个 Packet Tunnel VPN；若 Shadowrocket 与 Tailscale 冲突，断开
Shadowrocket，只保留 Tailscale。
