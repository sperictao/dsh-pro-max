// 更新器切片：应用自更新的健康/检查/安装编排。updateInfo 仅有可用更新时
// 非空；updateLastCheckAt/updateCheckError 供关于页状态卡持久展示检查结果

import { i18n } from "../../i18n";
import { tErr } from "../../i18n/error";
import * as cmd from "../../commands";
import type { DownloadProgress, UpdateInfo, UpdaterConfigHealth } from "../../types";
import type { Slice } from "./shared";

export interface UpdaterSlice {
  updaterHealth: UpdaterConfigHealth | null;
  updaterHealthError: string | null;
  updateInfo: UpdateInfo | null;
  updateBusyKind: "check" | "install" | null;
  updateLastCheckAt: number | null;
  updateCheckError: string | null;
  downloadProgress: DownloadProgress | null;
  setDownloadProgress: (p: DownloadProgress) => void;
  refreshUpdaterHealth: () => Promise<void>;
  checkForUpdates: (silent?: boolean) => Promise<void>;
  installPendingUpdate: () => Promise<void>;
}

export const createUpdaterSlice: Slice<UpdaterSlice> = (set, get) => ({
  updaterHealth: null,
  updaterHealthError: null,
  updateInfo: null,
  updateBusyKind: null,
  updateLastCheckAt: null,
  updateCheckError: null,
  downloadProgress: null,

  setDownloadProgress: (p) => set({ downloadProgress: p }),

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
        if (!silent) get().toast(tErr(info.message), "error");
      } else if (!silent) {
        get().toast(i18n.t("Already up to date"), "info");
      }
    } catch (e) {
      set({ updateCheckError: String(e) });
      if (!silent) get().toast(i18n.t("Failed to check for updates: {{error}}", { error: tErr(String(e)) }), "error");
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
      get().toast(i18n.t("Update failed: {{error}}", { error: tErr(String(e)) }), "error");
    } finally {
      set({ updateBusyKind: null, downloadProgress: null });
    }
  },
});
