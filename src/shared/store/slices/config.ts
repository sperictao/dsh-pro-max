// 配置切片：设置页草稿（输入即改草稿，Save 时才落盘）与语言切换编排。
// config = 可编辑草稿；persistedConfig = 最近一次落盘快照，是脏状态的事实来源。
// 语言即时落盘：不走草稿，写盘基于 persistedConfig，不夹带未保存修改。

import { currentLanguage, i18n } from "../../i18n";
import { tErr } from "../../i18n/error";
import * as cmd from "../../commands";
import { currentConfigDraft } from "../../config";
import type { LauncherConfig } from "../../types";
import type { Slice } from "./shared";

export interface ConfigSlice {
  config: LauncherConfig | null;
  persistedConfig: LauncherConfig | null;
  autostart: boolean;
  languageSetting: string;
  appVersion: string;
  applyConfig: (cfg: LauncherConfig) => void;
  setConfigField: (patch: Partial<LauncherConfig>) => void;
  setAutostart: (enabled: boolean) => void;
  setLanguageSetting: (setting: string) => Promise<void>;
  saveConfig: () => Promise<void>;
  discardConfigDraft: () => void;
  toggleAutostart: () => Promise<void>;
  setAppVersion: (v: string) => void;
}

// 草稿是否有未落盘修改：只比较草稿字段（language 即时落盘，永不参与）
export function isConfigDirty(s: {
  config: LauncherConfig | null;
  persistedConfig: LauncherConfig | null;
}): boolean {
  const a = s.config;
  const b = s.persistedConfig;
  if (!a || !b) return false;
  return (
    a.minimize_to_tray_on_close !== b.minimize_to_tray_on_close ||
    a.dsh_admin_cap_domain !== b.dsh_admin_cap_domain ||
    a.dsh_use_cap_domain !== b.dsh_use_cap_domain ||
    a.dsh_extra_allowed_logins !== b.dsh_extra_allowed_logins ||
    a.market_catalog_url !== b.market_catalog_url
  );
}

export const createConfigSlice: Slice<ConfigSlice> = (set, get) => ({
  config: null,
  persistedConfig: null,
  autostart: false,
  languageSetting: "system",
  appVersion: "-",

  applyConfig: (cfg) =>
    set({
      config: cfg,
      persistedConfig: cfg,
      languageSetting: cfg.language || "system",
    }),
  setConfigField: (patch) => set((s) => ({ config: s.config ? { ...s.config, ...patch } : s.config })),
  setAutostart: (enabled) => set({ autostart: enabled }),

  // 语言切换编排：语言即时落盘（基于已保存状态，不夹带草稿）+ Rust 重建托盘 + react-i18next 响应式重渲染
  setLanguageSetting: async (setting) => {
    set({ languageSetting: setting });
    try {
      const saved = get().persistedConfig ?? get().config;
      if (saved) {
        await cmd.updateSettings({ ...saved, language: setting });
        set({ persistedConfig: { ...saved, language: setting } });
      }
      await cmd.setLanguage(setting);
      const resolved = await cmd.getResolvedLanguage();
      await i18n.changeLanguage(resolved === "zh-CN" ? "zh-CN" : "en");
      document.documentElement.lang = currentLanguage();
    } catch (e) {
      get().toast(i18n.t("Save failed: {{error}}", { error: tErr(String(e)) }), "error");
    }
  },

  saveConfig: async () => {
    try {
      const draft = currentConfigDraft(get());
      await cmd.updateSettings(draft);
      set({ persistedConfig: draft });
      get().toast(i18n.t("Settings saved"), "success");
    } catch (e) {
      get().toast(i18n.t("Save failed: {{error}}", { error: tErr(String(e)) }), "error");
    }
  },

  // 放弃未保存修改：草稿回滚到最近落盘快照
  discardConfigDraft: () => set((s) => (s.persistedConfig ? { config: s.persistedConfig } : {})),

  // 自启开关即时写 OS 注册项，失败回退
  toggleAutostart: async () => {
    const next = !get().autostart;
    set({ autostart: next });
    try {
      await cmd.autostartSet(next);
    } catch (e) {
      set({ autostart: !next });
      get().toast(tErr(String(e)), "error");
    }
  },

  setAppVersion: (v) => set({ appVersion: v }),
});
