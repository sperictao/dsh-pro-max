import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore, type View } from "./shared/store";
import { useSystemThemeSync } from "./shared/useSystemThemeSync";
import { onDshStep, onMarketInstallLog, onTrayDshAction, onUpdaterDownloadProgress } from "./shared/events";
import * as cmd from "./shared/commands";
import { log } from "./shared/logger";
import { i18n } from "./shared/i18n";
import { Toaster } from "./shared/components/Toaster";
import { openRepo } from "./shared/lib/links";
import { UpdateBadge } from "./features/updater/UpdateBadge";
import { SettingsView } from "./features/settings/SettingsView";
import { IntegrationView } from "./features/integration/IntegrationView";
import { restartDshWeb, startDshWeb, stopDshWeb } from "./features/integration/dshActions";
import { MarketView } from "./features/market/MarketView";
import { ModelsView } from "./features/models/ModelsView";

const NAV_ITEMS: { view: View; labelKey: string }[] = [
  { view: "integration", labelKey: "Home" },
  { view: "market", labelKey: "Plugins" },
  { view: "models", labelKey: "Models" },
  { view: "settings", labelKey: "Settings" },
];

export function App() {
  const { t } = useTranslation();
  const activeView = useAppStore((s) => s.activeView);
  const navigate = useAppStore((s) => s.navigate);

  // 事件桥 + 初始化
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const bind = (p: Promise<() => void>) => {
      void p.then((u) => {
        if (disposed) u();
        else unlisteners.push(u);
      });
    };
    bind(onUpdaterDownloadProgress((p) => useAppStore.getState().setDownloadProgress(p)));
    bind(onDshStep((s) => useAppStore.getState().handleDshStep(s)));
    // 插件安装过程明细：事件桥直写 store（specifier 锚定卡片）
    bind(onMarketInstallLog((p) => useAppStore.getState().appendMarketInstallLog(p)));
    // 托盘 dsh 三键：远端触发器，交互逻辑与首页按钮同源（dshActions）
    bind(onTrayDshAction((id) => {
      if (id === "dsh-start") void startDshWeb();
      else if (id === "dsh-stop") void stopDshWeb();
      else if (id === "dsh-restart") void restartDshWeb();
    }));

    // 进程事故通知需要系统授权（macOS），启动时静默请求一次
    void (async () => {
      try {
        if (!(await isPermissionGranted())) await requestPermission();
      } catch (e) {
        log.warn("请求通知权限失败（静默）", e);
      }
    })();

    void (async () => {
      try {
        const cfg = await cmd.loadConfig();
        if (disposed) return;
        useAppStore.getState().applyConfig(cfg);
        try {
          const autostart = await cmd.autostartIsEnabled();
          if (!disposed) useAppStore.getState().setAutostart(autostart);
        } catch {
          /* 读不到就当关 */
        }

        // 应用版本（关于页）
        try {
          useAppStore.getState().setAppVersion(await getVersion());
        } catch (e) {
          log.warn("读取应用版本失败", e);
          useAppStore.getState().setAppVersion("unknown");
        }

        // 更新源健康检查 + 静默检查更新（有新版本才提示）
        await useAppStore.getState().refreshUpdaterHealth();
        void useAppStore.getState().checkForUpdates(true);
      } catch (e) {
        useAppStore.getState().toast(i18n.t("Initialization failed: {{error}}", { error: String(e) }), "error");
      }
    })();

    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
    };
  }, []);

  // 跟随系统模式：OS 亮暗切换时重解析 data-theme（去抖在 hook 内）
  useSystemThemeSync();

  // 托盘 dsh 三键的可用性镜像首页按钮：running/busy 翻转时推送后端重建菜单
  const trayRunning = useAppStore((s) => !!s.dshStatus?.dshRunning);
  const trayBusy = useAppStore((s) => s.dshStartBusy || s.dshStopBusy || s.dshRestartBusy || s.dshRecheckBusy);
  useEffect(() => {
    cmd.syncTrayDshActions(trayRunning, trayBusy).catch(() => {
      /* 推送失败托盘保持上一次状态；invokeTyped 已记日志 */
    });
  }, [trayRunning, trayBusy]);

  // 键盘快捷键：Cmd/Ctrl + , 打开设置（macOS/Windows 系统惯例）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.key !== "," || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      navigate("settings");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return (
    <>
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="cursor-pointer rounded-md text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="GitHub"
            onClick={() => void openRepo()}
          >
            DSH Pro Max
          </button>
          <UpdateBadge />
        </div>
        <div className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.view}
              className={`header-btn${activeView === item.view ? " active" : ""}`}
              title={item.view === "settings" ? t("Shortcut: Cmd/Ctrl + ,") : undefined}
              onClick={() => navigate(item.view)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>
      </header>

      {activeView === "settings" && <SettingsView />}
      {activeView === "integration" && <IntegrationView />}
      {activeView === "market" && <MarketView />}
      {activeView === "models" && <ModelsView />}
      <Toaster />
    </>
  );
}
