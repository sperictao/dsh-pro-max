import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import type { ModelCatalogEntry, ProviderConfig } from "@/shared/types";
import { ProviderDialog } from "./ProviderDialog";

const catalog: ModelCatalogEntry[] = [
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    family: "openai",
    context: 131072,
    maxTokens: 16384,
    input: ["text"],
    reasoning: false,
    reasoningLevels: [],
    capabilities: ["text"],
  },
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
];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue(null);
  vi.spyOn(cmd, "modelRemoteList").mockResolvedValue(["deepseek-v4-pro", "deepseek-chat"]);
  vi.spyOn(cmd, "modelTestConnection").mockResolvedValue(undefined);
});

describe("ProviderDialog Add provider", () => {
  it("keeps the chosen service visible, hands off focus, and requires a model before save", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(provider: ProviderConfig, originalRoute: string | null) => Promise<void>>()
      .mockResolvedValue(undefined);

    render(
      <ProviderDialog
        state={{ mode: "add" }}
        catalog={catalog}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Add provider" });
    const save = within(dialog).getByRole("button", { name: "Save provider" });
    expect(save).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Test connection" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Close" })).not.toBeInTheDocument();

    const service = within(dialog).getByTestId("preset-input");
    await user.type(service, "deepseek");
    const picker = within(dialog).getByRole("listbox", {
      name: "Choose a service or custom endpoint",
    });
    await user.click(within(picker).getByRole("option", { name: /DeepSeek deepseek/i }));

    expect(service).toHaveValue("DeepSeek");
    const apiKey = within(dialog).getByLabelText("API Key Env Var");
    await waitFor(() => expect(apiKey).toHaveFocus());
    expect(within(dialog).queryByLabelText("Display Name")).not.toBeInTheDocument();
    expect(save).toBeDisabled();

    await user.type(apiKey, "DEEPSEEK_API_KEY");
    expect(save).toBeDisabled();

    const models = within(dialog).getByRole("list", { name: "Models from this service" });
    await user.click(within(models).getByRole("checkbox", { name: "deepseek-v4-pro" }));
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const [provider, originalRoute] = onSubmit.mock.calls[0];
    expect(originalRoute).toBeNull();
    expect(provider.route).toBe("deepseek");
    expect(provider.displayName).toBe("DeepSeek");
    expect(provider.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(provider.models.map((model) => model.id)).toEqual(["deepseek-v4-pro"]);
  });
});
