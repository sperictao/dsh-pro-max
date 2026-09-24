// 官方 DeepSeek Harness 桌面应用卡片：检测安装/运行、打开或聚焦、请求退出、新版本提示、
// 打开日志目录。全部走应用自身的外部能力（dsh:// 协议、AppleScript 退出事件、自带更新源），
// 不依赖桥接插件——插件与配置管理是更上面一层的事（见 ADR 0011）。
//
// 只在「纳管了桌面形态」时挂载（未纳管的形态不进 UI）；不提供安装：官方应用的安装归用户，
// 本应用只做检测与管理。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { useAppStore } from "@/shared/store";
import { renderMessage } from "@/shared/i18n/error";
import * as cmd from "@/shared/commands";
import { BTN_OUTLINE, BTN_PRIMARY, MUTED, PANEL } from "@/shared/lib/ui";
import type { BridgeStatus, DesktopStatus } from "@/shared/types";
import { BridgeNotice } from "./BridgeNotice";

/// 动作后应用还要若干秒才起停完毕，晚一点复检；端口探测是权威状态，
/// 读早了下次动作也会自纠
const RECHECK_DELAY_MS = 1500;

export function DesktopCard() {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  const detect = useCallback(async () => {
    try {
      // 两者都是本机查询（端口探测 + 回环 ping），无公网请求
      const [next, nextBridge] = await Promise.all([cmd.desktopDetect(), cmd.desktopBridgeStatus()]);
      setStatus(next);
      setBridge(nextBridge);
    } catch (e) {
      toast(renderMessage(e), "error");
    }
  }, [toast]);

  useEffect(() => {
    void detect();
  }, [detect]);

  // 打开与退出都不即时生效（应用要启动或走完自己的退出确认），延后复检一次
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setTimeout(() => void detect(), RECHECK_DELAY_MS);
    } catch (e) {
      toast(renderMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const checkLatest = async () => {
    setBusy(true);
    try {
      setLatest(await cmd.desktopCheckLatest());
      setChecked(true);
    } catch (e) {
      toast(renderMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const openLogDir = async () => {
    try {
      await openUrl(await cmd.desktopLogDir());
    } catch (e) {
      toast(renderMessage(e), "error");
    }
  };

  // 地址是要粘进另一个应用的一次性步骤，粘错一个字就白跑一趟
  const copyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      toast(t("Address copied"), "info");
    } catch (e) {
      toast(t("Failed to copy: {{error}}", { error: String(e) }), "error");
    }
  };

  const installed = status?.installed ?? false;
  const running = status?.running ?? false;

  const statusText = !status
    ? t("Checking...")
    : !status.supported
      ? t("The official desktop app has no build for this platform (macOS on Apple silicon and Windows x64 only).")
      : !installed
        ? t("DeepSeek Harness is not installed. Install it from the official channel; this app only detects and manages it.")
        : running
          ? t("DeepSeek Harness is running.")
          : t("DeepSeek Harness is installed but not running.");

  return (
    <div className={`${PANEL} flex flex-col gap-3 p-4`} id="desktop-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="truncate text-sm font-medium">{t("DeepSeek Harness desktop app")}</span>
          {status?.version && (
            <span className="shrink-0 rounded-full border border-border px-2.5 py-0.5 font-mono text-xs opacity-70">
              {status.version}
            </span>
          )}
        </div>
        {/* 更新提示：应用自带的更新源上确有更高版本才出现，升级动作由应用自己的更新器完成 */}
        {checked && (
          <span className={MUTED}>
            {latest ? t("New version available: v{{version}}", { version: latest }) : t("Already up to date")}
          </span>
        )}
      </div>

      <p className={MUTED}>{statusText}</p>

      {installed && (
        <div className="flex flex-wrap items-center gap-2">
          <button className={BTN_PRIMARY} disabled={busy} onClick={() => void run(cmd.desktopOpen)}>
            {running ? t("Focus DeepSeek Harness") : t("Open DeepSeek Harness")}
          </button>
          {/* 退出只有 macOS 有入口：Windows 上的窗口关闭被应用改成隐藏，
              没有可触发的正常退出，说明见下方行 */}
          {running && status?.canQuit && (
            <button className={BTN_OUTLINE} disabled={busy} onClick={() => void run(cmd.desktopQuit)}>
              {t("Quit DeepSeek Harness")}
            </button>
          )}
          <button className={BTN_OUTLINE} disabled={busy} onClick={() => void checkLatest()}>
            {t("Check for Updates")}
          </button>
          <button className={BTN_OUTLINE} disabled={busy} onClick={() => void openLogDir()}>
            {t("Open log folder")}
          </button>
        </div>
      )}

      {running && status && !status.canQuit && (
        <p className={MUTED}>
          {t("On this platform the DeepSeek Harness desktop app can only be quit from its own tray menu")}
        </p>
      )}

      {/* 未就绪的四态说明由共用组件给（插件页的桌面 tab 用的是同一份） */}
      {installed && bridge && (
        <>
          <BridgeNotice bridge={bridge} onCopy={copyAddress} />
          {bridge.state === "connected" && <p className={MUTED}>{t("Bridge connected")}</p>}
        </>
      )}
    </div>
  );
}

