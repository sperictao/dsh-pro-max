#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../src/features/models/ModelsView.tsx", import.meta.url);
let source = readFileSync(path, "utf8");

function replaceOne(before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Step 4 patch target not found: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Step 4 patch target is not unique: ${label}`);
  }
  source = source.replace(before, after);
}

replaceOne(
  'import { CATALOG_STALE_SECS, DELETE_CONFIRM_MS, EFFORT_OPTIONS, fmtTokens } from "./shared";',
  `import {
  CATALOG_STALE_SECS,
  DELETE_CONFIRM_MS,
  EFFORT_OPTIONS,
  firstProviderModelId,
  fmtTokens,
  providerModelChoices,
} from "./shared";`,
  "shared imports",
);

replaceOne(
  `  // 第一个真正拥有显式模型且凭据条件已满足的服务自动成为默认；继承目录但
  // 未选择模型、或凭据尚未 Ready 的服务不写入一个不可运行的默认模型。
  if (!defaultProvider?.trim() && provider.models.length > 0 && canAutoDefault) {
    defaultProvider = provider.route;
    defaultModel = provider.models[0]?.id ?? null;
  }

  // 默认服务的模型集合被编辑后，若旧默认模型已不存在则回落到首个模型。
  const active = providers.find((item) => item.route === defaultProvider);
  if (active && !active.models.some((model) => model.id === defaultModel)) {
    defaultModel = active.models[0]?.id ?? null;
  }`,
  `  // 第一个 Ready 且拥有有效模型目录的服务自动成为默认。models=[] 的内置
  // Provider 从 pi-ai 同版本目录取首个模型，但不会把继承目录写回 settings.yaml。
  const firstModel = firstProviderModelId(provider);
  if (!defaultProvider?.trim() && firstModel && canAutoDefault) {
    defaultProvider = provider.route;
    defaultModel = firstModel;
  }

  // 显式 models 代表覆盖内置目录：编辑后旧默认不在覆盖集合时回落首个显式模型。
  // models=[] 则继续继承目录，并保留已存 defaultModel；DSH 允许引用目录未广告的 id。
  const active = providers.find((item) => item.route === defaultProvider);
  if (
    active &&
    active.models.length > 0 &&
    !active.models.some((model) => model.id === defaultModel)
  ) {
    defaultModel = active.models[0]?.id ?? null;
  }`,
  "upsert inherited default",
);

replaceOne(
  `  // 删除默认服务时只回退到当前真正 Ready 且有显式模型的服务。
  const next = providers.find(
    (provider) => readyRoutes.has(provider.route) && provider.models.length > 0,
  );
  return {
    ...config,
    providers,
    defaultProvider: next?.route ?? null,
    defaultModel: next?.models[0]?.id ?? null,
  };`,
  `  // 删除默认服务时回退到当前 Ready 且拥有有效模型目录的服务；继承目录与
  // 显式 models 使用同一选择语义。
  const next = providers.find(
    (provider) => readyRoutes.has(provider.route) && firstProviderModelId(provider),
  );
  return {
    ...config,
    providers,
    defaultProvider: next?.route ?? null,
    defaultModel: next ? firstProviderModelId(next) : null,
  };`,
  "delete fallback",
);

replaceOne(
  `  const hasReadyModel = cfg.providers.some(
    (provider) => readyRoutes.has(provider.route) && provider.models.length > 0,
  );`,
  `  const hasReadyModel = cfg.providers.some(
    (provider) => readyRoutes.has(provider.route) && Boolean(firstProviderModelId(provider)),
  );`,
  "ready model availability",
);

replaceOne(
  `  const makeDefault = async (provider: ProviderConfig) => {
    const model = provider.models[0]?.id;
    if (!model || !readyRoutes.has(provider.route)) return;
    await persistDefault(provider.route, model);
  };`,
  `  const makeDefault = async (provider: ProviderConfig) => {
    const model = firstProviderModelId(provider);
    if (!model || !readyRoutes.has(provider.route)) return;
    await persistDefault(provider.route, model);
  };`,
  "make default",
);

replaceOne(
  `                const firstModel = provider.models[0]?.id ?? null;
                const readiness =`,
  `                const firstModel = firstProviderModelId(provider);
                const displayModel = provider.models[0]?.id ?? null;
                const readiness =`,
  "provider row effective first model",
);

replaceOne(
  `                          {firstModel ?? t("Inherits catalog models")}`,
  `                          {displayModel ?? t("Inherits catalog models")}`,
  "provider row display model",
);

replaceOne(
  `  // 候选 = Ready 路由的显式模型，按服务分组；搜索过滤（服务名 + 模型 id）。`,
  `  // 候选 = Ready 路由的有效模型目录：显式 models 优先，空集合则读取同版本 pi-ai\n  // 内置目录；这里只做选择视图，不物化继承模型。`,
  "default menu comment",
);

replaceOne(
  `        models: provider.models.filter(`,
  `        models: providerModelChoices(provider).filter(`,
  "default menu effective models",
);

writeFileSync(path, source);
console.log("✓ Step 4 ModelsView patch applied");
