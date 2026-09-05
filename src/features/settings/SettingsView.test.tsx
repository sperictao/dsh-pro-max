import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { LauncherConfig } from "@/shared/types";
import { SettingsView } from "./SettingsView";

const saved: LauncherConfig = {
  minimize_to_tray_on_close: false,
  language: "en",
  dsh_admin_cap_domain: "",
  dsh_use_cap_domain: "",
  dsh_extra_allowed_logins: "",
  market_catalog_url: "",
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({
    activeView: "settings",
    settingsSection: "general",
    config: { ...saved },
    persistedConfig: { ...saved },
    toasts: [],
  });
  vi.spyOn(cmd, "updateSettings").mockResolvedValue();
});

describe("SettingsView global save bar", () => {
  it("hides the save bar while clean, shows it on change, and Discard reverts the draft", async () => {
    const user = userEvent.setup();
    render(createElement(SettingsView));

    expect(screen.queryByRole("button", { name: "Save Settings" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Minimize to tray when closing window" }));
    expect(screen.getByRole("button", { name: "Save Settings" })).toBeInTheDocument();
    expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("button", { name: "Save Settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Minimize to tray when closing window" })).not.toBeChecked();
    expect(useAppStore.getState().config?.minimize_to_tray_on_close).toBe(false);
  });

  it("keeps the save bar visible on other sections while the draft is dirty", async () => {
    const user = userEvent.setup();
    render(createElement(SettingsView));

    await user.click(screen.getByRole("checkbox", { name: "Minimize to tray when closing window" }));
    await user.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByRole("button", { name: "Save Settings" })).toBeInTheDocument();
  });

  it("saves the draft and clears the bar", async () => {
    const user = userEvent.setup();
    render(createElement(SettingsView));

    await user.click(screen.getByRole("checkbox", { name: "Minimize to tray when closing window" }));
    await user.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() =>
      expect(cmd.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ minimize_to_tray_on_close: true })),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save Settings" })).not.toBeInTheDocument(),
    );
  });

  it("blocks save while the catalog URL is invalid and releases it once valid", async () => {
    const user = userEvent.setup();
    render(createElement(SettingsView));

    const url = screen.getByPlaceholderText("https://mirror.example.com/catalog.json");
    await user.type(url, "ftp://mirror.example.com");
    expect(screen.getByRole("button", { name: "Save Settings" })).toBeDisabled();

    await user.clear(url);
    await user.type(url, "https://mirror.example.com/catalog.json");
    expect(screen.getByRole("button", { name: "Save Settings" })).toBeEnabled();
  });
});
