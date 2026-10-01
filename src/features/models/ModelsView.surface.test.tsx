// 模型页按目标形态参数化（ADR 0012）：两档都纳管时页头出形态切换；desktop 档读写都经桥接、
// 桥接没连上时编辑器整体不出现、换成去向说明——不是空配置，也不是报错
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { BridgeStatus, DshSurface, ModelCatalogFile, ModelConfig } from "@/shared/types";
import { MODEL_PRESETS } from "./shared";
import { ModelsView } from "./ModelsView";

const preset = MODEL_PRESETS.find((item) => item.id === "openai")!;
// 每次给新对象：同一个引用会让 React 跳过重渲染，掩盖「切档后没重拉」这类问题
const configFor = (surface: DshSurface): ModelConfig => ({
  defaultProvider: "openai",
  defaultModel: preset.modelIds[0]!,
  defaultReasoningEffort: null,
  providers: [
    {
      route: "openai",
      displayName: surface === "web" ? "OpenAI (web)" : "OpenAI (desktop)",
      baseURL: null,
      api: null,
      apiKeyEnv: "OPENAI_API_KEY",
      models: [],
      headers: null,
      timeoutMs: null,
      reasoning: null,
      extra: null,
    },
  ],
});
const catalog: ModelCatalogFile = { fetchedAt: Math.floor(Date.now() / 1000), providers: [], models: [] };
const bridge = (state: BridgeStatus["state"]): BridgeStatus => ({
  state,
  protocol: state === "connected" ? 1 : null,
  expectedProtocol: 1,
  installSpec: "@sperictao/dsh-pro-max-bridge@0.1.5",
});
const configWith = (surfaces: DshSurface[]) => ({
  minimize_to_tray_on_close: false,
  language: "en",
  managed_surfaces: surfaces,
  dsh_admin_cap_domain: "",
  dsh_use_cap_domain: "",
  dsh_extra_allowed_logins: "",
  market_catalog_url: "",
});

beforeEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({
    toasts: [],
    modelConfigBusy: false,
    config: configWith(["web", "desktop"]),
    desktopStatus: null,
    desktopBridge: null,
    desktopChecked: false,
  });
  vi.spyOn(cmd, "desktopDetect").mockResolvedValue({
    supported: true,
    installed: true,
    version: "0.2.0-rc.2",
    running: true,
    canQuit: true,
  });
  vi.spyOn(cmd, "modelConfigLoad").mockImplementation(async (surface) => configFor(surface));
  vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
  vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(catalog);
  vi.spyOn(cmd, "modelCatalogRefresh").mockResolvedValue(catalog);
  vi.spyOn(cmd, "modelCredentialStatus").mockResolvedValue({ OPENAI_API_KEY: true });
});

describe("ModelsView target surface", () => {
  it("switches to the desktop surface and reads and writes through it", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "desktopBridgeStatus").mockResolvedValue(bridge("connected"));
    render(createElement(ModelsView));

    expect(await screen.findByText("OpenAI (web)")).toBeInTheDocument();
    expect(cmd.modelConfigLoad).toHaveBeenLastCalledWith("web");

    await user.click(screen.getByRole("button", { name: "Desktop" }));
    expect(await screen.findByText("OpenAI (desktop)")).toBeInTheDocument();
    expect(cmd.modelConfigLoad).toHaveBeenLastCalledWith("desktop");
    // web 档的编辑状态不串过来
    expect(screen.queryByText("OpenAI (web)")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Reasoning Effort"), "medium");
    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledTimes(1));
    expect(vi.mocked(cmd.modelConfigSave).mock.calls[0][0]).toBe("desktop");
  });

  it("explains the bridge state instead of showing an empty editor when the bridge is not connected", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "desktopBridgeStatus").mockResolvedValue(bridge("app_unavailable"));
    render(createElement(ModelsView));
    await screen.findByText("OpenAI (web)");

    await user.click(screen.getByRole("button", { name: "Desktop" }));
    expect(
      await screen.findByText("Open DeepSeek Harness to manage its plugins and configuration."),
    ).toBeInTheDocument();
    expect(cmd.modelConfigLoad).not.toHaveBeenCalledWith("desktop");
    expect(document.getElementById("models-default")).toBeNull();
  });

  // 真机发现：切到 desktop 档后编辑器加载期间页头整块消失，形态切换跟着闪没——
  // 慢加载时用户连切回去的入口都没有
  it("keeps the surface switch on screen while the other surface loads", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "desktopBridgeStatus").mockResolvedValue(bridge("connected"));
    render(createElement(ModelsView));
    await screen.findByText("OpenAI (web)");

    let release: (config: ModelConfig) => void = () => {};
    vi.mocked(cmd.modelConfigLoad).mockImplementation(
      (surface) => new Promise((resolve) => (release = () => resolve(configFor(surface)))),
    );
    await user.click(screen.getByRole("button", { name: "Desktop" }));
    await waitFor(() => expect(cmd.modelConfigLoad).toHaveBeenLastCalledWith("desktop"));
    expect(screen.getByText("Detecting…")).toBeInTheDocument();
    expect(document.getElementById("models-surface")).not.toBeNull();

    release(configFor("desktop"));
    expect(await screen.findByText("OpenAI (desktop)")).toBeInTheDocument();
  });

  // 桌面状态全应用一份：别的页面留下的「已连接」可能已经过期。进门要以这次探测为准，
  // 否则桥接刚断时编辑器先挂上、读一次注定失败的配置、弹一条错误
  it("does not trust a stale connected state left by another page", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ desktopBridge: bridge("connected"), desktopChecked: true });
    vi.spyOn(cmd, "desktopBridgeStatus").mockResolvedValue(bridge("app_unavailable"));
    render(createElement(ModelsView));
    await screen.findByText("OpenAI (web)");

    await user.click(screen.getByRole("button", { name: "Desktop" }));
    expect(
      await screen.findByText("Open DeepSeek Harness to manage its plugins and configuration."),
    ).toBeInTheDocument();
    expect(cmd.modelConfigLoad).not.toHaveBeenCalledWith("desktop");
    expect(useAppStore.getState().toasts.filter((toast) => toast.type === "error")).toHaveLength(0);
  });

  it("shows no switch when only one surface is managed", async () => {
    useAppStore.setState({ config: configWith(["desktop"]) });
    vi.spyOn(cmd, "desktopBridgeStatus").mockResolvedValue(bridge("connected"));
    render(createElement(ModelsView));

    expect(await screen.findByText("OpenAI (desktop)")).toBeInTheDocument();
    expect(document.getElementById("models-surface")).toBeNull();
    expect(cmd.modelConfigLoad).not.toHaveBeenCalledWith("web");
  });
});
