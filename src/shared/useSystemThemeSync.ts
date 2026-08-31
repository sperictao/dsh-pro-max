// useSystemThemeSync：监听 OS 亮暗外观变化，按当前主题模式重解析 data-theme。
// 为什么去抖：macOS 在浅色/深色过渡（含自动切换的过渡段）会连发多个
// prefers-color-scheme change 事件；每次都同步写 <html data-theme> 会反复触发
// 整窗样式重算，表现为窗口持续闪烁。等待事件静默后再应用，只取最终外观。

import { useEffect } from "react";
import { useAppStore } from "./store";
import { log } from "./logger";

const SETTLE_MS = 250;

export function useSystemThemeSync(): void {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: boolean | null = null;

    const flush = () => {
      timer = null;
      if (pending === null || pending === mq.matches) return;
      pending = null;
      log.info(`系统外观变化已稳定，同步主题: prefersDark=${mq.matches}`);
      useAppStore.getState().syncSystemTheme();
    };

    const onChange = (e: MediaQueryListEvent) => {
      pending = e.matches;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, SETTLE_MS);
    };

    mq.addEventListener("change", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
