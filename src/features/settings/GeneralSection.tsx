// 通用分区：语言、系统行为（托盘/自启）、插件目录源、日志入口。
// 语言/应用自启即时生效；托盘/目录源走全局草稿，由设置页保存条统一保存。

import { useTranslation } from "react-i18next";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { useAppStore } from "@/shared/store";
import * as cmd from "@/shared/commands";
import { SelectCard } from "@/shared/components/SelectCard";
import { BTN, INPUT_MONO, TOGGLE } from "@/shared/lib/ui";
import { SettingsCard, SettingField, SettingRow } from "./SettingRow";
import { isValidCatalogUrl } from "./validation";

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

  const catalogUrl = config?.market_catalog_url ?? "";

  return (
    <section className="settings-section" id="section-general">
      <h2 className="mb-4 text-base font-semibold">{t("General")}</h2>

      <div className="flex max-w-2xl flex-col gap-4">
        <SettingsCard>
          <SettingRow
            label={t("Language")}
            control={
              <div className="flex gap-2">
                {LANG_OPTIONS.map((opt) => (
                  <SelectCard key={opt.id} selected={languageSetting === opt.id} onClick={() => void setLanguageSetting(opt.id)}>
                    <span className="text-sm">{t(opt.labelKey)}</span>
                  </SelectCard>
                ))}
              </div>
            }
          />
        </SettingsCard>

        <SettingsCard>
          <SettingRow
            label={t("Minimize to tray when closing window")}
            description={t("When enabled, the close button hides the window and the app keeps running in the system tray.")}
            htmlFor="toggle-tray"
            control={
              <input type="checkbox" className={TOGGLE} id="toggle-tray"
                checked={config?.minimize_to_tray_on_close ?? false}
                onChange={(e) => setConfigField({ minimize_to_tray_on_close: e.target.checked })} />
            }
          />
          <SettingRow
            label={t("Launch at login")}
            description={t("When enabled, the app starts silently in the system tray when you log in.")}
            htmlFor="toggle-autostart"
            control={
              <input type="checkbox" className={TOGGLE} id="toggle-autostart"
                checked={autostart} onChange={() => void toggleAutostart()} />
            }
          />
        </SettingsCard>

        <SettingsCard>
          <SettingField
            label={t("Plugin catalog")}
            description={t(
              "Optional https:// or http:// mirror serving the same catalog JSON. Empty = built-in awesome-dsh-plugin.com source; applied on next refresh.",
            )}
            htmlFor="config-catalog-url"
            error={isValidCatalogUrl(catalogUrl) ? undefined : t("Must start with https:// or http://")}
          >
            <input
              type="text"
              className={INPUT_MONO}
              id="config-catalog-url"
              placeholder="https://mirror.example.com/catalog.json"
              value={catalogUrl}
              onChange={(e) => setConfigField({ market_catalog_url: e.target.value })}
            />
          </SettingField>
        </SettingsCard>

        <SettingsCard>
          <SettingRow
            label={t("Open log folder")}
            description={t("Logs are written to files only; open the folder when something goes wrong.")}
            control={<button className={BTN} onClick={() => void openLogDir()}>{t("Open")}</button>}
          />
        </SettingsCard>
      </div>
    </section>
  );
}
