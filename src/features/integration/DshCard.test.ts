import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as shell from "@tauri-apps/plugin-shell";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { DshStatus } from "@/shared/types";
import { DshCard } from "./DshCard";
import {
  localStatusTextKey,
  localTimelineFromStatus,
  proxyBypassHostForRemoteUrl,
  statusTextKey,
  timelineFromStatus,
  verifiedRemoteUrl,
} from "./dshActions";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

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
};

const storedValues = new Map<string, string>();
const testLocalStorage: Storage = {
  get length() { return storedValues.size; },
  clear: () => storedValues.clear(),
  getItem: (key) => storedValues.get(key) ?? null,
  key: (index) => [...storedValues.keys()][index] ?? null,
  removeItem: (key) => { storedValues.delete(key); },
  setItem: (key, value) => { storedValues.set(key, String(value)); },
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: testLocalStorage,
  });
  localStorage.clear();
  useAppStore.setState({
    dshTimeline: [],
    toasts: [],
    config: null,
    dshStatus: null,
    dshAccessMode: "local",
    dshStartBusy: false,
    dshStopBusy: false,
    dshRestartBusy: false,
    dshRecheckBusy: false,
    dshHasRunSetup: false,
    dshLatest: null,
    dshLatestBusy: false,
    dshInstallingVersion: null,
    dshAutostart: null,
    dshAutostartBusy: false,
  });
});

describe("dsh auth plugin readiness", () => {
  it("includes plugin installation and no loopback proxy step", () => {
    expect(timelineFromStatus(ready).map((step) => step.id)).toEqual([
      "node",
      "install",
      "plugins",
      "tailscale",
      "magicdns",
      "start",
      "serve",
      "verify",
    ]);
    expect(timelineFromStatus(ready).every((step) => step.state === "done")).toBe(true);
  });

  it("reports missing auth plugins only once dsh web is running", () => {
    // 插件只服务于远程访问链路：dsh 尚未运行时优先报告未运行
    expect(statusTextKey({ ...ready, pluginsInstalled: false, dshRunning: false }))
      .toBe("dsh web not running");
    // 本地模式已运行时，未装插件意味着远程还没准备好
    expect(statusTextKey({ ...ready, pluginsInstalled: false, dshRunning: true }))
      .toBe("dsh auth plugins not installed");
  });

  it("reports an incompatible dsh core before plugin state", () => {
    expect(statusTextKey({ ...ready, dshCompatible: false, pluginsInstalled: false }))
      .toBe("dsh version is not supported by the auth plugins");
  });

  it("does not report ready while this Mac's proxy blocks the remote URL", () => {
    const blocked = { ...ready, remoteUrlAccess: "proxy_interference" as const };
    expect(statusTextKey(blocked)).toBe("Local proxy bypass required");
    expect(timelineFromStatus(blocked).at(-1)?.state).toBe("pending");
  });

  it("reports a denied remote capability separately from endpoint failure", () => {
    const denied = { ...ready, remoteUrlAccess: "capability_denied" as const };
    expect(statusTextKey(denied)).toBe("Remote capability grant denied");
    expect(timelineFromStatus(denied).at(-1)?.state).toBe("pending");
    expect(verifiedRemoteUrl(denied)).toBeNull();
  });

  it("does not report or open remote access before the URL probe succeeds", () => {
    expect(statusTextKey({ ...ready, remoteUrlAccess: null }))
      .toBe("Remote access not verified");
    expect(verifiedRemoteUrl({ ...ready, remoteUrlAccess: null })).toBeNull();
    expect(verifiedRemoteUrl({ ...ready, remoteUrlAccess: "endpoint_failure" })).toBeNull();
    expect(verifiedRemoteUrl({ ...ready, remoteUrlAccess: "proxy_interference" })).toBeNull();
    expect(verifiedRemoteUrl(ready)).toBe(ready.url);
  });

  it("extracts the narrow proxy bypass host from the remote URL", () => {
    expect(proxyBypassHostForRemoteUrl("https://node.tailnet.ts.net"))
      .toBe("node.tailnet.ts.net");
    expect(proxyBypassHostForRemoteUrl(null)).toBeNull();
  });
});

describe("local one-click timeline", () => {
  it("uses 4 local-only steps and marks all done when dsh web is running", () => {
    const steps = localTimelineFromStatus(ready);
    expect(steps.map((s) => s.id)).toEqual(["node", "install", "start", "ready"]);
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(steps.every((s) => s.state === "done")).toBe(true);
  });

  it("marks start/ready pending when dsh web is not running", () => {
    const steps = localTimelineFromStatus({ ...ready, dshRunning: false });
    expect(steps[2].state).toBe("pending");
    expect(steps[3].state).toBe("pending");
  });
});

describe("local mode status text", () => {
  it("ignores remote-only prerequisites and reports ready when dsh web runs", () => {
    // 本地模式不要求插件/Tailscale：插件缺失即可就绪
    expect(localStatusTextKey({ ...ready, pluginsInstalled: false, serveConfigured: false }))
      .toBe("Local access ready");
    expect(statusTextKey({ ...ready, pluginsInstalled: false, serveConfigured: false }))
      .toBe("dsh auth plugins not installed");
  });

  it("reports missing prerequisites in local order", () => {
    expect(localStatusTextKey({ ...ready, dshRunning: false })).toBe("dsh web not running");
    expect(localStatusTextKey({ ...ready, nodeAvailable: false })).toBe("Node.js not detected");
    expect(localStatusTextKey({ ...ready, dshInstalled: false, dshCompatible: false }))
      .toBe("DeepSeek Harness not installed");
  });
});

describe("remote URL verification flow", () => {
  it("shows the tailnet grants action when a capability probe is denied", async () => {
    localStorage.setItem("dsh-access-mode", "remote");
    useAppStore.setState({ dshAccessMode: "remote" });
    vi.spyOn(cmd, "dshDetect").mockResolvedValue({
      ...ready,
      remoteUrlAccess: "capability_denied",
    });

    render(createElement(DshCard));

    // 两处：状态球文字 + 告警盒标题（卡片状态行已移除，状态文字由球区承载）
    expect(await screen.findAllByText("Remote capability grant denied")).toHaveLength(2);
    expect(screen.getByText(
      "Grant TCP 443 and the configured use/admin capabilities to this identity and dsh node in the same tailnet grant, then stop and run one-click start again.",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
  });

  it("shows the exact skip-proxy host and keeps remote open disabled", async () => {
    localStorage.setItem("dsh-access-mode", "remote");
    useAppStore.setState({ dshAccessMode: "remote" });
    const blocked = { ...ready, remoteUrlAccess: "proxy_interference" as const };
    vi.spyOn(cmd, "dshDetect").mockResolvedValue(blocked);

    render(createElement(DshCard));

    expect(await screen.findByText("node.tailnet.ts.net")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy bypass host" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
  });

  it("reruns detection with URL verification when switching to remote mode", async () => {
    const stopped = {
      ...ready,
      dshRunning: false,
      localUrl: null,
      url: null,
      remoteUrlAccess: null,
      serveConfigured: false,
    };
    const detect = vi.spyOn(cmd, "dshDetect").mockResolvedValue(stopped);

    render(createElement(DshCard));
    await waitFor(() => expect(detect).toHaveBeenCalledWith(false));

    await userEvent.click(screen.getByRole("checkbox", { name: /Remote access/i }));

    await waitFor(() => expect(detect).toHaveBeenCalledWith(true));
  });

  it("does not open the remote URL when the post-setup probe fails", async () => {
    localStorage.setItem("dsh-access-mode", "remote");
    useAppStore.setState({ dshAccessMode: "remote" });
    const stopped = {
      ...ready,
      dshRunning: false,
      localUrl: null,
      url: null,
      remoteUrlAccess: null,
      serveConfigured: false,
    };
    const failed = { ...ready, remoteUrlAccess: "endpoint_failure" as const };
    const detect = vi.spyOn(cmd, "dshDetect")
      .mockResolvedValueOnce(stopped)
      .mockResolvedValue(failed);
    const setup = vi.spyOn(cmd, "dshSetup").mockResolvedValue();
    const open = vi.mocked(shell.open).mockResolvedValue();

    render(createElement(DshCard));
    await waitFor(() => expect(detect).toHaveBeenCalledWith(true));
    await userEvent.click(screen.getByRole("button", { name: "One-click start dsh web" }));

    await waitFor(() => expect(setup).toHaveBeenCalledOnce());
    await waitFor(() => expect(detect.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(open).not.toHaveBeenCalled();
  });
});

describe("one-click restart", () => {
  it("stops before starting again in local mode, then opens the local URL", async () => {
    useAppStore.setState({ dshStatus: { ...ready } });
    const detect = vi.spyOn(cmd, "dshDetect").mockResolvedValue(ready);
    const stop = vi.spyOn(cmd, "dshStop").mockResolvedValue();
    const startWeb = vi.spyOn(cmd, "dshStartWeb").mockResolvedValue("http://127.0.0.1:3899");
    const open = vi.mocked(shell.open).mockResolvedValue();

    render(createElement(DshCard));
    await waitFor(() => expect(detect).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "One-click restart dsh web" }));

    await waitFor(() => expect(startWeb).toHaveBeenCalledOnce());
    expect(stop).toHaveBeenCalledOnce();
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(startWeb.mock.invocationCallOrder[0]);
    await waitFor(() => expect(open).toHaveBeenCalledWith("http://127.0.0.1:3899"));
    // 重启完成后所有按钮回到可用状态
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "One-click restart dsh web" })).toBeEnabled(),
    );
  });

  it("is disabled while dsh web is not running", async () => {
    const stopped = { ...ready, dshRunning: false };
    useAppStore.setState({ dshStatus: stopped });
    vi.spyOn(cmd, "dshDetect").mockResolvedValue(stopped);

    render(createElement(DshCard));

    expect(await screen.findByRole("button", { name: "One-click restart dsh web" })).toBeDisabled();
  });
});

describe("start failure log disclosure", () => {
  const failedStart = {
    index: 2,
    id: "start",
    state: "failed" as const,
    detail: null,
    problem: "dsh web failed to start; log says:\nError: boom",
    solution: "Check the log at ~/.dsh/dsh-web.log",
  };

  function renderFailedStart() {
    useAppStore.setState({
      dshHasRunSetup: true,
      dshStatus: { ...ready, dshRunning: false },
      dshTimeline: [failedStart],
    });
    vi.spyOn(cmd, "dshDetect").mockResolvedValue({ ...ready, dshRunning: false });
    return render(createElement(DshCard));
  }

  it("loads and shows the web log tail with a copy action", async () => {
    renderFailedStart();
    const webLog = vi.spyOn(cmd, "dshWebLog").mockResolvedValue("Error: boom\n    at frame");
    // jsdom 没有 clipboard 实现，与 beforeEach 的 localStorage 同法打桩
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await userEvent.click(await screen.findByRole("button", { name: "View log" }));

    expect(webLog).toHaveBeenCalledOnce();
    // problem 摘要也含 "Error: boom"，用只在完整日志里出现的堆栈行断言
    expect(await screen.findByText(/at frame/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy log" }));
    expect(writeText).toHaveBeenCalledWith("Error: boom\n    at frame");
  });

  it("refetches on each expand and shows a placeholder for an empty log", async () => {
    renderFailedStart();
    const webLog = vi.spyOn(cmd, "dshWebLog").mockResolvedValue("");

    await userEvent.click(await screen.findByRole("button", { name: "View log" }));
    expect(await screen.findByText("Log is empty or missing.")).toBeInTheDocument();

    // 收起再展开：重新读日志（重试后能看到最新现场），不显示复制按钮
    await userEvent.click(screen.getByRole("button", { name: "Hide log" }));
    await userEvent.click(screen.getByRole("button", { name: "View log" }));
    expect(webLog).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Copy log" })).not.toBeInTheDocument();
  });

  it("does not offer the log viewer on non-start failures", () => {
    useAppStore.setState({
      dshHasRunSetup: true,
      dshStatus: { ...ready, dshRunning: false },
      dshTimeline: [{ ...failedStart, id: "node" }],
    });
    vi.spyOn(cmd, "dshDetect").mockResolvedValue({ ...ready, dshRunning: false });

    render(createElement(DshCard));

    expect(screen.getByText(/dsh web failed to start/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View log" })).not.toBeInTheDocument();
  });
});

describe("cross-page state preservation", () => {
  it("keeps running/failed one-click state after unmount and remount", async () => {
    const failedStep = {
      index: 0,
      id: "node",
      state: "failed" as const,
      detail: "detail",
      problem: "problem",
      solution: "solution",
    };
    useAppStore.setState({
      dshStartBusy: true,
      dshHasRunSetup: true,
      dshStatus: { ...ready, dshRunning: false },
      dshTimeline: [failedStep],
    });
    vi.spyOn(cmd, "dshDetect").mockResolvedValue({ ...ready, dshRunning: false });

    const first = render(createElement(DshCard));
    expect(screen.getByRole("button", { name: "Starting..." })).toBeInTheDocument();
    expect(screen.getByText("problem")).toBeInTheDocument();

    first.unmount();
    const second = render(createElement(DshCard));
    expect(screen.getByRole("button", { name: "Starting..." })).toBeInTheDocument();
    expect(screen.getByText("problem")).toBeInTheDocument();
    second.unmount();
  });
});
