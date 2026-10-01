// 插件市场按目标形态参数化（ADR 0012）：两档都纳管时卡片按形态分行、角标标出装在哪几档；
// 两档同一套命令、按 surface 分派：desktop 档的写入只带 "desktop"，绝不落到 web 档上；desktop 档不可知时
// 如实显示「?」而不是「未安装」
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type {
  DesktopInstalledPlugin,
  DshSurface,
  InstalledPlugin,
  InstallOutcome,
  MarketCatalog,
  PluginUpdateInfo,
} from "@/shared/types";
import { MarketView, desktopMatchKey } from "./MarketView";

vi.mock("@/features/integration/dshActions", () => ({ restartDshWeb: vi.fn() }));

const plugin = (name: string) => ({
  fullName: `owner/${name}`,
  name,
  description: { en: `${name} plugin` },
  url: `https://github.com/owner/${name}`,
  stars: 10,
  category: "ui",
  installSpecifier: `${name}@latest`,
  deprecated: false,
  replacement: null,
});

const catalog: MarketCatalog = {
  updated: "2026-10-01",
  categories: { ui: { en: "UI", zh: "UI" } },
  total: 3,
  fromSnapshot: false,
  plugins: [plugin("both"), plugin("desk-only"), plugin("neither")],
};

const webInstalled: InstalledPlugin[] = [
  { name: "both", spec: "both@1.0.0", version: "1.0.0", upstreamRepo: null, managed: false, enabled: true },
];

const desktopInstalled: DesktopInstalledPlugin[] = [
  { name: "both", version: "1.0.0", enabled: true, managed: false },
  { name: "desk-only", version: "0.3.0", enabled: false, managed: false },
  { name: "@sperictao/dsh-pro-max-bridge", version: "0.1.5", enabled: true, managed: true },
];

const configWith = (surfaces: DshSurface[]) => ({
  minimize_to_tray_on_close: false,
  language: "en",
  managed_surfaces: surfaces,
  dsh_admin_cap_domain: "",
  dsh_use_cap_domain: "",
  dsh_extra_allowed_logins: "",
  market_catalog_url: "",
});

const installedOutcome = (name: string, spec: string): InstallOutcome => ({
  status: "installed",
  receipt: { name, spec },
  notices: [],
});

const updateInfo = (name: string, installed: string, latest: string): PluginUpdateInfo => ({
  name,
  spec: null,
  managed: false,
  installedVersion: installed,
  latestVersion: latest,
  latestInReleaseAgeWindow: false,
  latestPublishTime: null,
  requiresDsh: null,
  compatible: null,
  updateAvailable: true,
});

/// 卡片按插件名找（标题是按钮或文字，取最近的 article）
async function card(name: string): Promise<HTMLElement> {
  const title = await screen.findByText(name, { selector: "button, span" });
  return title.closest("article") as HTMLElement;
}

beforeAll(() => {
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { IntersectionObserver: typeof IO }).IntersectionObserver = IO;
});

beforeEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({
    config: configWith(["web", "desktop"]),
    marketCatalog: null,
    marketCatalogBusy: false,
    marketInstalled: [],
    marketInstalledBusy: false,
    marketDesktopInstalled: null,
    desktopStatus: null,
    desktopBridge: null,
    desktopChecked: false,
    marketInstalling: null,
    marketInstallLog: null,
    marketInstallError: null,
    marketRemoving: null,
    marketPendingApproval: null,
    marketReleaseAgeConfirm: null,
    marketUpdates: { web: null, desktop: null },
    marketUpdatesBusy: { web: false, desktop: false },
    marketUpdating: null,
    marketUpdateAllQueue: null,
    marketUpdateAllQueueSurfaces: null,
    marketUpdateAllOk: 0,
    marketUpdateAllFailed: 0,
    marketUpdateAllPrefetching: false,
    marketFavorites: [],
    marketCompat: {},
    marketReleaseNotes: null,
    toasts: [],
  });
  vi.spyOn(cmd, "marketFetch").mockResolvedValue(catalog);
  vi.spyOn(cmd, "marketSnapshot").mockResolvedValue(null);
  // 每次给新数组：重拉是真 IPC，同一引用会让 React 跳过重渲染、掩盖「没刷新」
  vi.spyOn(cmd, "marketInstalled").mockImplementation(async () => structuredClone(webInstalled));
  vi.spyOn(cmd, "marketDesktopInstalled").mockImplementation(async () => structuredClone(desktopInstalled));
  vi.spyOn(cmd, "marketCheckUpdates").mockResolvedValue([]);
  vi.spyOn(cmd, "marketDiscoveryCompat").mockResolvedValue([]);
  vi.spyOn(cmd, "marketReleaseNotes").mockResolvedValue(null);
  vi.spyOn(cmd, "marketInstall").mockImplementation(async (surface) =>
    surface === "web" ? installedOutcome("x", "x@1.0.0") : installedOutcome("x", "1.0.0"),
  );
  vi.spyOn(cmd, "marketRemove").mockResolvedValue("applied");
  vi.spyOn(cmd, "marketSetPluginEnabled").mockResolvedValue("applied");
  vi.spyOn(cmd, "desktopDetect").mockResolvedValue({
    supported: true,
    installed: true,
    version: "0.2.0-rc.2",
    running: true,
    canQuit: true,
  });
});

describe("desktop installed match", () => {
  // 桌面档只有 bundle 名可比：npm: 前缀要剥、目录名的大小写不能让匹配落空
  it("keys by package name, falling back to the catalog name, case-insensitively", () => {
    expect(desktopMatchKey("npm:dsh-better-sidebar@latest", "DSH-better-sidebar")).toBe("dsh-better-sidebar");
    expect(desktopMatchKey("@scope/Pkg@1.0.0", "x")).toBe("@scope/pkg");
    expect(desktopMatchKey("github:owner/Repo", "DSH-Repo")).toBe("dsh-repo");
    expect(desktopMatchKey(null, "Manual")).toBe("manual");
  });
});

describe("surface badges", () => {
  it("names every surface a plugin is installed on", async () => {
    render(createElement(MarketView));

    // 角标与行首的形态标签同名：按角标自己的标记取
    const badge = (scope: HTMLElement, label: string) => within(scope).queryByText(label, { selector: "[data-surface]" });
    const both = await card("both");
    await waitFor(() => expect(badge(both, "Desktop")).toBeInTheDocument());
    expect(badge(both, "Web")).toBeInTheDocument();
    expect(within(both).getByText("Installed")).toBeInTheDocument();

    const deskOnly = await card("desk-only");
    expect(badge(deskOnly, "Desktop")).toBeInTheDocument();
    expect(badge(deskOnly, "Web")).not.toBeInTheDocument();
    expect(within(deskOnly).getByText("Installed")).toBeInTheDocument();

    const neither = await card("neither");
    expect(within(neither).getByText("Not installed")).toBeInTheDocument();
    expect(badge(neither, "Desktop")).not.toBeInTheDocument();
  });

  // 桥接没连上：桌面档的事实不可知，必须说「?」并给原因，不能落成「未安装」——
  // 那会让人去重装一个其实已经装着的插件
  it("marks the desktop surface unknown instead of not installed when the bridge is down", async () => {
    vi.spyOn(cmd, "marketDesktopInstalled").mockRejectedValue(new Error("bridge down"));
    vi.spyOn(cmd, "desktopBridgeStatus").mockResolvedValue({
      state: "app_unavailable",
      protocol: null,
      expectedProtocol: 1,
      installSpec: "@sperictao/dsh-pro-max-bridge@0.1.5",
    });
    render(createElement(MarketView));

    const deskOnly = await card("desk-only");
    const unknown = await within(deskOnly).findByText("Desktop ?");
    expect(unknown).toHaveAttribute("title", "Open DeepSeek Harness to see what is installed there.");
    expect(within(deskOnly).getByText("Unknown — DeepSeek Harness is not connected")).toBeInTheDocument();
    // 不可知的那一行没有安装入口：装不了，也不该假装能装
    expect(within(deskOnly).getAllByRole("button", { name: /^Install/ })).toHaveLength(1);
    expect(within(deskOnly).getByRole("button", { name: "Install desk-only (Web)" })).toBeInTheDocument();
  });
});

describe("installing per surface", () => {
  it("installs into the desktop surface through the bridge only", async () => {
    const user = userEvent.setup();
    render(createElement(MarketView));

    const neither = await card("neither");
    await waitFor(() => expect(within(neither).getAllByRole("button", { name: /^Install/ })).toHaveLength(2));
    await user.click(within(neither).getByRole("button", { name: "Install neither (Desktop)" }));
    await user.click(within(neither).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(cmd.marketInstall).toHaveBeenCalledWith("desktop", "neither@latest"));
    expect(cmd.marketInstall).not.toHaveBeenCalledWith("web", expect.anything());
  });

  // 两档都装：按顺序逐档装、各自报结果——web 失败不阻止 desktop，desktop 成功不被回滚
  it("installs to both surfaces in order and reports each on its own", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "marketInstall").mockImplementation(async (surface) => {
      if (surface === "web") throw { key: "registry unreachable", args: {} };
      return installedOutcome("neither", "1.0.0");
    });
    render(createElement(MarketView));

    const neither = await card("neither");
    await waitFor(() => expect(within(neither).getAllByRole("button", { name: /^Install/ })).toHaveLength(2));
    await user.click(within(neither).getByRole("button", { name: "Install neither (Web)" }));
    await user.click(within(neither).getByRole("button", { name: "Install to both" }));

    await waitFor(() => expect(cmd.marketInstall).toHaveBeenCalledWith("desktop", "neither@latest"));
    // 按卡上的形态顺序逐档装：web 先
    expect(vi.mocked(cmd.marketInstall).mock.calls.map((call) => call[0])).toEqual(["web", "desktop"]);
    const messages = useAppStore.getState().toasts.map((toast) => toast.message);
    expect(messages).toContain("Plugin installed in DeepSeek Harness: neither (1.0.0)");
    expect(messages.some((message) => message.startsWith("Failed to install plugin"))).toBe(true);
    // web 那一行的失败留在它那一行，没被 desktop 那次开始顺手抹掉
    expect(useAppStore.getState().marketInstallError?.surface).toBe("web");
  });

  it("approves desktop build scripts by handing them back to the desktop app, then installs the remaining surface", async () => {
    const user = userEvent.setup();
    vi.spyOn(cmd, "marketInstall").mockImplementation(async (surface, _specifier, approved) =>
      surface === "desktop" && !approved
        ? { status: "needsApproval", packages: ["sharp"], workspaceYaml: null }
        : installedOutcome("neither", "1.0.0"),
    );
    // 审批挂在第一档（desktop）上；排在后面的 web 要等审批落定再装
    await useAppStore.getState().installMarketPlugin("neither@latest", "neither", ["desktop", "web"]);
    expect(cmd.marketInstall).not.toHaveBeenCalledWith("web", expect.anything());
    render(createElement(MarketView));

    const dialog = await screen.findByRole("dialog");
    // desktop 档没有 Launcher 要写的文件：说法换成「由桌面应用记录」
    expect(
      within(dialog).getByText(
        "Install scripts run arbitrary code as your user. pnpm blocks them by default; approving lets DeepSeek Harness record your choice in its own profile and retries the install there.",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Approve & install" }));

    // 放行名单原样交回桌面档（应用自己记录放行），不落到 web 档
    await waitFor(() => expect(cmd.marketInstall).toHaveBeenCalledWith("desktop", "neither@latest", ["sharp"]));
    expect(cmd.marketInstall).not.toHaveBeenCalledWith("web", expect.anything(), expect.anything());
    await waitFor(() => expect(cmd.marketInstall).toHaveBeenCalledWith("web", "neither@latest"));
  });

  it("still installs the remaining surface when the user keeps the scripts blocked", async () => {
    vi.spyOn(cmd, "marketInstall").mockImplementation(async (surface) =>
      surface === "desktop"
        ? { status: "needsApproval", packages: ["sharp"], workspaceYaml: null }
        : installedOutcome("neither", "neither@1.0.0"),
    );
    await useAppStore.getState().installMarketPlugin("neither@latest", "neither", ["desktop", "web"]);

    useAppStore.getState().dismissMarketApproval();

    await waitFor(() => expect(cmd.marketInstall).toHaveBeenCalledWith("web", "neither@latest"));
    expect(useAppStore.getState().toasts.map((toast) => toast.message)).toContain(
      "Build scripts not approved. The plugin was not installed in DeepSeek Harness.",
    );
  });
});

describe("installed page", () => {
  async function openInstalled() {
    const user = userEvent.setup();
    render(createElement(MarketView));
    await user.click(screen.getByRole("button", { name: "Installed" }));
    return user;
  }

  it("merges both surfaces into one card per plugin with a row each", async () => {
    await openInstalled();
    const both = await card("both");
    await waitFor(() => expect(within(both).getByRole("button", { name: "Remove both (Desktop)" })).toBeInTheDocument());
    expect(within(both).getByRole("button", { name: "Remove both (Web)" })).toBeInTheDocument();
    // 桥接自己在列、但受管：不给移除也不给停用
    const bridge = await card("@sperictao/dsh-pro-max-bridge");
    expect(within(bridge).queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(within(bridge).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(bridge).getByText("managed by launcher")).toBeInTheDocument();
  });

  it("removes and toggles on the desktop surface through the bridge, never through the web profile", async () => {
    const user = await openInstalled();
    const both = await card("both");
    await user.click(await within(both).findByRole("button", { name: "Remove both (Desktop)" }));
    await waitFor(() => expect(cmd.marketRemove).toHaveBeenCalledWith("desktop", "both"));
    expect(cmd.marketRemove).not.toHaveBeenCalledWith("web", expect.anything());

    const deskOnly = await card("desk-only");
    await user.click(within(deskOnly).getByRole("switch", { name: "Enable desk-only" }));
    await waitFor(() => expect(cmd.marketSetPluginEnabled).toHaveBeenCalledWith("desktop", "desk-only", true));
    expect(cmd.marketSetPluginEnabled).not.toHaveBeenCalledWith("web", expect.anything(), expect.anything());
  });

  it("says where a desktop change went when the app needs a restart", async () => {
    vi.spyOn(cmd, "marketRemove").mockResolvedValue("restart-required");
    await useAppStore.getState().removeMarketPlugin({ surface: "desktop", name: "both" });
    const toasts = useAppStore.getState().toasts;
    expect(toasts.map((toast) => toast.message)).toContain("Restart DeepSeek Harness to apply this change.");
    expect(toasts.map((toast) => toast.type)).not.toContain("error");
  });

  // desktop 档拿不到安装 spec：更新一律钉检测到的精确版本，不走 @latest（会被发布冷却
  // 静默解析到旧版），也不弹 web 档那道供应链窗口确认
  it("updates a desktop plugin by pinning the exact latest version", async () => {
    vi.spyOn(cmd, "marketCheckUpdates").mockImplementation(async (surface) =>
      surface === "desktop" ? [updateInfo("desk-only", "0.3.0", "0.4.0")] : [],
    );
    vi.spyOn(cmd, "marketInstall").mockResolvedValue(installedOutcome("desk-only", "0.4.0"));
    const user = await openInstalled();

    const deskOnly = await card("desk-only");
    await user.click(await within(deskOnly).findByRole("button", { name: "Update desk-only" }));
    // 先过更新说明对话框（G5），确认后才进更新管线
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Update" }));

    await waitFor(() => expect(cmd.marketInstall).toHaveBeenCalledWith("desktop", "desk-only@0.4.0"));
    expect(cmd.marketInstall).not.toHaveBeenCalledWith("web", expect.anything());
    expect(useAppStore.getState().marketReleaseAgeConfirm).toBeNull();
  });

  it("updates both surfaces in one batch", async () => {
    vi.spyOn(cmd, "marketCheckUpdates").mockImplementation(async (surface) =>
      surface === "web" ? [updateInfo("both", "1.0.0", "2.0.0")] : [updateInfo("desk-only", "0.3.0", "0.4.0")],
    );
    vi.spyOn(cmd, "marketPrefetch").mockResolvedValue(undefined);
    const user = await openInstalled();

    await user.click(await screen.findByRole("button", { name: "Update all (2)" }));

    await waitFor(() => expect(cmd.marketInstall).toHaveBeenCalledWith("desktop", "desk-only@0.4.0"));
    expect(cmd.marketInstall).toHaveBeenCalledWith("web", "both@latest");
    // 预热只对 web 档：desktop 档的安装在应用里跑，预热不到它的 store
    expect(cmd.marketPrefetch).toHaveBeenCalledWith(["both@latest"]);
    await waitFor(() => expect(useAppStore.getState().marketUpdateAllQueue).toBeNull());
  });
});
