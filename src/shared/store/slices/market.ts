// 插件市场切片：目录（stale-while-revalidate）、已装列表、安装/审批/移除、
// 更新检测与收藏。catalog 跨页保留：27MB 目录解析结果不随切页重拉

import { i18n } from "../../i18n";
import { tErr } from "../../i18n/error";
import * as cmd from "../../commands";
import type {
  InstalledPlugin,
  MarketCatalog,
  MarketInstallLogEvent,
  PluginUpdateInfo,
} from "../../types";
import { readStored, type Slice } from "./shared";

// 插件收藏：localStorage 是用户选择的记忆，store 是渲染镜像；
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

export interface MarketSlice {
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
}

export const createMarketSlice: Slice<MarketSlice> = (set, get) => ({
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
        get().toast(i18n.t("Failed to load plugin catalog: {{error}}", { error: tErr(String(e)) }), "error");
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
      get().toast(i18n.t("Failed to list installed plugins: {{error}}", { error: tErr(String(e)) }), "error");
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
      get().toast(i18n.t("Failed to install plugin: {{error}}", { error: tErr(String(e)) }), "error");
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
      get().toast(i18n.t("Failed to install plugin: {{error}}", { error: tErr(String(e)) }), "error");
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
      get().toast(i18n.t("Failed to remove plugin: {{error}}", { error: tErr(String(e)) }), "error");
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
      get().toast(i18n.t("Failed to check plugin updates: {{error}}", { error: tErr(String(e)) }), "error");
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
      if (!silent) get().toast(i18n.t("Failed to update plugin: {{error}}", { error: tErr(String(e)) }), "error");
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
});
