// 目录测试夹具：与 models.dev 站点同构（providers + canonical models）。
// 测试里平铺的条目默认放进一个目录服务下，因此未命中 route 的服务仍能经协议
// 家族回落看到它们；需要验证「服务自己的模型列表」时用 catalogForProviders 显式
// 声明 provider 记录。

import type {
  ModelCatalogEntry,
  ModelCatalogFile,
  ModelCatalogProvider,
} from "@/shared/types";

export const CATALOG_FETCHED_AT = 1_700_000_000;

export function catalogProviderFixture(
  id: string,
  models: ModelCatalogEntry[],
  family: "openai" | "anthropic" = "openai",
  api: string | null = null,
): ModelCatalogProvider {
  return { id, name: id, family, api: api ?? undefined, models };
}

/** 平铺条目 → 单个目录服务；未命中该服务时按协议家族回落即可见 */
export function catalogFile(
  models: ModelCatalogEntry[],
  family: "openai" | "anthropic" = "openai",
  fetchedAt = CATALOG_FETCHED_AT,
): ModelCatalogFile {
  return {
    fetchedAt,
    providers: models.length > 0 ? [catalogProviderFixture("fixture-catalog", models, family)] : [],
    models: [],
  };
}

/** 自定义 provider 视图：route 命中时候选池只取该服务自己的模型列表 */
export function catalogForProviders(
  providers: ModelCatalogProvider[],
  models: ModelCatalogEntry[] = [],
  fetchedAt = CATALOG_FETCHED_AT,
): ModelCatalogFile {
  return { fetchedAt, providers, models };
}

/** canonical 模型页夹具（provider-agnostic 模型） */
export function canonicalEntry(id: string, overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return { id, name: id, context: null, ...overrides };
}
