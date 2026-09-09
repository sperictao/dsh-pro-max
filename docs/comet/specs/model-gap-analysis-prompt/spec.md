# Spec：模型模块差距分析提示词（model-gap-analysis-prompt）

归档后的完整行为：本项目提供一份自包含的中文提示词文档 `docs/agent/model-module-gap-prompt.md`，任何 agent 会话拿到它即可独立完成"dsh-pro-max 模型模块相对 CometixSpace/CCursor 模型模块的功能缺失"分析，产出差距清单 + 可迁移性判断 + 机制提案。

## 文档结构（六要素，缺一不可）

1. **任务目标与对比方向**：单向分析本项目相对 CCursor 的功能缺失；范围限定为用户可见的模型/供应商管理能力，客户端集成层（协议拦截、proto 构建、SSE）归入架构差异说明。
2. **双侧模块定位**：
   - 本项目：`src/features/models/ModelsView.tsx`、`src-tauri/src/dsh/models.rs`、`src/shared/store/slices/models.ts`、`src/shared/bindings/{ModelConfig,ProviderConfig}.ts`；
   - CCursor：GitHub `https://github.com/CometixSpace/CCursor`，附克隆命令，实际根目录 `Cursor++/`，入口文件清单（providersStore.ts、catalogStore.ts、routesStore.ts、defaults.ts、models-section/model-card/provider-accordion/provider-fields/providers 组件、app.ts）。
3. **事实基线**：内嵌双侧现状盘点（本项目已有能力、CCursor 已有能力），声明执行者可将其为起点、按需复核，不得凭 README 断言。
4. **对比与归类规则**：每条缺失给双方代码依据（`文件:行号`）；三分类判定——可迁移缺失 / 归属他模块或架构差异 / 本项目有意的设计差异（例：apiKeyEnv 只存环境变量名是安全设计）。
5. **输出格式要求**：差距清单表（功能项、CCursor 依据、本项目依据、三分类判定、机制提案）；机制提案只对"可迁移缺失"给出，需说明在本项目架构（dsh CLI 拥有 settings.yaml、UI 经 Tauri IPC 读写）下的落点。
6. **执行验收标准**：执行会话完成分析的 done 条件（每条缺失有依据、三分类齐全、可迁移项均有提案、架构差异单独成节）。

## 硬性约束

- 文档自包含：不引用本 change、本会话或任何临时路径；CCursor 一律以 GitHub URL + 克隆命令指称。
- 文档中引用的本项目文件路径必须真实存在。
- 中文书写，面向任意 agent 会话通用，不绑定特定工具或平台。
