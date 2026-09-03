// 主题切片：localStorage 是唯一事实来源，store 是渲染镜像

import { getStoredFamily, getStoredTheme, resolveDataTheme, type ThemeMode } from "../../theme";
import { readStored, type Slice } from "./shared";

// 已落 DOM 的 data-theme 值：OS 在外观过渡期间可能连发多个 change 事件，
// 同值重写 <html> 属性会触发整窗重绘，导致主窗口持续闪烁
let lastAppliedDataTheme: string | null = null;

function applyDataTheme(mode: ThemeMode, family: string): void {
  const next = resolveDataTheme(
    mode,
    family,
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  if (next === lastAppliedDataTheme) return;
  lastAppliedDataTheme = next;
  document.documentElement.dataset.theme = next;
}

export interface ThemeSlice {
  themeMode: ThemeMode;
  themeFamily: string;
  setThemeMode: (mode: ThemeMode) => void;
  setThemeFamily: (family: string) => void;
  syncSystemTheme: () => void;
}

export const createThemeSlice: Slice<ThemeSlice> = (set, get) => ({
  themeMode: getStoredTheme(readStored("theme")),
  themeFamily: getStoredFamily(readStored("theme-family")),

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
});
