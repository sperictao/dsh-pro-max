import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { BridgeStatus, DesktopPlugins, DesktopStatus } from "@/shared/types";
import { DesktopPluginsPane } from "./DesktopPluginsPane";

const INSTALL_SPEC = "@sperictao/dsh-pro-max-bridge@0.1.5";

const desktop = (over: Partial<DesktopStatus> = {}): DesktopStatus => ({
  supported: true,
  installed: true,
  version: "0.1.7-rc.1.20260924.1",
  running: true,
  canQuit: true,
  ...over,
});

const bridge = (over: Partial<BridgeStatus> = {}): BridgeStatus => ({
  state: "connected",
  protocol: 1,
  expectedProtocol: 1,
  installSpec: INSTALL_SPEC,
  ...over,
});

// desktop_bridge_plugins 的应答：Rust 侧已只留内置部分（用户 bundle 及其插件行归市场，
// 过滤与它的测试在 bridge.rs），这里按那个形状给
const catalog: DesktopPlugins = {
  plugins: [
    { entryId: "e1", moduleName: "@deepseek-ai/dsh-host-open-in-app", enabled: true, patchId: "row-1", readOnlyReason: null },
    { entryId: "e2", moduleName: "managed-by-app", enabled: true, patchId: null, readOnlyReason: "management-required" },
  ],
  bundles: [
    { name: "builtin", version: null, description: null, enabled: true, removable: false, readOnlyReason: null },
  ],
};


/// 桥接态之后每个用例都要拉一次列表与配置；漏桩会让整条链路走 catch
function mount(options: { bridge?: BridgeStatus; plugins?: DesktopPlugins } = {}) {
  vi.spyOn(cmd, "desktopDetect").mockResolvedValue(desktop());
  vi.spyOn(cmd, "desktopBridgeStatus").mockResolvedValue(options.bridge ?? bridge());
  vi.spyOn(cmd, "desktopBridgePlugins").mockResolvedValue(options.plugins ?? catalog);
  // 每次返回新对象：桥接是真的 HTTP，重拉拿回的是新 JSON。给同一个引用会让 React 跳过
  // 重渲染，从而掩盖「重拉把编辑中的内容冲掉」这类问题
  vi.spyOn(cmd, "desktopBridgeConfig").mockImplementation(async () => [
    {
      id: "agent-default-model",
      name: "@deepseek-ai/dsh-agent-default-model",
      current: { model: "x" },
      inherited: { model: "x" },
      override: {},
    },
  ]);
  return render(createElement(DesktopPluginsPane));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  // 桌面状态全应用一份：每个用例从「还没探测过」开始，不吃上一个用例的结论
  useAppStore.setState({ toasts: [], desktopStatus: null, desktopBridge: null, desktopChecked: false });
});

describe("DesktopPluginsPane gates", () => {
  it("says where to get the app when it is not installed", async () => {
    vi.spyOn(cmd, "desktopDetect").mockResolvedValue(desktop({ installed: false, version: null }));
    vi.spyOn(cmd, "desktopBridgeStatus").mockResolvedValue(bridge({ state: "app_unavailable" }));
    render(createElement(DesktopPluginsPane));

    expect(
      await screen.findByText("DeepSeek Harness is not installed. Install it from the official channel; this app only detects and manages it."),
    ).toBeInTheDocument();
  });

  it("hands over the install address instead of the lists when the bridge is missing", async () => {
    mount({ bridge: bridge({ state: "not_installed", protocol: null }) });

    expect(
      await screen.findByText("The bridge plugin is not installed in DeepSeek Harness. Install it once from the app's Plugins page with this package spec:"),
    ).toBeInTheDocument();
    expect(screen.getByText(INSTALL_SPEC)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
    expect(cmd.desktopBridgePlugins).not.toHaveBeenCalled();
  });
});

describe("DesktopPluginsPane lists", () => {
  it("lets a row the profile can address be toggled", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "desktopBridgeSetEnabled").mockResolvedValue("applied");
    mount();

    const row = await screen.findByRole("checkbox", { name: "@deepseek-ai/dsh-host-open-in-app" });
    expect(row).toBeEnabled();
    await user.click(row);

    // 插件行按 entryId 寻址，不是模块名
    expect(cmd.desktopBridgeSetEnabled).toHaveBeenCalledWith({ pluginId: "e1" }, false);
  });

  it("greys out a row the app manages itself and says why", async () => {
    mount();
    const row = await screen.findByRole("checkbox", { name: "managed-by-app" });
    expect(row).toBeDisabled();
    expect(screen.getByText("The desktop app manages this itself; it cannot be changed here.")).toBeInTheDocument();
  });

  // 用户装的插件归市场（ADR 0012）：这里只有内置 bundle 的开关，没有安装与移除入口；
  // 模型域的配置行指向模型页
  it("offers only built-in switches and points model rows to the Models page", async () => {
    mount();
    expect(await screen.findByRole("checkbox", { name: "builtin" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
    expect(screen.getByText(/The default model and AI providers are edited on the Models page\./)).toBeInTheDocument();
  });
});

describe("DesktopPluginsPane change outcomes", () => {
  it("reports the failure reason instead of treating a returned failure as success", async () => {
    const user = userEvent.setup();
    // 上游折叠进返回值的失败由 Rust 侧解读成 Err（带上游诊断），这里收到的就是那条消息
    vi.spyOn(cmd, "desktopBridgeSetEnabled").mockRejectedValue({
      key: "DeepSeek Harness could not apply this change: {{reason}}",
      args: { reason: "supplied by dsh" },
    });
    mount();

    await user.click(await screen.findByRole("checkbox", { name: "builtin" }));
    await waitFor(() =>
      expect(useAppStore.getState().toasts[0]?.message).toBe("DeepSeek Harness could not apply this change: supplied by dsh"),
    );
  });

  it("says a restart is needed when the app applies it only on next start", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "desktopBridgeSetEnabled").mockResolvedValue("restart-required");
    mount();

    await user.click(await screen.findByRole("checkbox", { name: "builtin" }));
    expect(cmd.desktopBridgeSetEnabled).toHaveBeenCalledWith({ bundleName: "builtin" }, false);
    await waitFor(() =>
      expect(useAppStore.getState().toasts[0]?.message).toBe("Restart DeepSeek Harness to apply this change."),
    );
  });
});

describe("DesktopPluginsPane configuration", () => {
  it("saves a row as parsed JSON", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "desktopBridgeConfigEdit").mockResolvedValue();
    mount();

    const box = await screen.findByRole("textbox", { name: "agent-default-model" });
    expect((box as HTMLTextAreaElement).value).toContain('"model": "x"');
    await user.clear(box);
    await user.type(box, '{{"model":"y"}');
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(cmd.desktopBridgeConfigEdit).toHaveBeenCalledWith("agent-default-model", { model: "y" }));
  });

  it("refuses to send text that is not JSON", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "desktopBridgeConfigEdit").mockResolvedValue();
    mount();

    const box = await screen.findByRole("textbox", { name: "agent-default-model" });
    await user.clear(box);
    await user.type(box, "not json");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(cmd.desktopBridgeConfigEdit).not.toHaveBeenCalled();
    await waitFor(() => expect(useAppStore.getState().toasts[0]?.message).toMatch(/Not valid JSON/));
  });
});

describe("DesktopPluginsPane partial probe failure", () => {
  it("stays out of the loading state when only the bridge probe fails", async () => {
    vi.spyOn(cmd, "desktopDetect").mockResolvedValue(desktop());
    vi.spyOn(cmd, "desktopBridgeStatus").mockRejectedValue(new Error("not json"));
    render(createElement(DesktopPluginsPane));

    // 曾经两个探测绑在同一个 Promise.all 上，桥接一挂连「应用装没装」都不知道，界面停在
    // 「检测中」——那不是真实状态
    await waitFor(() => expect(screen.queryByText("Checking...")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
  });
});

describe("DesktopPluginsPane editing safety", () => {
  it("keeps an in-progress config edit when an unrelated action refetches the lists", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "desktopBridgeSetEnabled").mockResolvedValue("applied");
    mount();

    // 展开一行并在里面打字
    const box = await screen.findByRole("textbox", { name: "agent-default-model" });
    await user.clear(box);
    await user.type(box, '{{"model":"half-typed"');
    expect((box as HTMLTextAreaElement).value).toBe('{"model":"half-typed"');

    // 另一个动作会重拉列表与配置：重拉回来的 row 是新对象，若编辑器跟着它重置，
    // 用户打了一半的内容就被冲掉了
    await user.click(await screen.findByRole("checkbox", { name: "@deepseek-ai/dsh-host-open-in-app" }));
    await waitFor(() => expect(cmd.desktopBridgeConfig).toHaveBeenCalledTimes(2));

    expect((screen.getByRole("textbox", { name: "agent-default-model" }) as HTMLTextAreaElement).value).toBe(
      '{"model":"half-typed"',
    );
  });
});
