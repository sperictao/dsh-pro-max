# DSH Pro Max 商业化演进调研基线

> 调研日期：2026-08-30
> 仓库快照：本地 `main` 在 `aeb0de4`，公开最新版本为 [v0.4.0](https://github.com/sperictao/dsh-pro-max/releases/tag/v0.4.0)（`f2e8b85`）。
> 目的：为 [商业级软件进化路线图](../roadmap/COMMERCIAL_EVOLUTION_ROADMAP.md) 提供代码事实、实时发行证据和外部一手资料。

## 1. 方法与边界

本调研只把以下内容当作事实来源：

1. 当前仓库的代码、文档、测试和 GitHub Actions；
2. npm registry 返回的 `@deepseek-ai/dsh` 元数据；
3. Tauri、Apple、Microsoft、Tailscale、SLSA、OpenSSF、Docker、Raycast、LM Studio 的官方资料。

“来源事实”和“对 DSH Pro Max 的推论”分开表述。当前没有真实客户访谈、留存数据、付费意愿或企业采购材料，因此本文不估算市场规模，不编造价格，也不把功能清单当作产品市场契合度。

## 2. 当前产品事实

### 2.1 已成立的核心价值

- 产品已经把 dsh 的安装、启动、固定版本兼容、授权插件、Tailscale Serve 和远程验证串成一条明确流程。代码与产品语义见 [README.zh-CN.md](../../README.zh-CN.md)、[CONTEXT.md](../../CONTEXT.md) 和 `src-tauri/src/dsh.rs`。
- 远程访问默认只绑定 `127.0.0.1:3899`，不使用公网 Funnel；普通访问、远程管理和网络 `tcp:443` 授权分别裁决，失败时保持拒绝。见 [dsh-remote-access.md](../dsh-remote-access.md)。
- 前端已具备 React 19、集中式 typed commands、Zustand、i18n、主题、更新检查和关键流程测试。架构决策见 [ADR 0010](../adr/0010-shell-frontend-react-rewrite.md)。
- 公开发行覆盖 macOS Apple Silicon、macOS Intel、macOS Universal、Windows x64 和 Linux x64。v0.4.0 Release 实际包含 9 个资产，GitHub API 为每个资产返回 SHA-256 digest。

### 2.2 2026-08-30 本地验证

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | 主题测试 5/5；Vitest 3 个文件、19 个测试全部通过 |
| `pnpm run test:e2e` | mock Tauri IPC 的 Playwright 浏览器 smoke 6 步全部通过 |
| `pnpm build` | TypeScript 与 Vite production build 通过 |
| `pnpm run check:i18n` | 前端 129 个 key、Rust 120 条翻译，无缺失或死 key |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 49/49 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | 通过 |
| 最新公开 CI | 当前主线 [Quality run 33311240107](https://github.com/sperictao/dsh-pro-max/actions/runs/33311240107) 与 v0.4.0 [release run 32805932978](https://github.com/sperictao/dsh-pro-max/actions/runs/32805932978) 成功 |

这些结果证明当前提交可构建，现有单元测试和 mock IPC 的浏览器壳流程通过；它们不等于安装器、原生 Tauri 桌面交互、跨设备 Tailscale、更新回滚或三平台端到端流程已通过。

### 2.3 当前商业级缺口

| 维度 | 当前事实 | 对商业化的影响 |
| --- | --- | --- |
| 运行时 | README 要求 Node.js 18+；两个内置插件声明 Node.js 22.5+；后端只检查 Node 是否存在 | 清洁机器上的成功率不可控，支持责任跨系统 Node、全局 npm、dsh 和 Launcher |
| 上游稳定性 | Launcher pin `@deepseek-ai/dsh@0.1.1-rc.2`；npm 最新版同为 RC；2026-08-10 至 08-21 连续发布多个 RC | 需要兼容矩阵、组件签名、回滚和受管运行时，不能把“npm latest”当稳定通道 |
| 进程生命周期 | dsh 以 detached 进程运行；Launcher 不持有 `Child`，停止依赖命令行模式匹配 | 缺可靠实例身份、PID reuse 防护、崩溃恢复、健康历史和确定性停止 |
| 配置 | `~/.dsh-pro-max/config.json` 直接读写，无 schema version、原子替换、备份和文件权限收敛 | 配置损坏、并发写入、迁移和恢复不满足长期支持要求 |
| 密钥 | 未使用 Keychain/Credential Manager/Secret Service；dsh credentials 仍是外部文件 | 无法给出企业凭据存储、轮换、访问审计承诺 |
| Tauri 权限 | 主窗口具有 `shell:allow-open`；open scope 允许任意 HTTPS URL 和绝对文件路径 | 权限面应按固定文档、日志目录和可信 URL 收窄 |
| 发布 | release workflow 在签名 secret 缺失时仍构建 macOS unsigned；Windows 导入证书但未做最终签名验真 | 商业发行必须 fail closed，不能发布未知签名状态的安装器 |
| 更新 | Tauri updater 有签名与 runtime config，但 release 可删除并重建同名 Release | 需要 staging、不可变发布、分批渠道、撤回与回滚手册 |
| 供应链 | 未发布 SBOM、provenance 或独立校验清单 | 客户无法从安装包追溯依赖和构建来源 |
| 测试 | Quality CI 已有 mock Tauri IPC 的浏览器 smoke；release 矩阵负责多平台构建，但仍无原生安装/启动/升级或真实 Tailscale smoke | 浏览器壳回归已受保护，但不能证明用户机器上的原生关键旅程成功 |
| 诊断支持 | 应用日志单文件 2 MiB；UI 只提供打开日志目录；无脱敏诊断包、崩溃报告或事件关联 | 很难建立可重复支持流程和 SLA |
| 产品证据 | 公开仓库当前 0 个 Issue、0 star，Release 下载量极少 | 不能从公开数据证明付费需求；企业功能必须以设计伙伴验证为前置门 |
| 团队能力 | 无账号、组织、成员、节点 ID、fleet、审计、entitlement 或云控制面 | 当前产品是个人单机工具，不是团队运营系统 |

### 2.4 结构性边界

- `src-tauri/src/dsh.rs` 约 4,000 行，同时承担运行时发现、安装、插件、进程、Tailscale、验证和自启动。
- `src/features/integration/DshCard.tsx` 约 580 行，承担状态展示、操作和多条恢复路径。
- 当前 `LauncherConfig` 只有本机偏好和远程授权字符串，不适合直接扩展成组织或 fleet 配置。
- 当前两个 vendored 插件是固定、受信、pin 版本组件，不是通用插件市场。

因此，后续演进应先建立运行时、进程、配置、网络适配器、诊断和更新的领域边界；不应直接在现有 JSON 或单个 `dsh.rs` 里叠加团队、计费和 fleet 逻辑。

## 3. 外部一手资料基准

### 3.1 发行与更新信任

#### 来源事实

- Tauri Updater 强制验证更新签名，不能关闭。客户端保存公钥，私钥只应用于签名；私钥丢失会阻断已安装客户端后续更新。[Tauri Updater](https://v2.tauri.app/plugin/updater/)
- Apple 要求 Developer ID 直发软件采用有效签名、Hardened Runtime 和安全时间戳后再 notarize；`notarytool` 可用于 CI，ticket 可 staple 到交付物。[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- Microsoft 要求 MSIX 使用受信任证书签名，并建议 timestamp；生产分发可使用 Azure Artifact Signing、受信任 OV 证书或 Microsoft Store 签名。[Microsoft MSIX signing](https://learn.microsoft.com/en-us/windows/msix/package/sign-msix-package-guide)

#### 对本项目的推论

- 所有正式渠道必须 fail closed：缺任一平台签名、公证、timestamp 或 updater 签名即停止发布。
- updater 私钥、Apple/Windows 证书需要备份、轮换、撤销和应急发布手册。
- 发布应先进入 staging，完成安装、更新、验签和回滚 smoke 后再提升为 stable；不能通过删除同名 Release 来实现“重试”。

### 3.2 Tailscale 集成边界

#### 来源事实

- Tailscale Grants 把网络层 `ip` 与应用层 `app` 权限放在同一声明中，默认拒绝，支持用户、设备、组和姿态选择器。[Tailscale Grants](https://tailscale.com/docs/features/access-control/grants)
- Tailscale 推荐新配置使用 Grants；旧 ACL 继续支持，但不再获得新能力。[Tailscale ACLs](https://tailscale.com/docs/features/access-control/acls)
- OAuth clients 使用 client-credentials flow，scope 限制 API 权限，access token 默认一小时到期。[Tailscale OAuth clients](https://tailscale.com/docs/features/oauth-clients)
- 按用户创建设备的 OAuth provisioning 仍是 alpha，且仅支持同一 tailnet。[Tailscale device provisioning](https://tailscale.com/docs/features/oauth-apps/device-provisioning)
- Tailscale 配置审计日志记录 actor、target、action 和时间，默认保留最近 90 天，并可流向 SIEM。[Tailscale logging](https://tailscale.com/docs/features/logging)

#### 对本项目的推论

- Tailscale 应是明确的网络访问适配器，不应渗透为产品自己的组织和权限模型。
- 第一版团队集成应先生成、验证和解释 Grants；若使用 API，只请求最小 scope，并保留管理员明确确认。
- alpha provisioning 不能成为稳定商业流程的唯一入口。
- 产品自己的审计必须记录对 dsh 节点、配置、凭据和更新产生的最终变更，不能用 Tailscale 审计替代。

### 3.3 供应链

#### 来源事实

- SLSA 要求 provenance 以 cryptographic digest 唯一指向输出，并描述构建过程；更高等级还要求消费者验证来源真实性与构建平台身份。[SLSA requirements](https://slsa.dev/spec/v1.0/requirements)
- OpenSSF Scorecard 把 SBOM 视为供应链风险控制，并把“随 Release 产物发布”视为优于只放源码的方式。[OpenSSF Scorecard checks](https://github.com/ossf/scorecard/blob/main/docs/checks.md#sbom)

#### 对本项目的推论

- 每个 Release 应附 digest 清单、SPDX 或 CycloneDX SBOM、provenance/attestation 和验证说明。
- SBOM 要覆盖 Rust crates、pnpm 依赖、Tauri plugins、vendored dsh 插件和随包运行时组件。
- 签名组件 manifest 应成为 managed runtime、插件目录和 fleet rollout 的共同事实来源。

### 3.4 商业桌面与团队管理基准

#### 来源事实

- Docker 的管理模型包含 company、organization、team、member、role、SCIM 和集中策略；activity log 可按 actor、时间和变更检索，并可通过 API 获取。[Docker administration](https://docs.docker.com/admin/)、[Docker activity logs](https://docs.docker.com/admin/activity-logs/)
- Docker 把组织成员身份、产品访问和 license assignment 分开管理，支持分配、撤销和部分自动分配。[Docker product access](https://docs.docker.com/admin/organization/manage/manage-products/)、[Docker licenses](https://docs.docker.com/admin/organization/manage/manage-licenses/)
- Raycast 官方安全说明把 signed/notarized、自动更新、本地加密数据库、系统 Keychain 和由产品管理且校验的 Node runtime 作为桌面安全模型的一部分。[Raycast security](https://developers.raycast.com/information/security)
- Raycast Teams 的公开能力从组织、成员和私有 extension store 起步，并在发布前验证 manifest 和 build。[Raycast Teams](https://developers.raycast.com/teams/getting-started)
- LM Studio 公开把本地免费使用与团队/企业增值分开；团队需求集中在私有协作，企业需求集中在 SSO、模型/MCP gating 和部署选择。[LM Studio work use](https://lmstudio.ai/blog/free-for-work)、[LM Studio Enterprise](https://lmstudio.ai/enterprise)

#### 对本项目的推论

- “有登录页”不等于团队产品。最小闭环是组织、成员、角色、资源、许可证、审计和策略的统一生命周期。
- DSH Pro Max 更适合保持 local-first 核心，把付费价值放在受管运行时、多 profile、fleet、组织策略、审计、支持和托管集成，而不是锁住安全更新。
- 插件生态必须先有 manifest、签名、兼容矩阵、权限声明和审核，再谈市场。

## 4. 路线图硬约束

1. 先把“安装、启动、更新、恢复、支持”变成可测、可重复、可追溯的系统，再增加团队功能。
2. 清除系统全局 Node/npm 作为默认运行时事实来源；用应用拥有的组件 manifest 和目录承载 dsh 兼容单元。
3. 本地偏好、节点期望状态、组织策略、商业 entitlement 和 secret reference 必须分属不同事实来源。
4. 控制面只能下发声明式期望状态，不能成为任意远程 shell。
5. 远程访问保持 deny-by-default；应用层能力与网络连通性继续分开验证。
6. telemetry、crash、diagnostic 和 audit 是四种不同数据用途，必须分别定义字段、同意、保留和访问权限。
7. Community 的安全修复、签名更新和基础诊断不能成为付费门槛。
8. 没有设计伙伴和真实使用数据前，不启动 SSO/SCIM、air-gap、SIEM、第三方插件市场或多网络适配器的大规模建设。

## 5. 仍需真实客户验证的问题

- 个人用户最愿意为多 profile、自动修复、备份恢复还是支持付费？
- 团队真正共享的是 dsh 节点、配置模板、凭据引用、插件集合，还是结果产物？
- 客户是否已有 Tailscale，谁拥有 tailnet policy 的修改权？
- 团队需要管理多少节点，节点是员工桌面、固定工作站还是服务器？
- 是否存在必须离线/air-gap 的场景，还是托管控制面已经足够？
- 谁是采购主体：个人开发者、AI 平台团队、安全团队，还是 IT？
- 客户愿意上传哪些不含 prompt、模型输出和凭据的健康数据？

这些问题必须通过访谈、设计伙伴和受控 beta 回答，不能由代码仓库推断。
