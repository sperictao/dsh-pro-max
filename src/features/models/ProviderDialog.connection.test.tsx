import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import type { ProviderConfig } from "@/shared/types";
import { ProviderDialog } from "./ProviderDialog";

const provider: ProviderConfig = {
  route: "my-gateway",
  displayName: "My Gateway",
  baseURL: "https://gateway.example.com/v1",
  api: "openai-completions",
  apiKeyEnv: "MY_GATEWAY_KEY",
  models: [
    {
      id: "my-model",
      name: null,
      contextWindow: null,
      maxTokens: null,
      input: null,
      reasoningEfforts: null,
      extra: null,
    },
  ],
  headers: { "X-Tenant": "desktop" },
  timeoutMs: null,
  reasoning: null,
  extra: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(cmd, "modelTestConnection").mockResolvedValue(undefined);
  vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue(null);
});

describe("ProviderDialog connection test", () => {
  it("tests the draft inference configuration and renders the result inline", async () => {
    const user = userEvent.setup();
    render(
      <ProviderDialog
        state={{ mode: "edit", index: 0, provider }}
        catalog={[]}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(cmd.modelTestConnection).toHaveBeenCalledOnce());
    expect(cmd.modelTestConnection).toHaveBeenCalledWith(
      "https://gateway.example.com/v1",
      "openai-completions",
      "MY_GATEWAY_KEY",
      { "X-Tenant": "desktop" },
      "my-model",
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Connection successful");
  });

  it("does not send an unauthenticated launcher test for a built-in provider using dsh/pi-ai auth", () => {
    render(
      <ProviderDialog
        state={{
          mode: "edit",
          index: 0,
          provider: {
            ...provider,
            route: "openai",
            displayName: "OpenAI",
            baseURL: "https://api.openai.com/v1",
            api: "openai-responses",
            apiKeyEnv: null,
          },
        }}
        catalog={[]}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
    expect(cmd.modelTestConnection).not.toHaveBeenCalled();
    expect(screen.getByTestId("catalog-route-hint")).toHaveTextContent("Inherits the built-in catalog");
  });

});
