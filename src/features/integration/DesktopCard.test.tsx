import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { BridgeStatus, DesktopStatus } from "@/shared/types";
import { DesktopCard } from "./DesktopCard";

const MISSING = "DeepSeek Harness is not installed. Install it from the official channel; this app only detects and manages it.";
const NO_BUILD = "The official desktop app has no build for this platform (macOS on Apple silicon and Windows x64 only).";

const detected = (over: Partial<DesktopStatus> = {}): DesktopStatus => ({
  supported: true,
  installed: true,
  version: "0.1.7-rc.1.20260924.1",
  running: false,
  canQuit: true,
  ...over,
});

function mockDetect(status: DesktopStatus) {
  vi.spyOn(cmd, "desktopDetect").mockResolvedValue(status);
}

const bridge = (over: Partial<BridgeStatus> = {}): BridgeStatus => ({
  state: "not_installed",
  protocol: null,
  expectedProtocol: 1,
  installUrl: "https://github.com/sperictao/dsh-pro-max-bridge/releases/latest/download/dsh-pro-max-bridge.tgz",
  ...over,
});

/// 卡片的状态探测并行取两个命令；漏桩会让整条链路走 catch，两个状态都落空
function mockBridge(status: BridgeStatus = bridge()) {
  vi.spyOn(cmd, "desktopBridgeStatus").mockResolvedValue(status);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [] });
  mockBridge();
});

describe("DesktopCard", () => {
  it("offers no actions before the app is installed, and says where to get it", async () => {
    mockDetect(detected({ installed: false, version: null }));
    render(createElement(DesktopCard));

    expect(await screen.findByText(MISSING)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open DeepSeek Harness" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check for Updates" })).not.toBeInTheDocument();
  });

  it("names the missing platform build instead of pretending the app is absent", async () => {
    mockDetect(detected({ supported: false, installed: false, version: null }));
    render(createElement(DesktopCard));

    expect(await screen.findByText(NO_BUILD)).toBeInTheDocument();
  });

  it("opens when stopped and focuses when already running", async () => {
    mockDetect(detected({ running: false }));
    const { unmount } = render(createElement(DesktopCard));
    expect(await screen.findByRole("button", { name: "Open DeepSeek Harness" })).toBeInTheDocument();
    unmount();

    mockDetect(detected({ running: true }));
    render(createElement(DesktopCard));
    expect(await screen.findByRole("button", { name: "Focus DeepSeek Harness" })).toBeInTheDocument();
  });

  it("hides Quit where the app has no quittable exit and explains the tray menu instead", async () => {
    mockDetect(detected({ running: true, canQuit: false }));
    render(createElement(DesktopCard));

    expect(
      await screen.findByText("On this platform the DeepSeek Harness desktop app can only be quit from its own tray menu"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Quit DeepSeek Harness" })).not.toBeInTheDocument();

    // 已装但没运行时不该出现这条说明：它只在「退不掉」成为实际问题时才说话
    mockDetect(detected({ running: false, canQuit: false }));
    render(createElement(DesktopCard));
    await waitFor(() =>
      expect(
        screen.getAllByText("DeepSeek Harness is installed but not running.").length,
      ).toBeGreaterThan(0),
    );
  });

  it("reports update state only after the user asks for it", async () => {
    const user = userEvent.setup();
    mockDetect(detected());
    vi.spyOn(cmd, "desktopCheckLatest").mockResolvedValue("0.1.7-rc.2");
    render(createElement(DesktopCard));

    await screen.findByRole("button", { name: "Check for Updates" });
    expect(screen.queryByText("New version available: v0.1.7-rc.2")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check for Updates" }));
    expect(await screen.findByText("New version available: v0.1.7-rc.2")).toBeInTheDocument();
  });

  it("says so when there is nothing newer", async () => {
    const user = userEvent.setup();
    mockDetect(detected());
    vi.spyOn(cmd, "desktopCheckLatest").mockResolvedValue(null);
    render(createElement(DesktopCard));

    await user.click(await screen.findByRole("button", { name: "Check for Updates" }));
    expect(await screen.findByText("Already up to date")).toBeInTheDocument();
  });
});

describe("DesktopCard bridge row", () => {
  it("hands over the one address to paste when the bridge is missing", async () => {
    mockDetect(detected());
    render(createElement(DesktopCard));

    expect(
      await screen.findByText("The bridge plugin is not installed in DeepSeek Harness. Install it once from the app's Plugins page with this address:"),
    ).toBeInTheDocument();
    expect(screen.getByText(bridge().installUrl)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeInTheDocument();
  });

  it("names both protocol generations when the bridge is out of date", async () => {
    mockDetect(detected());
    mockBridge(bridge({ state: "incompatible", protocol: 2 }));
    render(createElement(DesktopCard));

    expect(
      await screen.findByText(
        "The bridge plugin is out of date: this app expects protocol 1, the installed bridge reports 2. Reinstall it in DeepSeek Harness with this address:",
      ),
    ).toBeInTheDocument();
  });

  it("says the app has to run first when it is not up", async () => {
    mockDetect(detected());
    mockBridge(bridge({ state: "app_unavailable" }));
    render(createElement(DesktopCard));

    expect(
      await screen.findByText("Open DeepSeek Harness to manage its plugins and configuration."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy address" })).not.toBeInTheDocument();
  });

  it("stays quiet once connected", async () => {
    mockDetect(detected());
    mockBridge(bridge({ state: "connected", protocol: 1 }));
    render(createElement(DesktopCard));

    expect(await screen.findByText("Bridge connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy address" })).not.toBeInTheDocument();
  });

  it("shows no bridge row at all when the app is not installed", async () => {
    mockDetect(detected({ installed: false, version: null }));
    mockBridge(bridge({ state: "app_unavailable" }));
    render(createElement(DesktopCard));

    await screen.findByText(MISSING);
    expect(screen.queryByText("Bridge connected")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Open DeepSeek Harness to manage its plugins and configuration."),
    ).not.toBeInTheDocument();
  });
});
