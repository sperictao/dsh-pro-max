// 配置切片：设置页草稿（输入即改草稿，Save 时才落盘）与语言切换编排

import { currentLanguage, i18n } from "../../i18n";
import { tErr } from "../../i18n/error";
import * as cmd from "../../commands";
import { currentConfigDraft } from "../../config";
import type { LauncherConfig } from "../../types";
import type { Slice } from "./shared";

export interface ConfigSlice {
  config: LauncherConfig | null;
  autostart: boolean;
  languageSetting: string;
  appVersion: string;
  applyConfig: (cfg: LauncherConfig) => void;
  setConfigField: (patch: Partial<LauncherConfig>) => void;
  setAutostart: (enabled: boolean) => void;
  setLanguageSetting: (setting: string) => Promise<void>;
  saveConfig: () => Promise<void>;
  toggleAutostart: () => Promise<void>;
  setAppVersion: (v: string) => void;
}

export const createConfigSlice: Slice<ConfigSlice> = (set, get) => ({
  config: null,
  autostart: false,
  languageSetting: "system",
  appVersion: "-",

  applyConfig: (cfg) =>
    set({
      config: cfg,
      languageSetting: cfg.language || "system",
    }),
  setConfigField: (patch) => set((s) => ({ config: s.config ? { ...s.config, ...patch } : s.config })),
  setAutostart: (enabled) => set({ autostart: enabled }),

  // 语言切换编排：落盘 + Rust 重建托盘 + react-i18next 响应式重渲染
  setLanguageSetting: async (setting) => {
    set({ languageSetting: setting });
    try {
      const cfg = get().config;
      if (cfg) await cmd.updateSettings({ ...cfg, language: setting });
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
      await cmd.updateSettings(currentConfigDraft(get()));
      get().toast(i18n.t("Settings saved"), "success");
    } catch (e) {
      get().toast(i18n.t("Save failed: {{error}}", { error: tErr(String(e)) }), "error");
    }
  },

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
