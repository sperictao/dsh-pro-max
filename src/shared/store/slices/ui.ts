// 导航与通知切片：视图切换、设置分区、toast

import type { Slice } from "./shared";

export type View = "integration" | "market" | "models" | "settings";
export type SettingsSection =
  | "general"
  | "appearance"
  | "dsh-version"
  | "dsh-autostart"
  | "dsh-auth"
  | "about";
export type ToastType = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

export interface UiSlice {
  activeView: View;
  settingsSection: SettingsSection;
  toasts: ToastItem[];
  navigate: (view: View) => void;
  setSettingsSection: (section: SettingsSection) => void;
  toast: (message: string, type?: ToastType) => void;
  dismissToast: (id: string) => void;
}

export const createUiSlice: Slice<UiSlice> = (set, get) => ({
  activeView: "integration",
  settingsSection: "general",
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
});
