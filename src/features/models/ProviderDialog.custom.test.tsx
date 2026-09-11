import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import type { ModelCatalogEntry, ProviderConfig } from "@/shared/types";
import { ProviderDialog } from "./ProviderDialog";

const catalog: ModelCatalogEntry[] = [
  {
    id: "catalog-only-model",
    name: "Catalog Only",
    family: "openai",
    context: 64000,
    maxTokens: 8192,
    input: ["text"],
    reasoning: false,
    reasoningLevels: [],
    capabilities: ["text"],
  },
  {
    id: "acme-chat-pro",
    name: "Acme Chat Pro",
    family: "openai",
    context: 128000,
    maxTokens: 16384,
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
  vi.spyOn(cmd, "modelRemoteList").mockResolvedValue(["acme-chat-pro"]);
  vi.spyOn(cmd, "modelTestConnection").mockResolvedValue(undefined);
});

describe("ProviderDialog Custom endpoint", () => {
  it("focuses the name, derives an editable route, and waits for remote models", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn<(provider: ProviderConfig, originalRoute: string | null) => Promise<void>>()
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
    const service = within(dialog).getByTestId("preset-input");
    await user.click(service);
    await user.click(within(dialog).getByRole("option", { name: /Custom endpoint/ }));

    const displayName = within(dialog).getByLabelText("Display Name");
    await waitFor(() => expect(displayName).toHaveFocus());
    expect(service).toHaveValue("Custom endpoint");

    const models = within(dialog).getByRole("list", { name: "Models from this service" });
    expect(models).toHaveAttribute("data-total-count", "0");
    expect(within(models).queryByRole("checkbox", { name: "catalog-only-model" })).not.toBeInTheDocument();

    await user.type(displayName, "Acme Gateway");
    const route = within(dialog).getByLabelText("Route key");
    expect(route).toHaveValue("acme-gateway");

    // Explicit route edits become authoritative and are not overwritten by later name changes.
    await user.clear(route);
    await user.type(route, "stable-route");
    await user.clear(displayName);
    await user.type(displayName, "Renamed Gateway");
    expect(route).toHaveValue("stable-route");

    const baseURL = within(dialog).getByLabelText("Base URL");
    await user.type(baseURL, "https://gateway.acme.test/v1/chat/completions");
    await user.tab();
    expect(baseURL).toHaveValue("https://gateway.acme.test/v1");

    await waitFor(
      () => expect(within(models).getByRole("checkbox", { name: "acme-chat-pro" })).toBeInTheDocument(),
      { timeout: 2000 },
    );
    expect(within(models).queryByRole("checkbox", { name: "catalog-only-model" })).not.toBeInTheDocument();

    const save = within(dialog).getByRole("button", { name: "Save provider" });
    expect(save).toBeDisabled();
    await user.click(within(models).getByRole("checkbox", { name: "acme-chat-pro" }));
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const [provider, originalRoute] = onSubmit.mock.calls[0];
    expect(originalRoute).toBeNull();
    expect(provider.route).toBe("stable-route");
    expect(provider.displayName).toBe("Renamed Gateway");
    expect(provider.baseURL).toBe("https://gateway.acme.test/v1");
    expect(provider.models.map((model) => model.id)).toEqual(["acme-chat-pro"]);
  });
});
