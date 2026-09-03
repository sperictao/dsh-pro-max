// shared/events：Tauri 推送事件的类型化订阅——事件名全仓只出现在这里
// 每个函数返回 unlisten；调用方负责在 effect cleanup 中解绑

import { listen } from "@tauri-apps/api/event";
import type { DownloadProgress, DshStepEvent, MarketInstallLogEvent } from "./types";

export const onUpdaterDownloadProgress = (cb: (p: DownloadProgress) => void) =>
  listen<DownloadProgress>("updater-download-progress", (e) => cb(e.payload));

export const onDshStep = (cb: (p: DshStepEvent) => void) =>
  listen<DshStepEvent>("dsh-step", (e) => cb(e.payload));

// 插件安装过程明细：dsh/pnpm 子进程的展示行（Rust 侧逐行推送）
export const onMarketInstallLog = (cb: (p: MarketInstallLogEvent) => void) =>
  listen<MarketInstallLogEvent>("market-install-log", (e) => cb(e.payload));

// 托盘 dsh 三键点击：payload 为菜单项 id（dsh-start / dsh-stop / dsh-restart）
export const onTrayDshAction = (cb: (id: string) => void) =>
  listen<string>("tray-dsh-action", (e) => cb(e.payload));
