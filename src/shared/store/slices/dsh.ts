// dsh 运行时切片：一键流程的运行态、时间轴与版本/自启状态。
// 跨页面保留：切页不丢一键启动/停止/修复的进行态与远程授权状态

import type { DshAccessMode, DshLatestInfo, DshStatus, DshStepEvent } from "../../types";
import { readStored, type Slice } from "./shared";

// dsh 访问模式：localStorage 是用户选择的记忆，store 是渲染镜像（与主题同理）
const ACCESS_MODE_KEY = "dsh-access-mode";

function readStoredAccessMode(): DshAccessMode {
  return readStored(ACCESS_MODE_KEY) === "remote" ? "remote" : "local";
}

function storeAccessMode(mode: DshAccessMode): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(ACCESS_MODE_KEY, mode);
}

export interface DshSlice {
  dshStatus: DshStatus | null;
  dshAccessMode: DshAccessMode;
  dshStartBusy: boolean;
  dshStopBusy: boolean;
  dshRestartBusy: boolean;
  dshRecheckBusy: boolean;
  dshHasRunSetup: boolean;
  // dsh 版本管理（安装/检查状态跨页面保留）
  dshLatest: DshLatestInfo | null;
  dshLatestBusy: boolean;
  dshInstallingVersion: string | null;
  // dsh 开机自启（与设置页分区共用，切页后保留检测/切换状态）
  dshAutostart: boolean | null;
  dshAutostartBusy: boolean;
  // 事件桥写入区
  dshTimeline: DshStepEvent[];
  setDshStatus: (status: DshStatus | null) => void;
  setDshAccessMode: (mode: DshAccessMode) => void;
  setDshStartBusy: (busy: boolean) => void;
  setDshStopBusy: (busy: boolean) => void;
  setDshRestartBusy: (busy: boolean) => void;
  setDshRecheckBusy: (busy: boolean) => void;
  setDshHasRunSetup: (hasRunSetup: boolean) => void;
  setDshLatest: (info: DshLatestInfo | null) => void;
  setDshLatestBusy: (busy: boolean) => void;
  setDshInstallingVersion: (version: string | null) => void;
  setDshAutostart: (value: boolean | null) => void;
  setDshAutostartBusy: (busy: boolean) => void;
  handleDshStep: (step: DshStepEvent) => void;
  setDshTimeline: (steps: DshStepEvent[]) => void;
}

export const createDshSlice: Slice<DshSlice> = (set) => ({
  dshStatus: null,
  dshAccessMode: readStoredAccessMode(),
  dshStartBusy: false,
  dshStopBusy: false,
  dshRestartBusy: false,
  dshRecheckBusy: false,
  dshHasRunSetup: false,
  dshLatest: null,
  dshLatestBusy: false,
  dshInstallingVersion: null,
  dshAutostart: null,
  dshAutostartBusy: false,
  dshTimeline: [],

  setDshStatus: (status) => set({ dshStatus: status }),
  setDshAccessMode: (mode) => {
    storeAccessMode(mode);
    set({ dshAccessMode: mode });
  },
  setDshStartBusy: (busy) => set({ dshStartBusy: busy }),
  setDshStopBusy: (busy) => set({ dshStopBusy: busy }),
  setDshRestartBusy: (busy) => set({ dshRestartBusy: busy }),
  setDshRecheckBusy: (busy) => set({ dshRecheckBusy: busy }),
  setDshHasRunSetup: (hasRunSetup) => set({ dshHasRunSetup: hasRunSetup }),
  setDshLatest: (info) => set({ dshLatest: info }),
  setDshLatestBusy: (busy) => set({ dshLatestBusy: busy }),
  setDshInstallingVersion: (version) => set({ dshInstallingVersion: version }),
  setDshAutostart: (value) => set({ dshAutostart: value }),
  setDshAutostartBusy: (busy) => set({ dshAutostartBusy: busy }),

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
      // running 事件兜底置位：流程真实启动后时间轴必须以事件流为准，
      // 即使入口因并发回声没走到置位（见 dshActions start/restart 的注释）
      return {
        dshTimeline: tl,
        dshHasRunSetup: step.state === "running" ? true : s.dshHasRunSetup,
      };
    }),
  setDshTimeline: (steps) => set({ dshTimeline: steps }),
});
