import { render, screen, within } from "@testing-library/react";
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
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
};

function renderDialog() {
  const onSubmit = vi.fn<(next: ProviderConfig, originalRoute: string | null) => Promise<void>>()
    .mockResolvedValue(undefined);
  render(
    <ProviderDialog
      state={{ mode: "edit", index: 0, provider }}
      catalog={[]}
      onClose={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
  return { dialog: screen.getByRole("dialog", { name: "Edit provider" }), onSubmit };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue(null);
  vi.spyOn(cmd, "modelRemoteList").mockResolvedValue(["my-model"]);
  vi.spyOn(cmd, "modelTestConnection").mockResolvedValue(undefined);
});

describe("ProviderDialog Base URL validation recovery", () => {
  it("preserves invalid input on blur and keeps Test/Save blocked with an associated error", async () => {
    const user = userEvent.setup();
    const { dialog, onSubmit } = renderDialog();
    const baseURL = within(dialog).getByRole("textbox", { name: "Base URL" });

    await user.clear(baseURL);
    await user.type(baseURL, "gateway.example.com/v1/chat/completions");
    await user.tab();

    const error = within(dialog).getByRole("alert");
    expect(error).toHaveTextContent("Enter a valid http:// or https:// URL.");
    expect(baseURL).toHaveValue("gateway.example.com/v1/chat/completions");
    expect(baseURL).toHaveAttribute("aria-invalid", "true");
    expect(baseURL).toHaveAttribute("aria-describedby", error.id);
    expect(within(dialog).getByRole("button", { name: "Test connection" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Save provider" })).toBeDisabled();
    expect(cmd.modelTestConnection).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps a surfaced error through an invalid repair and clears it only when the URL becomes valid", async () => {
    const user = userEvent.setup();
    const { dialog, onSubmit } = renderDialog();
    const baseURL = within(dialog).getByRole("textbox", { name: "Base URL" });

    await user.clear(baseURL);
    await user.type(baseURL, "gateway.example.com/v1/chat/completions");
    await user.tab();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a valid http:// or https:// URL.");

    await user.clear(baseURL);
    await user.type(baseURL, "ftp://gateway.example.com/v1/chat/completions");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a valid http:// or https:// URL.");
    expect(baseURL).toHaveAttribute("aria-invalid", "true");

    await user.clear(baseURL);
    await user.type(baseURL, "https://gateway.example.com/v1/chat/completions");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(baseURL).toHaveAttribute("aria-invalid", "false");
    expect(within(dialog).getByRole("button", { name: "Test connection" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Save provider" })).toBeEnabled();

    await user.tab();
    expect(baseURL).toHaveValue("https://gateway.example.com/v1");

    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText("Connection successful", { exact: true })).toBeVisible();
    expect(cmd.modelTestConnection).toHaveBeenCalledWith(
      "https://gateway.example.com/v1",
      "openai-completions",
      "MY_GATEWAY_KEY",
      null,
      "my-model",
    );

    await user.click(within(dialog).getByRole("button", { name: "Save provider" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]?.[0].baseURL).toBe("https://gateway.example.com/v1");
  });
});
