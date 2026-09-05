import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/shared/store";
import type { LauncherConfig } from "@/shared/types";
import { GeneralSection } from "./GeneralSection";

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
    config: { ...saved },
    persistedConfig: { ...saved },
    toasts: [],
  });
});

describe("GeneralSection", () => {
  it("writes toggle changes into the global draft without touching the persisted snapshot", async () => {
    const user = userEvent.setup();
    render(createElement(GeneralSection));

    await user.click(screen.getByRole("checkbox", { name: "Minimize to tray when closing window" }));
    expect(useAppStore.getState().config?.minimize_to_tray_on_close).toBe(true);
    expect(useAppStore.getState().persistedConfig?.minimize_to_tray_on_close).toBe(false);
  });

  it("shows an inline error for a non-http(s) catalog URL and clears it once valid", async () => {
    const user = userEvent.setup();
    render(createElement(GeneralSection));

    const url = screen.getByPlaceholderText("https://mirror.example.com/catalog.json");
    await user.type(url, "ftp://mirror.example.com");
    expect(screen.getByText("Must start with https:// or http://")).toBeInTheDocument();

    await user.clear(url);
    await user.type(url, "https://mirror.example.com/catalog.json");
    expect(screen.queryByText("Must start with https:// or http://")).not.toBeInTheDocument();
  });
});
