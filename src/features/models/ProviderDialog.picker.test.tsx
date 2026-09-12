import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { ProviderDialog } from "./ProviderDialog";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue(null);
  vi.spyOn(cmd, "modelRemoteList").mockResolvedValue([]);
  vi.spyOn(cmd, "modelTestConnection").mockResolvedValue(undefined);
});

function renderDialog(onClose = vi.fn()) {
  render(
    <ProviderDialog
      state={{ mode: "add" }}
      catalog={[]}
      onClose={onClose}
      onSubmit={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  return {
    dialog: screen.getByRole("dialog", { name: "Add provider" }),
    onClose,
  };
}

describe("ProviderDialog service picker", () => {
  it("does not turn an unhighlighted filtered query into Custom on Enter", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog();
    const service = within(dialog).getByRole("combobox", { name: "Service" });

    await user.type(service, "deepseek");
    const listbox = within(dialog).getByRole("listbox", {
      name: "Choose a service or custom endpoint",
    });
    const custom = within(listbox).getByRole("option", { name: /Custom endpoint/i });
    const deepseek = within(listbox).getByRole("option", { name: /DeepSeek deepseek/i });

    expect(custom).toHaveAttribute("aria-selected", "false");
    expect(deepseek).toHaveAttribute("aria-selected", "false");
    expect(service).not.toHaveAttribute("aria-activedescendant");

    await user.keyboard("{Enter}");
    expect(service).toHaveValue("deepseek");
    expect(within(dialog).queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{ArrowDown}");
    expect(deepseek).toHaveAttribute("aria-selected", "true");
    expect(service).toHaveAttribute("aria-activedescendant", "provider-preset-deepseek");

    await user.keyboard("{Enter}");
    expect(service).toHaveValue("DeepSeek");
    const apiKey = within(dialog).getByLabelText("API Key");
    await waitFor(() => expect(apiKey).toHaveFocus());
  });

  it("closes only the open picker on Escape and keeps the dialog open", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { dialog } = renderDialog(onClose);
    const service = within(dialog).getByRole("combobox", { name: "Service" });

    await user.click(service);
    expect(service).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(service).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).queryByRole("listbox")).not.toBeInTheDocument();
    expect(service).toHaveFocus();
    expect(dialog).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps Custom endpoint keyboard-reachable without treating it as selected by default", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog();
    const service = within(dialog).getByRole("combobox", { name: "Service" });

    await user.click(service);
    const listbox = within(dialog).getByRole("listbox");
    const custom = within(listbox).getByRole("option", { name: /Custom endpoint/i });
    expect(custom).toHaveAttribute("aria-selected", "false");

    await user.keyboard("{ArrowUp}");
    expect(custom).toHaveAttribute("aria-selected", "true");
    expect(service).toHaveAttribute("aria-activedescendant", "provider-preset-custom");

    await user.keyboard("{Enter}");
    expect(service).toHaveValue("Custom endpoint");
    const displayName = within(dialog).getByLabelText("Display Name");
    await waitFor(() => expect(displayName).toHaveFocus());
  });
});
