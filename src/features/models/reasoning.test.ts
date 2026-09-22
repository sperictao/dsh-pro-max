import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry, ModelEntry, ProviderConfig } from "@/shared/types";
import { EFFORT_OPTIONS, modelReasoningCapability } from "./shared";

const entry = (id: string, reasoningEfforts: ModelEntry["reasoningEfforts"] = null): ModelEntry => ({
  id,
  name: null,
  contextWindow: null,
  maxTokens: null,
  input: null,
  reasoningEfforts,
  extra: null,
});

const provider = (models: ModelEntry[]): ProviderConfig => ({
  route: "custom",
  displayName: "Custom",
  baseURL: "https://example.com/v1",
  api: "openai-responses",
  apiKeyEnv: null,
  models,
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
});

const catalog: ModelCatalogEntry[] = [
  {
    id: "published-reasoning",
    name: "Published reasoning",
    context: 128000,
    reasoning: true,
    reasoningLevels: ["low", "high"],
    capabilities: ["text", "reasoning"],
  },
  {
    id: "published-plain",
    name: "Published plain",
    context: 128000,
    reasoning: false,
    reasoningLevels: [],
    capabilities: ["text"],
  },
];

/** 目录查询结果：调用方（ModelsView）经 catalogEntryFor 解析后只把这一条交给能力判定 */
const published = (id: string) => catalog.find((entry) => entry.id === id) ?? null;

describe("modelReasoningCapability", () => {
  it("prefers an explicit model reasoningEfforts map over catalog metadata", () => {
    expect(
      modelReasoningCapability(
        provider([entry("published-reasoning", { off: null, max: "max" })]),
        "published-reasoning",
        published("published-reasoning"),
      ),
    ).toEqual({ kind: "supported", levels: ["off", "max"] });
  });

  it("treats an explicit boolean reasoning declaration as disabled", () => {
    expect(
      modelReasoningCapability(
        provider([entry("published-reasoning", false)]),
        "published-reasoning",
        published("published-reasoning"),
      ),
    ).toEqual({ kind: "unsupported", levels: [] });
  });

  it("inherits published reasoning levels and respects an explicit non-reasoning catalog record", () => {
    expect(
      modelReasoningCapability(
        provider([entry("published-reasoning")]),
        "published-reasoning",
        published("published-reasoning"),
      ),
    ).toEqual({ kind: "supported", levels: ["low", "high"] });
    expect(
      modelReasoningCapability(
        provider([entry("published-plain")]),
        "published-plain",
        published("published-plain"),
      ),
    ).toEqual({ kind: "unsupported", levels: [] });
  });

  it("fails closed for an explicit custom model without metadata but keeps inherited catalog models unknown", () => {
    expect(
      modelReasoningCapability(
        provider([entry("private-model")]),
        "private-model",
        published("private-model"),
      ),
    ).toEqual({
      kind: "unsupported",
      levels: [],
    });
    expect(
      modelReasoningCapability(
        provider([]),
        "builtin-only-model",
        published("builtin-only-model"),
      ),
    ).toEqual({
      kind: "unknown",
      levels: [...EFFORT_OPTIONS],
    });
  });
});
