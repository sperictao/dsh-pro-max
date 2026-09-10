#!/usr/bin/env node
// 生成模型服务预设表（src/shared/lib/model-presets.generated.ts）。
//
// 单一事实来源 = @earendil-works/pi-ai 内置 provider 目录（devDependency，
// 版本对齐 vendored dsh 所用版本）：路由键命中目录时，dsh 端点/协议/模型目录
// 全部继承，UI 只需填 apiKeyEnv。生成物入库，运行时零开销；
// 升级 pi-ai 版本后重跑 `pnpm gen:model-presets` 再提交。
//
// 本脚本只被手动/CI 显式执行，不进构建链。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// @earendil-works/pi-ai 的 exports 不暴露 package.json：从目录入口模块的
// 解析路径向上定位包根，读版本与内置目录
const allJsUrl = import.meta.resolve("@earendil-works/pi-ai/providers/all");
const allJs = fileURLToPath(allJsUrl);
let pkgDir = dirname(allJs);
while (pkgDir !== "/") {
  try {
    const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8"));
    if (pkg.name === "@earendil-works/pi-ai") break;
  } catch {
    // 还没到包根，继续向上
  }
  pkgDir = dirname(pkgDir);
}
const { version } = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8"));
const { builtinProviders, getBuiltinModels } = await import(pathToFileURL(allJs).href);

// UI 暴露的三种 wire 协议（models.rs API_OPTIONS 同源）；目录路由的协议
// 未落在其中时不预填 api（缺省即继承目录协议，语义正确）
const UI_WIRE_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);

const providers = builtinProviders();
const presets = [];
for (const provider of providers) {
  if (!provider.baseUrl) continue; // bedrock/azure 等特殊认证形态交给"自定义端点"
  const models = getBuiltinModels(provider.id);
  const apis = new Map();
  for (const model of models) {
    if (!model.api) continue;
    apis.set(model.api, (apis.get(model.api) ?? 0) + 1);
  }
  // 多数协议即该服务的默认协议（混协议网关按模型级 api 覆盖）
  const api = [...apis.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  presets.push({
    id: provider.id,
    name: provider.name ?? provider.id,
    baseUrl: provider.baseUrl,
    api: UI_WIRE_APIS.has(api) ? api : null,
    models: models.length,
  });
}
presets.sort((a, b) => a.id.localeCompare(b.id));

const out = `// 本文件由 scripts/generate-model-presets.mjs 生成（@earendil-works/pi-ai@${version}）。
// 单一事实来源是 pi-ai 内置 provider 目录：手改即破，升级后重跑 pnpm gen:model-presets。

export type ModelPreset = {
  /** pi-ai 内置目录的路由键：命中时 dsh 继承目录端点/协议/模型目录 */
  id: string;
  name: string;
  baseUrl: string;
  /** UI 三协议之一；null = 不预填（继承目录协议） */
  api: string | null;
  /** 目录模型数量（选择器副行展示） */
  models: number;
};

export const MODEL_PRESETS: ModelPreset[] = ${JSON.stringify(presets, null, 2)};
`;

const target = resolve(import.meta.dirname, "../src/shared/lib/model-presets.generated.ts");
writeFileSync(target, out);
console.log(`✓ ${presets.length} presets (@earendil-works/pi-ai@${version}) -> ${target}`);
