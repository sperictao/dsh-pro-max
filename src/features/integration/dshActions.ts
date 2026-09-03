// dsh 一键流程（启动/关闭/重启）与状态→视图模型的纯函数：首页按钮与系统托盘
// 菜单共用的唯一实现。入口（按钮 onClick / 托盘 tray-dsh-action 事件）只负责
// 触发，busy 守卫、访问模式选择、时间轴推进、toast 与收尾检测都在这里，
// 保证两条入口的交互逻辑完全一致。

import { open as openUrl } from "@tauri-apps/plugin-shell";
import { i18n } from "@/shared/i18n";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { DshStatus, DshStepEvent } from "@/shared/types";

export function proxyBypassHostForRemoteUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host || null;
  } catch {
    return null;
  }
}

export function verifiedRemoteUrl(status: DshStatus): string | null {
  return status.remoteUrlAccess === "ready" ? status.url : null;
}

// 远程时间轴步骤顺序（与 Rust dsh_setup 的 index 一一对应）
const STEP_IDS = ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"] as const;

// 本地一键启动的时间轴步骤（与 Rust dsh_start_web 的 LOCAL_STEPS 一一对应）
const LOCAL_STEP_IDS = ["node", "install", "start", "ready"] as const;

export function statusTextKey(s: DshStatus): string {
  if (!s.nodeAvailable) return "Node.js not detected";
  if (!s.dshInstalled) return "DeepSeek Harness not installed";
  if (!s.dshCompatible) return "dsh version is not supported by the auth plugins";
  if (!s.tailscaleInstalled || !s.tailscaleOnline) return "Tailscale not ready";
  if (!s.magicDnsEnabled) return "MagicDNS not enabled";
  if (!s.dshRunning) return "dsh web not running";
  // 授权插件只服务于远程访问链路；纯本地用 dsh 不需要，故放在运行之后
  if (!s.pluginsInstalled) return "dsh auth plugins not installed";
  if (!s.serveConfigured) return "Tailscale serve not configured";
  if (s.remoteUrlAccess === "capability_denied") return "Remote capability grant denied";
  if (s.remoteUrlAccess === "proxy_interference") return "Local proxy bypass required";
  if (s.remoteUrlAccess === "endpoint_failure") return "Remote endpoint check failed";
  if (s.remoteUrlAccess !== "ready") return "Remote access not verified";
  return "Remote access ready";
}

// 本地模式状态文案：不要求 Tailscale/插件/serve，只看 node、dsh 安装与 web 是否在跑
export function localStatusTextKey(s: DshStatus): string {
  if (!s.nodeAvailable) return "Node.js not detected";
  if (!s.dshInstalled) return "DeepSeek Harness not installed";
  if (!s.dshCompatible) return "dsh version is not supported by the auth plugins";
  if (!s.dshRunning) return "dsh web not running";
  return "Local access ready";
}

// 状态行文案总入口（首页状态球与卡片状态行共用）：流程进行中 → Working…，
// 尚无检测结果 → Detecting…，其余按访问模式取对应状态键
export function statusLineKey(status: DshStatus | null, busy: boolean, isRemote: boolean): string {
  if (busy) return "Working…";
  if (!status) return "Detecting…";
  return isRemote ? statusTextKey(status) : localStatusTextKey(status);
}

// 由检测结果推导「就绪时间轴」：已满足的步骤标 done，其余 pending（远程 8 步）
export function timelineFromStatus(s: DshStatus): DshStepEvent[] {
  const allReady =
    s.nodeAvailable && s.dshInstalled && s.dshCompatible && s.pluginsInstalled &&
    s.dshRunning && s.tailscaleOnline && s.magicDnsEnabled && s.serveConfigured &&
    s.remoteUrlAccess === "ready";
  const done = (ok: boolean): DshStepEvent["state"] => (ok ? "done" : "pending");
  const step = (index: number, id: string, ok: boolean): DshStepEvent => ({
    index, id, state: done(ok), detail: null, problem: null, solution: null,
  });
  return [
    step(0, "node", s.nodeAvailable),
    step(1, "install", s.dshInstalled && s.dshCompatible),
    step(2, "plugins", s.pluginsInstalled),
    step(3, "tailscale", s.tailscaleInstalled && s.tailscaleOnline),
    step(4, "magicdns", s.magicDnsEnabled),
    step(5, "start", s.dshRunning),
    step(6, "serve", s.serveConfigured),
    step(7, "verify", allReady),
  ];
}

// 本地模式就绪时间轴：node / install / start / ready 四项，与远程 8 步不同
export function localTimelineFromStatus(s: DshStatus): DshStepEvent[] {
  const done = (ok: boolean): DshStepEvent["state"] => (ok ? "done" : "pending");
  const step = (index: number, id: string, ok: boolean): DshStepEvent => ({
    index, id, state: done(ok), detail: null, problem: null, solution: null,
  });
  return [
    step(0, "node", s.nodeAvailable),
    step(1, "install", s.dshInstalled && s.dshCompatible),
    step(2, "start", s.dshRunning),
    step(3, "ready", s.dshRunning),
  ];
}

const store = () => useAppStore.getState();

const busyNow = (): boolean => {
  const s = store();
  return s.dshStartBusy || s.dshStopBusy || s.dshRestartBusy || s.dshRecheckBusy;
};

// 启动流程体：时间轴骨架的初始化由入口（start/restart）负责（随后由后端
// dsh-step 事件逐步推进）；这里按当前模式执行 → 收尾刷新状态。busy 标志由
// 调用方持有到收尾 detect 结束，避免流程未完全落地时按钮抢先可用
async function runStartFlow(): Promise<void> {
  const s = store();
  const isRemote = s.dshAccessMode === "remote";
  let succeeded = false;
  try {
    if (isRemote) {
      await cmd.dshSetup();
      // dsh_setup 返回 void：serve 配置完成后远程地址由 detect 给出。三个授权参数
      // 留空也能正常 serve（普通远程访问仍需身份 allowlist 与 tailnet TCP 443 grant）。只有
      // HTTPS + WebSocket + 本机代理路径都复查通过才打开远程地址。
      const status = await cmd.dshDetect(true);
      s.setDshStatus(status);
      const url = verifiedRemoteUrl(status);
      if (!url) {
        s.setDshTimeline(timelineFromStatus(status));
        s.toast(i18n.t(statusTextKey(status)), "error");
        return;
      }
      await openUrl(url);
      s.toast(i18n.t("Remote access ready"), "success");
    } else {
      const url = await cmd.dshStartWeb();
      await openUrl(url);
    }
    succeeded = true;
  } catch (e) {
    // 远程失败详情已由 dsh-step 事件渲染在时间轴节点上
    if (!isRemote) s.toast(i18n.t("dsh start failed: {{error}}", { error: String(e) }), "error");
  } finally {
    // 成功后回到状态驱动视图；失败时保留事件时间轴（问题+解决方案持续可见）
    if (succeeded) s.setDshHasRunSetup(false);
    try {
      const status = await cmd.dshDetect(isRemote);
      store().setDshStatus(status);
      if (succeeded) {
        store().setDshTimeline(isRemote ? timelineFromStatus(status) : localTimelineFromStatus(status));
      }
    } catch (e) {
      store().toast(i18n.t("dsh detection failed: {{error}}", { error: String(e) }), "error");
    }
  }
}

// 一键启动：按当前模式走对应启用流程。
// 远程 → dsh_setup 全链路（dsh web + Tailscale Serve + 校验）；
// 本地 → dsh_start_web（幂等保证 3899 就绪并返回本地地址，这里只管打开浏览器）
// hasRunSetup 必须在 busy 守卫之前设置：托盘点击经 app.emit 广播，同窗口会
// 收到回声再进这里，回声被守卫挡下时也要让时间轴以事件流为准——否则主流程
// 发出的 dsh-step 事件会被状态推导视图盖掉，界面上「点了没进度」。
// 骨架重置放在守卫之后：回声走不到这里，不会清掉主触发已推进的事件时间轴；
// 而一次真实的新启动总是先把时间轴整体翻回 pending，再随事件逐步点亮
export async function startDshWeb(): Promise<void> {
  store().setDshHasRunSetup(true);
  if (busyNow()) return;
  const ids = store().dshAccessMode === "remote" ? STEP_IDS : LOCAL_STEP_IDS;
  store().setDshTimeline(ids.map((id, index) => ({
    index, id, state: "pending" as const, detail: null, problem: null, solution: null,
  })));
  store().setDshStartBusy(true);
  try {
    await runStartFlow();
  } finally {
    store().setDshStartBusy(false);
  }
}

// 一键重启：先关后启，沿用当前访问模式（运行中模式锁定，重启不改变服务形态）。
// dsh_stop 幂等；关闭失败则中止重启，避免在未知状态上强行拉起
export async function restartDshWeb(): Promise<void> {
  store().setDshHasRunSetup(true);
  if (busyNow()) return;
  const ids = store().dshAccessMode === "remote" ? STEP_IDS : LOCAL_STEP_IDS;
  store().setDshTimeline(ids.map((id, index) => ({
    index, id, state: "pending" as const, detail: null, problem: null, solution: null,
  })));
  store().setDshRestartBusy(true);
  try {
    await cmd.dshStop();
    await runStartFlow();
  } catch (e) {
    // stop 阶段失败时流程根本没跑起来，回到状态驱动视图，不留半吊子时间轴
    store().setDshHasRunSetup(false);
    store().toast(i18n.t("Restart failed: {{error}}", { error: String(e) }), "error");
  } finally {
    store().setDshRestartBusy(false);
  }
}

// 一键关闭：按当前模式关闭。Rust dsh_stop 对两种模式都是幂等的：
// 本地模式会关掉 dsh web（serve/自启若从未配置则为 no-op）
export async function stopDshWeb(): Promise<void> {
  if (busyNow()) return;
  store().setDshStopBusy(true);
  try {
    await cmd.dshStop();
    store().toast(i18n.t("dsh web stopped"), "info");
  } catch (e) {
    store().toast(i18n.t("Stop failed: {{error}}", { error: String(e) }), "error");
  } finally {
    store().setDshStopBusy(false);
    // 停止后回到状态驱动时间轴，避免事件时间轴残留「已就绪」的历史状态
    store().setDshHasRunSetup(false);
    try {
      const isRemote = store().dshAccessMode === "remote";
      const status = await cmd.dshDetect(isRemote);
      store().setDshStatus(status);
      store().setDshTimeline(isRemote ? timelineFromStatus(status) : localTimelineFromStatus(status));
    } catch (e) {
      store().toast(i18n.t("dsh detection failed: {{error}}", { error: String(e) }), "error");
    }
  }
}
