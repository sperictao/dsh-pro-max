// models.dev 目录查询：站点同构快照（providers + canonical models）下的
// 服务匹配、条目解析与候选池回落规则。

import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry, ModelCatalogFile, ProviderConfig } from "@/shared/types";
import { catalogCandidates, catalogEntryFor, catalogIndex, catalogProviderFor } from "./shared";

const provider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  route: "acme",
  displayName: "Acme",
  baseURL: "https://acme.example/v1",
  api: "openai-completions",
  apiKeyEnv: null,
  models: [],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
  ...overrides,
});

const entry = (id: string, context: number | null = null): ModelCatalogEntry => ({
  id,
  name: id,
  context,
});

const catalog: ModelCatalogFile = {
  fetchedAt: 1,
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      family: "anthropic",
      api: "https://api.anthropic.com",
      models: [entry("claude-opus-4", 200000)],
    },
    {
      id: "gateway",
      name: "Gateway",
      family: "openai",
      models: [entry("claude-opus-4", 1000000), entry("gpt-x", 128000)],
    },
    {
      id: "shared-host-a",
      name: "Shared A",
      family: "openai",
      api: "https://gw.example.com/a",
      models: [entry("a-model")],
    },
    {
      id: "shared-host-b",
      name: "Shared B",
      family: "openai",
      api: "https://gw.example.com/b",
      models: [entry("b-model")],
    },
  ],
  models: [entry("claude-opus-4", 999), entry("canonical-only", 555)],
};

describe("catalogProviderFor", () => {
  it("matches the service route against the models.dev provider key first", () => {
    expect(catalogProviderFor(catalog, provider({ route: "anthropic" }))?.id).toBe("anthropic");
  });

  it("falls back to the endpoint URL, then to a unique host", () => {
    expect(
      catalogProviderFor(catalog, provider({ route: "unknown", baseURL: "https://api.anthropic.com/" }))?.id,
    ).toBe("anthropic");
    expect(
      catalogProviderFor(catalog, provider({ route: "unknown", baseURL: "https://api.anthropic.com/other" }))?.id,
    ).toBe("anthropic");
  });

  it("does not guess when one host serves several catalog providers", () => {
    expect(
      catalogProviderFor(catalog, provider({ route: "unknown", baseURL: "https://gw.example.com/x" })),
    ).toBeNull();
  });

  it("returns null without a catalog", () => {
    expect(catalogProviderFor(null, provider())).toBeNull();
  });
});

describe("catalogEntryFor", () => {
  it("prefers the matched service own record over the canonical model", () => {
    expect(catalogEntryFor(catalog, provider({ route: "anthropic" }), "claude-opus-4")?.context).toBe(200000);
    expect(catalogEntryFor(catalog, provider({ route: "gateway" }), "claude-opus-4")?.context).toBe(1000000);
  });

  it("falls back to the canonical model when the matched service has no such id", () => {
    expect(catalogEntryFor(catalog, provider({ route: "gateway" }), "canonical-only")?.context).toBe(555);
  });

  it("returns null for ids the catalog does not publish", () => {
    expect(catalogEntryFor(catalog, provider({ route: "gateway" }), "nope")).toBeNull();
    expect(catalogEntryFor(null, provider(), "claude-opus-4")).toBeNull();
  });
});

describe("catalogCandidates", () => {
  it("returns the matched service own model list", () => {
    expect(catalogCandidates(catalog, provider({ route: "anthropic" })).map((e) => e.id)).toEqual([
      "claude-opus-4",
    ]);
  });

  it("falls back to the same protocol family when the service is not in the catalog", () => {
    expect(
      catalogCandidates(
        catalog,
        provider({ baseURL: "https://nope.example/v1", api: "anthropic-messages" }),
      ).map((e) => e.id),
    ).toEqual(["claude-opus-4"]);
  });

  it("keeps one entry per id in the family fallback", () => {
    expect(
      catalogCandidates(catalog, provider({ baseURL: "https://gw.example.com/x" })).map((e) => e.id),
    ).toEqual(["claude-opus-4", "gpt-x", "a-model", "b-model"]);
  });

  it("returns an empty pool without a catalog", () => {
    expect(catalogCandidates(null, provider())).toEqual([]);
  });
});

describe("catalogIndex", () => {
  it("lets the matched service records override canonical entries", () => {
    const index = catalogIndex(catalog, provider({ route: "gateway" }));
    expect(index.get("claude-opus-4")?.context).toBe(1000000);
    expect(index.get("canonical-only")?.context).toBe(555);
  });
});
