// 远程授权配置（设置页 dsh 分区内的独立模块）
// 配置项从集成卡片迁入设置页：本地草稿 + 一次性灌入，
// onChange 同步写 store 草稿，点保存才落盘。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import { BTN_SM, INPUT_MONO } from "@/shared/lib/ui";

export function RemoteAuthSection() {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  const config = useAppStore((s) => s.config);
  const setConfigField = useAppStore((s) => s.setConfigField);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const [adminCapDomain, setAdminCapDomain] = useState("");
  const [useCapDomain, setUseCapDomain] = useState("");
  const [extraLogins, setExtraLogins] = useState("");
  const authLoadedRef = useRef(false);

  useEffect(() => {
    if (config && !authLoadedRef.current) {
      authLoadedRef.current = true;
      setAdminCapDomain(config.dsh_admin_cap_domain);
      setUseCapDomain(config.dsh_use_cap_domain);
      setExtraLogins(config.dsh_extra_allowed_logins);
    }
  }, [config]);

  const saveRemoteAuth = async () => {
    await saveConfig();
    toast(t("Remote authorization saved"), "success");
  };

  return (
    <div
      className="mt-4 flex max-w-2xl flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground"
      id="dsh-remote-auth-block"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("Remote authorization")}</span>
        <button className={BTN_SM} id="btn-save-remote-auth" onClick={() => void saveRemoteAuth()}>
          {t("Save")}
        </button>
      </div>
      <div className="text-xs opacity-60">
        {t("After changing remote authorization, run one-click start again to apply it; stop dsh web first if it is running.")}
      </div>
      <div className="text-xs opacity-60">
        {t("Every remote identity needs TCP 443 in tailnet grants. If you configure capabilities, include both ip and app in the same grant.")}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs opacity-70" htmlFor="dsh-admin-cap-domain">{t("Admin capability domain")}</label>
        <input type="text" className={INPUT_MONO} id="dsh-admin-cap-domain"
          value={adminCapDomain}
          onChange={(e) => { setAdminCapDomain(e.target.value); setConfigField({ dsh_admin_cap_domain: e.target.value }); }} />
        <span className="text-xs opacity-60">
          {adminCapDomain.trim()
            ? t("Full capability: {{capability}}", { capability: `${adminCapDomain.trim()}/cap/dsh-admin` })
            : t("Empty = remote management (settings/credentials) stays unavailable")}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs opacity-70" htmlFor="dsh-use-cap-domain">{t("Use capability domain")}</label>
        <input type="text" className={INPUT_MONO} id="dsh-use-cap-domain"
          value={useCapDomain}
          onChange={(e) => { setUseCapDomain(e.target.value); setConfigField({ dsh_use_cap_domain: e.target.value }); }} />
        <span className="text-xs opacity-60">
          {useCapDomain.trim()
            ? t("Full capability: {{capability}}", { capability: `${useCapDomain.trim()}/cap/dsh` })
            : t("Empty = plain remote access still needs identity allowlist and tailnet TCP 443")}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs opacity-70" htmlFor="dsh-extra-allowed-logins">{t("Extra allowed logins")}</label>
        <input type="text" className={INPUT_MONO} id="dsh-extra-allowed-logins"
          value={extraLogins}
          onChange={(e) => { setExtraLogins(e.target.value); setConfigField({ dsh_extra_allowed_logins: e.target.value }); }} />
        <span className="text-xs opacity-60">{t("Comma-separated; the current user on this machine is always allowed")}</span>
      </div>
    </div>
  );
}
