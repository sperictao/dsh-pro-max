# models-config 完整目标规格

本模块管理 dsh 的模型接入配置：读写 `~/.dsh/settings.yaml` 的 `agent-default-model` 与 `llm-pi-ai.providers` 两个顶层键，呈现为"默认模型 + AI 服务列表 + 添加/编辑对话框 + 模型双栏 + 目录 + 导入"的管理页面。归档后本规格即该能力的完整行为描述。

数据事实来源：dsh `@deepseek-ai/dsh-llm-pi-ai/lib/types/{config,catalog,adapter}.d.ts`（schema）、`dsh-settings-file`（热加载）、`dsh-agent-default-model`（默认模型）。settings.yaml 是唯一事实来源；目录快照与预设表是缓存的引用数据。

## 页面结构（`src/features/models/`）

- `ModelsView`：页面骨架，持有配置草稿状态（加载→本地草稿→保存）。分区：默认模型行、AI 服务列表、目录状态行、页脚保存区、导入入口。
- 服务列表行组件：名称、徽标（默认 / 未设凭据引用）、副行（Base URL host · N 个模型）、行内操作（设为默认、编辑、两步删除）。
- 添加/编辑对话框组件：预设选择器 + 基础字段 + 模型双栏 + 高级设置折叠区 + 保存门控。
- 双栏选模型组件：左栏候选模型（含搜索/全选/获取列表），右栏已选模型（含每模型高级面板展开）。
- 旧 `ModelSearchInput` 模糊联想组件按新交互吸收进双栏与默认模型菜单，不再独立存在于卡片表单。

## 数据模型

Rust `ProviderConfig`（`src-tauri/src/dsh/models.rs`）对齐 dsh `PiAiProviderProfile` 的 UI 管理子集，其余字段逐层透传：

- 管理键（provider 级）：`route`（dict 键）、`displayName`、`api`、`baseURL`、`apiKeyEnv`、`models[]`、`headers`、`timeoutMs`、`reasoning`。
- 模型条目（`ModelEntry`）管理键：`id`（必填）、`name`、`contextWindow`、`maxTokens`、`input`（text/image 布尔三态投影）、`reasoningEfforts`（档位集合 + 每档 wire 拼写 + 默认档投影）；条目内其余键（如 `compat`）透传。
- provider 级其余键（`modelOverrides`、`compat`、`retryPolicy`、`thinkingBudgets` 等）走既有 `extra` 透传。
- 空值语义：可选字段留空 = 不写键（继承 dsh/目录默认）；`models` 为空列表 = 不写 `models` 键（继承内置目录）；providers 为空 = 移除整个 `llm-pi-ai` 键；默认模型缺任一必填 = 移除 `agent-default-model`。
- ts-rs 再生 `src/shared/bindings/`，前端经 `src/shared/commands.ts` 既有 IPC 封装读写。

## IPC 面

沿用并扩展 `model_config_load` / `model_config_save` / `model_catalog_load` / `model_catalog_refresh` / `model_remote_list`；新增 `model_config_import_scan` / `model_config_import_run`。全部经 `ipc_blocking` 模式；密钥值永不进入 IPC 载荷、日志与错误文案。

## 默认模型区

- 行内容：`服务 · 模型 · 推理档`；未配置时显示引导态。
- "更改"锚定菜单：候选 = 已配置路由的模型，按服务分组；搜索框过滤（大小写不敏感，匹配服务名与模型 id）；当前项勾选；无匹配显示提示；键盘 ↑↓/Enter/Esc 可用。
- 推理档下拉：未设置/off/minimal/low/medium/high/xhigh/max，写入 `agent-default-model.reasoningEffort`。

## AI 服务列表

- 行内操作：设为默认（仅非默认行）、编辑（打开对话框）、两步删除（垃圾桶 → "确认删除？"，3 秒未确认或失焦自动还原）。
- 默认同步：保存首个服务且当前无默认时自动设为默认；删除默认服务后自动回退到下一个可用服务，无可用则清空默认。
- 空状态：图标 + 引导文案 + 添加按钮。

## 添加/编辑对话框

- 预设选择器：预设表由 pi-ai 内置 provider 目录生成入库（生成脚本 + 生成物同仓，注明来源与再生成方式），含"自定义端点"项；可搜索、键盘导航；选预设回填路由键/名称/Base URL/协议；路由键命中内置目录的预设仅凭据引用必填（端点、协议、模型目录由 dsh 目录继承）。
- 基础字段：路由键（非空校验）、显示名、Base URL（http/https 形校验；失焦时剥离 `/chat/completions`、`/responses`、`/messages`、`/models` 等尾部路径）、API Key 环境变量名（密码无关，明文值永不出现）、wire 协议（openai-completions / openai-responses / anthropic-messages / 未设置）。
- 模型双栏：见下节。
- 高级设置折叠区：headers、timeoutMs、reasoning 默认档。
- 保存门控：路由键非空；URL 合法（自定义端点时）；保存中禁用重复提交。编辑态回显现有配置。

## 模型双栏

- 左栏"该服务的模型"：手动"获取列表"按钮（复用 `model_remote_list`：openai 系 `{base}/models`、anthropic `{base}/v1/models`，凭据经 `std::env::var(apiKeyEnv)` 内存读取）；结果逐条展示（等宽 id、token 缩写），点选切换、全选（indeterminate）、客户端搜索；已选条目禁用标记。加载/失败/空结果各有静态文案，失败按 原因（环境变量未设置/网络/HTTP 状态/响应不可解析）归类；端点三元组（baseURL/api/apiKeyEnv）变更撤下旧结果。
- 目录补充：获取失败或未获取时，可从 models.dev 目录按协议 family 过滤联想（沿用既有快照加载/24h 自动刷新链路）。
- 右栏"已选模型"：列表 + 移除；行展开高级面板。

## 每模型高级面板

- 显示名（`name`）；上下文窗口、最大输出（正整数，留空=继承）。
- 推理档 chips：off..max 多选；每启用档可编辑 wire 拼写（默认=档名）。全不勾 = 不写 `reasoningEfforts`。手写 `false`（声明不支持推理）原样保留，不设 UI。每模型"默认档"无 dsh schema 字段承载，默认档语义由 provider 级 `reasoning` 与 `agent-default-model.reasoningEffort` 两级表达。
- 图片输入三态开关：跟随目录（不写 `input`）/ 关（`["text"]`）/ 开（`["text","image"]`）。

## 服务高级设置

- headers 键值行增删改；常用头预设下拉；JSON 粘贴导入（同名键合并，格式错误静态提示）；凭据类保留头（authorization、x-api-key、cookie 等）拒收。
- timeoutMs 正整数校验；reasoning 默认档下拉（未设置/off..max）。

## 目录状态行

- 文案：`目录：{source} · {n} 个模型 · 更新于 {time}`（source ∈ models.dev / 内置快照 / 不可用）。
- 手动刷新按钮：刷新中禁用；失败静默保留旧快照并 toast 提示。自动刷新链路（进入页面缺失或超 24h 后台刷新）不变。

## 配置导入

- 入口：模型页"导入配置"，页面草稿有未保存修改时先要求保存或撤销。
- 扫描源（本机已知路径，缺失静默跳过）：Claude Code（`~/.claude/settings.json(.local)`）、Codex（`~/.codex/config.toml`）、OpenCode（`~/.config/opencode/opencode.json(c)` + `auth.json`）、CC Switch（`~/.cc-switch/`）、Pi（`~/.pi/agent/models.json`）。
- 扫描结果按来源分组展示、分组勾选；导入将所选写入 settings.yaml（经既有保存管道，原子写）。
- 去重：route 键已存在，或端点+凭据引用均相同 → skipped 计数。
- 凭据映射：源持环境变量引用 → `apiKeyEnv`；源仅明文密钥 → 导入不含凭据的声明并在结果计数提示（内置目录路由可靠 pi-ai 环境发现兜底）；明文值不读取、不展示、不落盘、不进日志。
- 结果 toast：`导入完成：X 已导入，Y 已跳过，Z 失败`。

## 保存与生效语义

- 保存 = 原子写 settings.yaml（temp + fsync + rename，管理键整体重建、其余顶层键原样保留、extra 逐层透传）。
- 生效文案：保存成功即热加载生效（dsh-settings-file 监听 + llm-pi-ai 按请求解析），不得宣称"需重启"。

## 校验与错误路径

- UI 写入前按 dsh 约束校验（枚举值、正整数、headers 值为字符串、保留头拒收），避免写出热重载拒收的无效段落（无效段落会被 dsh 静默拒收）。
- 全部用户可见文案 en/zh-CN 双语齐全（`node scripts/check-i18n.mjs`），错误键为静态英文键名以命中 zh 字典。
- 失败路径有原因与下一步（toast/行内提示），不裸抛异常。

## 测试

- 前端 `ModelsView.test.tsx`：列表呈现、默认菜单、对话框校验与预设回填、双栏获取/点选/搜索、高级面板写值、目录状态、导入流程（mock IPC）。
- Rust `tests.rs`：save/load 往返无损（含模型级手写字段与 extra 透传）、空列表不写键、导入扫描/映射/去重纯函数、原子写无残留。
- e2e `smoke.mjs`：models 渲染步骤同步新结构，mock 新增 IPC。
