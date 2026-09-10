import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@/shared/types";
import { firstProviderModelId, MODEL_PRESETS, providerModelChoices } from "./shared";

function provider(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    route: "openai",
    displayName: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    api: "openai-responses",
    apiKeyEnv: "OPENAI_API_KEY",
    models: [],
    headers: null,
    timeoutMs: null,
    reasoning: null,
    extra: null,
    ...overrides,
  };
}

describe("inherited provider model choices", () => {
  it("projects the pinned pi-ai catalog when an installed provider keeps models empty", () => {
    const preset = MODEL_PRESETS.find((item) => item.id === "openai");
    expect(preset).toBeDefined();
    expect(preset!.modelIds.length).toBe(preset!.models);

    const choices = providerModelChoices(provider({}));
    expect(choices.map((choice) => choice.id)).toEqual(preset!.modelIds);
    expect(choices.every((choice) => choice.inherited)).toBe(true);
    expect(firstProviderModelId(provider({}))).toBe(preset!.modelIds[0]);
  });

  it("treats explicit models as a replacement instead of mixing in inherited models", () => {
    const explicit = provider({
      models: [
        {
          id: "my-openai-compatible-model",
          name: null,
          contextWindow: 123456,
          maxTokens: null,
          input: null,
          reasoningEfforts: null,
          extra: null,
        },
      ],
    });

    expect(providerModelChoices(explicit)).toEqual([
      { id: "my-openai-compatible-model", contextWindow: 123456, inherited: false },
    ]);
    expect(firstProviderModelId(explicit)).toBe("my-openai-compatible-model");
  });

  it("does not invent inherited models for an unknown custom route", () => {
    expect(providerModelChoices(provider({ route: "my-local-gateway" }))).toEqual([]);
    expect(firstProviderModelId(provider({ route: "my-local-gateway" }))).toBeNull();
  });
});
