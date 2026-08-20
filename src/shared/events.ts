// shared/events：Tauri 推送事件的类型化订阅——事件名全仓只出现在这里
// 每个函数返回 unlisten；调用方负责在 effect cleanup 中解绑

import { listen } from "@tauri-apps/api/event";
import type { DownloadProgress, DshStepEvent } from "./types";

export const onUpdaterDownloadProgress = (cb: (p: DownloadProgress) => void) =>
  listen<DownloadProgress>("updater-download-progress", (e) => cb(e.payload));

export const onDshStep = (cb: (p: DshStepEvent) => void) =>
  listen<DshStepEvent>("dsh-step", (e) => cb(e.payload));
