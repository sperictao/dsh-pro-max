// 桥接未就绪时的去向说明。首页桌面卡片与插件页的桌面 tab 共用同一份——同一件事只有
// 一个说法，改文案不会只改一半。
//
// 已连接时什么都不渲染：那是调用方展示内容的前提，不是一条需要说的状态。

import { useTranslation } from "react-i18next";
import { BTN_SM, MUTED } from "@/shared/lib/ui";
import type { BridgeStatus } from "@/shared/types";

export function BridgeNotice({
  bridge,
  onCopy,
}: {
  bridge: BridgeStatus;
  onCopy: (url: string) => void;
}) {
  const { t } = useTranslation();

  if (bridge.state === "connected") return null;

  if (bridge.state === "app_unavailable") {
    return <p className={MUTED}>{t("Open DeepSeek Harness to manage its plugins and configuration.")}</p>;
  }

  // not_installed 与 incompatible 的去向是同一个：粘一次地址重装
  const reason =
    bridge.state === "not_installed"
      ? t("The bridge plugin is not installed in DeepSeek Harness. Install it once from the app's Plugins page with this address:")
      : t(
          "The bridge plugin is out of date: this app expects protocol {{expected}}, the installed bridge reports {{actual}}. Reinstall it in DeepSeek Harness with this address:",
          { expected: bridge.expectedProtocol, actual: bridge.protocol ?? "?" },
        );

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p className={MUTED}>{reason}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs opacity-80">{bridge.installUrl}</code>
        <button className={BTN_SM} onClick={() => void onCopy(bridge.installUrl)}>
          {t("Copy address")}
        </button>
      </div>
    </div>
  );
}
