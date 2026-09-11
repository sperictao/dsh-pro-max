import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue(null);
  vi.spyOn(cmd, "modelRemoteList").mockResolvedValue(["deepseek-chat"]);
  vi.spyOn(cmd, "modelTestConnection").mockResolvedValue(undefined);
});

function renderEdit(onClose = vi.fn(), onSubmit = vi.fn().mockResolvedValue(undefined)) {
  render(
    <ProviderDialog
      state={{ mode: "edit", index: 0, provider }}
      catalog={catalog}
      onClose={onClose}
      onSubmit={onSubmit}
    />,
  );
  return { onClose, onSubmit };
}

describe("ProviderDialog close behavior", () => {
  it("closes pristine edit state immediately from Cancel, Escape, and backdrop", async () => {
    const user = userEvent.setup();

    let result = renderEdit();
    let dialog = screen.getByRole("dialog", { name: "Edit provider" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(result.onClose).toHaveBeenCalledOnce();
    expect(within(dialog).queryByTestId("provider-discard-confirm")).not.toBeInTheDocument();

    result = renderEdit();
    const dialogsAfterSecondRender = screen.getAllByRole("dialog", { name: "Edit provider" });
    dialog = dialogsAfterSecondRender.at(-1)!;
    within(dialog).getByLabelText("Display Name").focus();
    await user.keyboard("{Escape}");
    expect(result.onClose).toHaveBeenCalledOnce();
    expect(within(dialog).queryByTestId("provider-discard-confirm")).not.toBeInTheDocument();

    result = renderEdit();
    const dialogsAfterThirdRender = screen.getAllByRole("dialog", { name: "Edit provider" });
    dialog = dialogsAfterThirdRender.at(-1)!;
    fireEvent.click(dialog);
    expect(result.onClose).toHaveBeenCalledOnce();
    expect(within(dialog).queryByTestId("provider-discard-confirm")).not.toBeInTheDocument();
  });

  it("protects dirty edits and requires an explicit discard", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEdit();
    const dialog = screen.getByRole("dialog", { name: "Edit provider" });
    const displayName = within(dialog).getByLabelText("Display Name");

    await user.clear(displayName);
    await user.type(displayName, "DeepSeek Production");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(onClose).not.toHaveBeenCalled();
    const confirmation = within(dialog).getByTestId("provider-discard-confirm");
    expect(confirmation).toHaveTextContent("You have unsaved changes");
    const keepEditing = within(dialog).getByRole("button", { name: "Cancel" });
    const discard = within(dialog).getByRole("button", { name: "Discard" });
    await waitFor(() => expect(keepEditing).toHaveFocus());

    await user.click(keepEditing);
    expect(within(dialog).queryByTestId("provider-discard-confirm")).not.toBeInTheDocument();
    expect(displayName).toHaveValue("DeepSeek Production");
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(within(dialog).getByTestId("provider-discard-confirm")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(discard).not.toBeInTheDocument();
  });

  it("keeps Escape layered from Advanced settings to discard confirmation to editing", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEdit();
    const dialog = screen.getByRole("dialog", { name: "Edit provider" });
    const displayName = within(dialog).getByLabelText("Display Name");

    await user.clear(displayName);
    await user.type(displayName, "DeepSeek Production");
    await user.click(within(dialog).getByRole("button", { name: "Advanced settings" }));
    expect(within(dialog).getByTestId("provider-advanced")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(within(dialog).queryByTestId("provider-advanced")).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId("provider-discard-confirm")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(within(dialog).getByTestId("provider-discard-confirm")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(within(dialog).queryByTestId("provider-discard-confirm")).not.toBeInTheDocument();
    expect(displayName).toHaveValue("DeepSeek Production");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("protects dirty edits from backdrop clicks", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEdit();
    const dialog = screen.getByRole("dialog", { name: "Edit provider" });

    const displayName = within(dialog).getByLabelText("Display Name");
    await user.clear(displayName);
    await user.type(displayName, "DeepSeek Production");
    fireEvent.click(dialog);

    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByTestId("provider-discard-confirm")).toBeInTheDocument();
  });

  it("does not treat Add search text as work, but protects progress after choosing a service", async () => {
    const user = userEvent.setup();
    const pristineClose = vi.fn();
    const { unmount } = render(
      <ProviderDialog
        state={{ mode: "add" }}
        catalog={catalog}
        onClose={pristineClose}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    let dialog = screen.getByRole("dialog", { name: "Add provider" });
    await user.type(within(dialog).getByTestId("preset-input"), "deepseek");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(pristineClose).toHaveBeenCalledOnce();
    unmount();

    const dirtyClose = vi.fn();
    render(
      <ProviderDialog
        state={{ mode: "add" }}
        catalog={catalog}
        onClose={dirtyClose}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    dialog = screen.getByRole("dialog", { name: "Add provider" });
    const service = within(dialog).getByTestId("preset-input");
    await user.type(service, "deepseek");
    const picker = within(dialog).getByRole("listbox", { name: "Choose a service or custom endpoint" });
    await user.click(within(picker).getByRole("option", { name: /DeepSeek deepseek/i }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(dirtyClose).not.toHaveBeenCalled();
    expect(within(dialog).getByTestId("provider-discard-confirm")).toBeInTheDocument();
  });

  it("restores focus to the control that opened the dialog after a real close", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Edit provider
          </button>
          {open && (
            <ProviderDialog
              state={{ mode: "edit", index: 0, provider }}
              catalog={catalog}
              onClose={() => setOpen(false)}
              onSubmit={vi.fn().mockResolvedValue(undefined)}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Edit provider" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Edit provider" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit provider" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
