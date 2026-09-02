// dsh 卡片：DeepSeek Harness 访问模式（本地/远程）切换 + 一键启动/关闭 + 状态链时间轴
// 模式开关只是选择访问模式（本地 = 127.0.0.1:3899，远程 = 追加 Tailscale HTTPS），
// 不执行任何启用/停止；一键启动/关闭/重启的流程实现在 dshActions（与托盘共用），
// 这里只负责触发。时间轴步骤由事件桥写入 store.dshTimeline；
// 未跑过流程时用检测结果推导就绪视图

import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { useAppStore } from "@/shared/store";
import * as cmd from "@/shared/commands";
import { BTN_DESTRUCTIVE, BTN_PRIMARY, BTN_SM, TOGGLE } from "@/shared/lib/ui";
import type { DshAccessMode, DshStepEvent } from "@/shared/types";
import {
  localStatusTextKey,
  localTimelineFromStatus,
  proxyBypassHostForRemoteUrl,
  restartDshWeb,
  startDshWeb,
  statusTextKey,
  stopDshWeb,
  timelineFromStatus,
  verifiedRemoteUrl,
} from "./dshActions";

// 保持旧导出兼容（类型已上移到 shared/types）
export type { DshAccessMode };

// 步骤标题（key 即 i18n key；本地四步 node/install/start/ready 也在其中）
const STEP_TITLES: Record<string, string> = {
  node: "Check Node.js & npm",
  install: "Install DeepSeek Harness (dsh)",
  plugins: "Install authorization plugins",
  tailscale: "Check Tailscale",
  magicdns: "Enable MagicDNS",
  start: "Start dsh Web",
  serve: "Configure Tailscale serve",
  verify: "Verify remote access",
  ready: "Local access ready",
};

function StepMarker({ state }: { state: DshStepEvent["state"] }) {
  switch (state) {
    case "done":
      return <>✓</>;
    case "failed":
      return <>✕</>;
    case "running":
      return <span className="timeline-spinner"></span>;
    case "skipped":
      return <>–</>;
    default:
      return <>○</>;
  }
}

// 单个可用地址行：地址 + 复制/打开（本地与远程各一行，互不混淆）
function AddressRow({
  url,
  onCopy,
  onOpen,
  openDisabled = false,
}: {
  url: string;
  onCopy: (u: string) => void;
  onOpen: (u: string) => void;
  openDisabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <span className="shrink-0 rounded-full bg-primary/15 px-2.5 py-0.5 font-mono text-xs text-primary">{url}</span>
      <button className={BTN_SM} onClick={() => void onCopy(url)}>{t("Copy")}</button>
      <button className={BTN_SM} disabled={openDisabled} onClick={() => void onOpen(url)}>{t("Open")}</button>
    </div>
  );
}

export function DshCard() {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  const timeline = useAppStore((s) => s.dshTimeline);
  const setDshTimeline = useAppStore((s) => s.setDshTimeline);
  const status = useAppStore((s) => s.dshStatus);
  const startBusy = useAppStore((s) => s.dshStartBusy);
  const stopBusy = useAppStore((s) => s.dshStopBusy);
  const restartBusy = useAppStore((s) => s.dshRestartBusy);
  const recheckBusy = useAppStore((s) => s.dshRecheckBusy);
  const hasRunSetup = useAppStore((s) => s.dshHasRunSetup);
  const mode = useAppStore((s) => s.dshAccessMode);
  const setStatus = useAppStore((s) => s.setDshStatus);
  const setStartBusy = useAppStore((s) => s.setDshStartBusy);
  const setRecheckBusy = useAppStore((s) => s.setDshRecheckBusy);
  const setHasRunSetup = useAppStore((s) => s.setDshHasRunSetup);
  const setMode = useAppStore((s) => s.setDshAccessMode);

  const busy = startBusy || stopBusy || restartBusy || recheckBusy;
  // 是否跑过一键流程：跑过则时间轴以事件流为准，否则用检测结果渲染就绪视图
  // 当前访问模式：local（127.0.0.1:3899 本地访问）或 remote（Tailscale HTTPS 远程访问）。
  // 默认本地模式；用户切换后记住选择（localStorage）；store 是渲染镜像
  const isRemote = mode === "remote";
  // 运行中锁定访问模式：切换只决定「下次启动走哪条流程」，不会改变运行中
  // 服务的实际形态（本地回环 vs Tailscale serve），允许切换只会造成
  // 「切了没反应」的困惑；明确禁用并给出解锁路径（先停止）
  const modeLocked = !!status?.dshRunning;

  const refresh = useCallback(async () => {
    try {
      const s = await cmd.dshDetect(isRemote);
      setStatus(s);
      if (!hasRunSetup) {
        setDshTimeline(isRemote ? timelineFromStatus(s) : localTimelineFromStatus(s));
      }
    } catch (e) {
      toast(t("dsh detection failed: {{error}}", { error: String(e) }), "error");
    }
  }, [hasRunSetup, isRemote, setDshTimeline, setStatus, t, toast]);

  useEffect(() => {
    void refresh();
    // 仅挂载时检测一次；后续刷新由操作完成时触发（与旧行为一致）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换访问模式：仅选择，不执行任何启动/停止；时间轴切到对应模式的就绪视图
  const switchMode = async (next: DshAccessMode) => {
    if (next === mode || busy) return;
    setMode(next);
    setHasRunSetup(false);
    setRecheckBusy(true);
    if (next === "remote") {
      const current = useAppStore.getState().dshStatus;
      setStatus(current ? { ...current, remoteUrlAccess: null } : current);
    }
    try {
      const s = await cmd.dshDetect(next === "remote");
      setStatus(s);
      setDshTimeline(next === "remote" ? timelineFromStatus(s) : localTimelineFromStatus(s));
    } catch (e) {
      toast(t("dsh detection failed: {{error}}", { error: String(e) }), "error");
    } finally {
      setRecheckBusy(false);
    }
  };

  const open = async (url: string) => {
    try {
      await openUrl(url);
    } catch (e) {
      toast(t("Failed to open: {{error}}", { error: String(e) }), "error");
    }
  };

  // 复制地址：Open 只会用系统默认浏览器打开，用户想把地址发到手机/
  // 换已配好代理规则的浏览器时需要手动复制
  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast(t("Address copied"), "info");
    } catch (e) {
      toast(t("Failed to copy: {{error}}", { error: String(e) }), "error");
    }
  };

  const copyProxyBypassHost = async (host: string) => {
    try {
      await navigator.clipboard.writeText(host);
      toast(t("Proxy bypass host copied"), "info");
    } catch (e) {
      toast(t("Failed to copy: {{error}}", { error: String(e) }), "error");
    }
  };

  const recheckRemoteAccess = async () => {
    if (busy) return;
    setRecheckBusy(true);
    try {
      const s = await cmd.dshDetect(true);
      setStatus(s);
      const url = verifiedRemoteUrl(s);
      if (url) {
        setHasRunSetup(false);
        setDshTimeline(timelineFromStatus(s));
        toast(t("Remote access ready"), "success");
        await openUrl(url);
        return;
      }
      toast(t(statusTextKey(s)), "error");
    } catch (e) {
      toast(t("dsh detection failed: {{error}}", { error: String(e) }), "error");
    } finally {
      setRecheckBusy(false);
    }
  };

  const repair = async () => {
    if (busy) return;
    setStartBusy(true);
    try {
      const version = await cmd.dshUpdate();
      toast(t("dsh integration repaired for {{version}}", { version }), "success");
    } catch (e) {
      toast(t("dsh integration repair failed: {{error}}", { error: String(e) }), "error");
    } finally {
      setStartBusy(false);
      // 更新流程不走 dsh-step 事件流：回到状态驱动时间轴
      setHasRunSetup(false);
      try {
        const s = await cmd.dshDetect(isRemote);
        setStatus(s);
        setDshTimeline(isRemote ? timelineFromStatus(s) : localTimelineFromStatus(s));
      } catch (e) {
        toast(t("dsh detection failed: {{error}}", { error: String(e) }), "error");
      }
    }
  };

  // 卸载授权插件：纯本地用户可摆脱 rc 钉版插件；远程授权链路随之失效，
  // 状态链会如实停在「插件未安装」。卸载后回到状态驱动时间轴
  const removePlugins = async () => {
    if (busy) return;
    setStartBusy(true);
    try {
      await cmd.dshRemovePlugins();
      toast(t("Authorization plugins removed"), "success");
    } catch (e) {
      toast(t("Failed to remove authorization plugins: {{error}}", { error: String(e) }), "error");
    } finally {
      setStartBusy(false);
      setHasRunSetup(false);
      try {
        const s = await cmd.dshDetect(isRemote);
        setStatus(s);
        setDshTimeline(isRemote ? timelineFromStatus(s) : localTimelineFromStatus(s));
      } catch (e) {
        toast(t("dsh detection failed: {{error}}", { error: String(e) }), "error");
      }
    }
  };

  // 自启开关与远程授权已迁移到设置页 dsh 分区（配置项归设置，集成卡片只管流程操作）
  // 当前模式的访问地址：本地模式在 dsh web 运行时显示 dsh 原生带 token 的
  // 本机地址（Open/复制即用），远程模式在 serve 就绪且有 URL 时显示 tailnet HTTPS 地址
  const activeUrl = !busy
    ? isRemote
      ? status?.url ?? null
      : status?.dshRunning
        ? status?.localUrl ?? "http://127.0.0.1:3899"
        : null
    : null;
  const proxyBypassHost = proxyBypassHostForRemoteUrl(status?.url ?? null);

  const statusText = busy ? t("Working…") : status ? t(isRemote ? statusTextKey(status) : localStatusTextKey(status)) : t("Detecting…");

  return (
    <div className="rounded-xl border border-border bg-card text-card-foreground flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">{t("DeepSeek Harness")}</div>
        <div className="flex min-w-0 items-center justify-end gap-2">
          {status?.dshVersion && (
            <span className="shrink-0 rounded-full border border-border px-2.5 py-0.5 font-mono text-xs opacity-70">
              {status.dshVersion}
            </span>
          )}
          {/* 修复只在版本不兼容时出现：回退到 Launcher 锁定栈（装回 rc 钉版 + 插件）。
              版本够但缺插件不再强制降级 dsh，由下方状态行引导走一键启动安装插件 */}
          {status && !status.dshCompatible && (
            <button
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground whitespace-nowrap transition-colors outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              disabled={busy}
              onClick={() => void repair()}
            >
              {t("Repair dsh stack ({{version}})", { version: status.supportedVersion })}
            </button>
          )}
          {/* 卸载授权插件：摆脱 rc 钉版插件的纯本地入口；远程授权链路随之失效 */}
          {status?.pluginsInstalled && (
            <button
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              disabled={busy}
              onClick={() => void removePlugins()}
            >
              {t("Remove authorization plugins")}
            </button>
          )}
        </div>
      </div>

      <div className="min-w-0">
        <div className="truncate text-sm">{statusText}</div>
        {status?.error && !busy && (
          <div className="mt-1 text-xs text-destructive">
            {t("dsh integration check failed: {{error}}", { error: status.error })}
          </div>
        )}
        {status?.dshVersionAboveSupported && !busy && (
          <div className="mt-1 text-xs opacity-60">
            {t("Newer than the verified stack ({{version}}); authorization plugins may be incompatible", { version: status.supportedVersion })}
          </div>
        )}
        {isRemote ? (
          <>
            <div className="mt-1 text-xs opacity-60">
              {t("Remote access to the dsh Web UI over Tailscale HTTPS: https://<hostname>.ts.net → dsh web :3899. Remote settings and credentials require the configured admin capability in tailnet grants.")}
            </div>
            {status?.remoteUrlAccess === "capability_denied" ? (
              <div className="mt-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs" id="dsh-capability-warning">
                <div className="font-medium text-destructive">
                  {t("Remote capability grant denied")}
                </div>
                <div className="mt-1 opacity-70">
                  {t("Grant TCP 443 and the configured use/admin capabilities to this identity and dsh node in the same tailnet grant, then stop and run one-click start again.")}
                </div>
              </div>
            ) : status?.remoteUrlAccess === "proxy_interference" && proxyBypassHost ? (
              <div className="mt-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs" id="dsh-local-proxy-warning">
                <div className="font-medium text-destructive">
                  {t("This Mac can reach the service directly, but its proxy blocks the same Tailscale URL.")}
                </div>
                <div className="mt-1 opacity-70">
                  {t("Add this host to the macOS proxy bypass list. In Shadowrocket: General → Skip Proxy:")}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{proxyBypassHost}</code>
                  <button className={BTN_SM} disabled={busy} onClick={() => void copyProxyBypassHost(proxyBypassHost)}>
                    {t("Copy bypass host")}
                  </button>
                  <button className={BTN_SM} disabled={busy} onClick={() => void recheckRemoteAccess()}>
                    {recheckBusy ? t("Rechecking...") : t("Recheck and open")}
                  </button>
                </div>
              </div>
            ) : status?.url && status.remoteUrlAccess === "ready" && !busy && (
              <div className="mt-1 text-xs opacity-60">
                {t("URL won't open? On the host Mac, use proxy bypass / skip-proxy; on another client device, use a DIRECT rule.")}{" "}
                <a
                  className="underline underline-offset-2 hover:opacity-80"
                  href="https://github.com/sperictao/dsh-pro-max/blob/main/docs/dsh-remote-access.md"
                  onClick={(e) => {
                    e.preventDefault();
                    void openUrl("https://github.com/sperictao/dsh-pro-max/blob/main/docs/dsh-remote-access.md");
                  }}
                >
                  {t("Troubleshooting guide")}
                </a>
              </div>
            )}
          </>
        ) : (
          <div className="mt-1 text-xs opacity-60">
            {t("Local access to the dsh Web UI at http://127.0.0.1:3899.")}
          </div>
        )}
      </div>

      <label
        className={`flex flex-1 items-center justify-between gap-4 rounded-lg border border-border p-3${modeLocked ? "" : " cursor-pointer"}`}
        id="dsh-remote-access-row"
      >
        <span className="flex flex-col gap-0.5">
          <span className="text-sm">{t("Remote access")}</span>
          <span className="text-sm">
            {t(isRemote ? "Remote access mode" : "Local access mode")}
          </span>
          <span className="text-xs opacity-60">
            {modeLocked
              ? t("dsh web is running; stop it before switching the access mode.")
              : t("Switching the access mode only selects the setup/close flow; click Start or Stop below to apply it. It does not start or stop anything by itself.")}
          </span>
        </span>
        <input
          type="checkbox"
          className={TOGGLE}
          id="toggle-dsh-remote-access"
          checked={isRemote}
          disabled={busy || modeLocked}
          onChange={(e) => void switchMode(e.target.checked ? "remote" : "local")}
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          className={BTN_PRIMARY}
          disabled={busy || !!status?.dshRunning}
          onClick={() => void startDshWeb()}
        >
          {startBusy ? t("Starting...") : t("One-click start dsh web")}
        </button>
        <button
          className={BTN_DESTRUCTIVE}
          disabled={busy || !status?.dshRunning}
          onClick={() => void stopDshWeb()}
        >
          {stopBusy ? t("Stopping...") : t("One-click stop dsh web")}
        </button>
        <button
          className={BTN_PRIMARY}
          disabled={busy || !status?.dshRunning}
          onClick={() => void restartDshWeb()}
        >
          {restartBusy ? t("Restarting...") : t("One-click restart dsh web")}
        </button>
        <div className="ml-auto flex min-w-0 flex-col items-end gap-1.5">
          {activeUrl && (
            <AddressRow
              url={activeUrl}
              onCopy={copyUrl}
              onOpen={open}
              openDisabled={isRemote && status?.remoteUrlAccess !== "ready"}
            />
          )}
        </div>
      </div>

      <div className="border-t border-border pt-3">
        <div className="mb-2 text-sm font-medium">{t("Setup Progress")}</div>
        <div className="flex flex-col">
          {timeline.map((step) => (
            <div className="timeline-node" data-state={step.state} key={step.index}>
              <div className="timeline-marker">
                <StepMarker state={step.state} />
              </div>
              <div className="timeline-content">
                <div className="timeline-title">{t(STEP_TITLES[step.id] ?? step.id)}</div>
                {step.detail && <div className="timeline-detail">{step.detail}</div>}
                {step.state === "failed" && (step.problem || step.solution) && (
                  <div className="timeline-issue">
                    {step.problem && <div className="timeline-problem">{step.problem}</div>}
                    {step.solution && <div className="timeline-solution">{step.solution}</div>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
