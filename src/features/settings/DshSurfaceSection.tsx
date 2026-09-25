// 纳管形态分区：选择本应用纳管哪些 dsh 官方形态（至少一档，可两档并存）。
// "全关"在此不可表示——只剩一档时该档开关禁用；落盘后由 Rust 归一化再次收口。

import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import { MUTED, TOGGLE } from "@/shared/lib/ui";
import { SettingsCard, SettingRow } from "./SettingRow";

const SURFACES = [
  {
    id: "web",
    labelKey: "Manage dsh web",
    descriptionKey: "The dsh --profile web runtime: install, start/stop, plugins, models and remote access, bound to 127.0.0.1:3899.",
    htmlFor: "toggle-surface-web",
  },
  {
    id: "desktop",
    labelKey: "Manage the DeepSeek Harness desktop app",
    descriptionKey: "The official desktop app: detect, open, quit and update checks, plus its plugins and configuration through the bridge plugin.",
    htmlFor: "toggle-surface-desktop",
  },
] as const;

export function DshSurfaceSection() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const setConfigField = useAppStore((s) => s.setConfigField);
  const surfaces = config?.managed_surfaces ?? ["web"];

  return (
    <section className="settings-section" id="section-dsh-surface">
      <h2 className="mb-1 text-base font-semibold">{t("Managed Surfaces")}</h2>
      <p className={`mb-4 max-w-2xl ${MUTED}`}>
        {t("Choose which official dsh surfaces this app manages. At least one stays enabled; both can run side by side.")}
      </p>

      <SettingsCard>
        {SURFACES.map(({ id, labelKey, descriptionKey, htmlFor }) => {
          const checked = surfaces.includes(id);
          return (
            <SettingRow
              key={id}
              label={t(labelKey)}
              description={t(descriptionKey)}
              htmlFor={htmlFor}
              control={
                <input
                  type="checkbox"
                  className={TOGGLE}
                  id={htmlFor}
                  checked={checked}
                  // 只剩这一档时不许再关：至少纳管一档在此成为不可表示
                  disabled={checked && surfaces.every((s) => s === id)}
                  onChange={(e) =>
                    setConfigField({
                      managed_surfaces: e.target.checked
                        ? [...surfaces, id]
                        : surfaces.filter((s) => s !== id),
                    })
                  }
                />
              }
            />
          );
        })}
      </SettingsCard>
    </section>
  );
}
