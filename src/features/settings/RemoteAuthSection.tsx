// 远程授权分区：三个域字段直接绑定全局草稿，保存由设置页统一保存条接管。
// 生效时机：改完需重跑一键启动（dsh web 启动时读取配置）。

import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import { INPUT_MONO } from "@/shared/lib/ui";
import { SettingsCard, SettingField } from "./SettingRow";

export function RemoteAuthSection() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const setConfigField = useAppStore((s) => s.setConfigField);

  const adminCapDomain = config?.dsh_admin_cap_domain ?? "";
  const useCapDomain = config?.dsh_use_cap_domain ?? "";
  const extraLogins = config?.dsh_extra_allowed_logins ?? "";

  return (
    <section className="settings-section" id="section-dsh-auth">
      <h2 className="mb-1 text-base font-semibold">{t("Remote authorization")}</h2>
      <p className="max-w-2xl text-xs opacity-60">
        {t("After changing remote authorization, run one-click start again to apply it; stop dsh web first if it is running.")}
      </p>
      <p className="mb-4 max-w-2xl text-xs opacity-60">
        {t("Every remote identity needs TCP 443 in tailnet grants. If you configure capabilities, include both ip and app in the same grant.")}
      </p>

      <SettingsCard>
        <SettingField
          label={t("Admin capability domain")}
          htmlFor="dsh-admin-cap-domain"
          description={adminCapDomain.trim()
            ? t("Full capability: {{capability}}", { capability: `${adminCapDomain.trim()}/cap/dsh-admin` })
            : t("Empty = remote management (settings/credentials) stays unavailable")}
        >
          <input type="text" className={INPUT_MONO} id="dsh-admin-cap-domain"
            value={adminCapDomain}
            onChange={(e) => setConfigField({ dsh_admin_cap_domain: e.target.value })} />
        </SettingField>

        <SettingField
          label={t("Use capability domain")}
          htmlFor="dsh-use-cap-domain"
          description={useCapDomain.trim()
            ? t("Full capability: {{capability}}", { capability: `${useCapDomain.trim()}/cap/dsh` })
            : t("Empty = plain remote access still needs identity allowlist and tailnet TCP 443")}
        >
          <input type="text" className={INPUT_MONO} id="dsh-use-cap-domain"
            value={useCapDomain}
            onChange={(e) => setConfigField({ dsh_use_cap_domain: e.target.value })} />
        </SettingField>

        <SettingField
          label={t("Extra allowed logins")}
          htmlFor="dsh-extra-allowed-logins"
          description={t("Comma-separated; the current user on this machine is always allowed")}
        >
          <input type="text" className={INPUT_MONO} id="dsh-extra-allowed-logins"
            value={extraLogins}
            onChange={(e) => setConfigField({ dsh_extra_allowed_logins: e.target.value })} />
        </SettingField>
      </SettingsCard>
    </section>
  );
}
