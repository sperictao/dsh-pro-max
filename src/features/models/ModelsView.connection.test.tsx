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
const deepseekPreset = MODEL_PRESETS.find((item) => item.id === "deepseek")!;
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
const deepseekProvider: ProviderConfig = {
  route: "deepseek",
  displayName: "DeepSeek",
  baseURL: null,
  api: null,
  apiKeyEnv: "DEEPSEEK_API_KEY",
  models: [],
  headers: null,
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
  vi.spyOn(cmd, "modelEnvStatus").mockResolvedValue({
    OPENAI_API_KEY: true,
    DEEPSEEK_API_KEY: true,
  });
  vi.spyOn(cmd, "modelTestConnection").mockResolvedValue(undefined);
  vi.spyOn(cmd, "modelRemoteList").mockResolvedValue([]);
});

describe("ModelsView provider connection test", () => {
  it("tests the inherited inference target without discovery or navigation", async () => {
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
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe("OpenAI · Connection successful");
  });

  it("keeps one card test active at a time and restores both rows after success", async () => {
    const user = userEvent.setup();
    vi.mocked(cmd.modelConfigLoad).mockResolvedValue(
      structuredClone({ ...config, providers: [provider, deepseekProvider] }),
    );
    let resolveTest!: () => void;
    vi.mocked(cmd.modelTestConnection).mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveTest = resolve; }),
    );

    render(createElement(ModelsView));
    const buttons = await screen.findAllByRole("button", { name: "Test connection" });
    expect(buttons).toHaveLength(2);

    await user.click(buttons[0]!);
    const testingButton = await screen.findByRole("button", { name: "Testing…" });
    const openaiRow = document.querySelector('[data-route="openai"]');
    expect(openaiRow).toHaveAttribute("aria-busy", "true");
    expect(testingButton).toBeDisabled();
    await waitFor(() => expect(buttons[1]).toBeDisabled());

    await user.click(buttons[1]!);
    expect(cmd.modelTestConnection).toHaveBeenCalledTimes(1);

    resolveTest();
    await waitFor(() => {
      expect(document.querySelector('[data-route="openai"]')).toHaveAttribute("aria-busy", "false");
      for (const button of screen.getAllByRole("button", { name: "Test connection" })) {
        expect(button).toBeEnabled();
      }
    });
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe("OpenAI · Connection successful");
    expect(deepseekPreset.modelIds.length).toBeGreaterThan(0);
  });

  it("restores the card after a failed test and identifies the provider in feedback", async () => {
    const user = userEvent.setup();
    vi.mocked(cmd.modelTestConnection).mockRejectedValueOnce(new Error("401 Unauthorized"));
    render(createElement(ModelsView));

    await user.click(await screen.findByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled());
    expect(document.querySelector('[data-route="openai"]')).toHaveAttribute("aria-busy", "false");
    const feedback = useAppStore.getState().toasts.at(-1);
    expect(feedback?.type).toBe("error");
    expect(feedback?.message).toContain("OpenAI");
    expect(feedback?.message).toContain("401 Unauthorized");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
