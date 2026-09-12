import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import type { ModelCatalogEntry, ProviderConfig } from "@/shared/types";
import { ProviderDialog } from "./ProviderDialog";

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
  ],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
};

const catalog: ModelCatalogEntry[] = [
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

function renderDialog() {
  const onSubmit = vi.fn<(next: ProviderConfig, originalRoute: string | null) => Promise<void>>()
    .mockResolvedValue(undefined);
  render(
    <ProviderDialog
      state={{ mode: "edit", index: 0, provider }}
      catalog={catalog}
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
  vi.spyOn(cmd, "modelRemoteList").mockResolvedValue(["deepseek-chat"]);
});

describe("ProviderDialog Test connection recovery", () => {
  it("clears the failed result after connection repair and retries with the repaired draft", async () => {
    const user = userEvent.setup();
    const test = vi
      .spyOn(cmd, "modelTestConnection")
      .mockRejectedValueOnce(new Error("HTTP 401 Unauthorized: invalid API key"))
      .mockResolvedValueOnce(undefined);
    const { dialog, onSubmit } = renderDialog();

    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText(/HTTP 401 Unauthorized: invalid API key/)).toBeVisible();
    expect(within(dialog).getByTestId("provider-test-result")).toBeVisible();

    const apiKey = within(dialog).getByLabelText("API Key");
    await user.type(apiKey, "sk-deepseek-prod");

    expect(within(dialog).queryByText(/HTTP 401 Unauthorized: invalid API key/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText("Connection successful", { exact: true })).toBeVisible();

    expect(test).toHaveBeenCalledTimes(2);
    expect(test.mock.calls[0]).toEqual([
      "https://api.deepseek.com/v1",
      "openai-completions",
      "DEEPSEEK_API_KEY",
      null,
      "deepseek-chat",
      null,
    ]);
    expect(test.mock.calls[1]).toEqual([
      "https://api.deepseek.com/v1",
      "openai-completions",
      "DEEPSEEK_API_KEY",
      null,
      "deepseek-chat",
      "sk-deepseek-prod",
    ]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not publish an obsolete test result when connection fields change while the request is pending", async () => {
    const user = userEvent.setup();
    let rejectPending: ((reason?: unknown) => void) | null = null;
    const test = vi
      .spyOn(cmd, "modelTestConnection")
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectPending = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const { dialog } = renderDialog();

    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(within(dialog).getByRole("button", { name: "Testing…" })).toBeDisabled();

    const apiKey = within(dialog).getByLabelText("API Key");
    await user.type(apiKey, "sk-deepseek-rotated");

    await act(async () => {
      rejectPending?.(new Error("HTTP 401 Unauthorized: old credential"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Test connection" })).toBeEnabled(),
    );
    expect(within(dialog).queryByText(/HTTP 401 Unauthorized: old credential/)).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId("provider-test-result")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText("Connection successful", { exact: true })).toBeVisible();
    expect(test).toHaveBeenCalledTimes(2);
    expect(test.mock.calls[1]?.[2]).toBe("DEEPSEEK_API_KEY");
    expect(test.mock.calls[1]?.[5]).toBe("sk-deepseek-rotated");
  });
});
