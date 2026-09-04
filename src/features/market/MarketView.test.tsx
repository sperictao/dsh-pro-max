import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { InstalledPlugin, InstallOutcome, MarketCatalog } from "@/shared/types";
import vectorsJson from "../../../src-tauri/src/dsh/specifier_cases.json";

interface SpecifierVectors {
  packageNameFromSpecifier: [string, string | null][];
  specifierToCatalogName: [string, string][];
}
const vectors = vectorsJson as SpecifierVectors;
import { MarketView, packageNameFromSpecifier, protocolInstalledMatch, specifierToCatalogName } from "./MarketView";

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

// vitest globals: false，jsdom 的 localStorage 不保证就绪：收藏持久化断言用测试桩（DshCard.test 同款）
const storedValues = new Map<string, string>();
const testLocalStorage = {
  getItem: (key: string) => storedValues.get(key) ?? null,
  removeItem: (key: string) => {
    storedValues.delete(key);
  },
  setItem: (key: string, value: string) => {
    storedValues.set(key, String(value));
  },
  clear: () => storedValues.clear(),
};

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
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: testLocalStorage });
  testLocalStorage.clear();
  useAppStore.setState({
    marketCatalog: null,
    marketCatalogBusy: false,
    marketInstalled: [],
    marketInstalledBusy: false,
    marketInstalling: null,
    marketInstallLog: null,
    marketInstallError: null,
    marketRemoving: null,
    marketPendingApproval: null,
    marketReleaseAgeConfirm: null,
    marketFavorites: [],
    toasts: [],
  });
  vi.spyOn(cmd, "marketFetch").mockResolvedValue(catalog);
  vi.spyOn(cmd, "marketSnapshot").mockResolvedValue(null);
  vi.spyOn(cmd, "marketInstalled").mockResolvedValue(installed);
  vi.spyOn(cmd, "marketApproveBuilds").mockResolvedValue(null);
  vi.spyOn(cmd, "marketCheckUpdates").mockResolvedValue([]);
});

// 语义定义只有一份：specifier_cases.json（Rust 侧同名解析器由同一向量表驱动，
// 两侧漂移在一侧测试立即失败）。本组只断言 TS 实现与向量表一致
describe("specifier parsers match the shared test vectors", () => {
  it("packageNameFromSpecifier matches every vector", () => {
    for (const [input, expectName] of vectors.packageNameFromSpecifier) {
      expect(packageNameFromSpecifier(input)).toBe(expectName);
    }
  });
  it("specifierToCatalogName matches every vector", () => {
    for (const [input, expectName] of vectors.specifierToCatalogName) {
      expect(specifierToCatalogName(input)).toBe(expectName);
    }
  });
});

describe("protocolInstalledMatch", () => {
  it("matches a github-installed plugin whose key differs from the catalog name", () => {
    const list: InstalledPlugin[] = [
      { name: "dsh-api-relay-audit", spec: "github:toby-bridges/api-relay-audit", managed: false },
      { name: "dsh-at-file", spec: "git+https://github.com/omdsh-dev/dsh-at-file.git", managed: false },
    ];
    const hit = protocolInstalledMatch("github:toby-bridges/api-relay-audit", "api-relay-audit", list);
    expect(hit?.name).toBe("dsh-api-relay-audit");
  });

  it("matches a specifier with a trailing ref on disk (#sha/#path:)", () => {
    const list: InstalledPlugin[] = [
      { name: "dsh-api-relay-audit", spec: "github:toby-bridges/api-relay-audit#c0ffee", managed: false },
    ];
    const hit = protocolInstalledMatch("github:toby-bridges/api-relay-audit", "api-relay-audit", list);
    expect(hit?.name).toBe("dsh-api-relay-audit");
  });

  it("refuses ambiguous prefix hits (dsh vs dsh-relay)", () => {
    const list: InstalledPlugin[] = [
      { name: "dsh", spec: "github:owner/dsh", managed: false },
      { name: "dsh-relay", spec: "github:owner/dsh-relay", managed: false },
    ];
    expect(protocolInstalledMatch("github:owner/dsh", "dsh", list)).toBeNull();
  });

  it("refuses a zero hit", () => {
    expect(protocolInstalledMatch("github:owner/missing", "missing", [])).toBeNull();
  });
});

describe("MarketView", () => {
  it("lands on the Discover tab by default without the installed list", async () => {
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    // 已装列表收敛到二级导航的 Installed 页（受管标记不出现在发现页）；
    // 已装卡片 meta 行按新设计直接显示落盘 spec
    expect(screen.queryByText("managed by launcher")).not.toBeInTheDocument();
    expect(screen.getByText("npm:dsh-better-sidebar@1.0.0")).toBeInTheDocument();
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
        latestInReleaseAgeWindow: false,
        latestPublishTime: null,
        updateAvailable: true,
      },
      {
        name: "@dsh-external/dsh-auth-tailscale",
        spec: "file:/x.tgz",
        managed: true,
        installedVersion: null,
        latestVersion: null,
        latestInReleaseAgeWindow: false,
        latestPublishTime: null,
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
        latestInReleaseAgeWindow: false,
        latestPublishTime: null,
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
    // 正常更新 = 以 name@latest 重装（与安装同一闸门与审计路径）；
    // minimumReleaseAge 窗口内的版本走确认框钉版本，另测
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
        latestInReleaseAgeWindow: false,
        latestPublishTime: null,
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

  it("reinstall button reruns install at latest and pauses on build approval", async () => {
    // 终端手动 add 被 pnpm 拦构建脚本留下的半成品（依赖已写入但构建未跑）
    // 走同一修复闭环：Reinstall → 被拦 → 审批对话框
    const installSpy = vi.spyOn(cmd, "marketInstall").mockResolvedValue({
      status: "needsApproval",
      packages: ["node-pty"],
      workspaceYaml: "~/.dsh/profiles/web/pnpm-workspace.yaml",
    });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    // 无更新的已装卡出 Reinstall；受管卡只读
    await screen.findByRole("button", { name: "Reinstall dsh-better-sidebar" });
    expect(screen.queryByRole("button", { name: "Reinstall @dsh-external/dsh-auth-tailscale" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reinstall dsh-better-sidebar" }));
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith("dsh-better-sidebar@latest"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(useAppStore.getState().toasts.map((t) => t.message)).toContainEqual(
      "Paused: approve build scripts for dsh-better-sidebar, then retry.",
    );
  });

  it("outdated card offers Update instead of Reinstall", async () => {
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([
      { name: "DSH-better-sidebar", spec: "dsh-better-sidebar@1.0.0", managed: false },
    ]);
    vi.spyOn(cmd, "marketCheckUpdates").mockResolvedValue([
      {
        name: "DSH-better-sidebar",
        spec: "dsh-better-sidebar@1.0.0",
        managed: false,
        installedVersion: "1.0.0",
        latestVersion: "2.0.0",
        latestInReleaseAgeWindow: false,
        latestPublishTime: null,
        updateAvailable: true,
      },
    ]);
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    expect(await screen.findByRole("button", { name: "Update DSH-better-sidebar" })).toBeInTheDocument();
    // 更新本身就是重装到 latest，不与 Reinstall 同卡并存
    expect(screen.queryByRole("button", { name: "Reinstall DSH-better-sidebar" })).not.toBeInTheDocument();
  });

  it("update inside the pnpm minimumReleaseAge window asks before pinning", async () => {
    // latest 落在 pnpm 供应链保护窗口内：@latest 会被静默拦回旧版（假成功），
    // 必须先弹确认框，用户知情确认后才钉版本重装
    vi.spyOn(cmd, "marketCheckUpdates").mockResolvedValue([
      {
        name: "dsh-better-sidebar",
        spec: "npm:dsh-better-sidebar@1.0.0",
        managed: false,
        installedVersion: "1.0.0",
        latestVersion: "2.0.0",
        latestInReleaseAgeWindow: true,
        latestPublishTime: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
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
    // 点 Update 不直接安装，先出供应链确认框；框内展示版本过渡与发布时长
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("1.0.0 → 2.0.0");
    expect(dialog.textContent).toContain("5 hours ago");
    expect(installSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Update anyway" }));
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith("dsh-better-sidebar@2.0.0"));
    await waitFor(() =>
      expect(useAppStore.getState().toasts.map((t) => t.message)).toContainEqual(
        "Plugin updated: dsh-better-sidebar (npm:dsh-better-sidebar@2.0.0)",
      ),
    );
    expect(useAppStore.getState().marketReleaseAgeConfirm).toBeNull();
  });

  it("dismissing the release-age dialog skips the update and explains the wait", async () => {
    vi.spyOn(cmd, "marketCheckUpdates").mockResolvedValue([
      {
        name: "dsh-better-sidebar",
        spec: "npm:dsh-better-sidebar@1.0.0",
        managed: false,
        installedVersion: "1.0.0",
        latestVersion: "2.0.0",
        latestInReleaseAgeWindow: true,
        latestPublishTime: null,
        updateAvailable: true,
      },
    ]);
    const installSpy = vi.spyOn(cmd, "marketInstall");
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: "Update dsh-better-sidebar" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(installSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().marketReleaseAgeConfirm).toBeNull();
    expect(useAppStore.getState().toasts.map((t) => t.type)).toContainEqual("info");
  });

  it("Escape dismisses the release-age dialog as a cancel", async () => {
    vi.spyOn(cmd, "marketCheckUpdates").mockResolvedValue([
      {
        name: "dsh-better-sidebar",
        spec: "npm:dsh-better-sidebar@1.0.0",
        managed: false,
        installedVersion: "1.0.0",
        latestVersion: "2.0.0",
        latestInReleaseAgeWindow: true,
        latestPublishTime: null,
        updateAvailable: true,
      },
    ]);
    const installSpy = vi.spyOn(cmd, "marketInstall");
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: "Update dsh-better-sidebar" }));
    await screen.findByRole("dialog");
    // 焦点默认落在取消（安全默认）；Esc 等价取消：不安装、挂起清空
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(installSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().marketReleaseAgeConfirm).toBeNull();
  });

  it("update all pauses at a release-age-windowed plugin and resumes it pinned after confirm", async () => {
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([
      { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@1.0.0", managed: false },
      { name: "dsh-context", spec: "npm:dsh-context@0.41.0", managed: false },
    ]);
    vi.spyOn(cmd, "marketCheckUpdates").mockResolvedValue([
      {
        name: "dsh-better-sidebar",
        spec: "npm:dsh-better-sidebar@1.0.0",
        managed: false,
        installedVersion: "1.0.0",
        latestVersion: "2.0.0",
        latestInReleaseAgeWindow: false,
        latestPublishTime: null,
        updateAvailable: true,
      },
      {
        name: "dsh-context",
        spec: "npm:dsh-context@0.41.0",
        managed: false,
        installedVersion: "0.41.0",
        latestVersion: "0.41.3",
        latestInReleaseAgeWindow: true,
        latestPublishTime: null,
        updateAvailable: true,
      },
    ]);
    const installSpy = vi.spyOn(cmd, "marketInstall").mockResolvedValue({
      status: "installed",
      receipt: { name: "dsh-context", spec: "npm:dsh-context@0.41.3" },
    });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: "Update all (2)" }));
    // 窗口外先正常更，撞上窗口内即停批弹框（与审批挂起同一模式）
    await screen.findByRole("dialog");
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith("dsh-better-sidebar@latest"));
    expect(installSpy).not.toHaveBeenCalledWith("dsh-context@latest");

    await user.click(screen.getByRole("button", { name: "Update anyway" }));
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith("dsh-context@0.41.3"));
  });

  it("favorites tab lists starred plugins in favorite order and allows unstarring", async () => {
    useAppStore.setState({ marketFavorites: ["some/one", "omdsh-dev/DSH-better-sidebar"] });
    const user = userEvent.setup();
    render(createElement(MarketView));

    await user.click(screen.getByRole("button", { name: "Favorites" }));
    // 收藏顺序展示（非目录顺序：some/one 在前）；已收藏星标常驻实心。
    // fullName 已降级：定位卡片用名称节点向上找 article 比较文档顺序
    const oneCard = (await screen.findByText("one")).closest("article");
    const sidebarCard = screen.getByText("DSH-better-sidebar").closest("article");
    expect(
      oneCard && sidebarCard && oneCard.compareDocumentPosition(sidebarCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: `Remove from favorites DSH-better-sidebar` })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: `Remove from favorites one` })).toHaveLength(1);

    // 星标就地取消：卡片消失，localStorage 同步落盘
    await user.click(screen.getByRole("button", { name: "Remove from favorites DSH-better-sidebar" }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("market-favorites") ?? "[]")).toEqual(["some/one"]),
    );
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.queryByText("DSH-better-sidebar")).not.toBeInTheDocument();
  });

  it("favoriting on the Discover tab persists to localStorage and shows an empty-state hint when none", async () => {
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    // 目录条目在收藏页交集外（未收藏）→ 空状态提示
    await user.click(screen.getByRole("button", { name: "Favorites" }));
    expect(
      screen.getByText("No favorites yet. Star plugins on the Discover tab to pin them here."),
    ).toBeInTheDocument();

    // 发现页点亮五角星 → localStorage 记 fullName，收藏页出现该卡片
    await user.click(screen.getByRole("button", { name: "Discover" }));
    await user.click(screen.getByRole("button", { name: "Add to favorites DSH-better-sidebar" }));
    expect(JSON.parse(localStorage.getItem("market-favorites") ?? "[]")).toEqual([
      "omdsh-dev/DSH-better-sidebar",
    ]);
    await user.click(screen.getByRole("button", { name: "Favorites" }));
    expect(await screen.findByText("DSH-better-sidebar")).toBeInTheDocument();
  });

  it("localizes the category label and demotes fullName to owner/spec in card meta", async () => {
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    // 分类用目录本地化名（与筛选下拉同一事实），原始 key 不裸露
    expect(screen.getAllByText("UI Enhancements").length).toBeGreaterThan(0);
    expect(screen.queryByText("ui")).not.toBeInTheDocument();
    // meta 行：未装卡显示 owner（fullName 降级），不常驻整串 owner/repo
    expect(screen.getByText("some")).toBeInTheDocument();
    expect(screen.queryByText("some/one")).not.toBeInTheDocument();
  });

  it("manual-only card offers a README way out instead of a dead end", async () => {
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("one")).toBeInTheDocument());

    // 无 candidate 的插件不再只有一句 Manual install only，还有去 README 的出口
    expect(screen.getByText("Manual install only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "README ↗ one" })).toBeInTheDocument();
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

  it("Escape dismisses the build approval dialog and cancel is the focused default", async () => {
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

    await screen.findByRole("dialog");
    // 放行 = 允许任意代码执行，焦点默认落在取消（安全默认）；Esc 等价取消
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(useAppStore.getState().marketPendingApproval).toBeNull();
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

  it("shows Installing… on the card between confirm and completion", async () => {
    // 回归：发现页此前没把 marketInstalling 传进卡片，确认后按钮弹回 Install
    let resolveInstall: (v: InstallOutcome) => void = () => {};
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([]);
    useAppStore.setState({ marketInstalled: [] });
    vi.spyOn(cmd, "marketInstall").mockReturnValue(
      new Promise<InstallOutcome>((resolve) => {
        resolveInstall = resolve;
      }),
    );
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Install" }));
    await user.click(await screen.findByText("Confirm"));
    // 安装挂起期间按钮恒为 Installing…（disabled），不弹回可再点的 Install
    const busy = await screen.findByRole("button", { name: "Installing…" });
    expect(busy).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument();

    resolveInstall({ status: "installed", receipt: { name: "dsh-better-sidebar", spec: "dsh-better-sidebar@1.2.3" } });
    await waitFor(() =>
      expect(useAppStore.getState().toasts.map((t) => t.message)).toContainEqual(
        "Plugin installed: dsh-better-sidebar (dsh-better-sidebar@1.2.3)",
      ),
    );
  });

  it("streams install output lines into the in-card log while installing", async () => {
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([]);
    useAppStore.setState({ marketInstalled: [] });
    vi.spyOn(cmd, "marketInstall").mockReturnValue(new Promise<InstallOutcome>(() => {}));
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Install" }));
    await user.click(await screen.findByText("Confirm"));
    // 事件桥逐行直写 store（首行命令 + pnpm 输出），明细区实时可见
    useAppStore.getState().appendMarketInstallLog({ specifier: "dsh-better-sidebar@latest", line: "$ dsh plugin --profile web add dsh-better-sidebar@latest" });
    useAppStore.getState().appendMarketInstallLog({ specifier: "dsh-better-sidebar@latest", line: "Packages: +1" });
    expect(await screen.findByText("Packages: +1")).toBeInTheDocument();
    expect(screen.getByText("$ dsh plugin --profile web add dsh-better-sidebar@latest")).toBeInTheDocument();
    // 别的 specifier（理论上不该发生）不落进当前明细
    useAppStore.getState().appendMarketInstallLog({ specifier: "other@latest", line: "noise" });
    expect(screen.queryByText("noise")).not.toBeInTheDocument();
  });

  it("keeps the log on failure, offers retry and dismiss, and clears on dismiss", async () => {
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([]);
    useAppStore.setState({ marketInstalled: [] });
    vi.spyOn(cmd, "marketInstall").mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Install" }));
    await user.click(await screen.findByText("Confirm"));
    // 失败态持久在卡片上：错误原因 + 留存明细 + 重试/关闭
    expect(await screen.findByText("Install failed: Error: network down")).toBeInTheDocument();
    expect(screen.getByText("$ dsh plugin --profile web add dsh-better-sidebar@latest")).toBeInTheDocument();
    expect(useAppStore.getState().marketInstallError?.specifier).toBe("dsh-better-sidebar@latest");

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    // 关闭后错误与明细一并清，卡片回可安装态
    expect(useAppStore.getState().marketInstallError).toBeNull();
    expect(useAppStore.getState().marketInstallLog).toBeNull();
    expect(await screen.findByRole("button", { name: "Install" })).toBeInTheDocument();
  });
});
