// 通用分区：语言、系统行为（托盘/自启）、日志入口

import { useTranslation } from "react-i18next";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { useAppStore } from "@/shared/store";
import * as cmd from "@/shared/commands";
import { SelectCard } from "@/shared/components/SelectCard";
import { BTN, TOGGLE } from "@/shared/lib/ui";

const LANG_OPTIONS = [
  { id: "system", labelKey: "Follow System" },
  { id: "en", labelKey: "English" },
  { id: "zh-CN", labelKey: "中文" },
] as const;

export function GeneralSection() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const autostart = useAppStore((s) => s.autostart);
  const languageSetting = useAppStore((s) => s.languageSetting);
  const setLanguageSetting = useAppStore((s) => s.setLanguageSetting);
  const setConfigField = useAppStore((s) => s.setConfigField);
  const toggleAutostart = useAppStore((s) => s.toggleAutostart);
  const toast = useAppStore((s) => s.toast);

  const openLogDir = async () => {
    try {
      await openUrl(await cmd.getLogDir());
    } catch (e) {
      toast(String(e), "error");
    }
  };

  return (
    <section className="settings-section" id="section-general">
      <h2 className="mb-4 text-base font-semibold">{t("General")}</h2>

      <div className="flex items-start gap-4 border-b border-border py-4">
        <label className="w-36 shrink-0 pt-1 text-sm font-medium">{t("Language")}</label>
        <div className="flex flex-1 gap-3">
          {LANG_OPTIONS.map((opt) => (
            <SelectCard key={opt.id} selected={languageSetting === opt.id} onClick={() => void setLanguageSetting(opt.id)}>
              <span className="text-sm">{t(opt.labelKey)}</span>
            </SelectCard>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-4 border-b border-border py-4">
        <label className="w-36 shrink-0 pt-1 text-sm font-medium">{t("System Behavior")}</label>
        <div className="flex flex-1 flex-col gap-2">
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border p-3">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm">{t("Minimize to tray when closing window")}</span>
              <span className="text-xs opacity-60">
                {t("When enabled, the close button hides the window and the app keeps running in the system tray.")}
              </span>
            </span>
            <input type="checkbox" className={TOGGLE} id="toggle-tray"
              checked={config?.minimize_to_tray_on_close ?? false}
              onChange={(e) => setConfigField({ minimize_to_tray_on_close: e.target.checked })} />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border p-3">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm">{t("Launch at login")}</span>
              <span className="text-xs opacity-60">
                {t("When enabled, the app starts silently in the system tray when you log in.")}
              </span>
            </span>
            <input type="checkbox" className={TOGGLE} id="toggle-autostart"
              checked={autostart} onChange={() => void toggleAutostart()} />
          </label>
        </div>
      </div>

      <div className="flex items-start gap-4 py-4">
        <label className="w-36 shrink-0 pt-1 text-sm font-medium">{t("Logs")}</label>
        <div className="flex flex-1 items-center justify-between gap-4 rounded-lg border border-border p-3">
          <span className="flex flex-col gap-0.5">
            <span className="text-sm">{t("Open log folder")}</span>
            <span className="text-xs opacity-60">
              {t("Logs are written to files only; open the folder when something goes wrong.")}
            </span>
          </span>
          <button className={BTN} onClick={() => void openLogDir()}>{t("Open")}</button>
        </div>
      </div>
    </section>
  );
}
