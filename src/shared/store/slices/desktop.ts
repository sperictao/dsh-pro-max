// 桌面应用切片：官方 DeepSeek Harness 桌面应用的外部检测与桥接状态——全应用一份。
// 首页卡片、插件页桌面 tab、市场的未知角标、模型页的桌面档都读这里，谁先需要谁刷新，
// 不各自探测、各存一份（同一件事各问各的，答案会在页面之间打架）

import { renderMessage } from "../../i18n/error";
import * as cmd from "../../commands";
import type { BridgeStatus, DesktopStatus } from "../../types";
import type { Slice } from "./shared";

export interface DesktopSlice {
  // 外部检测（安装/版本/运行）；null = 还没测过或测不了
  desktopStatus: DesktopStatus | null;
  // 桥接状态；null = 还没问过或问不到
  desktopBridge: BridgeStatus | null;
  // 至少完整探测过一次：区分「还在问」与「问过了、答案是不可用」
  desktopChecked: boolean;
  refreshDesktop: () => Promise<void>;
}

// 并发去重：几个页面同时挂载时只探测一次，大家等同一个结果
let inflight: Promise<void> | null = null;

export const createDesktopSlice: Slice<DesktopSlice> = (set, get) => ({
  desktopStatus: null,
  desktopBridge: null,
  desktopChecked: false,
  refreshDesktop: () => {
    inflight ??= (async () => {
      try {
        set({ desktopStatus: await cmd.desktopDetect() });
      } catch (e) {
        // 应用本身探测不了就没有可判断的前提：说明原因，桥接照问（它是本机端口探测）
        get().toast(renderMessage(e), "error");
      }
      // 桥接探测失败只让桥接那一项缺席，不牵连上面的检测结果
      let bridge: BridgeStatus | null = null;
      try {
        bridge = await cmd.desktopBridgeStatus();
      } catch {
        // 静默：依赖桥接的部分本就因桥接不可用而给出去向
      }
      set({ desktopBridge: bridge, desktopChecked: true });
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  },
});
