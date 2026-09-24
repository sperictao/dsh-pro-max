// shared/config：从 store 草稿构建 LauncherConfig

import type { DshSurface, LauncherConfig } from "./types";

export function currentConfigDraft(s: {
  config: LauncherConfig | null;
  languageSetting: string;
}): LauncherConfig {
  const c = s.config;
  return {
    minimize_to_tray_on_close: c?.minimize_to_tray_on_close ?? false,
    language: s.languageSetting,
    managed_surfaces: c?.managed_surfaces ?? ["web"],
    dsh_admin_cap_domain: c?.dsh_admin_cap_domain ?? "",
    dsh_use_cap_domain: c?.dsh_use_cap_domain ?? "",
    dsh_extra_allowed_logins: c?.dsh_extra_allowed_logins ?? "",
    market_catalog_url: c?.market_catalog_url ?? "",
  };
}

// 纳管形态是无序集合：顺序不同不算修改。"至少一项"由 Rust 归一化收口，前端不复述该规则
export function sameSurfaces(a: DshSurface[], b: DshSurface[]): boolean {
  return a.length === b.length && a.every((s) => b.includes(s));
}
