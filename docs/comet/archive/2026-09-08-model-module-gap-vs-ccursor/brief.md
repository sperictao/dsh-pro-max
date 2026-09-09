# 目标

产出一份**自包含的中文提示词文档**（差距分析任务书）：可整体复制到任意空白 agent 会话，独立完成"dsh-pro-max 模型模块相对 CometixSpace/CCursor（Cursor++）模型模块的功能缺失"分析。深度要求：差距清单 + 可迁移性判断 + 机制提案。

# 范围

- **交付物**：一份提示词文档（单文件），内嵌双侧事实基线，执行会话无需重新全量调查，只需按需复核。
- **本项目侧**：`src/features/models/ModelsView.tsx`（唯一 UI）、`src-tauri/src/dsh/models.rs`（读写 `~/.dsh/settings.yaml` 模型域：`agent-default-model` + `llm-pi-ai`）、`src/shared/store/slices/models.ts`、`src/shared/bindings/{ModelConfig,ProviderConfig}.ts`。
- **CCursor 侧**：GitHub `CometixSpace/CCursor`（实际根目录 `Cursor++/`），模型模块 = `src/server/config/providersStore.ts`、`catalogStore.ts`、`routesStore.ts`、`src/server/data/defaults.ts`、`src/ui/components/{models-section,model-card,provider-accordion,provider-fields,providers}.tsx`、`src/ui/webview/app.ts`。
- **对比方向**：单向——本项目相对 CCursor 的功能缺失为主轴。
- **归类规则**：计入"模型模块功能"的是用户可见的模型/供应商管理能力；不计入纯客户端集成层（ConnectRPC 拦截、proto variants 构建、SSE 推送），这些归入"架构差异"说明。

## 双侧现状盘点（已完成的调查事实，提示词的事实基线）

**本项目已有**：读取配置进视图；默认模型三件套（provider/model/reasoningEffort off–max）；自定义供应商 CRUD（route/displayName/wire protocol openai-completions|openai-responses|anthropic-messages/baseURL/apiKeyEnv/models 多行文本）；保存时整体重建 YAML 两键，extra 字段透传；密钥只存环境变量名；页脚提示保存后需重启 dsh web。明确没有：API Key 值输入、连通性测试、远端模型列表拉取、模型目录/补全、按用途分派、供应商排序、启停开关、热生效。

**CCursor 已有**：BYOK 模式热切换开关（重写 routes.json + SSE 推送刷新，无需重启）；供应商 CRUD + 草稿 dirty 标记 + 上下移排序 + 直编 JSON 入口；认证管理（apiKey/token 双模式、密码框、自定义 headers JSON 实时校验、HTTP 代理）；模型目录（models.dev 快照 4000+ 条）Fuse 模糊搜索 + 选中自动预填 8 个字段；远端模型拉取（按协议请求上游 /v1/models，兼作连通性验证，点选即添加）；模型条目管理（defaultOn 启停、Agent/Images/CmdK/Fast/Thinking 能力开关、contextTokenLimit/maxOutputTokens/thinkingBudgetTokens、tooltip）；thinking 档位 Level/Budget 双模式 + QuickSwitch 参数变体；server 侧按 modelId 路由解析到四类 SDK（未登记模型报错不静默回退）；token 用量统计；配置热更新（2s 轮询 + 原子写）。

# 非目标

- 本 change 不实现任何缺失功能，也不执行差距分析本身——只产出提示词文档。
- 不做 CCursor 仓库的逐单元源文档覆盖映射（其为对比参考材料，非需求规格来源）。
- 不评估 CCursor 与 Cursor 客户端集成层（协议拦截、伪装订阅等）。

# 验收示例

- A1: 交付物是单个 Markdown 文件，作为提示词包含六要素：任务目标与对比方向、双侧模块定位（真实文件清单 + CCursor 克隆方式）、事实基线（上述盘点）、对比与归类规则、输出格式要求（差距清单 + 可迁移性三类判定 + 机制提案）、执行验收标准。
- A2: 提示词自包含：不引用本会话、本 change 或 `/tmp` 临时路径；CCursor 一律以 GitHub URL + 克隆命令指称。
- A3: 提示词明确要求执行者对每条缺失给出双方代码依据（`文件:行号`），并区分三类：可迁移缺失 / 归属他模块或架构差异 / 本项目有意的设计差异（如 apiKeyEnv 只存环境变量名）。
- A4: 提示词中引用的本项目文件路径全部真实存在；抽查事实基线中至少 3 条陈述与源码一致。

# 约束与不变量

- 每条缺失判定必须有双方代码依据，禁止凭 README 或印象断言。
- 必须区分"功能缺失（架构上可迁移）"与"架构差异导致归属他模块/不可直接迁移"（例：模型路由与请求转发归 dsh CLI；热生效受 settings.yaml 单文件所有权与"dsh web 需重启"约束；apiKeyEnv 是安全设计不是缺失）。
- 提示词面向任意 agent 会话通用，不绑定特定工具或平台。

# 决策

- Q1 → 交付形态为"完美提示词文档"，非直接产出报告（Eric 2026-09-08 选定）。
- Q2 → 深度为"清单 + 可迁移性 + 机制提案"，提示词的输出格式要求按此定义。
- 对比基准：CCursor 以 GitHub URL 指称（提示词内附克隆指引），仅作参考材料，不触发源文档覆盖模式。
- 对比方向单向（本项目缺失），归类规则见 范围。
- 交付物落盘 `docs/agent/model-module-gap-prompt.md`（沿用既往 gap 分析材料的 gitignored 目录），最终回复同时附获取路径。

# 待解决问题

（无——Q1/Q2 已决，无剩余阻塞项）

# 验证预期

- 对照 A1–A4 逐条检查交付物文件。
- A4 的路径存在性用 `test -f` 核对；事实抽查直接读本项目源码核对。
