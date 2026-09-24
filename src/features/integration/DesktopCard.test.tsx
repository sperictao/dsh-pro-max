import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { DesktopStatus } from "@/shared/types";
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

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [] });
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
