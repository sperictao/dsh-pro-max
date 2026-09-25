import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { BridgeStatus, ChangeOutcome, DesktopPlugins, DesktopStatus } from "@/shared/types";
import { DesktopPluginsPane } from "./DesktopPluginsPane";

const INSTALL_URL = "https://github.com/sperictao/dsh-pro-max-bridge/releases/latest/download/dsh-pro-max-bridge.tgz";

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
  installUrl: INSTALL_URL,
  ...over,
});

const catalog: DesktopPlugins = {
  plugins: [
    { entryId: "e1", moduleName: "@deepseek-ai/dsh-host-open-in-app", enabled: true, patchId: "row-1", readOnlyReason: null },
    { entryId: "e2", moduleName: "managed-by-app", enabled: true, patchId: null, readOnlyReason: "management-required" },
  ],
  bundles: [
    { name: "@dsh-external/dsh-pro-max-bridge", version: "0.1.0", description: "bridge", enabled: true, installed: true, removable: true, readOnlyReason: null },
    { name: "builtin", version: null, description: null, enabled: true, installed: false, removable: false, readOnlyReason: null },
  ],
};

const applied: ChangeOutcome = {
  application: "applied",
  target: "t",
  enabled: null,
  errorCode: null,
  errorDiagnostic: null,
  pendingBuilds: [],
  warnings: [],
};

/// 桥接态之后每个用例都要拉一次列表与配置；漏桩会让整条链路走 catch
function mount(options: { bridge?: BridgeStatus; plugins?: DesktopPlugins } = {}) {
  vi.spyOn(cmd, "desktopDetect").mockResolvedValue(desktop());
  vi.spyOn(cmd, "desktopBridgeStatus").mockResolvedValue(options.bridge ?? bridge());
  vi.spyOn(cmd, "desktopBridgePlugins").mockResolvedValue(options.plugins ?? catalog);
  vi.spyOn(cmd, "desktopBridgeConfig").mockResolvedValue([
    { id: "agent-default-model", name: "@deepseek-ai/dsh-agent-default-model", current: { model: "x" } },
  ]);
  return render(createElement(DesktopPluginsPane));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [] });
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
      await screen.findByText("The bridge plugin is not installed in DeepSeek Harness. Install it once from the app's Plugins page with this address:"),
    ).toBeInTheDocument();
    expect(screen.getByText(INSTALL_URL)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
    expect(cmd.desktopBridgePlugins).not.toHaveBeenCalled();
  });
});

describe("DesktopPluginsPane lists", () => {
  it("lets a row the profile can address be toggled", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "desktopBridgeSetEnabled").mockResolvedValue(applied);
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

  it("only offers removal for a bundle the profile owns", async () => {
    mount();
    const remove = await screen.findAllByRole("button", { name: "Remove" });
    expect(remove).toHaveLength(2);
    expect(remove[0]).toBeEnabled();
    expect(remove[1]).toBeDisabled();
    expect(screen.getByText("Ships with dsh; it cannot be removed.")).toBeInTheDocument();
  });
});

describe("DesktopPluginsPane install", () => {
  it("installs the pasted spec", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "desktopBridgeInstall").mockResolvedValue(applied);
    mount();

    await user.type(await screen.findByPlaceholderText(/@scope\/plugin/), "github:owner/repo");
    await user.click(screen.getByRole("button", { name: "Install" }));

    // 没有待批构建脚本时不带 approvedBuilds（上游按「必须仍待批」校验，空数组会被拒）
    expect(cmd.desktopBridgeInstall).toHaveBeenCalledWith("github:owner/repo", undefined);
  });

  it("turns a pending-builds answer into an explicit approval that is passed back", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "desktopBridgeInstall")
      .mockResolvedValueOnce({ ...applied, application: "failed", pendingBuilds: ["sharp"] })
      .mockResolvedValueOnce(applied);
    mount();

    await user.type(await screen.findByPlaceholderText(/@scope\/plugin/), "sharp-plugin");
    await user.click(screen.getByRole("button", { name: "Install" }));

    const approve = await screen.findByRole("button", { name: "Approve build scripts and install" });
    expect(
      screen.getByText("These packages want to run install scripts: sharp. Approving lets them run for the desktop profile."),
    ).toBeInTheDocument();

    await user.click(approve);
    expect(cmd.desktopBridgeInstall).toHaveBeenLastCalledWith("sharp-plugin", ["sharp"]);
  });

  it("reports the failure reason instead of treating a returned failure as success", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "desktopBridgeRemove").mockResolvedValue({
      ...applied,
      application: "failed",
      errorCode: "not-removable",
      errorDiagnostic: "supplied by dsh",
    });
    mount();

    await user.click((await screen.findAllByRole("button", { name: "Remove" }))[0]);
    await waitFor(() =>
      expect(useAppStore.getState().toasts[0]?.message).toBe("The change failed: supplied by dsh"),
    );
  });

  it("says a restart is needed when the app applies it only on next start", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "desktopBridgeRemove").mockResolvedValue({ ...applied, application: "restart-required" });
    mount();

    await user.click((await screen.findAllByRole("button", { name: "Remove" }))[0]);
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
