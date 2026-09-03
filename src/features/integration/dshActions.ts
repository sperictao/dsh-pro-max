// dsh 一键流程（启动/关闭/重启）与状态→视图模型的纯函数：首页按钮与系统托盘
// 菜单共用的唯一实现。入口（按钮 onClick / 托盘 tray-dsh-action 事件）只负责
// 触发，busy 守卫、访问模式选择、时间轴推进、toast 与收尾检测都在这里，
// 保证两条入口的交互逻辑完全一致。
//
// 时间轴数据一律来自 Rust：步骤序列/标题骨架由 dsh_step_schema 命令提供，
// 就绪视图由 dsh_detect 的 readyTimeline 提供，事件流由 dsh-step 事件推进。
// 前端不持有任何步骤 id 列表或「什么算完成」的规则副本。

import { open as openUrl } from "@tauri-apps/plugin-shell";
import { i18n } from "@/shared/i18n";
import { tErr } from "@/shared/i18n/error";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { DshStatus } from "@/shared/types";

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

const store = () => useAppStore.getState();

const busyNow = (): boolean => {
  const s = store();
  return s.dshStartBusy || s.dshStopBusy || s.dshRestartBusy || s.dshRecheckBusy;
};

// 时间轴的唯一认领点：流程一旦开始，事件流独占时间线——hasRunSetup 翻转与
// 骨架重置原子发生在同一入口，托盘回声（被 busy 守卫挡下的重入）也先经这里
// 置位，杜绝「点了没进度」类时序漂移。骨架来自 Rust schema（步骤序列+标题）
async function beginDshFlow(): Promise<void> {
  const remote = store().dshAccessMode === "remote";
  const skeleton = await cmd.dshStepSchema(remote);
  const s = store();
  s.setDshHasRunSetup(true);
  s.setDshTimeline(skeleton);
}

// 收尾：流程结束回到状态驱动视图（失败也刷新状态，但保留事件时间轴——
// 问题+解决方案持续可见）。succeeded 时以检测结果的就绪时间轴覆盖骨架；
// !succeeded 时只刷新状态，不动时间轴
async function settleDshFlow(succeeded: boolean): Promise<void> {
  const s = store();
  if (succeeded) s.setDshHasRunSetup(false);
  const remote = s.dshAccessMode === "remote";
  try {
    const status = await cmd.dshDetect(remote);
    const st = store();
    st.setDshStatus(status);
    if (succeeded) st.setDshTimeline(status.readyTimeline);
  } catch (e) {
    store().toast(i18n.t("dsh detection failed: {{error}}", { error: tErr(String(e)) }), "error");
  }
}

// 启动流程体：按当前模式执行 → 收尾刷新状态。busy 标志由调用方持有到收尾
// detect 结束，避免流程未完全落地时按钮抢先可用
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
        s.setDshTimeline(status.readyTimeline);
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
    if (!isRemote) s.toast(i18n.t("dsh start failed: {{error}}", { error: tErr(String(e)) }), "error");
  }
  await settleDshFlow(succeeded);
}

// 一键启动：按当前模式走对应启用流程。
// 远程 → dsh_setup 全链路（dsh web + Tailscale Serve + 校验）；
// 本地 → dsh_start_web（幂等保证 3899 就绪并返回本地地址，这里只管打开浏览器）。
// 认领（beginDshFlow）必须在 busy 守卫之前：托盘点击经 app.emit 广播，同窗口会
// 收到回声再进这里，回声被守卫挡下时也要让时间轴以事件流为准——否则主流程
// 发出的 dsh-step 事件会被状态推导视图盖掉，界面上「点了没进度」。
// 骨架重置在守卫之后的 beginDshFlow 内：回声走不到那里，不会清掉主触发
// 已推进的事件时间轴；真实的新启动总是先把时间轴整体翻回 pending 骨架
export async function startDshWeb(): Promise<void> {
  if (busyNow()) {
    // 回声/重入：只认领，不动骨架（骨架由主触发的 beginDshFlow 重置）
    store().setDshHasRunSetup(true);
    return;
  }
  store().setDshStartBusy(true);
  try {
    await beginDshFlow();
    await runStartFlow();
  } finally {
    store().setDshStartBusy(false);
  }
}

// 一键重启：先关后启，沿用当前访问模式（运行中模式锁定，重启不改变服务形态）。
// dsh_stop 幂等；关闭失败则中止重启，避免在未知状态上强行拉起
export async function restartDshWeb(): Promise<void> {
  if (busyNow()) {
    store().setDshHasRunSetup(true);
    return;
  }
  store().setDshRestartBusy(true);
  try {
    await cmd.dshStop();
    await beginDshFlow();
    await runStartFlow();
  } catch (e) {
    // stop 阶段失败时流程根本没跑起来，回到状态驱动视图，不留半吊子时间轴
    store().setDshHasRunSetup(false);
    store().toast(i18n.t("Restart failed: {{error}}", { error: tErr(String(e)) }), "error");
    await settleDshFlow(false);
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
    store().toast(i18n.t("Stop failed: {{error}}", { error: tErr(String(e)) }), "error");
  } finally {
    store().setDshStopBusy(false);
    // 停止后回到状态驱动时间轴，避免事件时间轴残留「已就绪」的历史状态
    store().setDshHasRunSetup(false);
    const remote = store().dshAccessMode === "remote";
    try {
      const status = await cmd.dshDetect(remote);
      const st = store();
      st.setDshStatus(status);
      st.setDshTimeline(status.readyTimeline);
    } catch (e) {
      store().toast(i18n.t("dsh detection failed: {{error}}", { error: tErr(String(e)) }), "error");
    }
  }
}
