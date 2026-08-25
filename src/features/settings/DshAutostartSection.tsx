// dsh 开机自启分区：开启时若 dsh 版本过低会自动装回验证栈并安装授权插件（Rust 侧保证）

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import * as cmd from "@/shared/commands";
import { TOGGLE } from "@/shared/lib/ui";

export function DshAutostartSection() {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  const autostart = useAppStore((s) => s.dshAutostart);
  const autostartBusy = useAppStore((s) => s.dshAutostartBusy);
  const setAutostart = useAppStore((s) => s.setDshAutostart);
  const setAutostartBusy = useAppStore((s) => s.setDshAutostartBusy);

  useEffect(() => {
    // 没有正在切换时才拉取，避免切页回来后覆盖进行中的状态。
    // 只在挂载时决定一次，后续由切换操作/检测结果驱动。
    if (!autostartBusy) {
      cmd.dshDetect()
        .then((s) => setAutostart(s.autostartEnabled))
        .catch(() => setAutostart(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <section className="settings-section" id="section-dsh-autostart">
      <h2 className="mb-1 text-base font-semibold">{t("Boot Auto-start")}</h2>
      <p className="mb-4 max-w-2xl text-xs opacity-60">
        {t("Keeps remote access available without opening this app. Tailscale serve is managed by the Tailscale app itself.")}
      </p>

      <div className="flex max-w-2xl flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
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
