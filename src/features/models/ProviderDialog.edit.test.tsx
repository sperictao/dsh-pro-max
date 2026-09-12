import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import type { ModelCatalogEntry, ProviderConfig } from "@/shared/types";
import { ProviderDialog } from "./ProviderDialog";
import type { CredentialWrite } from "./credentials";

const provider: ProviderConfig = {
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
    {
      id: "deepseek-reasoner",
      name: "DeepSeek Reasoner",
      contextWindow: 65536,
      maxTokens: 8192,
      input: ["text"],
      reasoningEfforts: { low: "low", medium: "medium", high: "high" },
      extra: null,
    },
  ],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
};

const catalog: ModelCatalogEntry[] = provider.models.map((model) => ({
  id: model.id,
  name: model.name ?? model.id,
  family: "openai",
  context: model.contextWindow ?? null,
  maxTokens: model.maxTokens ?? undefined,
  input: model.input ?? ["text"],
  reasoning: Boolean(model.reasoningEfforts),
  reasoningLevels: model.reasoningEfforts ? Object.keys(model.reasoningEfforts) : [],
  capabilities: model.reasoningEfforts ? ["text", "reasoning"] : ["text"],
}));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue(null);
  vi.spyOn(cmd, "modelRemoteList").mockResolvedValue(["deepseek-chat", "deepseek-reasoner"]);
  vi.spyOn(cmd, "modelTestConnection").mockResolvedValue(undefined);
});

describe("ProviderDialog Edit provider", () => {
  it("keeps an existing credential reference when edit saves with a blank write-only key", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ProviderDialog
        state={{ mode: "edit", index: 0, provider }}
        catalog={catalog}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Edit provider" });
    expect(within(dialog).getByLabelText("API Key")).toHaveValue("");
    const displayName = within(dialog).getByRole("textbox", { name: "Display Name" });
    await user.clear(displayName);
    await user.type(displayName, "DeepSeek Production");
    await user.click(within(dialog).getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const [saved, originalRoute, credential] = onSubmit.mock.calls[0];
    expect(originalRoute).toBe("deepseek");
    expect(saved.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(credential).toBeNull();
  });

  it("keeps the primary path focused and only enables save for real changes", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn<
        (
          next: ProviderConfig,
          originalRoute: string | null,
          credential: CredentialWrite | null,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);

    render(
      <ProviderDialog
        state={{ mode: "edit", index: 1, provider }}
        catalog={catalog}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Edit provider" });
    const save = within(dialog).getByRole("button", { name: "Save provider" });
    expect(save).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Test connection" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Advanced settings" })).toBeInTheDocument();
    expect(within(dialog).queryByTestId("catalog-route-hint")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/deepseek · api\.deepseek\.com · openai-completions/i)).not.toBeInTheDocument();

    const displayName = within(dialog).getByRole("textbox", { name: "Display Name" });
    const apiKey = within(dialog).getByLabelText("API Key");

    await user.clear(displayName);
    await user.type(displayName, "DeepSeek Production");
    expect(save).toBeEnabled();

    await user.clear(displayName);
    await user.type(displayName, "DeepSeek");
    expect(save).toBeDisabled();

    expect(apiKey).toHaveValue("");
    await user.type(apiKey, "sk-deepseek-prod");
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const [saved, originalRoute, credential] = onSubmit.mock.calls[0];
    expect(originalRoute).toBe("deepseek");
    expect(saved.route).toBe("deepseek");
    expect(saved.displayName).toBe("DeepSeek");
    expect(saved.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(credential).toEqual({ ref: "DEEPSEEK_API_KEY", value: "sk-deepseek-prod" });
    expect(saved.baseURL).toBe("https://api.deepseek.com/v1");
    expect(saved.api).toBe("openai-completions");
    expect(saved.models.map((model) => model.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });
});