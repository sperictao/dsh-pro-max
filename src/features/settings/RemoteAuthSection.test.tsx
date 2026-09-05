import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/shared/store";
import type { LauncherConfig } from "@/shared/types";
import { RemoteAuthSection } from "./RemoteAuthSection";

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

describe("RemoteAuthSection global draft binding", () => {
  it("has no local save button and writes edits straight into the global draft", async () => {
    const user = userEvent.setup();
    render(createElement(RemoteAuthSection));

    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Admin capability domain"), "x");
    expect(useAppStore.getState().config?.dsh_admin_cap_domain).toBe("x");
    expect(useAppStore.getState().persistedConfig?.dsh_admin_cap_domain).toBe("");
  });

  it("renders the resolved capability as the field description", async () => {
    useAppStore.setState({ config: { ...saved, dsh_admin_cap_domain: "admin.example.com" } });
    render(createElement(RemoteAuthSection));

    expect(screen.getByText("Full capability: admin.example.com/cap/dsh-admin")).toBeInTheDocument();
    expect(screen.getByLabelText("Admin capability domain")).toHaveValue("admin.example.com");
  });
});
