import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as shell from "@tauri-apps/plugin-shell";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { DshStatus, DshStepEvent } from "@/shared/types";
import { DshCard } from "./DshCard";
import {
  localStatusTextKey,
  proxyBypassHostForRemoteUrl,
  startDshWeb,
  restartDshWeb,
  statusTextKey,
  verifiedRemoteUrl,
} from "./dshActions";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

const stepDone = (index: number, id: string): DshStepEvent => ({
  index, id, state: "done", detail: null, problem: null, solution: null, titleKey: `step.${id}`,
});
const remoteReadyTimeline: DshStepEvent[] =
  ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"].map((id, i) => stepDone(i, id));
const localReadyTimeline: DshStepEvent[] =
  ["node", "install", "start", "ready"].map((id, i) => stepDone(i, id));

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
  // 就绪时间轴由 Rust detect 推导（前端不再重推导步骤编排）；
  // 测试夹具给一份与 ready 状态一致的远程 8 步全 done 形态
  readyTimeline: remoteReadyTimeline,
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
  // beginDshFlow 的骨架来源（Rust 契约命令）；测试环境无 Tauri invoke，统一打桩
  vi.spyOn(cmd, "dshStepSchema").mockImplementation(async (remote: boolean) =>
    (remote ? ["node","install","plugins","tailscale","magicdns","start","serve","verify"]
            : ["node","install","start","ready"])
      .map((id, index) => ({ index, id, state: "pending" as const, detail: null, problem: null, solution: null, titleKey: `step.${id}` })),
  );
});

describe("dsh auth plugin readiness", () => {
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
  });

  it("reports a denied remote capability separately from endpoint failure", () => {
    const denied = { ...ready, remoteUrlAccess: "capability_denied" as const };
    expect(statusTextKey(denied)).toBe("Remote capability grant denied");
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
  it("renders the ready timeline provided by dsh_detect", () => {
    // 就绪时间轴由 Rust 派生（前端不再持有步骤列表）：本地 4 步全 done 的夹具
    expect(localReadyTimeline.map((s) => s.id)).toEqual(["node", "install", "start", "ready"]);
    expect(localReadyTimeline.every((s) => s.state === "done")).toBe(true);
    // 远程就绪时间轴 8 步（同一契约，模式不同序列）
    expect(remoteReadyTimeline.map((s) => s.id)).toEqual(
      ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"],
    );
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

    await userEvent.click(screen.getByRole("checkbox", { name: /access mode/i }));

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
    titleKey: null,
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

describe("tray echo keeps the timeline on the event stream", () => {
  it("a fresh start resets the timeline skeleton to all-pending before events land", async () => {
    // 正常触发：上一轮的 ✓ 不能残留，时间轴先整体翻回 pending 再随事件点亮。
    // 收尾后时间轴被 detect 的就绪视图覆盖（夹具 ready.readyTimeline 是远程 8 步全 done）
    useAppStore.setState({
      dshHasRunSetup: false,
      dshTimeline: [
        { index: 0, id: "node", state: "done", detail: "old", problem: null, solution: null, titleKey: null },
      ],
    });
    vi.spyOn(cmd, "dshStartWeb").mockResolvedValue("http://127.0.0.1:3899");
    vi.spyOn(cmd, "dshDetect").mockResolvedValue(ready);
    vi.mocked(shell.open).mockResolvedValue();

    await startDshWeb();

    const tl = useAppStore.getState().dshTimeline;
    expect(tl).toEqual(ready.readyTimeline);
    // 成功收尾后被就绪视图覆盖；此处只断言骨架确实被重置过（非残留的 done）
    expect(tl.some((s) => s.detail === "old")).toBe(false);
  });

  it("a re-entrant startDshWeb claims the timeline for events without resetting it", async () => {
    // 回声路径：主触发已把 startBusy 置 true，托盘回声再进 startDshWeb
    // 会被 busy 守卫挡下，但 hasRunSetup 必须在守卫之前置位
    useAppStore.setState({ dshStartBusy: true, dshHasRunSetup: false, dshTimeline: [] });
    const startWeb = vi.spyOn(cmd, "dshStartWeb").mockResolvedValue("http://127.0.0.1:3899");

    await startDshWeb();

    expect(useAppStore.getState().dshHasRunSetup).toBe(true);
    // 回声走不到骨架重置，主触发的事件时间轴保留原样
    expect(useAppStore.getState().dshTimeline).toEqual([]);
    // 回声被守卫挡下，不重复执行启动命令
    expect(startWeb).not.toHaveBeenCalled();
  });

  it("a re-entrant restartDshWeb claims the timeline for events without resetting it", async () => {
    useAppStore.setState({ dshRestartBusy: true, dshHasRunSetup: false, dshTimeline: [] });
    const stop = vi.spyOn(cmd, "dshStop").mockResolvedValue();
    const startWeb = vi.spyOn(cmd, "dshStartWeb").mockResolvedValue("http://127.0.0.1:3899");

    await restartDshWeb();

    expect(useAppStore.getState().dshHasRunSetup).toBe(true);
    expect(useAppStore.getState().dshTimeline).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
    expect(startWeb).not.toHaveBeenCalled();
  });

  it("handleDshStep flips hasRunSetup on the first running event", () => {
    useAppStore.setState({ dshHasRunSetup: false, dshTimeline: [] });

    useAppStore.getState().handleDshStep({
      index: 0,
      id: "node",
      state: "running",
      detail: "Checking Node.js & npm…",
      problem: null,
      solution: null,
      titleKey: null,
    });

    expect(useAppStore.getState().dshHasRunSetup).toBe(true);
    expect(useAppStore.getState().dshTimeline[0]?.state).toBe("running");
  });

  it("handleDshStep leaves hasRunSetup untouched for non-running events", () => {
    useAppStore.setState({ dshHasRunSetup: false, dshTimeline: [] });

    useAppStore.getState().handleDshStep({
      index: 0,
      id: "node",
      state: "done",
      detail: "Node.js is available",
      problem: null,
      solution: null,
      titleKey: null,
    });

    expect(useAppStore.getState().dshHasRunSetup).toBe(false);
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
    titleKey: null,
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
