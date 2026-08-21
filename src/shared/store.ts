// shared/store：全局状态（Zustand）。config 是设置页草稿（输入即改草稿，Save 时才落盘）。
// Tauri 推送事件经事件桥直写本 store。

import { create } from "zustand";
import { getStoredFamily, getStoredTheme, resolveDataTheme, type ThemeMode } from "./theme";
import { currentLanguage, i18n } from "./i18n";
import * as cmd from "./commands";
import { currentConfigDraft } from "./config";
import type {
  DownloadProgress,
  DshStepEvent,
  LauncherConfig,
  UpdateInfo,
  UpdaterConfigHealth,
} from "./types";

export type View = "integration" | "settings";
export type SettingsSection = "general" | "appearance" | "dsh" | "about";
export type ToastType = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

function applyDataTheme(mode: ThemeMode, family: string): void {
  document.documentElement.dataset.theme = resolveDataTheme(
    mode,
    family,
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
}

// 模块求值时机不保证 DOM 全局就绪（vitest 4 模块执行器在被依赖模块求值后才装 jsdom 全局），
// 读 localStorage 一律走这里：非 DOM 上下文回落 null（= 默认主题）
function readStored(key: string): string | null {
  return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
}

interface AppStore {
  // 导航
  activeView: View;
  settingsSection: SettingsSection;
  // 配置草稿
  config: LauncherConfig | null;
  autostart: boolean;
  languageSetting: string;
  appVersion: string;
  // 事件桥写入区
  dshTimeline: DshStepEvent[];
  downloadProgress: DownloadProgress | null;
  // 更新器（updateInfo 仅有可用更新时非空；
  // updateLastCheckAt/updateCheckError 供关于页状态卡持久展示检查结果，不再只靠瞬态 toast）
  updaterHealth: UpdaterConfigHealth | null;
  updaterHealthError: string | null;
  updateInfo: UpdateInfo | null;
  updateBusyKind: "check" | "install" | null;
  updateLastCheckAt: number | null;
  updateCheckError: string | null;
  // 主题（localStorage 是唯一事实来源，store 是渲染镜像）
  themeMode: ThemeMode;
  themeFamily: string;
  toasts: ToastItem[];

  navigate: (view: View) => void;
  setSettingsSection: (section: SettingsSection) => void;
  toast: (message: string, type?: ToastType) => void;
  dismissToast: (id: string) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setThemeFamily: (family: string) => void;
  syncSystemTheme: () => void;
  applyConfig: (cfg: LauncherConfig) => void;
  setConfigField: (patch: Partial<LauncherConfig>) => void;
  setAutostart: (enabled: boolean) => void;
  handleDshStep: (step: DshStepEvent) => void;
  setDshTimeline: (steps: DshStepEvent[]) => void;
  setDownloadProgress: (p: DownloadProgress) => void;
  setLanguageSetting: (setting: string) => Promise<void>;
  saveConfig: () => Promise<void>;
  toggleAutostart: () => Promise<void>;
  setAppVersion: (v: string) => void;
  refreshUpdaterHealth: () => Promise<void>;
  checkForUpdates: (silent?: boolean) => Promise<void>;
  installPendingUpdate: () => Promise<void>;
}

export const useAppStore = create<AppStore>()((set, get) => ({
  activeView: "integration",
  settingsSection: "general",
  config: null,
  autostart: false,
  languageSetting: "system",
  appVersion: "-",
  dshTimeline: [],
  downloadProgress: null,
  updaterHealth: null,
  updaterHealthError: null,
  updateInfo: null,
  updateBusyKind: null,
  updateLastCheckAt: null,
  updateCheckError: null,
  themeMode: getStoredTheme(readStored("theme")),
  themeFamily: getStoredFamily(readStored("theme-family")),
  toasts: [],

  navigate: (view) => set({ activeView: view }),
  setSettingsSection: (section) => set({ settingsSection: section }),

  toast: (message, type = "info") => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    // 3s 后组件开始淡出，3.3s 后移除
    setTimeout(() => get().dismissToast(id), 3300);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setThemeMode: (mode) => {
    localStorage.setItem("theme", mode);
    applyDataTheme(mode, get().themeFamily);
    set({ themeMode: mode });
  },
  setThemeFamily: (family) => {
    localStorage.setItem("theme-family", family);
    applyDataTheme(get().themeMode, family);
    set({ themeFamily: family });
  },
  syncSystemTheme: () => {
    if (get().themeMode === "system") applyDataTheme("system", get().themeFamily);
  },

  applyConfig: (cfg) =>
    set({
      config: cfg,
      languageSetting: cfg.language || "system",
    }),
  setConfigField: (patch) => set((s) => ({ config: s.config ? { ...s.config, ...patch } : s.config })),
  setAutostart: (enabled) => set({ autostart: enabled }),

  handleDshStep: (step) =>
    set((s) => {
      const tl = [...s.dshTimeline];
      const i = tl.findIndex((x) => x.index === step.index);
      if (i >= 0) {
        tl[i] = step;
      } else {
        tl.push(step);
        tl.sort((a, b) => a.index - b.index);
      }
      return { dshTimeline: tl };
    }),
  setDshTimeline: (steps) => set({ dshTimeline: steps }),
  setDownloadProgress: (p) => set({ downloadProgress: p }),

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
      get().toast(i18n.t("Save failed: {{error}}", { error: String(e) }), "error");
    }
  },

  saveConfig: async () => {
    try {
      await cmd.updateSettings(currentConfigDraft(get()));
      get().toast(i18n.t("Settings saved"), "success");
    } catch (e) {
      get().toast(i18n.t("Save failed: {{error}}", { error: String(e) }), "error");
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
      get().toast(String(e), "error");
    }
  },

  setAppVersion: (v) => set({ appVersion: v }),

  // 更新源健康
  refreshUpdaterHealth: async () => {
    try {
      set({ updaterHealth: await cmd.getUpdaterConfigHealth(), updaterHealthError: null });
    } catch (e) {
      set({ updaterHealth: null, updaterHealthError: String(e) });
    }
  },

  // 检查更新（silent 时静默失败/静默无更新；结果记录供状态卡展示）
  checkForUpdates: async (silent = false) => {
    if (get().updateBusyKind) return;
    set({ updateBusyKind: "check" });
    try {
      const info = await cmd.checkUpdate();
      set({ updateInfo: info.hasUpdate ? info : null, updateLastCheckAt: Date.now(), updateCheckError: null });
      if (info.hasUpdate) {
        get().toast(i18n.t("New version available: v{{version}}", { version: String(info.availableVersion) }), "info");
      } else if (info.message) {
        if (!silent) get().toast(info.message, "error");
      } else if (!silent) {
        get().toast(i18n.t("Already up to date"), "info");
      }
    } catch (e) {
      set({ updateCheckError: String(e) });
      if (!silent) get().toast(i18n.t("Failed to check for updates: {{error}}", { error: String(e) }), "error");
    } finally {
      set({ updateBusyKind: null });
    }
  },

  // 无待装更新时退化为检查更新
  installPendingUpdate: async () => {
    const pending = get().updateInfo;
    if (!pending) {
      await get().checkForUpdates();
      return;
    }
    if (get().updateBusyKind) return;
    set({ updateBusyKind: "install" });
    try {
      const msg = await cmd.installUpdate(pending.availableVersion);
      get().toast(msg, "success");
      set({ updateInfo: null });
    } catch (e) {
      get().toast(i18n.t("Update failed: {{error}}", { error: String(e) }), "error");
    } finally {
      set({ updateBusyKind: null, downloadProgress: null });
    }
  },
}));
