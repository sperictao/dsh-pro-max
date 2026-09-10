# 目标

参考 PI-Desktop（https://github.com/vastsa/PI-Desktop）模型模块的交互设计与功能，重构本项目模型模块：

1. **信息架构重构**：把现有"单文件卡片表单"（ModelsView 三段式：默认模型区 + Provider 卡片 + 保存）重构为 PI 式"服务列表 + 添加/编辑对话框 + 模型双栏 + 默认模型锚定菜单"的交互。
2. **数据结构对齐真实 schema**：当前 `ProviderConfig` 只管理 5 键且把模型条目压缩为 `{id}`，保存即丢弃用户手写的模型级字段（dsh schema 原生支持 `name/contextWindow/maxTokens/input/reasoningEfforts` 等）。重构后数据结构与 dsh `llm-pi-ai` 真实 schema 对齐，未管理字段逐层透传，往返无损。

# 范围

## Source coverage

来源：GitHub 仓库 `vastsa/PI-Desktop`（main @ v0.14.6-rc.4，2026-09-10 本地浅克隆完整只读调查其模型模块；本单元清单即来源覆盖映射，Spec 不重复此表）。

| # | 来源单元（PI-Desktop 定位） | 读取 | 归宿 |
|---|---|---|---|
| S1 | Models 设置页信息架构：默认模型行 + 更改锚定菜单（按服务分组/搜索/勾选/空态）、AI 服务列表（名称/徽标/副行 host·N 模型）、空状态 | complete | specs/models-config/ · A1 A2 |
| S2 | 服务行内操作：设为默认、编辑、连接测试、两步删除（3 秒未确认自动还原、失焦取消） | complete | specs/models-config/ · A2 |
| S3 | 添加/编辑服务对话框：Service 预设选择器（可搜索、键盘导航、选中回填）、名称/Base URL/API 密钥引用/协议字段与校验（URL 形校验、尾部路径剥离）、保存门控 | complete | specs/models-config/ · A3 |
| S4 | 模型双栏：左栏该服务模型（全选 indeterminate、搜索、手动"获取列表"、加载态、错误归类 8 种、来源注记 catalog/fallback）、右栏已选模型（别名、token 缩写、展开高级、移除） | complete | specs/models-config/ · A4 A5 |
| S5 | 模型实时发现：600ms 防抖、缓存先渲染再刷新、请求序号防乱序、端点三元组变更撤下旧结果 | complete | specs/models-config/ · A4 |
| S6 | 每模型高级面板：别名、上下文窗口、最大输出、思考等级 chips + 默认档、附件能力开关、子代理可用 | complete | specs/models-config/ · A5（收录 Q1 常用全套：别名/上下文窗口/最大输出/推理档/图片输入；子代理可用不收录——本应用无子代理调度） |
| S7 | 目录状态行（source·数量·更新时间）+ 手动刷新按钮（上轮明确非目标，本轮随 PI 参考重新收录） | complete | specs/models-config/ · A6 |
| S8 | 保存后默认同步：首个服务自动设为默认；删除默认服务自动回退下一个可用服务 | complete | specs/models-config/ · A2 |
| S9 | 服务预设表（22+ 命名端点预设 + 自定义端点） | complete | specs/models-config/ · A3（收录，Q3：预设表由 pi-ai 内置目录生成入库） |
| S10 | 自定义请求头编辑器（预设/JSON 导入导出/键值行） | complete | specs/models-config/ · A8（收录 Q2 常用子集：headers 键值行编辑 + timeoutMs + reasoning 默认档；headers 的"常用头预设下拉"一并收录） |
| S11 | 厂商账户 OAuth 区（列表/登录/编辑/测试/删除） | complete | 非目标（架构差异，见下） |
| S12 | Composer 模型切换器 + 推理等级菜单（聊天界面） | complete | 非目标（本应用无聊天界面） |
| S13 | 配置导入（CC Switch/Claude Code/OpenCode/Codex/Pi 扫描导入） | complete | specs/models-config/ · A9（收录，Q4 2026-09-10 用户选定；凭据映射规则见决策与 Spec） |
| S14 | API 密钥明文录入与加密存储、`hasSecret` 呈现 | complete | 非目标（架构差异：本项目凭据引用为 `apiKeyEnv` 环境变量名，密钥值永不落盘，属 dsh 硬设计；导入场景的凭据映射见 A9 决策） |
| S15 | 供应商 `enabled` 启停开关 | complete | 非目标（查实 dsh `PiAiProviderProfile` 无 enabled 字段；删除即停用） |

- 前端：`src/features/models/` 重构（ModelsView 拆分为列表/对话框/双栏组件）；`src/shared/store/slices/models.ts`、`src/shared/commands.ts`、`src/shared/bindings/`（ts-rs 再生）、`src/shared/i18n/{en,zh-CN}.ts` 同步。
- 后端：`src-tauri/src/dsh/models.rs` 的 `ProviderConfig` 结构对齐 dsh schema（模型条目结构化 + 管理键扩充 + 未管理字段逐层透传）；目录快照/远端拉取 IPC 复用并按需扩展。
- 测试：`src/features/models/ModelsView.test.tsx`、`src-tauri/src/dsh/tests.rs`、`e2e/smoke.mjs` 同步更新。

## dsh schema 事实基线（2026-09-10 查实于本机安装包）

`@deepseek-ai/dsh-llm-pi-ai/lib/types/{config,catalog,adapter}.d.ts`：

- `llm-pi-ai.providers.<route>`（`PiAiProviderProfile`）：`apiKeyEnv?`、`displayName?`、`api?`、`baseURL?`、`models?[]`、`modelOverrides?`、`compat?`、`defaultContextWindow?`、`defaultMaxTokens?`、`defaultInput?`、`headers?`、`reasoning?`、`thinkingBudgets?`、`cacheRetention?`、`transport?`、`timeoutMs?`、`websocketConnectTimeoutMs?`、`streamIdleTimeoutMs?`、`maxRequestImageBytes?`、`requestImagePixelBudget?`、`requestImageMaxBytes?`、`retryPolicy?`。无 `enabled` 字段。
- `models[]` 条目（`PiAiModelProfile`）：`id`（必填）、`name?`（显示别名）、`contextWindow?`、`maxTokens?`、`input?`（模态）、`reasoningEfforts?`（`false | Partial<Record<off..max, string|null>>`）、`compat?`。`models` 显式列表**整体替换**内置目录；缺省/不写 = 继承内置目录。
- 路由键命中 pi-ai 内置目录（约 40 个 provider）时，端点/协议/模型目录全部继承，仅 `apiKeyEnv` 即可成路。
- `agent-default-model`：`{ provider, model, reasoningEffort? }`，settings 用户层实时读取。
- 生效语义：`dsh-settings-file` 默认 chokidar 监听 settings.yaml 热重载；llm-pi-ai 档案按请求解析（换键/端点/模型/旋钮下一请求生效，路由集变更原位重注册）。**现有页脚"保存后需重启 dsh web 服务生效"与事实不符。**
- 校验：dsh 在写入路径拒收不可服务的档案；文件热重载遇无效段落时保留上一份有效文档并告警（即 UI 写入 schema 无效值会静默不生效）——UI 侧须按 dsh 约束做同构校验。

# 非目标

- API 密钥明文录入、加密存储、OAuth 厂商账户（S11/S14；架构差异：`apiKeyEnv` 引用是 dsh 安全设计，本应用只做 settings.yaml 文件级读写，不接 runtime 凭据缝）。
- 聊天内模型切换器（S12；本应用是 dsh 管理壳，无聊天界面）。
- 供应商启停开关（S15；schema 无此字段）。
- 不改 dsh CLI 本体与 settings.yaml 既有契约语义（键名、extra 透传、原子写、空键移除规则不变）。
- `modelOverrides`、`compat`、`thinkingBudgets`、`cacheRetention`、`transport`、重试策略、图片字节预算等高级旋钮不进 UI，走既有 extra/逐层透传。
- 每模型"可供 AI 自动调度（子代理）"开关（S6 子项；本应用无子代理调度语义）。
- `reasoningEfforts: false`（声明模型不支持推理）不设 UI；档位全不勾 = 不写该键（目录模型继承目录、手写模型视为不支持推理，两种语义各自正确）。
- 导入不迁移密钥明文值，不导入来源工具的非供应商配置（如 CC Switch 的代理切换语义）。

# 验收示例

- A1: 模型页呈现服务列表：每行显示名称、默认徽标、未设凭据引用提示徽标、副行（host · N 个模型）、设为默认/编辑/删除行内操作；无服务时空状态含引导按钮；默认模型行显示"服务 · 模型 · 推理档"，点"更改"弹按服务分组的锚定菜单（可搜索、当前项勾选、无匹配提示），菜单仅列已配置路由的模型。
- A2: 行内操作可用：两步删除（3 秒未确认自动还原、失焦取消）；删除默认服务后默认模型自动回退到下一个可用服务（无可用则清空）；保存首个服务且当前无默认时自动设为默认。
- A3: 添加/编辑对话框：服务预设选择器可搜索、键盘可用，选预设自动回填路由键/名称/Base URL/协议，含"自定义端点"项（路由键命中 pi-ai 内置目录的预设仅凭据引用必填）；字段校验（Base URL 形校验与尾部路径剥离、路由键非空）；保存门控；编辑回显现有配置。
- A4: 模型双栏：左栏可手动"获取列表"（成功逐条点选、全选含 indeterminate、搜索过滤、已选禁用标记、token 缩写展示；失败按原因归类为静态文案，任何路径不含密钥值）；右栏列出已选模型可移除；端点三元组变更撤下旧结果。
- A5: 每模型高级面板：右栏模型行可展开，编辑显示名、上下文窗口、最大输出（留空=继承，正整数校验）；推理档 chips（off..max 多选，每启用档可编辑 wire 拼写、默认等于档名；手写 `false` 声明原样保留）；图片输入三态开关（跟随目录=不写键 / 关 / 开，手写自定义模态原样保留）；保存后写入对应 `models[]` 条目字段。
- A6: 目录状态行显示 source/条数/更新时间，手动刷新按钮可用（刷新中禁用），失败静默保留旧快照并 toast 提示。
- A7: 往返无损：含手写模型级字段（如 `contextWindow`、`reasoningEfforts`）与 provider 级未管理字段（如 `retryPolicy`）的 settings.yaml 经 UI 加载→保存后逐字段原样保留；空模型列表保存后不写 `models` 键。
- A8: 服务高级设置区：headers 键值行增删改、常用头预设、JSON 粘贴导入（同名键合并）、凭据类保留头拒收；timeoutMs 正整数校验；reasoning 默认档下拉（未设置/off..max）；保存写入对应字段。
- A9: 配置导入：模型页"导入配置"入口扫描本机 Claude Code/Codex/OpenCode/CC Switch/Pi 五类已知路径（缺失静默跳过不报错），按来源分组展示并分组勾选；导入把所选条目写入 settings.yaml（route 键已存在或端点+凭据引用均相同则跳过并计数）；来源为环境变量引用的映射为 `apiKeyEnv`，来源为明文密钥值的导入不含凭据声明并在结果中计数提示；页面有未保存修改时先要求保存或撤销；结果 toast 含 imported/skipped/failed 计数；全程不展示、不落盘任何密钥明文。
- A10: 保存成功文案不宣称"需重启"（按热加载事实改为即时生效表述）；新增文案 en/zh-CN 双语齐全，`node scripts/check-i18n.mjs` 通过。
- A11: 前端 ModelsView 测试、Rust models 测试（含新增用例）、e2e smoke 全绿。

# 约束与不变量

- 密钥值永不落盘、不进日志；`apiKeyEnv` 只存环境变量名。
- settings.yaml 往返安全：UI 未管理的字段（provider 级与模型条目级）保存后逐层原样保留，消除"模型条目重建为 `{id}`"的数据破坏。
- UI 写入前按 dsh 约束校验（枚举值、正整数、headers 值类型、保留头拒收），避免写出热重载拒收的无效段落。
- UI 沿用共享 ui.ts class 常量、既有 toast/错误路径；无第三方 UI 依赖。
- 目录快照仍是缓存不是事实来源；缺失/损坏静默当作无目录。

# 决策

- 2026-09-10 用户指定：参考 PI-Desktop 模型模块的交互设计与功能重构本模块（来源文档，覆盖映射见 Source coverage，全部单元 complete）。
- 2026-09-10 Build 复核修订：A5 原含"启用多于 1 档出现默认档下拉"——查实 dsh `PiAiModelProfile` 无每模型默认档字段（schema 只有 provider 级 `reasoning` 与全局 `agent-default-model.reasoningEffort`），无处落盘，该子项从验收移除；默认档语义由既有两级承载。属 schema 事实修正，不改用户已确认的四项收录决定。
- 数据结构对齐 dsh 真实 schema（2026-09-10 查实 dsh-llm-pi-ai 类型定义；推翻上轮"模型级元数据归属 dsh schema 不可做"的判定——schema 一直支持，是旧 UI 未暴露）。
- 配置生效语义按热加载处理（查实 dsh-settings-file watch 默认开启 + llm-pi-ai 按请求解析），页脚文案随事实修正。
- models.dev 全量目录与 24h 自动刷新沿用上轮成果；新增状态行与手动刷新（上轮非目标，本轮随 PI 参考翻转，理由：成本极低且与 PI 一致）。
- 2026-09-10 用户四项收录决定：Q1 每模型字段收录常用全套（别名/上下文窗口/最大输出/推理档 chips+默认档+wire 拼写/图片输入三态）；Q2 服务级高级字段收录常用子集（headers 编辑器/timeoutMs/reasoning 默认档）；Q3 提供服务预设选择器（预设表由 pi-ai 内置 provider 目录生成入库，生成脚本 + 生成物同仓，避免手写第二事实源）；Q4 配置导入本轮收录（Claude Code/Codex/OpenCode/CC Switch/Pi 五源）。
- 导入凭据映射规则（架构约束推导，非用户特批）：源条目持环境变量引用（如 Codex `env_key`、Claude `env` 块）→ 直接映射 `apiKeyEnv`；源条目仅明文密钥 → 导入不含凭据的声明（内置目录路由可靠 pi-ai 环境发现兜底）并计数提示，明文值不读取、不展示、不落盘。
- 推理档 UI 语义：chips 全不勾 = 不写 `reasoningEfforts`（目录模型继承目录、手写模型不支持推理）；启用档的 wire 拼写默认等于档名、可编辑（dsh 要求非 off 档必须命名 wire 值）。

# 待解决问题

（无——Q1–Q4 已于 2026-09-10 由用户回答并写入决策）

# 验证预期

- 前端 vitest、Rust `cargo test`（含 `-D warnings` 的 clippy）、e2e smoke 全绿；`node scripts/check-i18n.mjs` 通过。
- 往返无损以 Rust 测试覆盖：含手写模型级字段与 extra 字段的 settings.yaml 经 save/load 往返逐字段保留。
