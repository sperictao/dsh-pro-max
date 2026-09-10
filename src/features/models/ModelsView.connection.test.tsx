import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { ModelCatalogFile, ModelConfig, ProviderConfig } from "@/shared/types";
import { MODEL_PRESETS } from "./shared";
import { ModelsView } from "./ModelsView";

const preset = MODEL_PRESETS.find((item) => item.id === "openai")!;
const provider: ProviderConfig = {
  route: "openai",
  displayName: "OpenAI",
  baseURL: null,
  api: null,
  apiKeyEnv: "OPENAI_API_KEY",
  models: [],
  headers: { "X-Title": "dsh-pro-max" },
  timeoutMs: null,
  reasoning: null,
  extra: null,
};
const config: ModelConfig = {
  defaultProvider: "openai",
  defaultModel: preset.modelIds[0]!,
  defaultReasoningEffort: null,
  providers: [provider],
};
const catalog: ModelCatalogFile = { fetchedAt: Math.floor(Date.now() / 1000), entries: [] };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [], modelConfigBusy: false });
  vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(structuredClone(config));
  vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(catalog);
  vi.spyOn(cmd, "modelCatalogRefresh").mockResolvedValue(catalog);
  vi.spyOn(cmd, "modelEnvStatus").mockResolvedValue({ OPENAI_API_KEY: true });
  vi.spyOn(cmd, "modelTestConnection").mockResolvedValue(undefined);
  vi.spyOn(cmd, "modelRemoteList").mockResolvedValue([]);
});

describe("ModelsView provider connection test", () => {
  it("tests the inherited inference target without calling model discovery", async () => {
    const user = userEvent.setup();
    render(createElement(ModelsView));

    await user.click(await screen.findByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(cmd.modelTestConnection).toHaveBeenCalledOnce());
    expect(cmd.modelTestConnection).toHaveBeenCalledWith(
      preset.baseUrl,
      preset.api,
      "OPENAI_API_KEY",
      { "X-Title": "dsh-pro-max" },
      preset.modelIds[0],
    );
    expect(cmd.modelRemoteList).not.toHaveBeenCalled();
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe("Connection successful");
  });
});
