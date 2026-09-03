// shared/store：全局状态（Zustand）。config 是设置页草稿（输入即改草稿，Save 时才落盘）。
// Tauri 推送事件经事件桥直写本 store。

import { create } from "zustand";
import { getStoredFamily, getStoredTheme, resolveDataTheme, type ThemeMode } from "./theme";
import { currentLanguage, i18n } from "./i18n";
import * as cmd from "./commands";
import { currentConfigDraft } from "./config";
import type {
  DshAccessMode,
  DshLatestInfo,
  DshStatus,
  DownloadProgress,
  DshStepEvent,
  InstalledPlugin,
  LauncherConfig,
  MarketCatalog,
  MarketInstallLogEvent,
  ModelConfig,
  PluginUpdateInfo,
  UpdateInfo,
  UpdaterConfigHealth,
} from "./types";

export type View = "integration" | "market" | "models" | "settings";
export type SettingsSection =
  | "general"
  | "appearance"
  | "dsh-version"
  | "dsh-autostart"
  | "dsh-auth"
  | "about";
export type ToastType = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

// 已落 DOM 的 data-theme 值：OS 在外观过渡期间可能连发多个 change 事件，
// 同值重写 <html> 属性会触发整窗重绘，导致主窗口持续闪烁
let lastAppliedDataTheme: string | null = null;

function applyDataTheme(mode: ThemeMode, family: string): void {
  const next = resolveDataTheme(
    mode,
    family,
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  if (next === lastAppliedDataTheme) return;
  lastAppliedDataTheme = next;
  document.documentElement.dataset.theme = next;
}

// 模块求值时机不保证 DOM 全局就绪（vitest 4 模块执行器在被依赖模块求值后才装 jsdom 全局），
// 读 localStorage 一律走这里：非 DOM 上下文回落 null（= 默认主题）
function readStored(key: string): string | null {
  return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
}

// dsh 访问模式：localStorage 是用户选择的记忆，store 是渲染镜像（与主题同理）
const ACCESS_MODE_KEY = "dsh-access-mode";

function readStoredAccessMode(): DshAccessMode {
  return readStored(ACCESS_MODE_KEY) === "remote" ? "remote" : "local";
}

function storeAccessMode(mode: DshAccessMode): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(ACCESS_MODE_KEY, mode);
}

// 插件收藏：localStorage 是用户选择的记忆，store 是渲染镜像（与访问模式同理）；
// 值为目录条目 fullName（目录内唯一）列表，顺序即收藏顺序
const MARKET_FAVORITES_KEY = "market-favorites";

function readStoredFavorites(): string[] {
  try {
    const parsed: unknown = JSON.parse(readStored(MARKET_FAVORITES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface AppStore {
  // 导航
  activeView: View;
  settingsSection: SettingsSection;
  // 配置草稿
  config: LauncherConfig | null;
  autostart: boolean;
  languageSetting: string;
  appVersion: string;
  // dsh 运行时（跨页面保留：一键启动/停止、修复、远程授权状态）
  dshStatus: DshStatus | null;
  dshAccessMode: DshAccessMode;
  dshStartBusy: boolean;
  dshStopBusy: boolean;
  dshRestartBusy: boolean;
  dshRecheckBusy: boolean;
  dshHasRunSetup: boolean;
  // dsh 版本管理（安装/检查状态跨页面保留）
  dshLatest: DshLatestInfo | null;
  dshLatestBusy: boolean;
  dshInstallingVersion: string | null;
  // dsh 开机自启（与设置页分区共用，切页后保留检测/切换状态）
  dshAutostart: boolean | null;
  dshAutostartBusy: boolean;
  // 事件桥写入区
  dshTimeline: DshStepEvent[];
  downloadProgress: DownloadProgress | null;
  // 更新器（updateInfo 仅有可用更新时非空；
  // updateLastCheckAt/updateCheckError 供关于页状态卡持久展示检查结果，不再只靠瞬态 toast）
  updaterHealth: UpdaterConfigHealth | null;
  updaterHealthError: string | null;
  updateInfo: UpdateInfo | null;
  updateBusyKind: "check" | "install" | null;
  updateLastCheckAt: number | null;
  updateCheckError: string | null;
  // 主题（localStorage 是唯一事实来源，store 是渲染镜像）
  themeMode: ThemeMode;
  themeFamily: string;
  toasts: ToastItem[];
  // 插件市场（catalog 跨页保留：27MB 目录解析结果不随切页重拉）
  marketCatalog: MarketCatalog | null;
  marketCatalogBusy: boolean;
  marketInstalled: InstalledPlugin[];
  marketInstalledBusy: boolean;
  marketInstalling: string | null;
  // 安装过程明细：单飞安装的流式输出行（specifier 锚定发起卡片；安装/审批
  // 重跑/更新共用同一 market_install 通道，行由事件桥追加）
  marketInstallLog: { specifier: string; lines: string[] } | null;
  // 安装失败详情：卡片失败态持久展示（toast 转瞬即逝），重试/关闭时清除
  marketInstallError: { specifier: string; message: string } | null;
  marketRemoving: string | null;
  // pnpm 拦截构建脚本 → 挂起等用户审批；确认后才经 market_approve_builds 放行重装
  marketPendingApproval: { specifier: string; label: string; packages: string[]; workspaceYaml: string } | null;
  // 更新检测结果（name → info）；null = 尚未检测
  marketUpdates: Record<string, PluginUpdateInfo> | null;
  marketUpdatesBusy: boolean;
  // 正在更新插件的 name（单次或批量中的当前项），与安装 busy 分开计
  marketUpdating: string | null;
  // 收藏的目录条目 fullName（localStorage 事实来源的渲染镜像）
  marketFavorites: string[];
  // 模型配置（配置加载状态跨页保留；编辑草稿在视图本地）
  modelConfigBusy: boolean;

  navigate: (view: View) => void;
  setSettingsSection: (section: SettingsSection) => void;
  toast: (message: string, type?: ToastType) => void;
  dismissToast: (id: string) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setThemeFamily: (family: string) => void;
  syncSystemTheme: () => void;
  applyConfig: (cfg: LauncherConfig) => void;
  setConfigField: (patch: Partial<LauncherConfig>) => void;
  setAutostart: (enabled: boolean) => void;
  setDshStatus: (status: DshStatus | null) => void;
  setDshAccessMode: (mode: DshAccessMode) => void;
  setDshStartBusy: (busy: boolean) => void;
  setDshStopBusy: (busy: boolean) => void;
  setDshRestartBusy: (busy: boolean) => void;
  setDshRecheckBusy: (busy: boolean) => void;
  setDshHasRunSetup: (hasRunSetup: boolean) => void;
  setDshLatest: (info: DshLatestInfo | null) => void;
  setDshLatestBusy: (busy: boolean) => void;
  setDshInstallingVersion: (version: string | null) => void;
  setDshAutostart: (value: boolean | null) => void;
  setDshAutostartBusy: (busy: boolean) => void;
  handleDshStep: (step: DshStepEvent) => void;
  setDshTimeline: (steps: DshStepEvent[]) => void;
  setDownloadProgress: (p: DownloadProgress) => void;
  setLanguageSetting: (setting: string) => Promise<void>;
  saveConfig: () => Promise<void>;
  toggleAutostart: () => Promise<void>;
  setAppVersion: (v: string) => void;
  refreshUpdaterHealth: () => Promise<void>;
  checkForUpdates: (silent?: boolean) => Promise<void>;
  installPendingUpdate: () => Promise<void>;
  refreshMarketCatalog: (force?: boolean) => Promise<void>;
  refreshMarketInstalled: () => Promise<void>;
  installMarketPlugin: (specifier: string, label: string) => Promise<void>;
  approveMarketBuilds: () => Promise<void>;
  dismissMarketApproval: () => void;
  appendMarketInstallLog: (e: MarketInstallLogEvent) => void;
  dismissMarketInstallError: () => void;
  removeMarketPlugin: (name: string) => Promise<void>;
  refreshMarketUpdates: () => Promise<void>;
  updateMarketPlugin: (name: string, opts?: { silent?: boolean }) => Promise<boolean>;
  updateAllMarketPlugins: () => Promise<void>;
  toggleMarketFavorite: (fullName: string) => void;
  loadModelConfig: () => Promise<ModelConfig>;
}

export const useAppStore = create<AppStore>()((set, get) => ({
  activeView: "integration",
  settingsSection: "general",
  config: null,
  autostart: false,
  languageSetting: "system",
  appVersion: "-",
  dshStatus: null,
  dshAccessMode: readStoredAccessMode(),
  dshStartBusy: false,
  dshStopBusy: false,
  dshRestartBusy: false,
  dshRecheckBusy: false,
  dshHasRunSetup: false,
  dshLatest: null,
  dshLatestBusy: false,
  dshInstallingVersion: null,
  dshAutostart: null,
  dshAutostartBusy: false,
  dshTimeline: [],
  downloadProgress: null,
  updaterHealth: null,
  updaterHealthError: null,
  updateInfo: null,
  updateBusyKind: null,
  updateLastCheckAt: null,
  updateCheckError: null,
  themeMode: getStoredTheme(readStored("theme")),
  themeFamily: getStoredFamily(readStored("theme-family")),
  toasts: [],
  marketCatalog: null,
  marketCatalogBusy: false,
  marketInstalled: [],
  marketInstalledBusy: false,
  marketInstalling: null,
  marketInstallLog: null,
  marketInstallError: null,
  marketRemoving: null,
  marketPendingApproval: null,
  marketUpdates: null,
  marketUpdatesBusy: false,
  marketUpdating: null,
  marketFavorites: readStoredFavorites(),
  modelConfigBusy: false,

  navigate: (view) => set({ activeView: view }),
  setSettingsSection: (section) => set({ settingsSection: section }),

  toast: (message, type = "info") => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    // 3s 后组件开始淡出，3.3s 后移除
    setTimeout(() => get().dismissToast(id), 3300);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setThemeMode: (mode) => {
    localStorage.setItem("theme", mode);
    applyDataTheme(mode, get().themeFamily);
    set({ themeMode: mode });
  },
  setThemeFamily: (family) => {
    localStorage.setItem("theme-family", family);
    applyDataTheme(get().themeMode, family);
    set({ themeFamily: family });
  },
  syncSystemTheme: () => {
    if (get().themeMode === "system") applyDataTheme("system", get().themeFamily);
  },

  applyConfig: (cfg) =>
    set({
      config: cfg,
      languageSetting: cfg.language || "system",
    }),
  setConfigField: (patch) => set((s) => ({ config: s.config ? { ...s.config, ...patch } : s.config })),
  setAutostart: (enabled) => set({ autostart: enabled }),

  setDshStatus: (status) => set({ dshStatus: status }),
  setDshAccessMode: (mode) => {
    storeAccessMode(mode);
    set({ dshAccessMode: mode });
  },
  setDshStartBusy: (busy) => set({ dshStartBusy: busy }),
  setDshStopBusy: (busy) => set({ dshStopBusy: busy }),
  setDshRestartBusy: (busy) => set({ dshRestartBusy: busy }),
  setDshRecheckBusy: (busy) => set({ dshRecheckBusy: busy }),
  setDshHasRunSetup: (hasRunSetup) => set({ dshHasRunSetup: hasRunSetup }),
  setDshLatest: (info) => set({ dshLatest: info }),
  setDshLatestBusy: (busy) => set({ dshLatestBusy: busy }),
  setDshInstallingVersion: (version) => set({ dshInstallingVersion: version }),
  setDshAutostart: (value) => set({ dshAutostart: value }),
  setDshAutostartBusy: (busy) => set({ dshAutostartBusy: busy }),

  handleDshStep: (step) =>
    set((s) => {
      const tl = [...s.dshTimeline];
      const i = tl.findIndex((x) => x.index === step.index);
      if (i >= 0) {
        tl[i] = step;
      } else {
        tl.push(step);
        tl.sort((a, b) => a.index - b.index);
      }
      // running 事件兜底置位：流程真实启动后时间轴必须以事件流为准，
      // 即使入口因并发回声没走到置位（见 dshActions start/restart 的注释）
      return {
        dshTimeline: tl,
        dshHasRunSetup: step.state === "running" ? true : s.dshHasRunSetup,
      };
    }),
  setDshTimeline: (steps) => set({ dshTimeline: steps }),
  setDownloadProgress: (p) => set({ downloadProgress: p }),

  // 语言切换编排：落盘 + Rust 重建托盘 + react-i18next 响应式重渲染
  setLanguageSetting: async (setting) => {
    set({ languageSetting: setting });
    try {
      const cfg = get().config;
      if (cfg) await cmd.updateSettings({ ...cfg, language: setting });
      await cmd.setLanguage(setting);
      const resolved = await cmd.getResolvedLanguage();
      await i18n.changeLanguage(resolved === "zh-CN" ? "zh-CN" : "en");
      document.documentElement.lang = currentLanguage();
    } catch (e) {
      get().toast(i18n.t("Save failed: {{error}}", { error: String(e) }), "error");
    }
  },

  saveConfig: async () => {
    try {
      await cmd.updateSettings(currentConfigDraft(get()));
      get().toast(i18n.t("Settings saved"), "success");
    } catch (e) {
      get().toast(i18n.t("Save failed: {{error}}", { error: String(e) }), "error");
    }
  },

  // 自启开关即时写 OS 注册项，失败回退
  toggleAutostart: async () => {
    const next = !get().autostart;
    set({ autostart: next });
    try {
      await cmd.autostartSet(next);
    } catch (e) {
      set({ autostart: !next });
      get().toast(String(e), "error");
    }
  },

  setAppVersion: (v) => set({ appVersion: v }),

  // 更新源健康
  refreshUpdaterHealth: async () => {
    try {
      set({ updaterHealth: await cmd.getUpdaterConfigHealth(), updaterHealthError: null });
    } catch (e) {
      set({ updaterHealth: null, updaterHealthError: String(e) });
    }
  },

  // 检查更新（silent 时静默失败/静默无更新；结果记录供状态卡展示）
  checkForUpdates: async (silent = false) => {
    if (get().updateBusyKind) return;
    set({ updateBusyKind: "check" });
    try {
      const info = await cmd.checkUpdate();
      set({ updateInfo: info.hasUpdate ? info : null, updateLastCheckAt: Date.now(), updateCheckError: null });
      if (info.hasUpdate) {
        get().toast(i18n.t("New version available: v{{version}}", { version: String(info.availableVersion) }), "info");
      } else if (info.message) {
        if (!silent) get().toast(info.message, "error");
      } else if (!silent) {
        get().toast(i18n.t("Already up to date"), "info");
      }
    } catch (e) {
      set({ updateCheckError: String(e) });
      if (!silent) get().toast(i18n.t("Failed to check for updates: {{error}}", { error: String(e) }), "error");
    } finally {
      set({ updateBusyKind: null });
    }
  },

  // 无待装更新时退化为检查更新
  installPendingUpdate: async () => {
    const pending = get().updateInfo;
    if (!pending) {
      await get().checkForUpdates();
      return;
    }
    if (get().updateBusyKind) return;
    set({ updateBusyKind: "install" });
    try {
      const msg = await cmd.installUpdate(pending.availableVersion);
      get().toast(msg, "success");
      set({ updateInfo: null });
    } catch (e) {
      get().toast(i18n.t("Update failed: {{error}}", { error: String(e) }), "error");
    } finally {
      set({ updateBusyKind: null, downloadProgress: null });
    }
  },

  // 目录拉取 stale-while-revalidate：本地快照先秒级上屏（不阻塞在 27MB 网络
  // 下载上），网络目录后台拉取后整体替换。已有内存缓存不重拉（刷新按钮传
  // force）；网络失败时已有内容则静默（fromSnapshot 横幅已如实标注来源），
  // 空手或 force 刷新失败才 toast
  refreshMarketCatalog: async (force = false) => {
    if (!force && get().marketCatalog) return;
    if (get().marketCatalogBusy) return;
    set({ marketCatalogBusy: true });
    try {
      if (!force) {
        const snap = await cmd.marketSnapshot();
        if (snap && !get().marketCatalog) set({ marketCatalog: snap });
      }
      set({ marketCatalog: await cmd.marketFetch() });
    } catch (e) {
      if (force || !get().marketCatalog) {
        get().toast(i18n.t("Failed to load plugin catalog: {{error}}", { error: String(e) }), "error");
      }
    } finally {
      set({ marketCatalogBusy: false });
    }
  },

  refreshMarketInstalled: async () => {
    if (get().marketInstalledBusy) return;
    set({ marketInstalledBusy: true });
    try {
      set({ marketInstalled: await cmd.marketInstalled() });
    } catch (e) {
      get().toast(i18n.t("Failed to list installed plugins: {{error}}", { error: String(e) }), "error");
    } finally {
      set({ marketInstalledBusy: false });
    }
  },

  // 安装长操作（pnpm 下载依赖）：busy 挂在 specifier 上，过程明细由事件桥
  // 逐行追加到 marketInstallLog（卡片内实时展示）；成功后刷新已装列表并收起
  // 明细（回执 toast + 卡片转已装态）；失败把错误挂到 marketInstallError
  // （卡片失败态持久展示 + 日志留存），重试或关闭时清除。被 pnpm 拦截构建
  // 脚本时清 busy 挂起审批（对话框需要可交互），不当作失败
  installMarketPlugin: async (specifier, label) => {
    if (get().marketInstalling) return;
    set({ marketInstalling: specifier, marketInstallLog: { specifier, lines: [] }, marketInstallError: null });
    try {
      const outcome = await cmd.marketInstall(specifier);
      if (outcome.status === "needsApproval") {
        set({
          marketInstalling: null,
          marketInstallLog: null,
          marketPendingApproval: {
            specifier,
            label,
            packages: outcome.packages,
            workspaceYaml: outcome.workspaceYaml,
          },
        });
        return;
      }
      const receipt = outcome.receipt;
      get().toast(
        receipt
          ? i18n.t("Plugin installed: {{name}} ({{spec}})", { name: receipt.name, spec: receipt.spec })
          : i18n.t("Plugin installed: {{name}}", { name: label }),
        "success",
      );
      set({ marketInstallLog: null });
      await get().refreshMarketInstalled();
    } catch (e) {
      set({ marketInstallError: { specifier, message: String(e) } });
      get().toast(i18n.t("Failed to install plugin: {{error}}", { error: String(e) }), "error");
    } finally {
      set({ marketInstalling: null });
    }
  },

  // 用户在审批对话框确认放行：写 pnpm-workspace.yaml → 自动重跑安装。
  // 失败保留挂起状态，用户可重试或取消；重跑输出同样经事件桥进卡片明细
  approveMarketBuilds: async () => {
    const pending = get().marketPendingApproval;
    if (!pending || get().marketInstalling) return;
    const { specifier } = pending;
    set({ marketInstalling: specifier, marketInstallLog: { specifier, lines: [] }, marketInstallError: null });
    try {
      const receipt = await cmd.marketApproveBuilds(pending.specifier, pending.packages);
      get().toast(
        receipt
          ? i18n.t("Plugin installed: {{name}} ({{spec}})", { name: receipt.name, spec: receipt.spec })
          : i18n.t("Plugin installed: {{name}}", { name: pending.label }),
        "success",
      );
      set({ marketPendingApproval: null, marketInstallLog: null });
      await get().refreshMarketInstalled();
    } catch (e) {
      set({ marketInstallError: { specifier, message: String(e) } });
      get().toast(i18n.t("Failed to install plugin: {{error}}", { error: String(e) }), "error");
    } finally {
      set({ marketInstalling: null });
    }
  },

  // 用户拒绝放行：只清挂起，不动已落盘的半成品依赖（重装路径可自然收敛）
  dismissMarketApproval: () => {
    const pending = get().marketPendingApproval;
    if (!pending) return;
    set({ marketPendingApproval: null });
    get().toast(
      i18n.t(
        'Build scripts not approved. Run "pnpm approve-builds" in {{path}} to allow them later.',
        { path: pending.workspaceYaml },
      ),
      "info",
    );
  },

  removeMarketPlugin: async (name) => {
    if (get().marketRemoving) return;
    set({ marketRemoving: name });
    try {
      await cmd.marketRemove(name);
      get().toast(i18n.t("Plugin removed: {{name}}", { name }), "success");
      await get().refreshMarketInstalled();
    } catch (e) {
      get().toast(i18n.t("Failed to remove plugin: {{error}}", { error: String(e) }), "error");
    } finally {
      set({ marketRemoving: null });
    }
  },

  // 更新检测（registry latest 比对）：进入市场页自动跑，已安装页可手动重跑。
  // 部分包检测失败不放大为整体失败（如实无 latest、不出更新按钮），
  // 全部可检包都失败才 toast（Rust 侧聚合的网络错误）
  refreshMarketUpdates: async () => {
    if (get().marketUpdatesBusy) return;
    set({ marketUpdatesBusy: true });
    try {
      const infos = await cmd.marketCheckUpdates();
      set({ marketUpdates: Object.fromEntries(infos.map((i) => [i.name, i])) });
    } catch (e) {
      get().toast(i18n.t("Failed to check plugin updates: {{error}}", { error: String(e) }), "error");
    } finally {
      set({ marketUpdatesBusy: false });
    }
  },

  // 更新单个插件 = 以 name@latest 重装：与安装同一 dsh 闸门、审计与审批路径，
  // 落盘 spec 形态也与市场安装一致（过程明细同通道进卡片）。silent 供批量
  // 更新跳过逐条成功/失败 toast；撞上 pnpm 构建脚本拦截时挂起审批对话框并
  // 提示（批量由调用方中止后续）。更新失败维持 toast，明细不驻留
  updateMarketPlugin: async (name, opts) => {
    const silent = opts?.silent ?? false;
    if (get().marketUpdating) return false;
    const specifier = `${name}@latest`;
    set({ marketUpdating: name, marketInstallLog: { specifier, lines: [] } });
    try {
      const outcome = await cmd.marketInstall(specifier);
      if (outcome.status === "needsApproval") {
        set({
          marketUpdating: null,
          marketInstallLog: null,
          marketPendingApproval: {
            specifier,
            label: name,
            packages: outcome.packages,
            workspaceYaml: outcome.workspaceYaml,
          },
        });
        get().toast(
          i18n.t("Paused: approve build scripts for {{plugin}}, then retry.", { plugin: name }),
          "info",
        );
        return false;
      }
      const receipt = outcome.receipt;
      if (!silent) {
        get().toast(
          receipt
            ? i18n.t("Plugin updated: {{name}} ({{spec}})", { name: receipt.name, spec: receipt.spec })
            : i18n.t("Plugin updated: {{name}}", { name }),
          "success",
        );
      }
      await get().refreshMarketInstalled();
      if (!silent) void get().refreshMarketUpdates();
      return true;
    } catch (e) {
      if (!silent) get().toast(i18n.t("Failed to update plugin: {{error}}", { error: String(e) }), "error");
      return false;
    } finally {
      set({ marketUpdating: null, marketInstallLog: null });
    }
  },

  // 一键全部更新：顺序执行（共享同一 profile 目录，pnpm 并发安装会争锁）。
  // 逐个静默更新，结束汇总一条；中途撞上审批挂起则停下，剩余项待放行后重试
  updateAllMarketPlugins: async () => {
    const targets = Object.values(get().marketUpdates ?? {})
      .filter((u) => u.updateAvailable && !u.managed)
      .map((u) => u.name);
    if (targets.length === 0 || get().marketUpdating) return;
    let ok = 0;
    let failed = 0;
    for (const name of targets) {
      const done = await get().updateMarketPlugin(name, { silent: true });
      if (!done && get().marketPendingApproval) break;
      if (done) ok += 1;
      else failed += 1;
    }
    if (failed === 0 && ok > 0) {
      get().toast(i18n.t("Updated {{count}} plugins", { count: ok }), "success");
    } else if (failed > 0) {
      get().toast(i18n.t("Updated {{ok}} plugins, {{failed}} failed", { ok, failed }), "error");
    }
    await get().refreshMarketInstalled();
    void get().refreshMarketUpdates();
  },

  // 收藏/取消收藏：只认目录条目 fullName；目录下架的条目留在清单里，
  // 收藏页渲染时与目录取交集（再收藏同类条目自然恢复）
  toggleMarketFavorite: (fullName) => {
    const favorites = get().marketFavorites.includes(fullName)
      ? get().marketFavorites.filter((f) => f !== fullName)
      : [...get().marketFavorites, fullName];
    if (typeof localStorage !== "undefined") localStorage.setItem(MARKET_FAVORITES_KEY, JSON.stringify(favorites));
    set({ marketFavorites: favorites });
  },

  // 安装输出行（事件桥直写）：specifier 匹配当前记录的日志才收（防跨安装
  // 错位）；行数封顶防超长安装无限涨内存，卡片只展示尾部
  appendMarketInstallLog: (e) =>
    set((s) => {
      if (!s.marketInstallLog || s.marketInstallLog.specifier !== e.specifier) return s;
      const lines = [...s.marketInstallLog.lines, e.line].slice(-200);
      return { marketInstallLog: { specifier: e.specifier, lines } };
    }),

  // 关闭卡片失败态：错误与留存的安装明细一并清（下次安装各自重建）
  dismissMarketInstallError: () => set({ marketInstallError: null, marketInstallLog: null }),

  loadModelConfig: async () => {
    if (get().modelConfigBusy) return await cmd.modelConfigLoad();
    set({ modelConfigBusy: true });
    try {
      return await cmd.modelConfigLoad();
    } finally {
      set({ modelConfigBusy: false });
    }
  },
}));
