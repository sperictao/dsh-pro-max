import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { ModelCatalogFile, ModelConfig } from "@/shared/types";
import { ModelsView } from "./ModelsView";

const config: ModelConfig = {
  defaultProvider: "deepseek",
  defaultModel: "deepseek-chat",
  defaultReasoningEffort: null,
  providers: [
    {
      route: "deepseek",
      displayName: "DeepSeek",
      baseURL: "https://api.deepseek.com/v1",
      api: "openai-completions",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: [
        {
          id: "deepseek-chat",
          name: "DeepSeek Chat",
          contextWindow: 65536,
          maxTokens: 8192,
          input: ["text"],
          reasoningEfforts: null,
          extra: null,
        },
      ],
      headers: null,
      timeoutMs: null,
      reasoning: null,
      extra: null,
    },
  ],
};

const catalog: ModelCatalogFile = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 1,
  entries: [
    {
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      family: "openai",
      context: 65536,
      maxTokens: 8192,
      input: ["text"],
      reasoning: false,
      reasoningLevels: [],
      capabilities: ["text"],
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [], modelConfigBusy: false });
  vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(structuredClone(config));
  vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(catalog);
  vi.spyOn(cmd, "modelCatalogRefresh").mockResolvedValue(catalog);
  vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue(null);
  vi.spyOn(cmd, "modelRemoteList").mockResolvedValue(["deepseek-chat"]);
  vi.spyOn(cmd, "modelTestConnection").mockResolvedValue(undefined);
  vi.spyOn(cmd, "modelEnvStatus").mockImplementation(async (names) =>
    Object.fromEntries(names.map((name) => [name, true])),
  );
});

describe("ModelsView provider save recovery", () => {
  it("keeps the draft, retires stale errors after a later edit, and retries without duplicate failure feedback", async () => {
    const save = vi
      .spyOn(cmd, "modelConfigSave")
      .mockRejectedValueOnce("Failed to write settings.yaml")
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();

    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit provider" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit provider" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit provider" });
    const displayName = within(dialog).getByRole("textbox", { name: "Display Name" });
    const saveButton = within(dialog).getByRole("button", { name: "Save provider" });

    await user.clear(displayName);
    await user.type(displayName, "DeepSeek Recovery");
    await user.click(saveButton);

    const submitError = await within(dialog).findByTestId("provider-submit-error");
    expect(submitError).toHaveTextContent("Failed to write settings.yaml");
    expect(displayName).toHaveValue("DeepSeek Recovery");
    expect(saveButton).toBeEnabled();
    expect(
      useAppStore
        .getState()
        .toasts.some((toast) => toast.message.includes("Failed to write settings.yaml")),
    ).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Advanced settings" }));
    const timeout = within(dialog).getByRole("spinbutton", { name: "Request timeout (ms)" });
    await user.type(timeout, "45000");
    expect(within(dialog).queryByTestId("provider-submit-error")).not.toBeInTheDocument();

    await user.click(saveButton);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit provider" })).not.toBeInTheDocument());

    const retried = save.mock.calls[1][0];
    const provider = retried.providers.find((item) => item.route === "deepseek");
    expect(provider).toBeDefined();
    expect(provider?.displayName).toBe("DeepSeek Recovery");
    expect(provider?.timeoutMs).toBe(45000);
    expect(provider?.baseURL).toBe("https://api.deepseek.com/v1");
    expect(provider?.api).toBe("openai-completions");
    expect(provider?.models.map((model) => model.id)).toEqual(["deepseek-chat"]);
    expect(retried.defaultProvider).toBe("deepseek");
    expect(retried.defaultModel).toBe("deepseek-chat");
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
      "Model configuration saved — changes take effect immediately",
    );
  });
});
