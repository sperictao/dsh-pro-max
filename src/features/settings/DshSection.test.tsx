import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { DshLatestInfo, DshStatus } from "@/shared/types";
import { DshSection } from "./DshSection";

const latest: DshLatestInfo = {
  tags: [],
  installedVersion: null,
  supportedVersion: "",
  error: null,
};

const detected: DshStatus = {
  nodeAvailable: false,
  dshInstalled: false,
  dshVersion: null,
  supportedVersion: "",
  dshCompatible: false,
  dshVersionAboveSupported: false,
  pluginsInstalled: false,
  dshRunning: false,
  tailscaleInstalled: false,
  tailscaleOnline: false,
  hostname: null,
  localUrl: null,
  url: null,
  remoteUrlAccess: null,
  magicDnsEnabled: false,
  serveConfigured: false,
  autostartEnabled: false,
  error: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({
    dshTimeline: [],
    toasts: [],
    config: {
      minimize_to_tray_on_close: false,
      language: "en",
      dsh_admin_cap_domain: "example.com",
      dsh_use_cap_domain: "example.com",
      dsh_extra_allowed_logins: "alice@example.com",
    },
  });
  vi.spyOn(cmd, "dshCheckLatest").mockResolvedValue(latest);
  vi.spyOn(cmd, "dshDetect").mockResolvedValue(detected);
});

describe("DshSection remote authorization", () => {
  it("shows the migrated remote authorization block and pre-fills configured values", async () => {
    render(createElement(DshSection));

    expect(await screen.findByText("Remote authorization")).toBeInTheDocument();
    expect(screen.getByText(
      "After changing remote authorization, run one-click start again to apply it; stop dsh web first if it is running.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "Every remote identity needs TCP 443 in tailnet grants. If you configure capabilities, include both ip and app in the same grant.",
    )).toBeInTheDocument();
    expect(screen.getByLabelText("Admin capability domain")).toHaveValue("example.com");
    expect(screen.getByLabelText("Use capability domain")).toHaveValue("example.com");
    expect(screen.getByLabelText("Extra allowed logins")).toHaveValue("alice@example.com");
  });

  it("saves remote authorization through the global settings draft", async () => {
    const updateSettings = vi.spyOn(cmd, "updateSettings").mockResolvedValue();
    render(createElement(DshSection));

    const input = await screen.findByLabelText("Admin capability domain");
    await userEvent.clear(input);
    await userEvent.type(input, "corp.example.com");
    expect(useAppStore.getState().config?.dsh_admin_cap_domain).toBe("corp.example.com");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateSettings).toHaveBeenCalledOnce();
  });
});
