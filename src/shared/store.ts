// shared/store：全局状态（Zustand），按领域切片组合（slices/ 目录）。
// 组合后的 useAppStore 接口与切片前完全一致：消费方选择器不受影响。
// config 是设置页草稿（输入即改草稿，Save 时才落盘）；Tauri 推送事件经事件桥直写本 store。

import { create } from "zustand";
import { createUiSlice, type UiSlice } from "./store/slices/ui";
import { createConfigSlice, type ConfigSlice } from "./store/slices/config";
import { createDshSlice, type DshSlice } from "./store/slices/dsh";
import { createThemeSlice, type ThemeSlice } from "./store/slices/theme";
import { createUpdaterSlice, type UpdaterSlice } from "./store/slices/updater";
import { createMarketSlice, type MarketSlice } from "./store/slices/market";
import { createModelSlice, type ModelSlice } from "./store/slices/models";

export type { View, SettingsSection, ToastType, ToastItem } from "./store/slices/ui";
import type { DshSurface } from "./types";
export { isConfigDirty } from "./store/slices/config";

export interface AppStore
  extends UiSlice,
    ConfigSlice,
    DshSlice,
    ThemeSlice,
    UpdaterSlice,
    MarketSlice,
    ModelSlice {}

export const useAppStore = create<AppStore>()((set, get, store) => ({
  ...createUiSlice(set, get, store),
  ...createConfigSlice(set, get, store),
  ...createDshSlice(set, get, store),
  ...createThemeSlice(set, get, store),
  ...createUpdaterSlice(set, get, store),
  ...createMarketSlice(set, get, store),
  ...createModelSlice(set, get, store),
}));

/// 本应用纳管的形态（设置页「纳管形态」的事实）。配置未加载时按仅 web 走——与首页、
/// 插件页同一约定。两个布尔各自订阅，避免每次渲染造新数组触发重渲染
export function useManagedSurfaces(): { web: boolean; desktop: boolean; list: DshSurface[] } {
  const web = useAppStore((s) => s.config?.managed_surfaces.includes("web") ?? true);
  const desktop = useAppStore((s) => s.config?.managed_surfaces.includes("desktop") ?? false);
  const list: DshSurface[] = [];
  if (web) list.push("web");
  if (desktop) list.push("desktop");
  return { web, desktop, list };
}
