// 首页状态球区：移植自 codex-pro-max 首页的总状态指示器（视觉动效同源：
// 常驻呼吸 + 悬停暂停放大），并承载状态文字下的访问模式说明小字。
// 聚合规则与卡片状态行同一条链：操作进行中/尚无检测结果 → starting，
// 检测出错 → failed，dsh web 运行中 → running，其余 → stopped；
// 文案取 statusLineKey（与卡片状态行同一事实来源，不另造字符串）。

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import { statusLineKey } from "./dshActions";

type BallState = "stopped" | "starting" | "running" | "failed";

const ICON_CHECK = (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>
);
const ICON_X = (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 18 18 6M6 6l12 12" /></svg>
);
const ICON_PLAY = (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8.5 5.5c-.8-.5-1.9 0-1.9 1v11c0 1 1.1 1.6 1.9 1.1l8.5-5.5c.8-.5.8-1.7 0-2.2L8.5 5.5z" /></svg>
);

const BALL_ICONS: Record<BallState, ReactNode> = {
  running: ICON_CHECK,
  stopped: ICON_X,
  starting: ICON_PLAY,
  failed: ICON_X,
};

export function StatusBall() {
  const { t } = useTranslation();
  const status = useAppStore((s) => s.dshStatus);
  const isRemote = useAppStore((s) => s.dshAccessMode) === "remote";
  const startBusy = useAppStore((s) => s.dshStartBusy);
  const stopBusy = useAppStore((s) => s.dshStopBusy);
  const restartBusy = useAppStore((s) => s.dshRestartBusy);
  const recheckBusy = useAppStore((s) => s.dshRecheckBusy);

  const busy = startBusy || stopBusy || restartBusy || recheckBusy;
  const state: BallState = busy || !status
    ? "starting"
    : status.error
      ? "failed"
      : status.dshRunning
        ? "running"
        : "stopped";

  return (
    <div className="status-indicator" id="dsh-status-ball" role="status" aria-live="polite">
      <div className="status-indicator-icon-container">
        <div className={`status-indicator-icon ${state}`} aria-hidden="true">
          <div className="status-indicator-symbol">{BALL_ICONS[state]}</div>
        </div>
      </div>
      <div className={`status-indicator-text ${state}`}>{t(statusLineKey(status, busy, isRemote))}</div>
      {/* 访问模式说明：自卡片状态区迁来，紧跟球区状态文字 */}
      <div className="status-indicator-desc">
        {t(
          isRemote
            ? "Remote access to the dsh Web UI over Tailscale HTTPS: https://<hostname>.ts.net → dsh web :3899. Remote settings and credentials require the configured admin capability in tailnet grants."
            : "Local access to the dsh Web UI at http://127.0.0.1:3899.",
        )}
      </div>
    </div>
  );
}
