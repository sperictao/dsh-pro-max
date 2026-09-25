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

/// 卡片的两个状态探测各自取数（串行、各自兜底）；漏桩会让那一条落空。
/// 注：桥接探测那条的失败源是 IPC 层（命令未注册、序列化失败），不是 bridge_status_once
/// 本身——它自己不会返回 Err
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
    vi.spyOn(cmd, "desktopCheckLatest").mockResolvedValue({ kind: "available", version: "0.1.7-rc.2" });
    render(createElement(DesktopCard));

    await screen.findByRole("button", { name: "Check for Updates" });
    expect(screen.queryByText("New version available: v0.1.7-rc.2")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check for Updates" }));
    expect(await screen.findByText("New version available: v0.1.7-rc.2")).toBeInTheDocument();
  });

  it("says so when there is nothing newer", async () => {
    const user = userEvent.setup();
    mockDetect(detected());
    vi.spyOn(cmd, "desktopCheckLatest").mockResolvedValue({ kind: "upToDate" });
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

describe("DesktopCard partial probe failure", () => {
  it("still shows the app state when only the bridge probe fails", async () => {
    mockDetect(detected({ running: true }));
    vi.spyOn(cmd, "desktopBridgeStatus").mockRejectedValue(new Error("port 19387 answered with something else"));
    render(createElement(DesktopCard));

    // 两项曾绑在同一个 Promise.all 上：桥接一挂，桌面应用的状态也一起落空
    expect(await screen.findByText("DeepSeek Harness is running.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Focus DeepSeek Harness" })).toBeInTheDocument();
    expect(screen.queryByText("Bridge connected")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy address" })).not.toBeInTheDocument();
  });
});

describe("DesktopCard update check", () => {
  it("says it cannot tell, instead of claiming the app is up to date", async () => {
    const user = userEvent.setup();
    mockDetect(detected());
    vi.spyOn(cmd, "desktopCheckLatest").mockResolvedValue({ kind: "unknown" });
    render(createElement(DesktopCard));

    await user.click(await screen.findByRole("button", { name: "Check for Updates" }));
    // 「查不出来」不是「已是最新」——后者是对用户撒谎
    expect(await screen.findByText("Cannot tell whether a newer version exists.")).toBeInTheDocument();
    expect(screen.queryByText("Already up to date")).not.toBeInTheDocument();
  });

  it("drops the previous conclusion when a re-check fails", async () => {
    const user = userEvent.setup();
    mockDetect(detected());
    const check = vi.spyOn(cmd, "desktopCheckLatest").mockResolvedValue({ kind: "available", version: "9.9.9" });
    render(createElement(DesktopCard));

    await user.click(await screen.findByRole("button", { name: "Check for Updates" }));
    expect(await screen.findByText("New version available: v9.9.9")).toBeInTheDocument();

    // 再查一次失败：过期的「有新版本」不该和错误 toast 并排挂着
    check.mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Check for Updates" }));
    await waitFor(() => expect(screen.queryByText("New version available: v9.9.9")).not.toBeInTheDocument());
  });
});
