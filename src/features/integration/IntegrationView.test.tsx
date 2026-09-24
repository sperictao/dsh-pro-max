// 只验门禁：哪一档被纳管就渲染哪张卡片。两张卡片各自的行为由它们自己的测试覆盖，
// 这里用哨兵替身隔开，避免为了测两行判断去铺满 dsh 命令的 mock
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/shared/store";
import type { DshSurface, LauncherConfig } from "@/shared/types";
import { IntegrationView } from "./IntegrationView";

vi.mock("./DshCard", () => ({ DshCard: () => createElement("div", null, "WEB CARD") }));
vi.mock("./DesktopCard", () => ({ DesktopCard: () => createElement("div", null, "DESKTOP CARD") }));

const saved: LauncherConfig = {
  minimize_to_tray_on_close: false,
  language: "en",
  managed_surfaces: ["web"],
  dsh_admin_cap_domain: "",
  dsh_use_cap_domain: "",
  dsh_extra_allowed_logins: "",
  market_catalog_url: "",
};

function mount(surfaces?: DshSurface[]) {
  useAppStore.setState(surfaces ? { config: { ...saved, managed_surfaces: surfaces } } : { config: null });
  render(createElement(IntegrationView));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("IntegrationView surface gating", () => {
  it("renders only the web card when only web is managed", () => {
    mount(["web"]);
    expect(screen.getByText("WEB CARD")).toBeInTheDocument();
    expect(screen.queryByText("DESKTOP CARD")).not.toBeInTheDocument();
  });

  it("renders only the desktop card when only desktop is managed", () => {
    mount(["desktop"]);
    expect(screen.getByText("DESKTOP CARD")).toBeInTheDocument();
    expect(screen.queryByText("WEB CARD")).not.toBeInTheDocument();
  });

  it("renders both cards when both are managed", () => {
    mount(["web", "desktop"]);
    expect(screen.getByText("WEB CARD")).toBeInTheDocument();
    expect(screen.getByText("DESKTOP CARD")).toBeInTheDocument();
  });

  it("falls back to the web card while the config is still loading", () => {
    mount();
    expect(screen.getByText("WEB CARD")).toBeInTheDocument();
    expect(screen.queryByText("DESKTOP CARD")).not.toBeInTheDocument();
  });
});
