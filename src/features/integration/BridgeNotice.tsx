// 桥接未就绪时的去向说明。首页桌面卡片、插件页的桌面 tab、模型页的桌面档共用同一份——
// 同一件事只有一个说法，改文案不会只改一半；复制包规格也在这里，不让每个调用方各写一遍。
//
// 已连接时什么都不渲染：那是调用方展示内容的前提，不是一条需要说的状态。

import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import { BTN_SM, MUTED } from "@/shared/lib/ui";
import type { BridgeStatus } from "@/shared/types";

export function BridgeNotice({ bridge }: { bridge: BridgeStatus }) {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);

  // 包规格是要粘进另一个应用的一次性步骤，粘错一个字就白跑一趟
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(bridge.installSpec);
      toast(t("Package spec copied"), "info");
    } catch (e) {
      toast(t("Failed to copy: {{error}}", { error: String(e) }), "error");
    }
  };

  if (bridge.state === "connected") return null;

  if (bridge.state === "app_unavailable") {
    return <p className={MUTED}>{t("Open DeepSeek Harness to manage its plugins and configuration.")}</p>;
  }

  // 三种未就绪态的去向都是「粘一次包规格重装」，但原因必须分开说。用**带返回类型的 switch**
  // 而不是条件链：给 BridgeState 加一种状态时，这里会因为「不是所有路径都返回值」编译不过
  // ——而不是静默落进「代次不符」那一支、给出一句不真的话
  const reason = ((): string => {
    switch (bridge.state) {
      case "not_installed":
        return t("The bridge plugin is not installed in DeepSeek Harness. Install it once from the app's Plugins page with this package spec:");
      case "not_ready":
        return t("The bridge plugin is installed but could not establish its credentials. Check that ~/.dsh-pro-max is writable, then reinstall the bridge with this package spec:");
      case "incompatible":
        return t(
          "The bridge plugin is out of date: this app expects protocol {{expected}}, the installed bridge reports {{actual}}. Reinstall it in DeepSeek Harness with this package spec:",
          { expected: bridge.expectedProtocol, actual: bridge.protocol ?? "?" },
        );
    }
  })();

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p className={MUTED}>{reason}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs opacity-80">{bridge.installSpec}</code>
        <button className={BTN_SM} onClick={() => void copy()}>
          {t("Copy")}
        </button>
      </div>
    </div>
  );
}
