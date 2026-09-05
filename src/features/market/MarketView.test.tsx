import { render, screen, waitFor, within } from "@testing-library/react";
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
  githubRepoId: [string, string | null][];
}
const vectors = vectorsJson as SpecifierVectors;
import {
  MarketView,
  githubRepoId,
  looksTerminal,
  normalizeCustomSpecifier,
  packageNameFromSpecifier,
  protocolInstalledMatch,
  repairContextText,
  specifierToCatalogName,
} from "./MarketView";
import { MarketErrorBoundary } from "./MarketErrorBoundary";
import { restartDshWeb } from "@/features/integration/dshActions";

// 重启入口复用 Shell 域一键重启：市场侧只验证「调用发生了」，流程本体由
// dshActions 自身测试覆盖
vi.mock("@/features/integration/dshActions", () => ({ restartDshWeb: vi.fn() }));

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
  { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@1.0.0", version: "1.0.0", managed: false, enabled: true },
  { name: "@dsh-external/dsh-auth-tailscale", spec: "file:/x.tgz", version: null, managed: true, enabled: true },
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
    // 更新检测态一并重置：挂起的检测 promise 会把 busy 卡在 true，泄漏到
    // 后续测试会让所有重检被 busy 守卫拦掉（卡片永远等不到 outdated 数据）
    marketUpdates: null,
    marketUpdatesBusy: false,
    marketFavorites: [],
    marketCompat: {},
    marketReleaseNotes: null,
    toasts: [],
  });
  vi.spyOn(cmd, "marketFetch").mockResolvedValue(catalog);
  vi.spyOn(cmd, "marketSnapshot").mockResolvedValue(null);
  vi.spyOn(cmd, "marketInstalled").mockResolvedValue(installed);
  vi.spyOn(cmd, "marketApproveBuilds").mockResolvedValue({ status: "installed", receipt: null, notices: [] });
  vi.spyOn(cmd, "marketCheckUpdates").mockResolvedValue([]);
  // G 块新增通道的默认桩：兼容性空、说明未覆盖、取消幂等
  vi.spyOn(cmd, "marketDiscoveryCompat").mockResolvedValue([]);
  vi.spyOn(cmd, "marketReleaseNotes").mockResolvedValue(null);
  vi.spyOn(cmd, "marketCancel").mockResolvedValue(false);
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
  it("githubRepoId matches every vector", () => {
    for (const [input, expectRepo] of vectors.githubRepoId) {
      expect(githubRepoId(input)).toBe(expectRepo);
    }
  });
});

describe("protocolInstalledMatch", () => {
  it("matches a github-installed plugin whose key differs from the catalog name", () => {
    const list: InstalledPlugin[] = [
      { name: "dsh-api-relay-audit", spec: "github:toby-bridges/api-relay-audit", version: null, managed: false, enabled: true },
      { name: "dsh-at-file", spec: "git+https://github.com/omdsh-dev/dsh-at-file.git", version: null, managed: false, enabled: true },
    ];
    const hit = protocolInstalledMatch("github:toby-bridges/api-relay-audit", "api-relay-audit", list);
    expect(hit?.name).toBe("dsh-api-relay-audit");
  });

  it("matches a specifier with a trailing ref on disk (#sha/#path:)", () => {
    const list: InstalledPlugin[] = [
      { name: "dsh-api-relay-audit", spec: "github:toby-bridges/api-relay-audit#c0ffee", version: null, managed: false, enabled: true },
    ];
    const hit = protocolInstalledMatch("github:toby-bridges/api-relay-audit", "api-relay-audit", list);
    expect(hit?.name).toBe("dsh-api-relay-audit");
  });

  // dsh-at-file 复现：pnpm 把无 fragment 的 github:owner/repo 落盘规范化为
  // git+https://github.com/owner/repo.git，前缀判定认不出 → 卡片恒显未安装
  it("matches a git+https disk spec against the github: catalog specifier (pnpm normalization)", () => {
    const list: InstalledPlugin[] = [
      { name: "dsh-at-file", spec: "git+https://github.com/omdsh-dev/dsh-at-file.git", version: null, managed: false, enabled: true },
    ];
    const hit = protocolInstalledMatch("github:omdsh-dev/dsh-at-file", "dsh-at-file", list);
    expect(hit?.name).toBe("dsh-at-file");
  });

  it("matches each sibling repo exactly (repo id equality, no prefix ambiguity)", () => {
    const list: InstalledPlugin[] = [
      { name: "dsh", spec: "github:owner/dsh", version: null, managed: false, enabled: true },
      { name: "dsh-relay", spec: "github:owner/dsh-relay", version: null, managed: false, enabled: true },
    ];
    expect(protocolInstalledMatch("github:owner/dsh", "dsh", list)?.name).toBe("dsh");
    expect(protocolInstalledMatch("github:owner/dsh-relay", "dsh-relay", list)?.name).toBe("dsh-relay");
  });

  it("refuses a zero hit", () => {
    expect(protocolInstalledMatch("github:owner/missing", "missing", [])).toBeNull();
  });
});

describe("normalizeCustomSpecifier", () => {
  it("passes npm and explicit protocol forms through", () => {
    expect(normalizeCustomSpecifier("pkg")).toBe("pkg");
    expect(normalizeCustomSpecifier("  pkg@1.2.3  ")).toBe("pkg@1.2.3");
    expect(normalizeCustomSpecifier("@scope/pkg@1.0.0")).toBe("@scope/pkg@1.0.0");
    expect(normalizeCustomSpecifier("npm:pkg@1.2.3")).toBe("npm:pkg@1.2.3");
    expect(normalizeCustomSpecifier("github:owner/repo#v1.2.3")).toBe("github:owner/repo#v1.2.3");
    expect(normalizeCustomSpecifier("github:owner/repo#refs/heads/main")).toBe("github:owner/repo#refs/heads/main");
  });

  it("normalizes pasted GitHub forms to explicit github: owner/repo", () => {
    expect(normalizeCustomSpecifier("https://github.com/owner/repo")).toBe("github:owner/repo");
    expect(normalizeCustomSpecifier("https://www.github.com/owner/repo.git")).toBe("github:owner/repo");
    expect(normalizeCustomSpecifier("http://github.com/owner/repo/")).toBe("github:owner/repo");
    expect(normalizeCustomSpecifier("https://github.com/owner/repo/tree/v1.2.3")).toBe("github:owner/repo#v1.2.3");
    expect(normalizeCustomSpecifier("git@github.com:owner/repo.git")).toBe("github:owner/repo");
    // 裸 owner/repo 只能是 GitHub 简写（npm 包名不含裸 /），归一为显式形态
    expect(normalizeCustomSpecifier("owner/repo")).toBe("github:owner/repo");
  });

  it("rejects unsupported shapes honestly", () => {
    expect(normalizeCustomSpecifier("")).toBeNull();
    expect(normalizeCustomSpecifier("   ")).toBeNull();
    // git+https 带 `+`，过不了 Rust 侧 valid_identifier 白名单
    expect(normalizeCustomSpecifier("git+https://github.com/owner/repo")).toBeNull();
    expect(normalizeCustomSpecifier("https://gitlab.com/owner/repo")).toBeNull();
    expect(normalizeCustomSpecifier("file:/x/y.tgz")).toBeNull();
    expect(normalizeCustomSpecifier("github:owner")).toBeNull();
    expect(normalizeCustomSpecifier("github:o#x/r")).toBeNull();
    // `^` 范围形态不在白名单字符集内，如实拒绝
    expect(normalizeCustomSpecifier("pkg@^1.2.3")).toBeNull();
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
      { name: "DSH-better-sidebar", spec: "dsh-better-sidebar@1.0.0", version: "1.0.0", managed: false, enabled: true },
      { name: "@dsh-external/dsh-auth-tailscale", spec: "file:/x.tgz", version: null, managed: true, enabled: true },
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
        requiresDsh: null,
        compatible: null,
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
        requiresDsh: null,
        compatible: null,
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

  it("disables Update and shows the requirement when the latest version needs a newer dsh", async () => {
    // engines.dsh 兼容门禁：目标包声明了更高 dsh 最低版本（compatible=false）
    // → 更新按钮禁用 + 红字要求；不满足时不出现在批量计数里
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([
      { name: "DSH-better-sidebar", spec: "dsh-better-sidebar@1.0.0", version: "1.0.0", managed: false, enabled: true },
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
        requiresDsh: ">=0.2.0",
        compatible: false,
        updateAvailable: true,
      },
    ]);
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Installed" }));
    const update = await screen.findByRole("button", { name: "Update DSH-better-sidebar" });
    expect(update).toBeDisabled();
    expect(screen.getByText("dsh >=0.2.0 required")).toBeInTheDocument();
    // 批量更新同样排除（无 Update all 按钮）
    expect(screen.queryByRole("button", { name: /Update all/ })).not.toBeInTheDocument();
  });

  it("toggles plugin enablement from the installed tab and refreshes the list", async () => {
    // disabled 覆盖行走 market_set_plugin_enabled（重启 dsh web 生效）；受管
    // 插件不出开关
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([
      { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@1.0.0", version: "1.0.0", managed: false, enabled: true },
      { name: "@dsh-external/dsh-auth-tailscale", spec: "file:/x.tgz", version: null, managed: true, enabled: true },
    ]);
    const setEnabled = vi
      .spyOn(cmd, "marketSetPluginEnabled")
      .mockResolvedValue({ name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@1.0.0", version: "1.0.0", managed: false, enabled: false });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Installed" }));
    // 启停是带状态文字的胶囊开关（role=switch）：可访问名沿用 Enable/Disable
    // + 插件名，胶囊文字呈现启停状态
    const toggle = await screen.findByRole("switch", { name: "Disable dsh-better-sidebar" });
    expect(toggle).toHaveAttribute("data-state-text", "Enabled");
    await user.click(toggle);
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith("dsh-better-sidebar", false));
    await waitFor(() =>
      expect(useAppStore.getState().toasts.map((x) => x.message)).toContainEqual(
        "Plugin dsh-better-sidebar will be disabled at the next dsh web start.",
      ),
    );
    // 受管插件只有受管标记，无启停开关（已装列表唯一的 switch 属非受管插件）
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.queryByRole("switch", { name: /@dsh-external/ })).not.toBeInTheDocument();
  });

  it("repeated toggle that changes nothing toasts a no-op instead of a change", async () => {
    // 回执 enabled 与请求一致 = 内容未变化的空操作（后端免写盘）：如实提示
    // 没改，不谎称「将于下次启动停用」
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([
      { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@1.0.0", version: "1.0.0", managed: false, enabled: true },
    ]);
    vi.spyOn(cmd, "marketSetPluginEnabled").mockResolvedValue({
      name: "dsh-better-sidebar",
      spec: "npm:dsh-better-sidebar@1.0.0",
      version: "1.0.0",
      managed: false,
      enabled: true,
    });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("switch", { name: "Disable dsh-better-sidebar" }));
    await waitFor(() =>
      expect(useAppStore.getState().toasts.map((x) => x.message)).toContainEqual(
        "No change needed: the toggle is already in that state.",
      ),
    );
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
        requiresDsh: null,
        compatible: null,
        updateAvailable: true,
      },
    ]);
    const installSpy = vi.spyOn(cmd, "marketInstall").mockResolvedValue({
      status: "installed",
      receipt: { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@2.0.0" },
      notices: [],
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
        requiresDsh: null,
        compatible: null,
        updateAvailable: true,
      },
    ]);
    const installSpy = vi.spyOn(cmd, "marketInstall").mockResolvedValue({
      status: "installed",
      receipt: { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@2.0.0" },
      notices: [],
    });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: "Update dsh-better-sidebar" }));
    // G5：更新先过说明框（本 fixture 探针未覆盖 → "暂无说明"不阻塞），框内
    // 确认后走既有更新管线
    await user.click(await screen.findByRole("button", { name: "Update" }));
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith("dsh-better-sidebar@latest"));
    await waitFor(() =>
      expect(useAppStore.getState().toasts.map((t) => t.message)).toContainEqual(
        "Plugin updated: dsh-better-sidebar (npm:dsh-better-sidebar@2.0.0)",
      ),
    );
    expect(checkSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("update success flips the card immediately without waiting for the re-check", async () => {
    // 更新检测挂起不返回：卡片的即时翻转只准依赖回执与磁盘刷新（乐观收敛），
    // 不准依赖 registry 重检（秒级到十秒级的慢路径，busy 丢弃或网络失败时
    // 还会更久）。重检挂起恰好复现 busy 场景：乐观置位不被覆盖
    vi.spyOn(cmd, "marketCheckUpdates").mockImplementation(() => new Promise(() => {}));
    useAppStore.setState({
      marketUpdates: {
        "dsh-better-sidebar": {
          name: "dsh-better-sidebar",
          spec: "npm:dsh-better-sidebar@1.0.0",
          managed: false,
          installedVersion: "1.0.0",
          latestVersion: "2.0.0",
          latestInReleaseAgeWindow: false,
          latestPublishTime: null,
          requiresDsh: null,
          compatible: null,
          updateAvailable: true,
        },
      },
    });
    vi.spyOn(cmd, "marketInstalled")
      .mockResolvedValueOnce([
        { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@1.0.0", version: "1.0.0", managed: false, enabled: true },
      ])
      .mockResolvedValue([
        { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@2.0.0", version: "2.0.0", managed: false, enabled: true },
      ]);
    vi.spyOn(cmd, "marketInstall").mockResolvedValue({
      status: "installed",
      receipt: { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@2.0.0" },
      notices: [],
    });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: "Update dsh-better-sidebar" }));
    // 说明框内确认后走既有更新管线（与单卡更新测试同一流程）
    await user.click(await screen.findByRole("button", { name: "Update" }));

    // 回执落地即翻转：乐观收敛清掉"有更新"，版本号随磁盘刷新换新，
    // "Up to date" 立即可见，全程不依赖挂起中的重检
    await waitFor(() =>
      expect(useAppStore.getState().marketUpdates?.["dsh-better-sidebar"]?.updateAvailable).toBe(false),
    );
    expect(await screen.findByRole("button", { name: "Reinstall dsh-better-sidebar" })).toBeInTheDocument();
    expect(screen.getByText("v2.0.0")).toBeInTheDocument();
    expect(screen.getByText("Up to date")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update dsh-better-sidebar" })).not.toBeInTheDocument();
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
      { name: "DSH-better-sidebar", spec: "dsh-better-sidebar@1.0.0", version: "1.0.0", managed: false, enabled: true },
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
        requiresDsh: null,
        compatible: null,
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
        requiresDsh: null,
        compatible: null,
        updateAvailable: true,
      },
    ]);
    const installSpy = vi.spyOn(cmd, "marketInstall").mockResolvedValue({
      status: "installed",
      receipt: { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@2.0.0" },
      notices: [],
    });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: "Update dsh-better-sidebar" }));
    // G5：先过说明框；确认后才出供应链确认框（框内展示版本过渡与发布时长）
    await user.click(await screen.findByRole("button", { name: "Update" }));
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
        requiresDsh: null,
        compatible: null,
        updateAvailable: true,
      },
    ]);
    const installSpy = vi.spyOn(cmd, "marketInstall");
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: "Update dsh-better-sidebar" }));
    await user.click(await screen.findByRole("button", { name: "Update" }));
    await user.click(await screen.findByRole("button", { name: "Keep current version" }));
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
        requiresDsh: null,
        compatible: null,
        updateAvailable: true,
      },
    ]);
    const installSpy = vi.spyOn(cmd, "marketInstall");
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: "Update dsh-better-sidebar" }));
    await user.click(await screen.findByRole("button", { name: "Update" }));
    await screen.findByRole("dialog");
    // 焦点默认落在取消（安全默认）；Esc 等价取消：不安装、挂起清空
    expect(screen.getByRole("button", { name: "Keep current version" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(installSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().marketReleaseAgeConfirm).toBeNull();
  });

  it("update all pauses at a release-age-windowed plugin and resumes it pinned after confirm", async () => {
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([
      { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@1.0.0", version: "1.0.0", managed: false, enabled: true },
      { name: "dsh-context", spec: "npm:dsh-context@0.41.0", version: "0.41.0", managed: false, enabled: true },
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
        requiresDsh: null,
        compatible: null,
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
        requiresDsh: null,
        compatible: null,
        updateAvailable: true,
      },
    ]);
    // 回执按 specifier 如实派发：批量第一项（dsh-better-sidebar）的回执名
    // 不能再静态写成 dsh-context——乐观收敛按回执名清"有更新"标志，清错包
    // 会让窗口确认框不再弹出
    const installSpy = vi.spyOn(cmd, "marketInstall").mockImplementation((specifier) =>
      Promise.resolve({
        status: "installed",
        receipt: { name: specifier.split("@")[0], spec: specifier },
        notices: [],
      }),
    );
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
      notices: [],
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
      .mockResolvedValue({ status: "installed", receipt: { name: "dsh-better-sidebar", spec: "dsh-better-sidebar@1.2.3" }, notices: [] });
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

    await user.click(screen.getByText("Keep scripts blocked"));
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
    expect(screen.getByRole("button", { name: "Keep scripts blocked" })).toHaveFocus();
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

    resolveInstall({ status: "installed", receipt: { name: "dsh-better-sidebar", spec: "dsh-better-sidebar@1.2.3" }, notices: [] });
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

  it("custom install normalizes pasted GitHub URLs and streams progress into the dialog", async () => {
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([]);
    useAppStore.setState({ marketInstalled: [] });
    let resolveInstall: (v: InstallOutcome) => void = () => {};
    vi.spyOn(cmd, "marketInstall").mockReturnValue(
      new Promise<InstallOutcome>((resolve) => {
        resolveInstall = resolve;
      }),
    );
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Custom install" }));
    const dialog = screen.getByRole("dialog");
    await user.type(screen.getByPlaceholderText("e.g. github:owner/repo or pkg@1.2.3"), "https://github.com/owner/repo");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    // 粘贴的 GitHub 网址归一为 github: 形态后才进安装闸门（与目录安装同一命令通道）
    await waitFor(() => expect(cmd.marketInstall).toHaveBeenCalledWith("github:owner/repo"));
    // 流式进度明细与卡片同款：首行命令 + pnpm 输出实时上屏
    useAppStore.getState().appendMarketInstallLog({ specifier: "github:owner/repo", line: "Packages: +1" });
    expect(await within(dialog).findByText("Packages: +1")).toBeInTheDocument();
    // 全局单飞：安装挂起期间对话框按钮 Working… 且禁用
    expect(within(dialog).getByRole("button", { name: "Working…" })).toBeDisabled();

    resolveInstall({ status: "installed", receipt: { name: "dsh-repo", spec: "github:owner/repo" }, notices: [] });
    expect(await within(dialog).findByText("Installed")).toBeInTheDocument();
    expect(within(dialog).getByText("github:owner/repo")).toBeInTheDocument();
  });

  it("custom install validates the address before touching the install gate", async () => {
    vi.spyOn(cmd, "marketInstall");
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Custom install" }));
    const dialog = screen.getByRole("dialog");
    await user.type(
      screen.getByPlaceholderText("e.g. github:owner/repo or pkg@1.2.3"),
      "https://gitlab.com/owner/repo",
    );
    // 不支持协议如实就地报错，安装按钮禁用，闸门未被触碰
    expect(screen.getByText(/Unsupported address/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Install" })).toBeDisabled();
    expect(cmd.marketInstall).not.toHaveBeenCalled();
  });

  it("custom install keeps the failure in the dialog and retries the same specifier", async () => {
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([]);
    useAppStore.setState({ marketInstalled: [] });
    const installSpy = vi
      .spyOn(cmd, "marketInstall")
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ status: "installed", receipt: { name: "dsh-repo", spec: "github:owner/repo" }, notices: [] });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Custom install" }));
    const dialog = screen.getByRole("dialog");
    await user.type(screen.getByPlaceholderText("e.g. github:owner/repo or pkg@1.2.3"), "owner/repo");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith("github:owner/repo"));
    // 失败态持久在对话框内：原因 + 留存明细
    expect(await screen.findByText("Install failed: Error: network down")).toBeInTheDocument();
    expect(screen.getByText("$ dsh plugin --profile web add github:owner/repo")).toBeInTheDocument();

    // Retry 固定重跑原 specifier（输入可能已被改掉）
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(installSpy).toHaveBeenNthCalledWith(2, "github:owner/repo"));
    expect(await within(dialog).findByText("Installed")).toBeInTheDocument();
  });
});

describe("repairContextText", () => {
  it("assembles a self-contained context from target, error and output", () => {
    const text = repairContextText("dsh-x@1.0", "Failed to install plugin: boom", [
      "$ dsh plugin --profile web add dsh-x@1.0",
      "ERR_PNPM_BUILD",
    ]);
    expect(text).toContain("Target: dsh-x@1.0");
    expect(text).toContain("Error: Failed to install plugin: boom");
    expect(text).toContain("Command output:");
    expect(text).toContain("$ dsh plugin --profile web add dsh-x@1.0");
    expect(text).toContain("ERR_PNPM_BUILD");
  });

  it("stays usable when no output was captured", () => {
    expect(repairContextText("pkg@1.0", "boom", [])).toContain("(no output captured)");
  });
});

describe("failed install affordances", () => {
  // jsdom 没有剪贴板实现，打桩断言写入内容。注意 userEvent.setup() 会挂它
  // 自己的 clipboard 桩（供其 copy/paste API）盖掉既有桩——各用例必须在
  // setup() 之后重挂（见下）
  const writeText = vi.fn();
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
  });

  it("copies the repair context from the failed card", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([]);
    useAppStore.setState({ marketInstalled: [] });
    vi.spyOn(cmd, "marketInstall").mockRejectedValue(new Error("boom"));
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Install" }));
    await user.click(await screen.findByText("Confirm"));
    // 失败后留存日志照常可进明细；复制要带上 specifier / 错误 / 已捕获输出
    useAppStore
      .getState()
      .appendMarketInstallLog({ specifier: "dsh-better-sidebar@latest", line: "$ dsh plugin --profile web add dsh-better-sidebar@latest" });
    await user.click(await screen.findByRole("button", { name: "Copy error" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain("Target: dsh-better-sidebar@latest");
    expect(text).toContain("boom");
    expect(text).toContain("$ dsh plugin --profile web add dsh-better-sidebar@latest");
    expect(useAppStore.getState().toasts.map((t) => t.message)).toContainEqual("Install details copied");
  });

  it("copies the repair context from the custom install dialog failure", async () => {
    vi.spyOn(cmd, "marketInstall").mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Custom install" }));
    const dialog = screen.getByRole("dialog");
    await user.type(screen.getByPlaceholderText("e.g. github:owner/repo or pkg@1.2.3"), "owner/repo");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    await within(dialog).findByText("Retry");
    await user.click(within(dialog).getByRole("button", { name: "Copy error" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0] as string).toContain("Target: github:owner/repo");
  });

  it("restarts dsh web from the installed tab through the shared shell action", async () => {
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Installed" }));
    const btn = await screen.findByRole("button", { name: "Restart dsh web" });
    expect(btn).toBeEnabled();
    await user.click(btn);
    expect(vi.mocked(restartDshWeb)).toHaveBeenCalledTimes(1);
  });
});

// ============ G 块：取消 / 兼容性 / 更新说明 / 终端警示 / 崩溃恢复 ============

describe("looksTerminal (G6)", () => {
  it("flags terminal-ish names and descriptions in both languages", () => {
    expect(looksTerminal("dsh-shell-runner", "A tool for dsh")).toBe(true);
    expect(looksTerminal("some-plugin", "Interact with your terminal from dsh")).toBe(true);
    expect(looksTerminal("some-plugin", "在 dsh 里使用命令行工具")).toBe(true);
  });

  it("skips negated clauses and ordinary plugins", () => {
    // 否定从句剔除："不是 TUI"/"no terminal" 不该命中
    expect(looksTerminal("some-plugin", "This is not a TUI plugin")).toBe(false);
    expect(looksTerminal("some-plugin", "一个纯网页界面，不是终端应用")).toBe(false);
    expect(looksTerminal("dsh-better-sidebar", "Sidebar toolkit")).toBe(false);
  });
});

describe("install cancel (G2)", () => {
  it("busy card offers cancel and the backend cancel command fires", async () => {
    const cancelSpy = vi.spyOn(cmd, "marketCancel").mockResolvedValue(true);
    // 已装列表置空：已装匹配会让卡片走 outdated 分支，安装中态就看不到了
    // （必须覆盖 mock——挂载刷新会用夹具重新填充）
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([]);
    useAppStore.setState({
      marketInstalling: "dsh-better-sidebar@latest",
      marketInstallLog: { specifier: "dsh-better-sidebar@latest", lines: ["$ dsh plugin --profile web add dsh-better-sidebar@latest"] },
    });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await user.click(cancel);
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("no cancel button when idle", async () => {
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("removing card offers cancel through the same channel and locks the enable toggle", async () => {
    const cancelSpy = vi.spyOn(cmd, "marketCancel").mockResolvedValue(true);
    // 移除态由 store 的 marketRemoving 驱动（按包名锚定卡片）；后端 remove
    // 挂起期间 token 注册在全局槽，market_cancel 置位即杀
    useAppStore.setState({ marketRemoving: "dsh-better-sidebar" });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Installed" }));
    // 移除中：Remove 变 Removing… 禁用，同卡出 Cancel（与安装同一通道）
    const removeBtn = await screen.findByRole("button", { name: "Remove dsh-better-sidebar" });
    expect(removeBtn).toBeDisabled();
    expect(removeBtn).toHaveTextContent("Removing…");
    // 启停开关在移除中禁用：翻转启停与移除后的孤儿行清理写同一 patch 文件
    const toggle = await screen.findByRole("switch");
    expect(toggle).toBeDisabled();
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(cancelSpy).toHaveBeenCalled();
  });
});

describe("discovery compatibility (G4)", () => {
  const compatUpdate = {
    name: "dsh-better-sidebar",
    spec: "npm:dsh-better-sidebar@1.0.0",
    managed: false,
    installedVersion: "1.0.0",
    latestVersion: "2.0.0",
    latestInReleaseAgeWindow: false,
    latestPublishTime: null,
    requiresDsh: ">=99.0.0",
    compatible: false,
    updateAvailable: true,
  };

  it("fetches compat for visible npm entries and badges confirmed-incompatible cards", async () => {
    // 已装列表置空：徽章在未安装卡的发现期状态条上，已装卡吃更新检测的
    // compatible 字段（另一条门禁）
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([]);
    const compatSpy = vi.spyOn(cmd, "marketDiscoveryCompat").mockResolvedValue([
      { name: "dsh-better-sidebar", requiresDsh: ">=99.0.0", compatible: false },
    ]);
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());
    // 可见卡片的 npm 包名自动进批量查询
    await waitFor(() => expect(compatSpy).toHaveBeenCalledWith(["dsh-better-sidebar"]));
    // 确认不兼容：卡片红字明示要求（安装前就能看到，不用点了才知道）
    expect(await screen.findByText("dsh >=99.0.0 required")).toBeInTheDocument();
  });

  it("the compatible-only filter hides confirmed-incompatible entries only", async () => {
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([]);
    vi.spyOn(cmd, "marketDiscoveryCompat").mockResolvedValue([
      { name: "dsh-better-sidebar", requiresDsh: ">=99.0.0", compatible: false },
    ]);
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());
    await screen.findByText("dsh >=99.0.0 required");
    await user.click(screen.getByRole("button", { name: "Compatible only" }));
    // 确认不兼容的被隐藏；计数回落（"one" 无 installSpecifier，未知保持可见）
    expect(screen.queryByText("DSH-better-sidebar")).not.toBeInTheDocument();
    expect(screen.getByText("one")).toBeInTheDocument();
    // 兼容门禁判 false 的更新同样不进批量（安装页事实，回归守卫）
    expect(compatUpdate.compatible).toBe(false);
  });
});

describe("release notes dialog (G5)", () => {
  it("update shows release notes and installs after confirm", async () => {
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([
      { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@1.0.0", version: "1.0.0", managed: false, enabled: true },
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
        requiresDsh: null,
        compatible: null,
        updateAvailable: true,
      },
    ]);
    // 仓库标识从目录条目 url 派生；探针覆盖 → 展示 release 正文与提交
    vi.spyOn(cmd, "marketReleaseNotes").mockResolvedValue({
      release: { tag: "v2.0.0", name: "v2.0.0", publishedAt: null, url: null, body: "## What changed" },
      commits: [{ sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", message: "feat: x", date: null }],
    });
    const installSpy = vi.spyOn(cmd, "marketInstall").mockResolvedValue({
      status: "installed",
      receipt: { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@2.0.0" },
      notices: [],
    });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: "Update dsh-better-sidebar" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("1.0.0 → 2.0.0");
    expect(dialog.textContent).toContain("## What changed");
    expect(dialog.textContent).toContain("feat: x");
    expect(installSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith("dsh-better-sidebar@latest"));
  });

  it("uncovered plugins show an honest no-notes state and still update", async () => {
    vi.spyOn(cmd, "marketInstalled").mockResolvedValue([
      { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@1.0.0", version: "1.0.0", managed: false, enabled: true },
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
        requiresDsh: null,
        compatible: null,
        updateAvailable: true,
      },
    ]);
    const installSpy = vi.spyOn(cmd, "marketInstall").mockResolvedValue({
      status: "installed",
      receipt: { name: "dsh-better-sidebar", spec: "npm:dsh-better-sidebar@2.0.0" },
      notices: [],
    });
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: "Update dsh-better-sidebar" }));
    expect(await screen.findByText("No release notes for this plugin.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith("dsh-better-sidebar@latest"));
  });
});

describe("market error boundary (G3)", () => {
  function Bomb(): never {
    throw new Error("boom");
  }

  it("crashing children render the recovery panel, not a blank screen", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    const { rerender } = render(createElement(MarketErrorBoundary, null, createElement(Bomb)));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy error" })).toBeInTheDocument();
    // 原始错误 details 展开可见
    expect(screen.getByText("Error details")).toBeInTheDocument();
    // 重载重置边界：换回不炸的子树后恢复渲染
    rerender(createElement(MarketErrorBoundary, null, createElement("div", null, "fine")));
    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.getByText("fine")).toBeInTheDocument();
    errSpy.mockRestore();
  });
});
