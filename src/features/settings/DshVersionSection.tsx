// dsh 版本分区：全部 dist-tag 一览 + 逐版本安装。
// 版本卡挂载自动查一次（npm view dist-tags 15s 超时，失败原因持久展示）；
// 安装按钮允许切换到任意 tag 指向的版本——高于验证栈的行有警示，
// 风险如实披露但不阻断用户选择（授权插件只影响远程链路）

import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import * as cmd from "@/shared/commands";
import { BTN, BTN_SM } from "@/shared/lib/ui";
import { tErr } from "@/shared/i18n/error";

export function DshVersionSection() {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  const info = useAppStore((s) => s.dshLatest);
  const checkBusy = useAppStore((s) => s.dshLatestBusy);
  const installing = useAppStore((s) => s.dshInstallingVersion);
  const setInfo = useAppStore((s) => s.setDshLatest);
  const setCheckBusy = useAppStore((s) => s.setDshLatestBusy);
  const setInstalling = useAppStore((s) => s.setDshInstallingVersion);

  const check = useCallback(async () => {
    setCheckBusy(true);
    try {
      setInfo(await cmd.dshCheckLatest());
    } catch (e) {
      setInfo({ tags: [], installedVersion: null, supportedVersion: "", error: String(e) });
    } finally {
      setCheckBusy(false);
    }
  }, [setCheckBusy, setInfo]);

  useEffect(() => {
    // 正在安装/已有检查在跑时不要触发新的检查，避免切页回来后覆盖正在进行的状态。
    // 只在挂载时决定一次，后续由安装完成/手动按钮刷新。
    if (!installing && !checkBusy) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = async (version: string) => {
    if (installing) return;
    setInstalling(version);
    try {
      await cmd.dshInstallVersion(version);
      toast(t("dsh updated to {{version}}", { version }), "success");
      await check();
    } catch (e) {
      toast(t("Install failed: {{error}}", { error: tErr(String(e)) }), "error");
    } finally {
      setInstalling(null);
    }
  };

  const busy = checkBusy || installing !== null;

  return (
    <section className="settings-section" id="section-dsh-version">
      <h2 className="mb-1 text-base font-semibold">{t("dsh Version")}</h2>
      <p className="mb-4 max-w-2xl text-xs opacity-60">
        {t("dsh is the DeepSeek Harness CLI; this app bundles a verified compatibility stack (CLI + authorization plugins) for one-click local & remote access.")}
      </p>

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
            {t("Check failed: {{error}}", { error: tErr(info.error) })}
          </div>
        )}
      </div>
    </section>
  );
}
