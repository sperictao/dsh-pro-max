import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore, type View } from "./shared/store";
import { onDshStep, onUpdaterDownloadProgress } from "./shared/events";
import * as cmd from "./shared/commands";
import { log } from "./shared/logger";
import { i18n } from "./shared/i18n";
import { Toaster } from "./shared/components/Toaster";
import { openRepo } from "./shared/lib/links";
import { UpdateBadge } from "./features/updater/UpdateBadge";
import { SettingsView } from "./features/settings/SettingsView";
import { IntegrationView } from "./features/integration/IntegrationView";

const NAV_ITEMS: { view: View; labelKey: string }[] = [
  { view: "integration", labelKey: "Home" },
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

  // 跟随系统模式：OS 亮暗切换时重解析 data-theme
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => useAppStore.getState().syncSystemTheme();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

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
              onClick={() => navigate(item.view)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>
      </header>

      {activeView === "settings" && <SettingsView />}
      {activeView === "integration" && <IntegrationView />}
      <Toaster />
    </>
  );
}
