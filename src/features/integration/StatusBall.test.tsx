import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/shared/store";
import type { DshStatus } from "@/shared/types";
import { StatusBall } from "./StatusBall";

const ready: DshStatus = {
  nodeAvailable: true,
  dshInstalled: true,
  dshVersion: "0.1.0-rc.6",
  supportedVersion: "0.1.0-rc.6",
  dshCompatible: true,
  dshVersionAboveSupported: false,
  pluginsInstalled: true,
  dshRunning: true,
  tailscaleInstalled: true,
  tailscaleOnline: true,
  hostname: "node",
  localUrl: "http://127.0.0.1:3899",
  url: "https://node.tailnet.ts.net",
  remoteUrlAccess: "ready",
  magicDnsEnabled: true,
  serveConfigured: true,
  autostartEnabled: false,
  error: null,
  // StatusBall 只读 status 布尔与文案键，不看时间轴；空就绪时间轴即可
  readyTimeline: [],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({
    dshStatus: null,
    dshAccessMode: "local",
    dshStartBusy: false,
    dshStopBusy: false,
    dshRestartBusy: false,
    dshRecheckBusy: false,
    toasts: [],
  });
});

function ballElement(): HTMLElement {
  return document.querySelector(".status-indicator-icon") as HTMLElement;
}

describe("StatusBall states", () => {
  it("shows starting before the first detection completes", () => {
    render(createElement(StatusBall));
    expect(ballElement().className).toContain("starting");
    expect(screen.getByText("Detecting…")).toBeInTheDocument();
  });

  it("shows starting while a one-click flow is in flight", () => {
    useAppStore.setState({ dshStatus: { ...ready }, dshStartBusy: true });
    render(createElement(StatusBall));
    expect(ballElement().className).toContain("starting");
    expect(screen.getByText("Working…")).toBeInTheDocument();
  });

  it("shows running with the local ready text when dsh web runs", () => {
    useAppStore.setState({ dshStatus: { ...ready } });
    render(createElement(StatusBall));
    expect(ballElement().className).toContain("running");
    expect(screen.getByText("Local access ready")).toBeInTheDocument();
  });

  it("shows stopped when dsh web is not running", () => {
    useAppStore.setState({ dshStatus: { ...ready, dshRunning: false } });
    render(createElement(StatusBall));
    expect(ballElement().className).toContain("stopped");
    expect(screen.getByText("dsh web not running")).toBeInTheDocument();
  });

  it("shows failed when detection reports an error", () => {
    useAppStore.setState({ dshStatus: { ...ready, dshRunning: false, error: "boom" } });
    render(createElement(StatusBall));
    expect(ballElement().className).toContain("failed");
  });

  it("follows the remote status chain in remote mode", () => {
    useAppStore.setState({ dshStatus: { ...ready }, dshAccessMode: "remote" });
    render(createElement(StatusBall));
    expect(screen.getByText("Remote access ready")).toBeInTheDocument();
  });
});
