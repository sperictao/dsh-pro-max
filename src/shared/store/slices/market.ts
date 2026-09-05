// 插件市场切片：目录（stale-while-revalidate）、已装列表、安装/审批/移除、
// 更新检测与收藏。catalog 跨页保留：27MB 目录解析结果不随切页重拉

import { i18n } from "../../i18n";
import { tErr } from "../../i18n/error";
import * as cmd from "../../commands";
import type {
  DiscoveryCompat,
  InstalledPlugin,
  InstallNotice,
  MarketCatalog,
  MarketInstallLogEvent,
  PluginReleaseNotes,
  PluginUpdateInfo,
} from "../../types";
import { readStored, type Slice } from "./shared";

// 插件收藏：localStorage 是用户选择的记忆，store 是渲染镜像；
// 值为目录条目 fullName（目录内唯一）列表，顺序即收藏顺序
const MARKET_FAVORITES_KEY = "market-favorites";

/// 安装护栏事实（结构化 kind）→ 用户文案：语言由前端词典组装，Rust 侧
/// 只传 name，不拼接句子（翻译不随 Rust 字符串漂移）
function installNoticeText(notices: InstallNotice[]): string {
  return notices
    .map((n) =>
      n.kind === "strippedDuplicateBundle"
        ? i18n.t(
            "Removed duplicate bundle entry {{name}} (already mounted by a patch row) to keep the next boot alive.",
            { name: n.name },
          )
        : "",
    )
    .filter(Boolean)
    .join(" ");
}

/// 更新/重装的安装标识拼装：latest 在 pnpm minimumReleaseAge 保护窗口内时
/// 钉版本（窗口内 @latest 会被静默拦回旧版、退出码仍为 0 造成假成功，
/// 钉版本是 pnpm 认的知情通道），否则 @latest。store 发起与卡片锚定
/// installError 共用此规则，两侧不得漂移
export function updateSpecifierFor(name: string, info: PluginUpdateInfo | null | undefined): string {
  return info?.updateAvailable && info.latestInReleaseAgeWindow && info.latestVersion
    ? `${name}@${info.latestVersion}`
    : `${name}@latest`;
}

/// 目录条目 url（https://github.com/<owner>/<repo>）→ "owner/repo"（G5 更新
/// 说明的查询键）。Rust 侧 valid_repo_id 认同一形态；非 GitHub 形态返回 null
export function repoIdFromCatalogUrl(url: string | null | undefined): string | null {
  const m = url?.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

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
  // latest 落在 pnpm minimumReleaseAge 保护窗口 → 挂起等用户知情确认；
  // 确认后钉版本重装（见 updateSpecifierFor）。载荷携带版本过渡与发布时间，
  // 确认框据此展示"从哪升到哪、发布多久了"
  marketReleaseAgeConfirm: {
    name: string;
    latestVersion: string;
    installedVersion: string | null;
    publishTime: string | null;
  } | null;
  // 更新检测结果（name → info）；null = 尚未检测
  marketUpdates: Record<string, PluginUpdateInfo> | null;
  marketUpdatesBusy: boolean;
  // 正在更新插件的 name（单次或批量中的当前项），与安装 busy 分开计
  marketUpdating: string | null;
  // 收藏的目录条目 fullName（localStorage 事实来源的渲染镜像）
  marketFavorites: string[];
  // 发现页兼容性（G4）：npm 包名 → 事实。缺键 = 未查询或查询失败（前端按
  // 未知处理，不隐藏）；compatible 由 Rust 按宿主版本现算
  marketCompat: Record<string, DiscoveryCompat>;
  // 更新说明对话框挂起态（G5）：name 锚定待更新插件；notes 为 null 且不
  // busy = 探针未覆盖或查询失败（对话框内如实显示"暂无说明"）
  marketReleaseNotes: { name: string; notes: PluginReleaseNotes | null; busy: boolean } | null;
  refreshMarketCatalog: (force?: boolean) => Promise<void>;
  refreshMarketInstalled: () => Promise<void>;
  installMarketPlugin: (specifier: string, label: string) => Promise<void>;
  approveMarketBuilds: () => Promise<void>;
  dismissMarketApproval: () => void;
  appendMarketInstallLog: (e: MarketInstallLogEvent) => void;
  dismissMarketInstallError: () => void;
  removeMarketPlugin: (name: string) => Promise<void>;
  setMarketPluginEnabled: (name: string, enabled: boolean) => Promise<void>;
  refreshMarketUpdates: () => Promise<void>;
  updateMarketPlugin: (name: string, opts?: { silent?: boolean; releaseAgePin?: string }) => Promise<boolean>;
  confirmMarketReleaseAge: () => Promise<void>;
  dismissMarketReleaseAge: () => void;
  updateAllMarketPlugins: () => Promise<void>;
  toggleMarketFavorite: (fullName: string) => void;
  fetchMarketCompat: (names: string[]) => Promise<void>;
  cancelMarketInstall: () => void;
  openMarketReleaseNotes: (name: string) => Promise<void>;
  dismissMarketReleaseNotes: () => void;
  confirmMarketReleaseNotesUpdate: () => Promise<void>;
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
  marketReleaseAgeConfirm: null,
  marketUpdates: null,
  marketUpdatesBusy: false,
  marketUpdating: null,
  marketFavorites: readStoredFavorites(),
  marketCompat: {},
  marketReleaseNotes: null,

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
      const notices = installNoticeText(outcome.notices);
      if (notices) get().toast(notices, "info");
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
      const outcome = await cmd.marketApproveBuilds(pending.specifier, pending.packages);
      if (outcome.status === "needsApproval") {
        // 放行后重装又撞上新的被拦包（依赖的依赖）：再挂审批，不当作失败
        set({
          marketPendingApproval: {
            specifier: pending.specifier,
            label: pending.label,
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
          : i18n.t("Plugin installed: {{name}}", { name: pending.label }),
        "success",
      );
      const notices = installNoticeText(outcome.notices);
      if (notices) get().toast(notices, "info");
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

  // 启停开关（写 profile patch 的 disabled 覆盖行，重启 dsh web 后生效；
  // 运行中的 dsh 不受影响）。落盘回执（重读后的落盘事实）与请求一致才出
  // 变更 toast；不一致 = 内容未变化的空操作（重复启停），如实提示没改
  setMarketPluginEnabled: async (name, enabled) => {
    try {
      const receipt = await cmd.marketSetPluginEnabled(name, enabled);
      if (receipt.enabled === enabled) {
        get().toast(
          i18n.t(
            enabled
              ? "Plugin {{name}} will be enabled at the next dsh web start."
              : "Plugin {{name}} will be disabled at the next dsh web start.",
            { name },
          ),
          "success",
        );
      } else {
        get().toast(i18n.t("No change needed: the toggle is already in that state."), "info");
      }
      await get().refreshMarketInstalled();
    } catch (e) {
      get().toast(i18n.t("Failed to toggle plugin: {{error}}", { error: tErr(String(e)) }), "error");
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
  // 落盘 spec 形态也与市场安装一致（过程明细同通道进卡片）。例外：latest 落在
  // pnpm minimumReleaseAge 保护窗口内时，@latest 会被静默解析回旧版（退出码
  // 仍为 0 的假成功）——挂起弹供应链确认框（marketReleaseAgeConfirm），用户
  // 知情确认后经 releaseAgePin 钉版本重装（pnpm 认的知情通道，自动写
  // minimumReleaseAgeExclude）。silent 供批量更新跳过逐条成功/失败 toast；
  // 撞上 pnpm 构建脚本拦截时挂起审批对话框并提示（批量由调用方中止后续）。
  // 更新失败维持 toast，明细不驻留
  updateMarketPlugin: async (name, opts) => {
    const silent = opts?.silent ?? false;
    if (get().marketUpdating) return false;
    const info = get().marketUpdates?.[name];
    if (!opts?.releaseAgePin && info?.updateAvailable && info.latestInReleaseAgeWindow && info.latestVersion) {
      set({
        marketReleaseAgeConfirm: {
          name,
          latestVersion: info.latestVersion,
          installedVersion: info.installedVersion,
          publishTime: info.latestPublishTime,
        },
      });
      return false;
    }
    const specifier = opts?.releaseAgePin ? `${name}@${opts.releaseAgePin}` : `${name}@latest`;
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
      // 护栏事实（重复挂载剥离）不受 silent 影响：批量更新里同样必须可见
      const notices = installNoticeText(outcome.notices);
      if (notices) get().toast(notices, "info");
      // 回执背书的乐观收敛：@latest/钉定版本装成 = 已到检测时的 latest，
      // 本包"有更新"即刻为假（徽章与 Update 按钮随回执消失，不等后台
      // registry 重检）。installedVersion 的暂态失真可容忍：卡片版本号读
      // installed.version（磁盘事实），后台重检落地后整体校正（registry
      // 又出新版会翻回来）
      if (receipt)
        set((s) => {
          const info = s.marketUpdates?.[receipt.name];
          if (!info) return s;
          return {
            marketUpdates: {
              ...s.marketUpdates!,
              [receipt.name]: { ...info, updateAvailable: false },
            },
          };
        });
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

  // 用户确认承担供应链窗口风险：清挂起，以挂起时捕获的版本钉版本重装
  confirmMarketReleaseAge: async () => {
    const pending = get().marketReleaseAgeConfirm;
    if (!pending || get().marketUpdating) return;
    set({ marketReleaseAgeConfirm: null });
    await get().updateMarketPlugin(pending.name, { releaseAgePin: pending.latestVersion });
  },

  // 用户放弃窗口内更新：正常路径（@latest）等版本过了保护期自然可用，
  // 如实告知去向，不留半成品
  dismissMarketReleaseAge: () => {
    if (!get().marketReleaseAgeConfirm) return;
    set({ marketReleaseAgeConfirm: null });
    get().toast(
      i18n.t("Update canceled. You can update normally once the version matures past the pnpm protection window."),
      "info",
    );
  },

  // 一键全部更新：顺序执行（共享同一 profile 目录，pnpm 并发安装会争锁）。
  // 逐个静默更新，结束汇总一条；中途撞上审批挂起或供应链窗口确认则停下，
  // 剩余项待用户处置后重试
  updateAllMarketPlugins: async () => {
    const targets = Object.values(get().marketUpdates ?? {})
      // 兼容门禁判 false（目标要求更高 dsh 版本）的更新不进批量——单卡
      // Update 按钮已禁用，批量入口同样排除
      .filter((u) => u.updateAvailable && !u.managed && u.compatible !== false)
      .map((u) => u.name);
    if (targets.length === 0 || get().marketUpdating) return;
    let ok = 0;
    let failed = 0;
    for (const name of targets) {
      const done = await get().updateMarketPlugin(name, { silent: true });
      if (!done && (get().marketPendingApproval || get().marketReleaseAgeConfirm)) break;
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

  // 取消当前安装/移除（G2）：后端置位取消令牌杀子进程，取消走失败路径
  // （display=取消文案、审计台账记 raw）。幂等：无活跃命令后端返回 false，
  // 前端不必预判
  cancelMarketInstall: () => {
    void cmd.marketCancel();
  },

  // 发现页兼容性按需批量查询（G4）：只查 marketCompat 里还没有的包名——
  // 已有事实不重查（磁盘缓存挡在后端）；失败的包名不入表，依赖下次变化时
  // 自然重试（失败不改变依赖，不会立刻成环）。兼容性是浏览辅助，失败静默
  fetchMarketCompat: async (names) => {
    const missing = names.filter((n) => !(n in get().marketCompat));
    if (missing.length === 0) return;
    try {
      const infos = await cmd.marketDiscoveryCompat(missing);
      // 空结果不 set：marketCompat 依赖在发现页 effect 里，空 set 会造成
      // 「缺键 → 拉空 → 依赖变更 → 再拉」的死循环（部分失败以缺席表达）
      if (infos.length > 0) {
        set((s) => ({
          marketCompat: { ...s.marketCompat, ...Object.fromEntries(infos.map((i) => [i.name, i])) },
        }));
      }
    } catch {
      // 兼容性缺失按未知处理：卡片不隐藏、徽章不出
    }
  },

  // 更新说明打开（G5）：仓库标识从目录条目 url 派生（github: spec 兜底）；
  // 说明是显示性增强，查询失败按"未覆盖"处理，不阻塞更新
  openMarketReleaseNotes: async (name) => {
    if (get().marketReleaseNotes?.busy) return;
    const spec = get().marketInstalled.find((p) => p.name === name)?.spec;
    // 目录名与落盘键大小写可能不一致（目录保留作者原样、npm 键常小写），
    // 仓库标识派生按不区分大小写匹配
    const url = get().marketCatalog?.plugins.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    )?.url;
    const repo = repoIdFromCatalogUrl(url) ?? (spec?.startsWith("github:") ? spec.slice(7).split("#")[0] : null);
    set({ marketReleaseNotes: { name, notes: null, busy: true } });
    try {
      const notes = repo ? await cmd.marketReleaseNotes(repo) : null;
      set({ marketReleaseNotes: { name, notes, busy: false } });
    } catch {
      set({ marketReleaseNotes: { name, notes: null, busy: false } });
    }
  },

  dismissMarketReleaseNotes: () => set({ marketReleaseNotes: null }),

  // 说明框内确认更新：关框走既有更新管线（可能再弹供应链窗口确认框）
  confirmMarketReleaseNotesUpdate: async () => {
    const pending = get().marketReleaseNotes;
    if (!pending) return;
    set({ marketReleaseNotes: null });
    await get().updateMarketPlugin(pending.name);
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
