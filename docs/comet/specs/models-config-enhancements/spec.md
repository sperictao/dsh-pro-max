# Spec：模型模块配置能力增强（models-config-enhancements）

归档后的完整行为：模型模块（`src/features/models` + `src-tauri/src/dsh/models.rs`）在原有"读配置/默认模型/供应商 CRUD/保存"之上，提供基于 models.dev 全量目录的模糊搜索联想（快照本地缓存、24h 过期自动后台刷新）、按 provider 拉取上游模型列表（兼连通性验证）、以及 settings.yaml 的原子写入。settings.yaml 契约（`agent-default-model`、`llm-pi-ai`、5 管理键、extra 透传、空键移除）不变。

## 1. 原子写

- `save_model_config_at` 写入流程：内容先写同目录临时文件（`settings.yaml.tmp`），`fs::rename` 原子替换目标文件；任一步失败时目标文件保持旧内容，错误经既有 keyf 契约上抛。
- 保存成功后无临时文件残留。
- 既有行为不变：保存前读现文件、整体重建两键、extra 剥离/透传、空键移除。

## 2. 全量模型目录（models.dev）与自动更新

- 数据源：`https://models.dev/api.json`。投影条目 `{ id, name, family }`：family 由 models.dev 顶层 providerKey 映射（`anthropic` → `anthropic`，其余含 `google` → `openai`）；按模型 id 去重（first-wins）；过滤无 id 的条目。
- 快照：JSON 文件 `{ fetchedAt, entries[] }`，存 app 数据目录（与 market 快照同目录惯例）。快照是缓存不是事实来源：缺失/损坏一律当作无目录，不报错。
- IPC：
  - `model_catalog_load() -> Result<Option<CatalogFile>, String>`：读快照，无/损坏返回 None；
  - `model_catalog_refresh() -> Result<CatalogFile, String>`：拉取 → 投影 → 原子写快照 → 返回；网络/解析失败上抛 keyf 错误。
- 自动更新：前端进入模型页时 `load`；快照缺失或 `fetchedAt` 距今超 24h 则后台触发 `refresh`（不阻塞渲染），成功后静默替换内存目录；失败静默跳过，下次进入重试。
- 无手动刷新按钮、无目录状态文案。

## 3. 模糊搜索联想（对齐 market 域模式）

- 过滤算法与 `MarketView.tsx` 的目录过滤一致：`query.trim().toLowerCase()` 为子串，匹配条目 `id` 或 `name`（大小写不敏感）；无第三方库。
- 候选池：该 provider 已配置模型 id ∪ 目录条目（按 wire protocol 映射 family：openai-completions/openai-responses → `openai`；anthropic-messages → `anthropic`），按 id 去重。协议未设置时不过滤 family。
- 交互（`ModelSearchInput` 组件）：输入框 + 候选浮层；候选截断前 50 条；↑↓ 高亮移动、Enter 或点击选中、Esc 或点击外部关闭；空 query 显示已配模型（不足 50 条再补目录头部条目）。
- 落点：默认模型 Model 输入（选中最替换值）；ProviderCard"添加模型"输入（选中追加进 models，去重）。原 datalist 引用移除。

## 4. 远端模型列表拉取

- 新增 Tauri 命令 `model_remote_list(baseURL, api, apiKeyEnv) -> Result<Vec<String>, String>`（`ipc_blocking` 包装）：
  - key 来源：`std::env::var(apiKeyEnv)`；未设置 → 静态错误键，不含值。
  - 请求：openai 系 GET `{base 归一}/models`（Bearer）；anthropic-messages GET `{base 归一}/v1/models`（`x-api-key` + `anthropic-version: 2023-06-01`）；尾斜杠归一；10s 超时。
  - 解析：取响应 JSON `data[].id`，去重、字典序。
  - 失败：网络错误与非 2xx 分别上抛静态错误键，消息含请求 URL，绝不含 key 值；日志不含 key。
- UI（ProviderCard）："拉取模型列表"按钮，busy 态禁用；成功后本卡内列出结果，单条点击追加到 models（去重，已存在者标记）；失败走全局 toast。

## 5. i18n

- 新增用户可见文案在 en 与 zh-CN 齐全；Rust 侧错误键为静态英文键，`scripts/check-i18n.mjs` 校验通过。

## 6. 测试

- Rust：原子写往返 + 无 tmp 残留；models.dev 投影纯函数（family 映射、去重、坏条目过滤）；快照往返与损坏容忍；目录过期判断；`model_remote_list` 的 URL 拼接（openai/anthropic、尾斜杠）、响应解析、env 缺失分支（网络部分拆纯函数，不做真实请求）。
- 前端：搜索浮层过滤（query 匹配、family 过滤、截断、去重）、键盘与点击选中、Esc/外点关闭；过期触发的后台刷新（IPC mock）；拉取按钮成功/失败路径（IPC mock）；点选追加去重。
- 全部既有相关测试保持绿。
