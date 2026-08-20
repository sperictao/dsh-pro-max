// shared/config：从 store 草稿构建 LauncherConfig

import type { LauncherConfig } from "./types";

export function currentConfigDraft(s: {
  config: LauncherConfig | null;
  languageSetting: string;
}): LauncherConfig {
  const c = s.config;
  return {
    minimize_to_tray_on_close: c?.minimize_to_tray_on_close ?? false,
    language: s.languageSetting,
    dsh_admin_cap_domain: c?.dsh_admin_cap_domain ?? "",
    dsh_use_cap_domain: c?.dsh_use_cap_domain ?? "",
    dsh_extra_allowed_logins: c?.dsh_extra_allowed_logins ?? "",
  };
}
