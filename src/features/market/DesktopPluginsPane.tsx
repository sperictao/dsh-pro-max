// 桌面应用 tab：官方桌面应用那个 profile 里 web 档没有对应物的部分，全部经它自己加载的
// 桥接插件（调它自己的 Plugin Manager / Config Editor，而不是在应用背后直写 profile，
// 见 ADR 0011）：桥接连接状态与一次性安装引导、内置 bundle 与插件行的开关、全部配置行的
// 原始 JSON 编辑。
//
// 用户装的插件不在这里：它们的安装、更新、启停、移除归市场（发现/收藏/已安装三页按目标
// 形态参数化，见 ADR 0012），这里再列一份就是第二个事实来源。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import { renderMessage } from "@/shared/i18n/error";
import * as cmd from "@/shared/commands";
import { BTN_OUTLINE, MUTED, PANEL, TEXTAREA, TOGGLE } from "@/shared/lib/ui";
import type { BridgeStatus, ChangeOutcome, ConfigRow, DesktopPlugins, DesktopStatus } from "@/shared/types";
import { BridgeNotice } from "@/features/integration/BridgeNotice";

export function DesktopPluginsPane() {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  const [desktop, setDesktop] = useState<DesktopStatus | null>(null);
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [plugins, setPlugins] = useState<DesktopPlugins | null>(null);
  const [config, setConfig] = useState<ConfigRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDesktop(await cmd.desktopDetect());
    } catch (e) {
      // 应用本身探测不了就没有可判断的前提，说明原因后到此为止
      toast(renderMessage(e), "error");
      return;
    }
    // 桥接探测失败不该牵连上面那一项：它是这个 tab 的下半段，不是全部
    let nextBridge: BridgeStatus | null = null;
    try {
      nextBridge = await cmd.desktopBridgeStatus();
    } catch {
      // 静默：下面的内容本就因桥接不可用而不显示
    }
    setBridge(nextBridge);
    if (nextBridge?.state !== "connected") {
      setPlugins(null);
      setConfig(null);
      return;
    }
    try {
      const [nextPlugins, nextConfig] = await Promise.all([cmd.desktopBridgePlugins(), cmd.desktopBridgeConfig()]);
      setPlugins(nextPlugins);
      setConfig(nextConfig);
    } catch (e) {
      toast(renderMessage(e), "error");
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  /// 管理动作的统一外壳：busy 守卫、失败去向、成功后重拉。
  /// `null` 表示这个动作没有变更结果可看（配置写入走的是桥接的 /config/edit，返回的不是
  /// ChangeResult）——那种情况下成功即成功，不给它现编一份假的 ChangeOutcome。
  /// 有结果时按 application 各给一句去向：上游把管理失败折叠进返回值而不是抛出，
  /// 所以判断成败看 application，不是「没抛就算成功」。
  const run = useCallback(
    async (action: () => Promise<ChangeOutcome | null>) => {
      setBusy(true);
      try {
        const outcome = await action();
        if (outcome === null) {
          toast(t("Applied"), "info");
          await load();
          return;
        }
        if (outcome.application === "applied") toast(t("Applied"), "info");
        else if (outcome.application === "restart-required") toast(t("Restart DeepSeek Harness to apply this change."), "info");
        else if (outcome.application === "overridden") toast(t("A higher-priority layer overrides this change; it is not in effect."), "error");
        else if (outcome.application === "cancelled") toast(t("The change was cancelled."), "error");
        else toast(t("The change failed: {{reason}}", { reason: outcome.errorDiagnostic ?? outcome.errorCode ?? "" }), "error");
        await load();
      } catch (e) {
        toast(renderMessage(e), "error");
      } finally {
        setBusy(false);
      }
    },
    [load, t, toast],
  );

  const copyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      toast(t("Address copied"), "info");
    } catch (e) {
      toast(t("Failed to copy: {{error}}", { error: String(e) }), "error");
    }
  };

  if (!desktop) return <p className={`${MUTED} p-4`}>{t("Checking...")}</p>;

  if (!desktop.installed) {
    return <p className={`${MUTED} p-4`}>{t("DeepSeek Harness is not installed. Install it from the official channel; this app only detects and manages it.")}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4" id="desktop-plugins-pane">
      {bridge && <BridgeNotice bridge={bridge} onCopy={copyAddress} />}

      {bridge?.state === "connected" && (
        <>
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t("Plugins")}</h3>
            <div className={`${PANEL} divide-y divide-border`}>
              {plugins?.plugins.map((row) => {
                const locked = row.patchId === null;
                return (
                  <div key={row.entryId} className="flex items-center justify-between gap-3 p-3">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-mono text-xs">{row.moduleName}</span>
                      {locked && (
                        <span className={MUTED}>
                          {row.readOnlyReason === "management-required"
                            ? t("The desktop app manages this itself; it cannot be changed here.")
                            : t("The profile cannot address this row; change it in DeepSeek Harness.")}
                        </span>
                      )}
                    </span>
                    <input
                      type="checkbox"
                      className={TOGGLE}
                      checked={row.enabled}
                      disabled={busy || locked}
                      aria-label={row.moduleName}
                      onChange={(e) => void run(() => cmd.desktopBridgeSetEnabled({ pluginId: row.entryId }, e.target.checked))}
                    />
                  </div>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t("Built-in bundles")}</h3>
            <p className={MUTED}>{t("Plugins you installed are managed on the Installed tab, side by side with the web profile.")}</p>
            <div className={`${PANEL} divide-y divide-border`}>
              {plugins?.bundles
                .filter((row) => !row.removable)
                .map((row) => (
                  <div key={row.name} className="flex items-center justify-between gap-3 p-3">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-xs">{row.name}</span>
                        {row.version && <span className="shrink-0 font-mono text-xs opacity-70">{row.version}</span>}
                      </span>
                      {row.description && <span className={MUTED}>{row.description}</span>}
                    </span>
                    <input
                      type="checkbox"
                      className={TOGGLE}
                      checked={row.enabled}
                      disabled={busy || row.readOnlyReason !== null}
                      aria-label={row.name}
                      onChange={(e) => void run(() => cmd.desktopBridgeSetEnabled({ bundleName: row.name }, e.target.checked))}
                    />
                  </div>
                ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t("Profile configuration")}</h3>
            <p className={MUTED}>
              {t("Each row is one plugin's configuration in this profile, as the desktop app stores it. Edit the JSON and save to write the whole row back.")}
            </p>
            {config?.map((row) => (
              <ConfigRowEditor key={row.id} row={row} busy={busy} onSave={run} />
            ))}
          </section>
        </>
      )}

      {busy && <p className={MUTED}>{t("Working…")}</p>}
    </div>
  );
}

/// 一行配置的原文编辑。整份替换而不是合并：上游的 edit 收到的就是下一份原始 config，
/// 它自己负责在落盘时保住文件其余部分
function ConfigRowEditor({
  row,
  busy,
  onSave,
}: {
  row: ConfigRow;
  busy: boolean;
  onSave: (action: () => Promise<ChangeOutcome | null>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  // 初值取自这一行的当前值，之后不再从 props 同步：重拉拿回的是新对象（桥接是真 HTTP），
  // 跟着它重置会把用户打了一半的内容冲掉——编辑中的内容是用户的状态，后台数据不该覆盖它。
  // 行换了身份由 key={row.id} 处理。
  const [text, setText] = useState(() => (row.current === null ? "{}" : JSON.stringify(row.current, null, 2)));

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      toast(t("Not valid JSON: {{error}}", { error: String(e) }), "error");
      return;
    }
    // null：这条路由没有 ChangeResult 可看，调用方按「成功即成功」处理
    await onSave(async () => {
      await cmd.desktopBridgeConfigEdit(row.id, parsed);
      return null;
    });
  };

  return (
    <details className={`${PANEL} p-3`}>
      <summary className="cursor-pointer font-mono text-xs">
        {row.id}
        <span className="ml-2 font-sans opacity-60">{row.name}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <textarea
          className={`${TEXTAREA} min-h-40`}
          value={text}
          disabled={busy}
          spellCheck={false}
          aria-label={row.id}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex justify-end">
          <button className={BTN_OUTLINE} disabled={busy} onClick={() => void save()}>
            {t("Save")}
          </button>
        </div>
      </div>
    </details>
  );
}
