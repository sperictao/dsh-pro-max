import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { ModelCatalogFile, ModelConfig, ProviderConfig } from "@/shared/types";
import { MODEL_PRESETS } from "./shared";
import { ModelsView } from "./ModelsView";

const openaiPreset = MODEL_PRESETS.find((preset) => preset.id === "openai")!;
const firstInheritedModel = openaiPreset.modelIds[0]!;
const secondInheritedModel = openaiPreset.modelIds[1] ?? firstInheritedModel;

const openaiProvider: ProviderConfig = {
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
};

const catalog: ModelCatalogFile = {
  fetchedAt: Math.floor(Date.now() / 1000),
  entries: [],
};

function loadWith(value: ModelConfig) {
  return vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(structuredClone(value));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [], modelConfigBusy: false });
  vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(catalog);
  vi.spyOn(cmd, "modelCatalogRefresh").mockResolvedValue(catalog);
  vi.spyOn(cmd, "modelEnvStatus").mockResolvedValue({ OPENAI_API_KEY: true });
  vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
});

describe("ModelsView inherited catalog defaults", () => {
  it("selects an inherited built-in model as default without materializing provider.models", async () => {
    loadWith({
      defaultProvider: null,
      defaultModel: null,
      defaultReasoningEffort: null,
      providers: [openaiProvider],
    });
    const user = userEvent.setup();
    render(createElement(ModelsView));

    const change = await screen.findByRole("button", { name: "Change" });
    expect(change).toBeEnabled();
    await user.click(change);

    const listbox = await screen.findByRole("listbox", { name: "Default model" });
    expect(within(listbox).getByText("OpenAI")).toBeInTheDocument();
    const option = within(listbox).getByRole("option", {
      name: `OpenAI · ${firstInheritedModel}`,
    });
    await user.click(option);

    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());
    const saved = vi.mocked(cmd.modelConfigSave).mock.calls[0][0];
    expect(saved.defaultProvider).toBe("openai");
    expect(saved.defaultModel).toBe(firstInheritedModel);
    expect(saved.providers[0].models).toEqual([]);
  });

  it("preserves an inherited current default when the provider remains in inherit mode", async () => {
    loadWith({
      defaultProvider: "openai",
      defaultModel: secondInheritedModel,
      defaultReasoningEffort: null,
      providers: [openaiProvider],
    });
    const user = userEvent.setup();
    render(createElement(ModelsView));

    await user.click(await screen.findByRole("button", { name: "Edit provider" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());
    const saved = vi.mocked(cmd.modelConfigSave).mock.calls[0][0];
    expect(saved.defaultProvider).toBe("openai");
    expect(saved.defaultModel).toBe(secondInheritedModel);
    expect(saved.providers[0].models).toEqual([]);
  });
});
