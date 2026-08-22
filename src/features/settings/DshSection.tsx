// dsh 分区：版本卡（全部 dist-tag 一览 + 逐版本安装）+ 开机自启开关。
// 版本卡挂载自动查一次（npm view dist-tags 15s 超时，失败原因持久展示）；
// 安装按钮允许切换到任意 tag 指向的版本——高于验证栈的行有警示，
// 风险如实披露但不阻断用户选择（授权插件只影响远程链路）

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import * as cmd from "@/shared/commands";
import { BTN, BTN_SM, TOGGLE } from "@/shared/lib/ui";
import type { DshLatestInfo } from "@/shared/types";

export function DshSection() {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  const [info, setInfo] = useState<DshLatestInfo | null>(null);
  const [checkBusy, setCheckBusy] = useState(false);
  // 正在安装的版本（防并发；null = 空闲）
  const [installing, setInstalling] = useState<string | null>(null);
  // 自启开关的本地状态：null = 尚未拿到检测结果（开关禁用）
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);

  const check = useCallback(async () => {
    setCheckBusy(true);
    try {
      setInfo(await cmd.dshCheckLatest());
    } catch (e) {
      setInfo({ tags: [], installedVersion: null, supportedVersion: "", error: String(e) });
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

  const install = async (version: string) => {
    if (installing) return;
    setInstalling(version);
    try {
      await cmd.dshInstallVersion(version);
      toast(t("dsh updated to {{version}}", { version }), "success");
      // 装完刷新：isInstalled 徽标与检测数据都需要更新
      await check();
    } catch (e) {
      toast(t("Install failed: {{error}}", { error: String(e) }), "error");
    } finally {
      setInstalling(null);
    }
  };

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

  const busy = checkBusy || installing !== null;

  return (
    <section className="settings-section" id="section-dsh">
      <h2 className="mb-1 text-base font-semibold">{t("DeepSeek Harness")}</h2>
      <p className="mb-4 max-w-2xl text-xs opacity-60">
        {t("dsh is the DeepSeek Harness CLI; this app bundles a verified compatibility stack (CLI + authorization plugins) for one-click local & remote access.")}
      </p>

      {/* 版本卡：全部 dist-tag 一览，每行可安装；不兼容行禁装，高于验证栈的同线行提示 */}
      <div className="flex max-w-2xl flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">{t("dsh Version")}</div>
          <button className={BTN} id="btn-check-dsh-latest" disabled={busy} onClick={() => void check()}>
            {checkBusy ? t("Checking...") : t("Check Latest")}
          </button>
        </div>

        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="shrink-0 opacity-70">{t("Installed")}</span>
          <span className="font-mono">{info?.installedVersion ?? t("Not installed")}</span>
        </div>

        {info && info.tags.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-border/50 pt-2">
            {info.tags.map((tag) => (
              <div className="flex items-center justify-between gap-3 text-sm" key={tag.tag}>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 rounded border border-border px-1.5 py-px font-mono text-xs opacity-70">{tag.tag}</span>
                  <span className="font-mono">{tag.version}</span>
                  {tag.isInstalled && (
                    <span className="shrink-0 text-xs text-primary">{t("installed")}</span>
                  )}
                  {tag.incompatible && !tag.isInstalled && (
                    <span className="shrink-0 text-xs text-destructive">{t("incompatible with the bundled plugin stack")}</span>
                  )}
                  {tag.aboveSupported && !tag.incompatible && !tag.isInstalled && (
                    <span className="shrink-0 text-xs opacity-50">{t("unverified")}</span>
                  )}
                </span>
                {!tag.isInstalled && (
                  <button
                    className={BTN_SM}
                    disabled={busy || tag.incompatible}
                    onClick={() => void install(tag.version)}
                  >
                    {installing === tag.version ? t("Installing…") : t("Install")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="text-xs opacity-50">
          {t("The verified stack is {{version}} — the dsh version this app's bundled authorization plugins are tested against. Versions marked incompatible break local & remote access; ones marked unverified are newer same-line releases with untested remote authorization.", { version: info?.supportedVersion || "…" })}
        </p>

        {info?.error && (
          <div className="text-xs text-destructive">
            {t("Check failed: {{error}}", { error: info.error })}
          </div>
        )}
      </div>

      {/* 开机自启：开启时若 dsh 版本过低会自动装回验证栈并安装授权插件（Rust 侧保证） */}
      <div className="mt-4 flex max-w-2xl flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
        <div className="text-sm font-medium">{t("Boot Auto-start")}</div>
        <label
          className="flex flex-1 cursor-pointer items-center justify-between gap-4"
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
