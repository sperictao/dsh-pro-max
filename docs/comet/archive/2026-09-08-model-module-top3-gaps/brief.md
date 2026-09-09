# 目标

实现差距分析报告（docs/agent/model-module-gap-analysis-ccursor.md）Top 3 可迁移项（按 2026-09-09 用户修订的需求）：

1. **模型全量目录 + 模糊搜索联想**（数据源 models.dev，自动更新；顺带消除 datalist 悬空 bug）；
2. **远端模型列表拉取**（兼连通性测试）；
3. **settings.yaml 原子写**。

# 范围

- `src-tauri/src/dsh/models.rs`：原子写；`model_remote_list` IPC；模型目录 `model_catalog_load` / `model_catalog_refresh` IPC 与投影纯函数。
- `src-tauri/src/main.rs` 与 `src-tauri/src/dsh/mod.rs`：注册新 IPC 命令。
- `src/features/models/ModelsView.tsx`：新增 `ModelSearchInput` 模糊搜索联想组件（默认模型输入 + ProviderCard 添加模型）；移除悬空 datalist 引用；ProviderCard 增加"拉取模型列表"入口与结果点选添加。
- `src/features/models/ModelsView.test.tsx`、`src-tauri/src/dsh/tests.rs`：新增/更新测试。
- `src/shared/commands.ts`、`src/shared/bindings/`：IPC 封装与类型（ts_rs 生成）。
- i18n：`src/shared/i18n/{en,zh-CN}.ts` 新增文案。
- 不修改 market 域与 integration 域。

## 关键决定（2026-09-09 用户修订后）

- **目录数据源与形态**：全量目录，数据源 `https://models.dev/api.json`（约 4.5MB / 4000+ 模型，CCursor 同源）。Rust 拉取后投影为轻量条目 `{ id, name, family }`（family：models.dev 顶层 providerKey `anthropic` → `anthropic`，其余含 google → `openai`——dsh pi-ai 无 gemini 原生协议，google 端点经 openai 兼容访问），按模型 id 去重，连同 `fetchedAt`（unix 秒）写本地快照（app 数据目录，跟随 market 快照惯例）。
- **自动更新**："随时可自动更新"= 进入模型页即加载快照立即可用；快照缺失或 `fetchedAt` 超过 24h 时自动后台刷新并替换内存目录；刷新失败静默降级（不打断用户，下次进入重试；搜索仍可用已配模型兜底）。不做手动刷新按钮与目录状态文案。
- **联想方式 = 模糊搜索，对齐 market 域模式**：搜索输入 + 实时过滤（`query.trim().toLowerCase()` 子串匹配 id 与 name，同 `MarketView.tsx:323-344`），不引入 Fuse.js 等第三方库。交互为输入框 + 候选浮层：聚焦显示候选（已配模型 + 目录按协议 family 过滤），输入实时过滤并截断前 50 条，↑↓ 导航、Enter/点击选中、Esc/外点关闭。落点两处：默认模型 Model 输入（选中即替换值）；ProviderCard 的"添加模型"输入（选中即追加进 models 并去重）。原 datalist 方案废弃，悬空引用（`ModelsView.tsx:120-122`）随组件替换自然消除。
- **远端拉取**：`reqwest::blocking` 经既有 `ipc_blocking` 模式；API key 经 `std::env::var(apiKeyEnv)` 从本机环境读取，值只在内存、不落盘、不进日志；URL 拼接 openai 系 `{base}/models`、anthropic `{base}/v1/models`（`anthropic-version` 头），尾斜杠归一；10s 超时；响应取 `data[].id` 去重排序；失败错误区分 env 未设置 / 网络 / HTTP 状态，附实际请求 URL（不含 key）。
- **点选添加**：拉取结果逐条展示，点击即追加到该 provider 的 models（去重），已添加的标记。
- **displayName 预填不适用**：模型条目仅 id 字符串，联想选中只填 id。

# 非目标

- 不做 Fuse.js 等第三方模糊搜索库、不做目录手动刷新按钮与目录状态文案。
- 不做模型级元数据（启停/能力位/上下文上限——归属 dsh schema）。
- 不做配置热生效（归属 dsh）。
- 不改 dsh CLI 与 settings.yaml 契约（llm-pi-ai providers 条目仍是 5 管理键 + extra）。
- 不新增 Rust 依赖（reqwest 已有）。

# 验收示例

- A1: settings.yaml 保存路径改为临时文件 + rename 原子替换；既有 save/load 往返测试保持通过；新增断言保存后无临时文件残留。
- A2: 模糊搜索联想（对齐 market 实时过滤模式）：默认模型 Model 输入与 ProviderCard"添加模型"输入均可输入即时过滤候选（匹配 id/name、大小写不敏感），↑↓/Enter/点击/Esc/外点交互可用；先写失败测试（当前无联想能力）再实现。
- A3: 全量目录数据链路：`model_catalog_refresh` 拉取 models.dev api.json 并投影 `{id,name,family}`（family 映射与按 id 去重以纯函数单测覆盖）、写含 `fetchedAt` 的快照；`model_catalog_load` 读快照；候选按 provider wire protocol 过滤 family（anthropic-messages→anthropic、openai 系→openai）。
- A4: 目录自动更新：进入模型页快照立即可用；缺失或 fetchedAt 超 24h 自动后台刷新并替换；刷新失败静默降级（不弹错误，联想仍含已配模型）。过期判断与降级以单测覆盖。
- A5: ProviderCard 提供"拉取模型列表"操作：成功时结果逐条展示、点击追加进 models 且去重；环境变量未设置 / 网络失败 / HTTP 错误三种失败各有静态中文错误文案（键无插值以命中 zh 字典；URL/变量名/状态码进日志，用户界面中卡片本身已展示 env 名与 Base URL），任何路径不含 key 值。
- A6: 新增用户可见文案 en/zh-CN 双语齐全，`node scripts/check-i18n.mjs` 通过。
- A7: 前端 ModelsView 测试与 Rust models 测试（含新增用例）全绿。

# 约束与不变量

- 密钥值永不落盘、不进日志（延续 models.rs:7 的安全边界）。
- settings.yaml 契约不变：管理键、extra 透传、空键移除规则原样保留。
- UI 沿用共享 ui.ts class 与既有 toast/错误路径；搜索过滤模式与 market 一致（无第三方依赖）。
- 模块边界：不改 market/integration 域；目录快照是缓存不是事实来源（参照 market 哲学：损坏/缺失静默跳过）。

# 决策

- 全量目录 + 24h 过期自动刷新（用户 2026-09-09 明确要求"全量目录、随时可以自动更新"）。
- 模糊搜索对齐 market 模式（用户 2026-09-09 指定"参考插件的模糊搜索"），即输入 + 实时 toLowerCase 子串过滤，无第三方库。
- 需求来源为会话内差距分析报告与用户指令；报告仅作实现参考，不触发源文档覆盖模式。

# 待解决问题

（无）

# 验证预期

- A1–A4、A7 以自动化测试断言（投影/过期判断/过滤纯函数单测 + 前端组件测试，网络请求不 mock 全链路、拆纯函数覆盖）。
- A5 以单测覆盖 URL 拼接/解析/env 缺失分支 + 手工验收路径说明。
- A6 跑 `node scripts/check-i18n.mjs`；A7 跑 `pnpm test` 与 `cargo test`（models 域）。
