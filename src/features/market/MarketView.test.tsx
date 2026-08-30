import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { InstalledPlugin, MarketCatalog } from "@/shared/types";
import { MarketView, packageNameFromSpecifier } from "./MarketView";

const catalog: MarketCatalog = {
  generatedAt: "2026-08-30T13:32:12.579Z",
  total: 2,
  plugins: [
    {
      repositoryId: 1,
      fullName: "omdsh-dev/DSH-better-sidebar",
      name: "DSH-better-sidebar",
      description: "侧边栏底座",
      url: "https://github.com/omdsh-dev/DSH-better-sidebar",
      stars: 3120,
      category: "ui",
      language: "TypeScript",
      verified: true,
      installSpecifier: "npm:dsh-better-sidebar@latest",
      installExecutable: true,
    },
    {
      repositoryId: 2,
      fullName: "some/one",
      name: "one",
      description: "no candidate",
      url: "https://github.com/some/one",
      stars: 10,
      category: "ui",
      language: null,
      verified: false,
      installSpecifier: null,
      installExecutable: false,
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
    toasts: [],
  });
  vi.spyOn(cmd, "marketFetch").mockResolvedValue(catalog);
  vi.spyOn(cmd, "marketInstalled").mockResolvedValue(installed);
});

describe("packageNameFromSpecifier", () => {
  it("extracts the npm package name from install specifiers", () => {
    expect(packageNameFromSpecifier("npm:dsh-better-sidebar@latest")).toBe("dsh-better-sidebar");
    expect(packageNameFromSpecifier("npm:@scope/pkg@1.0.0")).toBe("@scope/pkg");
    expect(packageNameFromSpecifier("npm:plain-name")).toBe("plain-name");
    // github 安装后的 dependencies 键无法预知，不参与已装匹配
    expect(packageNameFromSpecifier("github:owner/repo#c0ffee")).toBeNull();
  });
});

describe("MarketView", () => {
  it("renders catalog entries with install state and managed plugins", async () => {
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    // 目录两条 + 已装列表两条（授权插件带 managed 标记）
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("managed by launcher")).toBeInTheDocument();
    // npm candidate 已装 → Installed；无 candidate → Manual install only
    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("Manual install only")).toBeInTheDocument();
    // verified 徽章只给验证过的条目
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });

  it("search filter narrows the visible list", async () => {
    const user = userEvent.setup();
    render(createElement(MarketView));
    await waitFor(() => expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("Search plugins…"), "better-sidebar");
    await waitFor(() => expect(screen.queryByText("one")).not.toBeInTheDocument());
    expect(screen.getByText("DSH-better-sidebar")).toBeInTheDocument();
  });
});
