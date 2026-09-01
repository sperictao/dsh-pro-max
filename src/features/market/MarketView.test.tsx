import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { InstalledPlugin, MarketCatalog } from "@/shared/types";
import { MarketView, packageNameFromSpecifier } from "./MarketView";

const catalog: MarketCatalog = {
  updated: "2026-08-30",
  categories: { ui: { en: "UI Enhancements", zh: "UI 增强" } },
  total: 2,
  fromSnapshot: false,
  plugins: [
    {
      fullName: "omdsh-dev/DSH-better-sidebar",
      name: "DSH-better-sidebar",
      description: { en: "Sidebar toolkit", zh: "侧边栏底座" },
      url: "https://github.com/omdsh-dev/DSH-better-sidebar",
      stars: 3120,
      category: "ui",
      installSpecifier: "dsh-better-sidebar@latest",
      deprecated: false,
      replacement: null,
    },
    {
      fullName: "some/one",
      name: "one",
      description: { en: "no candidate" },
      url: "https://github.com/some/one",
      stars: null,
      category: "ui",
      installSpecifier: null,
      deprecated: true,
      replacement: "DSH-better-sidebar",
    },
  ],
};

const installed: InstalledPlugin[] = [
  { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@1.0.0", managed: false },
  { name: "@dsh-external/dsh-auth-tailscale", spec: "file:/x.tgz", managed: true },
];

beforeAll(() => {
  // jsdom 无 IntersectionObserver（滚动加载用），测试桩掉
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { IntersectionObserver: typeof IO }).IntersectionObserver = IO;
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({
    marketCatalog: null,
    marketCatalogBusy: false,
    marketInstalled: [],
    marketInstalledBusy: false,
    marketInstalling: null,
    marketRemoving: null,
    marketPendingApproval: null,
    toasts: [],
  });
  vi.spyOn(cmd, "marketFetch").mockResolvedValue(catalog);
  vi.spyOn(cmd, "marketSnapshot").mockResolvedValue(null);
  vi.spyOn(cmd, "marketInstalled").mockResolvedValue(installed);
  vi.spyOn(cmd, "marketApproveBuilds").mockResolvedValue(null);
  vi.spyOn(cmd, "marketCheckUpdates").mockResolvedValue([]);
});

describe("packageNameFromSpecifier", () => {
  it("extracts the npm package name from install specifiers", () => {
    expect(packageNameFromSpecifier("dsh-better-sidebar@latest")).toBe("dsh-better-sidebar");
    expect(packageNameFromSpecifier("@scope/pkg@1.0.0")).toBe("@scope/pkg");
    expect(packageNameFromSpecifier("plain-name")).toBe("plain-name");
    // 任何带协议前缀的形态（github:/npm:/file: 等）安装后的 dependencies 键
    // 无法预知，不参与已装匹配；与 Rust 侧同一套语义
    expect(packageNameFromSpecifier("github:owner/repo#c0ffee")).toBeNull();
    expect(packageNameFromSpecifier("npm:pkg@latest")).toBeNull();
    expect(packageNameFromSpecifier("file:/x/y.tgz")).toBeNull();
  });
});

describe("MarketView", () => {
  it("lands on the Discover tab by default without the installed list", async () => {
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    // 已装列表收敛到二级导航的 Installed 页，发现页只有目录
    expect(screen.queryByText("managed by launcher")).not.toBeInTheDocument();
    expect(screen.queryByText("npm:dsh-better-sidebar@1.0.0")).not.toBeInTheDocument();
  });

  it("shows the installed list on the Installed tab and switches back", async () => {
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    expect(await screen.findByText("managed by launcher")).toBeInTheDocument();
    expect(screen.getByText("npm:dsh-better-sidebar@1.0.0")).toBeInTheDocument();
    expect(screen.queryByText("★ 3,120")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Discover" }));
    await waitFor(() => expect(screen.getByText("★ 3,120")).toBeInTheDocument());
    expect(screen.queryByText("managed by launcher")).not.toBeInTheDocument();
  });

  it("installed tab renders catalog-consistent cards and marks available updates", async () => {
    // npm 包名大小写敏感：目录名与已装键精确一致才能补全描述/星标
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([
      { name: "DSH-better-sidebar", spec: "dsh-better-sidebar@1.0.0", managed: false },
      { name: "@dsh-external/dsh-auth-tailscale", spec: "file:/x.tgz", managed: true },
    ]);
    vi.spyOn(cmd, "marketCheckUpdates").mockResolvedValue([
      {
        name: "DSH-better-sidebar",
        spec: "dsh-better-sidebar@1.0.0",
        managed: false,
        installedVersion: "1.0.0",
        latestVersion: "2.0.0",
        updateAvailable: true,
      },
      {
        name: "@dsh-external/dsh-auth-tailscale",
        spec: "file:/x.tgz",
        managed: true,
        installedVersion: null,
        latestVersion: null,
        updateAvailable: false,
      },
    ]);
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    // 目录匹配的描述与星标上卡（与发现页同一观感）
    expect(await screen.findByText("Sidebar toolkit")).toBeInTheDocument();
    expect(screen.getByText("★ 3,120")).toBeInTheDocument();
    // 版本对比 + 更新按钮；受管插件不出更新/移除按钮，只有受管标记
    expect(screen.getByText(/v1\.0\.0/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update DSH-better-sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove DSH-better-sidebar" })).toBeInTheDocument();
    expect(screen.getAllByText("managed by launcher").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /@dsh-external/ })).not.toBeInTheDocument();
  });

  it("update all installs every outdated plugin via name@latest and toasts the summary", async () => {
    vi.spyOn(cmd, "marketCheckUpdates").mockResolvedValue([
      {
        name: "dsh-better-sidebar",
        spec: "npm:dsh-better-sidebar@1.0.0",
        managed: false,
        installedVersion: "1.0.0",
        latestVersion: "2.0.0",
        updateAvailable: true,
      },
    ]);
    const installSpy = vi.spyOn(cmd, "marketInstall").mockResolvedValue({
      status: "installed",
      receipt: { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@2.0.0" },
    });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: "Update all (1)" }));
    // 更新 = 以 name@latest 重装（与安装同一闸门与审计路径）
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith("dsh-better-sidebar@latest"));
    await waitFor(() =>
      expect(useAppStore.getState().toasts.map((t) => t.message)).toContainEqual("Updated 1 plugins"),
    );
  });

  it("single update button reinstalls the plugin at latest and re-checks updates", async () => {
    const checkSpy = vi.spyOn(cmd, "marketCheckUpdates").mockResolvedValue([
      {
        name: "dsh-better-sidebar",
        spec: "npm:dsh-better-sidebar@1.0.0",
        managed: false,
        installedVersion: "1.0.0",
        latestVersion: "2.0.0",
        updateAvailable: true,
      },
    ]);
    const installSpy = vi.spyOn(cmd, "marketInstall").mockResolvedValue({
      status: "installed",
      receipt: { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@2.0.0" },
    });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: "Update dsh-better-sidebar" }));
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith("dsh-better-sidebar@latest"));
    await waitFor(() =>
      expect(useAppStore.getState().toasts.map((t) => t.message)).toContainEqual(
        "Plugin updated: dsh-better-sidebar (npm:dsh-better-sidebar@2.0.0)",
      ),
    );
    expect(checkSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("renders catalog entries with install state on the Discover tab", async () => {
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    // 目录两条；npm candidate 已装 → Installed 徽章（与同名二级导航按钮并存）；
    // 无 candidate → Manual install only
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getAllByText("Installed").length).toBeGreaterThan(0);
    expect(screen.getByText("Manual install only")).toBeInTheDocument();
    // stars null（目录暂无数据）不渲染数字，不静默当 0
    expect(screen.getByText("★ 3,120")).toBeInTheDocument();
    expect(screen.queryByText("★ 0")).not.toBeInTheDocument();
  });

  it("search filter narrows the visible list", async () => {
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("Search plugins…"), "better-sidebar");
    await waitFor(() => expect(screen.queryByText("one")).not.toBeInTheDocument());
    expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument();
  });

  it("shows the native deprecated badge and replacement hint", async () => {
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("one")).toBeInTheDocument());
    // 目录侧弃用标记原样透传：徽章 + 替代建议
    expect(screen.getByText("Deprecated")).toBeInTheDocument();
    expect(screen.getByText("Deprecated — consider DSH-better-sidebar instead.")).toBeInTheDocument();
  });

  it("shows the snapshot banner when the catalog comes from the local snapshot", async () => {
    useAppStore.setState({ marketCatalog: { ...catalog, fromSnapshot: true } });
    render(createElement(MarketView));
    const banner = await screen.findByText("Network unavailable — showing the local catalog snapshot from 2026-08-30.");
    expect(banner).toBeInTheDocument();
  });

  it("toasts the install receipt with the landed name and spec", async () => {
    // 未装状态才能出现 Install 按钮（覆盖 beforeEach 的默认已装 mock，
    // 否则 useEffect 的刷新会把 fixture 灌回去）
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([]);
    useAppStore.setState({ marketInstalled: [] });
    vi.spyOn(cmd, "marketInstall").mockResolvedValue({
      status: "installed",
      receipt: { name: "dsh-better-sidebar", spec: "dsh-better-sidebar@1.2.3" },
    });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Install" }));
    await user.click(await screen.findByText("Confirm"));
    await waitFor(() =>
      expect(useAppStore.getState().toasts.map((t) => t.message)).toContainEqual(
        "Plugin installed: dsh-better-sidebar (dsh-better-sidebar@1.2.3)",
      ),
    );
  });

  it("surfaces the build approval dialog when pnpm blocks install scripts", async () => {
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([]);
    useAppStore.setState({ marketInstalled: [] });
    vi.spyOn(cmd, "marketInstall").mockResolvedValue({
      status: "needsApproval",
      packages: ["node-pty@1.1.0"],
      workspaceYaml: "~/.dsh/profiles/web/pnpm-workspace.yaml",
    });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Install" }));
    await user.click(await screen.findByText("Confirm"));
    // 对话框列出被拦包名与写入路径；安装不当失败处理（无 error toast）
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("node-pty@1.1.0")).toBeInTheDocument();
    expect(useAppStore.getState().marketPendingApproval?.specifier).toBe("dsh-better-sidebar@latest");
    expect(useAppStore.getState().toasts.map((t) => t.type)).not.toContain("error");
  });

  it("approving writes the allowlist via marketApproveBuilds and toasts the receipt", async () => {
    const approveSpy = vi
      .spyOn(cmd, "marketApproveBuilds")
      .mockResolvedValue({ name: "dsh-better-sidebar", spec: "dsh-better-sidebar@1.2.3" });
    useAppStore.setState({
      marketPendingApproval: {
        specifier: "dsh-better-sidebar@latest",
        label: "DSH-better-sidebar",
        packages: ["node-pty"],
        workspaceYaml: "~/.dsh/profiles/web/pnpm-workspace.yaml",
      },
    });
    const user = userEvent.setup();
    render(createElement(MarketView));

    await user.click(await screen.findByText("Approve & install"));
    await waitFor(() => expect(approveSpy).toHaveBeenCalledWith("dsh-better-sidebar@latest", ["node-pty"]));
    await waitFor(() =>
      expect(useAppStore.getState().toasts.map((t) => t.message)).toContainEqual(
        "Plugin installed: dsh-better-sidebar (dsh-better-sidebar@1.2.3)",
      ),
    );
    expect(useAppStore.getState().marketPendingApproval).toBeNull();
  });

  it("dismissing clears the pending approval and explains the manual path", async () => {
    useAppStore.setState({
      marketPendingApproval: {
        specifier: "dsh-better-sidebar@latest",
        label: "DSH-better-sidebar",
        packages: ["node-pty"],
        workspaceYaml: "~/.dsh/profiles/web/pnpm-workspace.yaml",
      },
    });
    const user = userEvent.setup();
    render(createElement(MarketView));

    await user.click(screen.getByText("Cancel"));
    expect(useAppStore.getState().marketPendingApproval).toBeNull();
    expect(useAppStore.getState().toasts.map((t) => t.type)).toContain("info");
    expect(cmd.marketApproveBuilds).not.toHaveBeenCalled();
  });

  it("shows the local snapshot instantly and replaces it once the fetch lands", async () => {
    const snapshot = { ...catalog, fromSnapshot: true };
    let resolveFetch: (c: MarketCatalog) => void = () => {};
    vi.spyOn(cmd, "marketSnapshot").mockResolvedValue(snapshot);
    vi.spyOn(cmd, "marketFetch").mockImplementation(
      () =>
        new Promise<MarketCatalog>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    render(createElement(MarketView));

    // 快照先行：内容立即上屏，不等网络下载
    expect(await screen.findByText("DSH-better-sidebar")).toBeInTheDocument();
    // 刷新进行中横幅不出现（busy 中等结果落定），快照数据如实带 fromSnapshot
    expect(screen.queryByText(/Network unavailable/)).not.toBeInTheDocument();
    expect(useAppStore.getState().marketCatalog?.fromSnapshot).toBe(true);

    // 网络目录到达后整体替换为在线数据
    resolveFetch({ ...catalog, fromSnapshot: false });
    await waitFor(() => expect(useAppStore.getState().marketCatalog?.fromSnapshot).toBe(false));
    expect(screen.queryByText(/Network unavailable/)).not.toBeInTheDocument();
  });

  it("keeps the snapshot silently and banners it when the background refresh fails", async () => {
    vi.spyOn(cmd, "marketSnapshot").mockResolvedValue({ ...catalog, fromSnapshot: true });
    vi.spyOn(cmd, "marketFetch").mockRejectedValue(new Error("network down"));
    render(createElement(MarketView));

    await screen.findByText("DSH-better-sidebar");
    await waitFor(() => expect(useAppStore.getState().marketCatalogBusy).toBe(false));
    // 已有内容时后台刷新失败不弹 toast，快照横幅在 busy 结束后如实出现
    expect(useAppStore.getState().toasts.map((t) => t.type)).not.toContain("error");
    expect(
      await screen.findByText("Network unavailable — showing the local catalog snapshot from 2026-08-30."),
    ).toBeInTheDocument();
    expect(useAppStore.getState().marketCatalog?.fromSnapshot).toBe(true);
  });

  it("toasts when a forced refresh fails even with content on screen", async () => {
    useAppStore.setState({ marketCatalog: { ...catalog, fromSnapshot: false } });
    vi.spyOn(cmd, "marketFetch").mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(createElement(MarketView));

    // 内存已有目录 → 挂载不触发拉取；Refresh 是用户主动操作，失败必须反馈
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(useAppStore.getState().toasts.map((t) => t.message)).toContainEqual(
        "Failed to load plugin catalog: Error: boom",
      ),
    );
  });
});
