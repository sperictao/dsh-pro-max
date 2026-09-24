import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { useAppStore } from "@/shared/store";
import type { DshSurface, LauncherConfig } from "@/shared/types";
import { DshSurfaceSection } from "./DshSurfaceSection";

const saved: LauncherConfig = {
  minimize_to_tray_on_close: false,
  language: "en",
  managed_surfaces: ["web"],
  dsh_admin_cap_domain: "",
  dsh_use_cap_domain: "",
  dsh_extra_allowed_logins: "",
  market_catalog_url: "",
};

const web = () => screen.getByRole("checkbox", { name: "Manage dsh web" });
const desktop = () => screen.getByRole("checkbox", { name: "Manage the DeepSeek Harness desktop app" });

function mount(surfaces: DshSurface[]) {
  const config = { ...saved, managed_surfaces: surfaces };
  useAppStore.setState({ config, persistedConfig: config });
  render(createElement(DshSurfaceSection));
}

describe("DshSurfaceSection", () => {
  it("greys out the last enabled surface so zero can never be selected", async () => {
    const user = userEvent.setup();
    mount(["web"]);

    expect(web()).toBeChecked();
    expect(web()).toBeDisabled();
    expect(desktop()).not.toBeChecked();
    expect(desktop()).toBeEnabled();

    await user.click(desktop());
    expect(web()).toBeEnabled();
    expect(desktop()).toBeChecked();

    await user.click(web());
    expect(useAppStore.getState().config?.managed_surfaces).toEqual(["desktop"]);
    expect(web()).not.toBeChecked();
    expect(desktop()).toBeDisabled();
  });

  it("leaves both surfaces enabled when both are managed", async () => {
    const user = userEvent.setup();
    mount(["web", "desktop"]);

    expect(web()).toBeEnabled();
    expect(desktop()).toBeEnabled();

    await user.click(web());
    expect(useAppStore.getState().config?.managed_surfaces).toEqual(["desktop"]);
  });

  it("shows web only before the config has loaded", () => {
    useAppStore.setState({ config: null, persistedConfig: null });
    render(createElement(DshSurfaceSection));

    expect(web()).toBeChecked();
    expect(desktop()).not.toBeChecked();
  });
});
