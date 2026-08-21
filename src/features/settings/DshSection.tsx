// dsh 分区：版本检测卡（本机安装 / npm 最新 / Launcher 验证栈）+ 开机自启开关。
// 版本卡挂载自动查一次（npm view 15s 超时，失败原因持久展示），不阻断其余操作；
// 自启开关从集成卡片迁入——自启是配置项而非流程操作，归设置页

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import * as cmd from "@/shared/commands";
import { BTN, TOGGLE } from "@/shared/lib/ui";
import type { DshLatestInfo } from "@/shared/types";

export function DshSection() {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  const [info, setInfo] = useState<DshLatestInfo | null>(null);
  const [checkBusy, setCheckBusy] = useState(false);
  // 自启开关的本地状态：null = 尚未拿到检测结果（开关禁用）
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);

  const check = useCallback(async () => {
    setCheckBusy(true);
    try {
      setInfo(await cmd.dshCheckLatest());
    } catch (e) {
      setInfo({
        latestVersion: null,
        installedVersion: null,
        supportedVersion: "",
        hasUpdate: false,
        error: String(e),
      });
    } finally {
      setCheckBusy(false);
    }
  }, []);

  useEffect(() => {
    void check();
    // 自启状态跟随版本检测一起拿（复用 detect，避免新增命令）
    cmd.dshDetect()
      .then((s) => setAutostart(s.autostartEnabled))
      .catch(() => setAutostart(null));
  }, [check]);

  const toggleAutostart = async () => {
    if (autostart === null || autostartBusy) return;
    const next = !autostart;
    setAutostartBusy(true);
    try {
      await cmd.dshSetAutostart(next);
      setAutostart(next);
      toast(next ? t("Auto-start enabled") : t("Auto-start disabled"), "success");
    } catch (e) {
      toast(t("Failed to change auto-start: {{error}}", { error: String(e) }), "error");
    } finally {
      setAutostartBusy(false);
    }
  };

  return (
    <section className="settings-section" id="section-dsh">
      <h2 className="mb-4 text-base font-semibold">{t("DeepSeek Harness")}</h2>

      {/* 版本检测卡：已安装 / npm 最新 / 验证栈三行并列——三者关系是版本困惑的根源 */}
      <div className="flex max-w-2xl flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">{t("dsh Version")}</div>
          <button className={BTN} id="btn-check-dsh-latest" disabled={checkBusy} onClick={() => void check()}>
            {checkBusy ? t("Checking...") : t("Check Latest")}
          </button>
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="opacity-70">{t("Installed")}</span>
            <span className="font-mono">{info?.installedVersion ?? t("Not installed")}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="opacity-70">{t("Latest on npm")}</span>
            <span className="font-mono">
              {info?.error ? "—" : (info?.latestVersion ?? (checkBusy ? t("Checking...") : "—"))}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="opacity-70">{t("Verified stack")}</span>
            <span className="font-mono opacity-70">{info?.supportedVersion || "—"}</span>
          </div>
        </div>

        {info?.error && (
          <div className="text-xs text-destructive">
            {t("Check failed: {{error}}", { error: info.error })}
          </div>
        )}
        {info?.hasUpdate && (
          <div className="text-xs">
            {t("A newer dsh is available (v{{latest}}). The bundled authorization plugins are verified against the stack above; upgrade via npm if you do not rely on remote access.", { latest: info.latestVersion })}
          </div>
        )}
      </div>

      {/* 开机自启：开启时若 dsh 版本过低会自动装回验证栈并安装授权插件（Rust 侧保证） */}
      <div className="mt-4 max-w-2xl">
        <div className="mb-2 text-sm font-medium">{t("Boot Auto-start")}</div>
        <label
          className="flex flex-1 cursor-pointer items-center justify-between gap-4 rounded-lg border border-border p-3"
          id="dsh-autostart-row"
        >
          <span className="flex flex-col gap-0.5">
            <span className="text-sm">{t("Auto-start the authorized dsh web service in the background at login")}</span>
            <span className="text-xs opacity-60">
              {t("Keeps remote access available without opening this app. Tailscale serve is managed by the Tailscale app itself.")}
            </span>
          </span>
          <input
            type="checkbox"
            className={TOGGLE}
            id="toggle-dsh-autostart"
            checked={autostart ?? false}
            disabled={autostart === null || autostartBusy}
            onChange={() => void toggleAutostart()}
          />
        </label>
      </div>
    </section>
  );
}
