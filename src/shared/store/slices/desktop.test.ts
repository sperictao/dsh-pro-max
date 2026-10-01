import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";

beforeEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({ toasts: [], desktopStatus: null, desktopBridge: null, desktopChecked: false });
});

describe("desktop slice", () => {
  // 首页卡片、桌面 tab、市场、模型页可能同时挂载：只探测一次，大家等同一个结果
  it("shares one probe between concurrent refreshes", async () => {
    const detect = vi.spyOn(cmd, "desktopDetect").mockResolvedValue({
      supported: true,
      installed: true,
      version: "0.2.0-rc.2",
      running: true,
      canQuit: true,
    });
    const bridge = vi.spyOn(cmd, "desktopBridgeStatus").mockResolvedValue({
      state: "connected",
      protocol: 1,
      expectedProtocol: 1,
      installSpec: "@sperictao/dsh-pro-max-bridge@0.1.5",
    });

    await Promise.all([
      useAppStore.getState().refreshDesktop(),
      useAppStore.getState().refreshDesktop(),
      useAppStore.getState().refreshDesktop(),
    ]);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().desktopBridge?.state).toBe("connected");
    expect(useAppStore.getState().desktopChecked).toBe(true);

    // 一轮结束后再刷新是新的一次探测，不是永远复用第一个结果
    await useAppStore.getState().refreshDesktop();
    expect(detect).toHaveBeenCalledTimes(2);
  });

  // 桥接问不到只让桥接那一项缺席，不牵连应用本身的检测结果
  it("keeps the app status when only the bridge probe fails", async () => {
    vi.spyOn(cmd, "desktopDetect").mockResolvedValue({
      supported: true,
      installed: true,
      version: null,
      running: false,
      canQuit: true,
    });
    vi.spyOn(cmd, "desktopBridgeStatus").mockRejectedValue(new Error("not json"));

    await useAppStore.getState().refreshDesktop();
    expect(useAppStore.getState().desktopStatus?.installed).toBe(true);
    expect(useAppStore.getState().desktopBridge).toBeNull();
    expect(useAppStore.getState().desktopChecked).toBe(true);
    expect(useAppStore.getState().toasts).toHaveLength(0);
  });
});
