// 插件市场切片：目录（stale-while-revalidate）、已装列表、安装/审批/移除、
// 更新检测与收藏。catalog 跨页保留：27MB 目录解析结果不随切页重拉。
//
// 操作按目标形态参数化（ADR 0012）：web 档走自己的 profile，desktop 档经桥接走桌面
// 应用自己的 Plugin Manager。进行中的操作、失败锚点、审批与批量队列都带上形态——同一个
// 插件两档都装时，卡片上两行各自只认自己那档的状态

import { i18n } from "../../i18n";
import { renderMessage, tErr } from "../../i18n/error";
import * as cmd from "../../commands";
import type { StoreApi } from "zustand";
import type {
  ChangeApplication,
  DesktopInstalledPlugin,
  DiscoveryCompat,
  DshSurface,
  InstalledPlugin,
  InstallNotice,
  InstallOutcome,
  MarketCatalog,
  MarketInstallLogEvent,
  PluginReleaseNotes,
  PluginUpdateInfo,
} from "../../types";
import { readStored, type Slice } from "./shared";
import { githubRepoId } from "../../lib/specifier";
import type { AppStore } from "../../store";

// 插件收藏：localStorage 是用户选择的记忆，store 是渲染镜像；
// 值为目录条目 fullName（目录内唯一）列表，顺序即收藏顺序
const MARKET_FAVORITES_KEY = "market-favorites";

/// 一次操作的对象：哪个形态上的哪个插件
export type MarketTarget = { surface: DshSurface; name: string };

/// 安装护栏事实（结构化 kind）→ 用户文案：语言由前端词典组装，Rust 侧
/// 只传 name，不拼接句子（翻译不随 Rust 字符串漂移）
function installNoticeText(notices: InstallNotice[]): string {
  return notices
    .map((n): string => {
      switch (n.kind) {
        case "strippedDuplicateBundle":
          return i18n.t(
            "Removed duplicate bundle entry {{name}} (already mounted by a patch row) to keep the next boot alive.",
            { name: n.name },
          );
        case "desktopRestartRequired":
          return i18n.t("Restart DeepSeek Harness to apply this change.");
        case "desktopOverridden":
          return i18n.t("A higher-priority layer overrides this change; it is not in effect.");
      }
    })
    .filter(Boolean)
    .join(" ");
}

type InstalledOutcome = Extract<InstallOutcome, { status: "installed" }>;
type MarketToast = (message: string, type?: "info" | "error" | "success") => void;

// needsStoreRepair 是 launcher 内部消化的自动修复信号，不会越过 IPC；
// 防御性收窄让类型系统证明其不可达，而非静默当成功处理
function asInstalled(outcome: InstallOutcome): InstalledOutcome | null {
  return outcome.status === "installed" ? outcome : null;
}

/// 成功文案：[有回执, 无回执]。桌面档的句子点名落点——两档都装时，一句「已安装」
/// 说不清装到了哪
const INSTALL_TOAST: Record<DshSurface, Record<"installed" | "updated", [string, string]>> = {
  web: {
    installed: ["Plugin installed: {{name}} ({{spec}})", "Plugin installed: {{name}}"],
    updated: ["Plugin updated: {{name}} ({{spec}})", "Plugin updated: {{name}}"],
  },
  desktop: {
    installed: [
      "Plugin installed in DeepSeek Harness: {{name}} ({{spec}})",
      "Plugin installed in DeepSeek Harness: {{name}}",
    ],
    updated: [
      "Plugin updated in DeepSeek Harness: {{name}} ({{spec}})",
      "Plugin updated in DeepSeek Harness: {{name}}",
    ],
  },
};

function notifyInstallOutcome(
  toast: MarketToast,
  outcome: InstalledOutcome,
  label: string,
  verb: "installed" | "updated",
  surface: DshSurface,
  silent = false,
): void {
  const receipt = outcome.receipt;
  if (!silent) {
    const [withSpec, bare] = INSTALL_TOAST[surface][verb];
    toast(
      receipt ? i18n.t(withSpec, { name: receipt.name, spec: receipt.spec }) : i18n.t(bare, { name: label }),
      "success",
    );
  }
  const notices = installNoticeText(outcome.notices);
  if (notices) toast(notices, "info");
}

/// 一次变更被接受后的去向（两档、市场与桌面 tab 共用这一个说法）：生效与「重启后生效」
/// 都是成功，句子由调用方给（「重启 dsh web」与「重启 DeepSeek Harness」不是一回事）；
/// 被覆盖、被取消、本来就是那个状态各给一句，都不算失败
export function notifyChange(
  toast: MarketToast,
  application: ChangeApplication,
  messages: { applied: string; restartRequired: string },
): void {
  switch (application) {
    case "applied":
      toast(messages.applied, "success");
      return;
    case "restart-required":
      toast(messages.restartRequired, "success");
      return;
    case "overridden":
      toast(i18n.t("A higher-priority layer overrides this change; it is not in effect."), "info");
      return;
    case "cancelled":
      toast(i18n.t("The change was cancelled."), "info");
      return;
    case "unchanged":
      toast(i18n.t("No change needed: the toggle is already in that state."), "info");
      return;
  }
}

type MarketOperationState = Pick<
  MarketSlice,
  | "marketInstalling"
  | "marketUpdating"
  | "marketRemoving"
  | "marketUpdateAllQueue"
  | "marketUpdateAllPrefetching"
  | "marketPendingApproval"
  | "marketReleaseAgeConfirm"
>;

/**
 * The profile is a single pnpm workspace, so every write must share one gate.
 * Batch queue state is ignored only by the batch driver itself; user actions
 * must wait until the whole queued operation has settled. The gate spans both
 * surfaces: one operation at a time keeps every card's busy state unambiguous.
 */
function hasMarketOperation(
  state: MarketOperationState,
  options: { allowBatchQueue?: boolean; allowApproval?: boolean } = {},
): boolean {
  if (
    state.marketInstalling !== null ||
    state.marketUpdating !== null ||
    state.marketRemoving !== null ||
    state.marketUpdateAllPrefetching
  ) {
    return true;
  }
  if (!options.allowBatchQueue && state.marketUpdateAllQueue !== null) return true;
  if (!options.allowApproval && state.marketPendingApproval !== null) return true;
  return state.marketReleaseAgeConfirm !== null;
}

/// 更新/重装的安装标识拼装：可检上游是 GitHub 仓库时按 github:owner/repo
/// 重装——pnpm 重新解析默认分支 HEAD，即"更到远端最新"。上游仓库读已装记录的
/// upstreamRepo（Rust 侧统一归一：spec 的 GitHub 形态，或本地路径安装包自述的
/// repository），前端不重复推导；这类包多半不在 npm registry（或 registry 上
/// 只是占位），name@latest 要么 404 要么把 git 源覆盖成 registry 包。npm 形态
/// 维持原规则：latest 在 pnpm minimumReleaseAge 保护窗口内时钉版本（窗口内
/// @latest 会被静默拦回旧版、退出码仍为 0 造成假成功，钉版本是 pnpm 认的
/// 知情通道），否则 @latest。store 发起、卡片锚定 installError、批量预热共用
/// 此规则，三处不得漂移
export function updateSpecifierFor(
  name: string,
  installed: Pick<InstalledPlugin, "upstreamRepo"> | null | undefined,
  info: PluginUpdateInfo | null | undefined,
): string {
  if (installed?.upstreamRepo) return `github:${installed.upstreamRepo}`;
  return info?.updateAvailable && info.latestInReleaseAgeWindow && info.latestVersion
    ? `${name}@${info.latestVersion}`
    : `${name}@latest`;
}

/// 桌面档的更新标识：一律钉检测到的精确版本——桌面档拿不到安装 spec（只按包名查
/// registry），而 tag 与范围会被 pnpm 的发布冷却静默解析到旧版还报成功（ADR 0011）。
/// 没检出新版时没有可钉的版本，返回 null（卡片不出更新入口）
export function desktopUpdateSpecifierFor(name: string, info: PluginUpdateInfo | null | undefined): string | null {
  return info?.latestVersion ? `${name}@${info.latestVersion}` : null;
}

/// 批量更新收尾（唯一出口）：清中继态，汇总 toast（成功/部分失败），刷已装
/// 列表与更新检测。队列耗尽（含最后一项经 confirm/dismiss 弹空）时调用，保证
/// 无论从驱动、窗口确认、窗口放弃哪个路径收尾，结果一致、无残留中继态
function settleUpdateAll(
  set: StoreApi<AppStore>["setState"],
  get: StoreApi<AppStore>["getState"],
) {
  const ok = get().marketUpdateAllOk;
  const failed = get().marketUpdateAllFailed;
  const surfaces = get().marketUpdateAllQueueSurfaces ?? [];
  set({
    marketUpdateAllQueue: null,
    marketUpdateAllQueueSurfaces: null,
    marketUpdateAllOk: 0,
    marketUpdateAllFailed: 0,
    marketUpdateAllPrefetching: false,
  });
  if (failed === 0 && ok > 0) {
    get().toast(i18n.t("Updated {{count}} plugins", { count: ok }), "success");
  } else if (failed > 0) {
    get().toast(i18n.t("Updated {{ok}} plugins, {{failed}} failed", { ok, failed }), "error");
  }
  for (const surface of surfaces) refreshSurface(get, surface);
}

/// 一档的已装列表与更新检测一起重拉（操作落定后的收口）
function refreshSurface(get: StoreApi<AppStore>["getState"], surface: DshSurface, updates = true) {
  void get().refreshMarketInstalled(surface);
  if (updates) void get().refreshMarketUpdates(surface);
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

/// 回执背书的乐观收敛：装成 = 已到检测时的 latest，该档本包"有更新"即刻为假
/// （徽章与 Update 按钮随回执消失，不等后台 registry 重检）
function clearUpdateFlag(set: StoreApi<AppStore>["setState"], surface: DshSurface, name: string) {
  set((s) => {
    const updates = s.marketUpdates[surface];
    const info = updates?.[name];
    if (!updates || !info) return s;
    return { marketUpdates: { ...s.marketUpdates, [surface]: { ...updates, [name]: { ...info, updateAvailable: false } } } };
  });
}

export interface MarketSlice {
  marketCatalog: MarketCatalog | null;
  marketCatalogBusy: boolean;
  marketInstalled: InstalledPlugin[];
  marketInstalledBusy: boolean;
  // desktop 档的已装事实；null = 不可知（桥接未连接），绝不当成空列表——空列表会被读成「没装」。
  // 不可知的原因看 desktop 切片的桥接状态（全应用一份）
  marketDesktopInstalled: DesktopInstalledPlugin[] | null;
  marketInstalling: { surface: DshSurface; specifier: string } | null;
  // 安装过程明细：单飞安装的流式输出行（specifier 锚定发起卡片；安装/审批
  // 重跑/更新共用同一 market_install 通道，行由事件桥追加）。只有 web 档有流式输出：
  // 桌面档的安装在应用进程里跑，桥接只在结束时给结果
  marketInstallLog: { specifier: string; lines: string[] } | null;
  // 安装失败详情：卡片失败态持久展示（toast 转瞬即逝），重试/关闭时清除
  marketInstallError: { surface: DshSurface; specifier: string; message: string } | null;
  marketRemoving: MarketTarget | null;
  // pnpm 拦截构建脚本 → 挂起等用户审批；确认后才放行重装。web 档放行写 Launcher 自己
  // profile 的 pnpm-workspace.yaml（workspaceYaml），desktop 档由应用自己记录（为 null）。
  // remaining：「两档都装」时排在后面、尚未开始的形态——审批无论放行还是拒绝都接着装它们
  marketPendingApproval: {
    surface: DshSurface;
    specifier: string;
    label: string;
    packages: string[];
    workspaceYaml: string | null;
    operation: "install" | "update";
    silent: boolean;
    remaining: DshSurface[];
  } | null;
  // latest 落在 pnpm minimumReleaseAge 保护窗口 → 挂起等用户知情确认；
  // 确认后钉版本重装（见 updateSpecifierFor）。载荷携带版本过渡与发布时间，
  // 确认框据此展示"从哪升到哪、发布多久了"。只有 web 档有这道确认：桌面档一律钉版本
  marketReleaseAgeConfirm: {
    name: string;
    latestVersion: string;
    installedVersion: string | null;
    publishTime: string | null;
  } | null;
  // 每档的更新检测结果（name → info）；null = 尚未检测
  marketUpdates: Record<DshSurface, Record<string, PluginUpdateInfo> | null>;
  marketUpdatesBusy: Record<DshSurface, boolean>;
  // 正在更新的插件（单次或批量中的当前项），与安装 busy 分开计
  marketUpdating: MarketTarget | null;
  // 批量更新中继态：剩余待处理候选（含当前撞上窗口/审批而挂起的队首项）+ 已
  // 成功/失败累计。null = 无批量进行。窗口项/审批项遇之挂起，confirm/dismiss
  // 后 queue 弹项续传下一个——批量绝不因单个需要确认的项而中断抛弃后续
  marketUpdateAllQueue: MarketTarget[] | null;
  // 本次批量涉及的形态（收尾时据此重拉各档），与队列同生同灭
  marketUpdateAllQueueSurfaces: DshSurface[] | null;
  marketUpdateAllOk: number;
  marketUpdateAllFailed: number;
  // 批量更新预下载（store 预热）进行中：串行安装尚未开始、marketUpdating 仍为
  // null，用此标志禁用「Update all」按钮防二次点击；预热完成或批量收尾即清零
  marketUpdateAllPrefetching: boolean;
  // 收藏的目录条目 fullName（localStorage 事实来源的渲染镜像）
  marketFavorites: string[];
  // 发现页兼容性（G4）：npm 包名 → 事实。缺键 = 未查询或查询失败（前端按
  // 未知处理，不隐藏）；compatible 由 Rust 按宿主版本现算
  marketCompat: Record<string, DiscoveryCompat>;
  // 更新说明对话框挂起态（G5）：target 锚定待更新插件；notes 为 null 且不
  // busy = 探针未覆盖或查询失败（对话框内如实显示"暂无说明"）
  marketReleaseNotes: { target: MarketTarget; notes: PluginReleaseNotes | null; busy: boolean } | null;
  refreshMarketCatalog: (force?: boolean) => Promise<void>;
  refreshMarketInstalled: (surface: DshSurface) => Promise<void>;
  installMarketPlugin: (specifier: string, label: string, surfaces: DshSurface[]) => Promise<void>;
  approveMarketBuilds: () => Promise<void>;
  dismissMarketApproval: () => void;
  appendMarketInstallLog: (e: MarketInstallLogEvent) => void;
  dismissMarketInstallError: () => void;
  removeMarketPlugin: (target: MarketTarget) => Promise<void>;
  setMarketPluginEnabled: (target: MarketTarget, enabled: boolean) => Promise<void>;
  refreshMarketUpdates: (surface: DshSurface) => Promise<void>;
  updateMarketPlugin: (target: MarketTarget, opts?: { silent?: boolean; releaseAgePin?: string }) => Promise<boolean>;
  confirmMarketReleaseAge: () => Promise<void>;
  dismissMarketReleaseAge: () => void;
  updateAllMarketPlugins: () => Promise<void>;
  resumeMarketUpdateAll: () => Promise<void>;
  toggleMarketFavorite: (fullName: string) => void;
  fetchMarketCompat: (names: string[]) => Promise<void>;
  cancelMarketInstall: () => void;
  openMarketReleaseNotes: (target: MarketTarget) => Promise<void>;
  dismissMarketReleaseNotes: () => void;
  confirmMarketReleaseNotesUpdate: () => Promise<void>;
}

/// 一次安装开始时的状态：busy 挂上、web 档开一份流式明细（desktop 档没有流式输出）、
/// 清掉同一档的旧失败
function installStarted(
  get: StoreApi<AppStore>["getState"],
  surface: DshSurface,
  specifier: string,
): Partial<AppStore> {
  return {
    marketInstalling: { surface, specifier },
    marketInstallLog: surface === "web" ? { specifier, lines: [] } : null,
    marketInstallError: otherSurfaceError(get().marketInstallError, surface),
  };
}

/// 新一次安装开始时清掉的失败只是同一档的：「两档都装」里前一档的失败要留在它那一行，
/// 不能被后一档的开始顺手抹掉（各档各自报结果）
function otherSurfaceError(error: MarketSlice["marketInstallError"], surface: DshSurface): MarketSlice["marketInstallError"] {
  return error !== null && error.surface !== surface ? error : null;
}

/// 一档上的一次安装（安装、「两档都装」的逐档、审批后续装共用）。返回 true 表示挂起
/// 等审批——调用方据此停下，剩余形态随审批结果续装（见 marketPendingApproval.remaining）
async function installOn(
  set: StoreApi<AppStore>["setState"],
  get: StoreApi<AppStore>["getState"],
  surface: DshSurface,
  specifier: string,
  label: string,
  remaining: DshSurface[],
): Promise<boolean> {
  set(installStarted(get, surface, specifier));
  try {
    const outcome = await cmd.marketInstall(surface, specifier);
    if (outcome.status === "needsApproval") {
      set({
        marketInstalling: null,
        marketInstallLog: null,
        marketPendingApproval: {
          surface,
          specifier,
          label,
          packages: outcome.packages,
          workspaceYaml: outcome.workspaceYaml,
          operation: "install",
          silent: false,
          remaining,
        },
      });
      return true;
    }
    const installed = asInstalled(outcome);
    if (!installed) return false;
    notifyInstallOutcome(get().toast, installed, label, "installed", surface);
    set({ marketInstallLog: null });
    await get().refreshMarketInstalled(surface);
  } catch (e) {
    set({ marketInstallError: { surface, specifier, message: renderMessage(e) } });
    get().toast(i18n.t("Failed to install plugin: {{error}}", { error: tErr(e) }), "error");
  } finally {
    set({ marketInstalling: null });
  }
  return false;
}

/// 逐档安装，撞上审批即停（剩余形态挂在审批上，审批落定后由这里续装）
async function installSequence(
  set: StoreApi<AppStore>["setState"],
  get: StoreApi<AppStore>["getState"],
  surfaces: DshSurface[],
  specifier: string,
  label: string,
): Promise<void> {
  for (let i = 0; i < surfaces.length; i++) {
    if (await installOn(set, get, surfaces[i], specifier, label, surfaces.slice(i + 1))) return;
  }
}

export const createMarketSlice: Slice<MarketSlice> = (set, get) => ({
  marketCatalog: null,
  marketCatalogBusy: false,
  marketInstalled: [],
  marketInstalledBusy: false,
  marketDesktopInstalled: null,
  marketInstalling: null,
  marketInstallLog: null,
  marketInstallError: null,
  marketRemoving: null,
  marketPendingApproval: null,
  marketReleaseAgeConfirm: null,
  marketUpdates: { web: null, desktop: null },
  marketUpdatesBusy: { web: false, desktop: false },
  marketUpdating: null,
  marketUpdateAllQueue: null,
  marketUpdateAllQueueSurfaces: null,
  marketUpdateAllOk: 0,
  marketUpdateAllFailed: 0,
  marketUpdateAllPrefetching: false,
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
        get().toast(i18n.t("Failed to load plugin catalog: {{error}}", { error: tErr(e) }), "error");
      }
    } finally {
      set({ marketCatalogBusy: false });
    }
  },

  // 两档的已装事实来源不同（web 档读自己的 profile，desktop 档读桥接），失败的含义也不同：
  // web 档读不到是错误；desktop 档读不到是常态（应用没开或桥接没装），角标如实显示「未知」，
  // 原因去问一次桥接状态（读到了就说明它是连着的，不必问）
  refreshMarketInstalled: async (surface) => {
    if (surface === "desktop") {
      try {
        set({ marketDesktopInstalled: await cmd.marketDesktopInstalled() });
      } catch {
        set({ marketDesktopInstalled: null });
        await get().refreshDesktop();
      }
      return;
    }
    if (get().marketInstalledBusy) return;
    set({ marketInstalledBusy: true });
    try {
      set({ marketInstalled: await cmd.marketInstalled() });
    } catch (e) {
      get().toast(i18n.t("Failed to list installed plugins: {{error}}", { error: tErr(e) }), "error");
    } finally {
      set({ marketInstalledBusy: false });
    }
  },

  // 安装长操作（pnpm 下载依赖）：busy 挂在 (形态, specifier) 上，web 档过程明细由事件桥
  // 逐行追加到 marketInstallLog（卡片内实时展示）；成功后刷新该档已装列表并收起
  // 明细（回执 toast + 卡片转已装态）；失败把错误挂到 marketInstallError
  // （卡片失败态持久展示 + 日志留存），重试或关闭时清除。被 pnpm 拦截构建
  // 脚本时清 busy 挂起审批（对话框需要可交互），不当作失败。
  // 多档按顺序逐档装、各自报结果：一档失败不回滚、不阻止另一档（两档本就互不相干）
  installMarketPlugin: async (specifier, label, surfaces) => {
    if (surfaces.length === 0 || hasMarketOperation(get())) return;
    await installSequence(set, get, surfaces, specifier, label);
  },

  // 用户在审批对话框确认放行：web 档写 pnpm-workspace.yaml → 自动重跑安装；desktop 档
  // 带着放行名单再调一次应用的安装。失败保留挂起状态，用户可重试或取消；重跑输出同样
  // 经事件桥进卡片明细
  approveMarketBuilds: async () => {
    const pending = get().marketPendingApproval;
    if (!pending || hasMarketOperation(get(), { allowApproval: true, allowBatchQueue: true })) return;
    const { specifier, surface } = pending;
    set(installStarted(get, surface, specifier));
    try {
      const outcome = await cmd.marketInstall(surface, specifier, pending.packages);
      if (outcome.status === "needsApproval") {
        // 放行后重装又撞上新的被拦包（依赖的依赖）：再挂审批，不当作失败
        set({
          marketPendingApproval: { ...pending, packages: outcome.packages, workspaceYaml: outcome.workspaceYaml },
        });
        return;
      }
      const installed = asInstalled(outcome);
      if (!installed) return;
      notifyInstallOutcome(
        get().toast,
        installed,
        pending.label,
        pending.operation === "update" ? "updated" : "installed",
        surface,
        pending.silent,
      );
      set({ marketPendingApproval: null, marketInstallLog: null });
      if (pending.operation === "update" && installed.receipt) clearUpdateFlag(set, surface, installed.receipt.name);
      refreshSurface(get, surface, pending.operation === "update" && !pending.silent);
      // 批量更新中撞审批后放行成功：弹队首（本项已装好）续传下一个。
      // 单卡安装路径无 marketUpdateAllQueue，不入此分支
      if (pending.operation === "update" && get().marketUpdateAllQueue) {
        // finally runs after this branch; release the current install before
        // handing control back to the batch driver.
        set((s) => ({
          marketInstalling: null,
          marketUpdateAllQueue: s.marketUpdateAllQueue!.slice(1),
          marketUpdateAllOk: s.marketUpdateAllOk + 1,
        }));
        await get().resumeMarketUpdateAll();
      }
      if (pending.operation === "install" && pending.remaining.length > 0) {
        set({ marketInstalling: null });
        await installSequence(set, get, pending.remaining, specifier, pending.label);
      }
    } catch (e) {
      set({ marketInstallError: { surface, specifier, message: renderMessage(e) } });
      get().toast(
        i18n.t(
          pending.operation === "update"
            ? "Failed to update plugin: {{error}}"
            : "Failed to install plugin: {{error}}",
          { error: tErr(e) },
        ),
        "error",
      );
    } finally {
      set({ marketInstalling: null });
    }
  },

  // 用户拒绝放行：清挂起但保留已下载的半成品；批量更新则跳过当前队首并继续，
  // 与 release-age 取消保持同一“用户拒绝当前项，不锁死剩余队列”的语义。
  // 「两档都装」时拒绝的只是这一档，排在后面的形态照常续装
  dismissMarketApproval: () => {
    const pending = get().marketPendingApproval;
    if (!pending) return;
    const batchQueue = get().marketUpdateAllQueue;
    set({ marketPendingApproval: null });
    get().toast(
      pending.workspaceYaml !== null
        ? i18n.t('Build scripts not approved. Run "pnpm approve-builds" in {{path}} to allow them later.', {
            path: pending.workspaceYaml,
          })
        : i18n.t("Build scripts not approved. The plugin was not installed in DeepSeek Harness."),
      "info",
    );
    if (pending.operation === "update" && batchQueue) {
      set((s) => ({ marketUpdateAllQueue: s.marketUpdateAllQueue?.slice(1) ?? null }));
      void get().resumeMarketUpdateAll();
    }
    if (pending.operation === "install" && pending.remaining.length > 0) {
      void installSequence(set, get, pending.remaining, pending.specifier, pending.label);
    }
  },

  removeMarketPlugin: async (target) => {
    if (hasMarketOperation(get())) return;
    const { surface, name } = target;
    set({ marketRemoving: target });
    try {
      notifyChange(get().toast, await cmd.marketRemove(surface, name), {
        applied:
          surface === "web"
            ? i18n.t("Plugin removed: {{name}}", { name })
            : i18n.t("Plugin removed from DeepSeek Harness: {{name}}", { name }),
        restartRequired: i18n.t("Restart DeepSeek Harness to apply this change."),
      });
      refreshSurface(get, surface, false);
    } catch (e) {
      get().toast(i18n.t("Failed to remove plugin: {{error}}", { error: tErr(e) }), "error");
    } finally {
      set({ marketRemoving: null });
    }
  },

  // 启停开关。web 档写 profile patch 的 disabled 覆盖行，重启 dsh web 后生效（运行中的
  // dsh 不受影响，Rust 侧报 restart-required），重复启停免写盘报 unchanged；desktop 档由
  // 应用自己翻转，去向按应用回报的结果给
  setMarketPluginEnabled: async ({ surface, name }, enabled) => {
    if (hasMarketOperation(get())) return;
    try {
      const restartRequired =
        surface === "web"
          ? i18n.t(
              enabled
                ? "Plugin {{name}} will be enabled at the next dsh web start."
                : "Plugin {{name}} will be disabled at the next dsh web start.",
              { name },
            )
          : i18n.t("Restart DeepSeek Harness to apply this change.");
      notifyChange(get().toast, await cmd.marketSetPluginEnabled(surface, name, enabled), {
        applied: i18n.t(
          enabled ? "Plugin {{name}} enabled in DeepSeek Harness." : "Plugin {{name}} disabled in DeepSeek Harness.",
          { name },
        ),
        restartRequired,
      });
      await get().refreshMarketInstalled(surface);
    } catch (e) {
      get().toast(i18n.t("Failed to toggle plugin: {{error}}", { error: tErr(e) }), "error");
    }
  },

  // 更新检测（registry latest 比对）：进入市场页自动跑，已安装页可手动重跑。
  // 部分包检测失败不放大为整体失败（如实无 latest、不出更新按钮），
  // 全部可检包都失败才 toast（Rust 侧聚合的网络错误）
  // desktop 档桥接不可用时已装事实本就未知，检测失败静默留空（角标已说明原因）
  refreshMarketUpdates: async (surface) => {
    if (get().marketUpdatesBusy[surface]) return;
    const busy = (value: boolean) => set((s) => ({ marketUpdatesBusy: { ...s.marketUpdatesBusy, [surface]: value } }));
    busy(true);
    try {
      const infos = await cmd.marketCheckUpdates(surface);
      set((s) => ({
        marketUpdates: { ...s.marketUpdates, [surface]: Object.fromEntries(infos.map((i) => [i.name, i])) },
      }));
    } catch (e) {
      if (surface === "web" || get().marketDesktopInstalled !== null) {
        get().toast(i18n.t("Failed to check plugin updates: {{error}}", { error: tErr(e) }), "error");
      }
    } finally {
      busy(false);
    }
  },

  // 更新单个插件 = 重跑安装。web 档：npm 形态以 name@latest（latest 落在 pnpm
  // minimumReleaseAge 保护窗口内时 @latest 会被静默解析回旧版（退出码仍为 0
  // 的假成功）——挂起弹供应链确认框（marketReleaseAgeConfirm），用户知情确认
  // 后经 releaseAgePin 钉版本重装（pnpm 认的知情通道，自动写
  // minimumReleaseAgeExclude））；GitHub 仓库形态按原仓 github:owner/repo
  // 重装（pnpm 重新解析默认分支 HEAD，见 updateSpecifierFor）。desktop 档一律
  // 钉检测到的精确版本（见 desktopUpdateSpecifierFor），没有那道确认。与安装同一
  // 闸门、审计与审批路径（过程明细同通道进卡片）。silent 供批量更新跳过逐条成功/失败
  // toast；撞上 pnpm 构建脚本拦截时挂起审批对话框并提示（批量由调用方中止后续）。
  // 更新失败维持 toast，明细不驻留
  updateMarketPlugin: async (target, opts) => {
    const { surface, name } = target;
    const silent = opts?.silent ?? false;
    if (hasMarketOperation(get(), { allowBatchQueue: true })) return false;
    let specifier: string;
    if (surface === "web") {
      const info = get().marketUpdates.web?.[name];
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
      const installed = get().marketInstalled.find((p) => p.name === name) ?? null;
      specifier = opts?.releaseAgePin ? `${name}@${opts.releaseAgePin}` : updateSpecifierFor(name, installed, info);
    } else {
      const pinned = desktopUpdateSpecifierFor(name, get().marketUpdates.desktop?.[name]);
      if (pinned === null) return false;
      specifier = pinned;
    }
    set({ marketUpdating: target, marketInstallLog: surface === "web" ? { specifier, lines: [] } : null });
    try {
      const outcome = await cmd.marketInstall(surface, specifier);
      if (outcome.status === "needsApproval") {
        set({
          marketUpdating: null,
          marketInstallLog: null,
          marketPendingApproval: {
            surface,
            specifier,
            label: name,
            packages: outcome.packages,
            workspaceYaml: outcome.workspaceYaml,
            operation: "update",
            silent,
            remaining: [],
          },
        });
        get().toast(
          i18n.t("Paused: approve build scripts for {{plugin}}, then retry.", { plugin: name }),
          "info",
        );
        return false;
      }
      const installed = asInstalled(outcome);
      if (!installed) return false;
      notifyInstallOutcome(get().toast, installed, name, "updated", surface, silent);
      // installedVersion 的暂态失真可容忍：卡片版本号读已装列表（磁盘/桥接事实），
      // 后台重检落地后整体校正（registry 又出新版会翻回来）
      if (installed.receipt) clearUpdateFlag(set, surface, installed.receipt.name);
      refreshSurface(get, surface, !silent);
      return true;
    } catch (e) {
      if (!silent) get().toast(i18n.t("Failed to update plugin: {{error}}", { error: tErr(e) }), "error");
      return false;
    } finally {
      set({ marketUpdating: null, marketInstallLog: null });
    }
  },

  // 用户确认承担供应链窗口风险：清挂起，以挂起时捕获的版本钉版本重装。
  // 若处于批量更新中，完成当前项后从队列弹出并续传下一个（项目前保留在
  // 队首）：批量绝不因单个需要确认的窗口项而终止，装完继续下一个
  confirmMarketReleaseAge: async () => {
    const pending = get().marketReleaseAgeConfirm;
    if (!pending || get().marketUpdating) return;
    set({ marketReleaseAgeConfirm: null });
    const done = await get().updateMarketPlugin(
      { surface: "web", name: pending.name },
      { releaseAgePin: pending.latestVersion },
    );
    // 单卡路径（非批量）：不与批量队列交互
    if (!get().marketUpdateAllQueue) return;
    // 钉版本重装又撞构建脚本审批：队首保留，等 approve 续传
    if (get().marketPendingApproval) return;
    set((s) => ({
      marketUpdateAllQueue: s.marketUpdateAllQueue!.slice(1),
      marketUpdateAllOk: s.marketUpdateAllOk + (done ? 1 : 0),
      marketUpdateAllFailed: s.marketUpdateAllFailed + (done ? 0 : 1),
    }));
    await get().resumeMarketUpdateAll();
  },

  // 用户放弃窗口内更新：正常路径（@latest）等版本过了保护期自然可用，
  // 如实告知去向，不留半成品。批量进行中则跳过当前窗口项（弹队首）续传下一个
  dismissMarketReleaseAge: () => {
    if (!get().marketReleaseAgeConfirm) return;
    set({ marketReleaseAgeConfirm: null });
    get().toast(
      i18n.t("Update canceled. You can update normally once the version matures past the pnpm protection window."),
      "info",
    );
    if (!get().marketUpdateAllQueue) return;
    set((s) => ({ marketUpdateAllQueue: s.marketUpdateAllQueue!.slice(1) }));
    void get().resumeMarketUpdateAll();
  },

  // 一键全部更新：把两档所有可更新项（含窗口内插件）排队，逐个静默更新。顺序执行
  // （web 档共享同一 profile 目录，pnpm 并发安装会争锁；两档共用一道闸，卡片的 busy
  // 态才不含糊）。窗口项/构建脚本拦截项遇之挂起确认框，用户确认/放弃后由
  // resumeMarketUpdateAll 从队列续传——批量绝不因单个需要确认的项而中断抛弃后续
  // （"只更新一个"的根因）。
  // 串行安装前先并发预下载（store 预热）：web 档 npm 形态更新包经 marketPrefetch 拉
  // tarball 进内容寻址 store，随后 dsh plugin add 直接从 store 复用（零下载）；
  // GitHub 形态无 registry tarball，跳过预热照旧串行时下载；desktop 档的安装在应用里
  // 跑，预热不到它的 store。预下载只读 store 不写 profile，并发安全；失败容忍不中止，
  // 串行安装仍是唯一写盘路径
  updateAllMarketPlugins: async () => {
    // 兼容门禁判 false（目标要求更高 dsh 版本）的更新不进批量——单卡
    // Update 按钮已禁用，批量入口同样排除
    const updates = get().marketUpdates;
    const targets = (["web", "desktop"] as const).flatMap((surface) =>
      Object.values(updates[surface] ?? {})
        .filter((u) => u.updateAvailable && !u.managed && u.compatible !== false)
        .map((u): MarketTarget => ({ surface, name: u.name })),
    );
    if (targets.length === 0 || hasMarketOperation(get())) return;
    // 预下载候选：与后续安装同源生成 specifier（上游是 GitHub 仓库的形态
    // 生成 github:owner/repo），只有 npm 形态（githubRepoId(specifier) 为
    // null）才预热；窗口项生成 name@latestVersion 钉版本，同样可预热
    const npmSpecifiers = targets
      .filter((target) => target.surface === "web")
      .map(({ name }) => {
        const installed = get().marketInstalled.find((p) => p.name === name) ?? null;
        const info = get().marketUpdates.web?.[name] ?? null;
        return updateSpecifierFor(name, installed, info);
      })
      .filter((specifier) => !githubRepoId(specifier));
    if (npmSpecifiers.length > 0) {
      set({ marketUpdateAllPrefetching: true });
      try {
        await cmd.marketPrefetch(npmSpecifiers);
      } catch {
        // 预热失败容忍：串行安装仍会自行下载，不中止批量
      } finally {
        set({ marketUpdateAllPrefetching: false });
      }
    }
    set({
      marketUpdateAllQueue: targets,
      marketUpdateAllQueueSurfaces: [...new Set(targets.map((target) => target.surface))],
      marketUpdateAllOk: 0,
      marketUpdateAllFailed: 0,
    });
    await get().resumeMarketUpdateAll();
  },

  // 批量驱动（唯一执行点）：逐项处理队首。项成功/失败即弹出计数；撞上窗口或
  // 构建脚本审批则停留（挂起框已置位，队首保留）等用户表态后再续传；队空则
  // settleUpdateAll 收尾。递归为异步尾调用，不涨调用栈。串行 await 保证同一
  // profile 不并发争锁。审批挂起是硬交互（需用户放行任意代码），与窗口确认同
  // 样停留，避免在用户表态前盲目重装
  resumeMarketUpdateAll: async () => {
    if (get().marketUpdating) return;
    if (get().marketPendingApproval || get().marketReleaseAgeConfirm) return;
    if (hasMarketOperation(get(), { allowBatchQueue: true })) return;
    const queue = get().marketUpdateAllQueue;
    if (!queue) return;
    // 队列已空但仍持中继态（最后一项经 confirm/dismiss 弹空后触发）：收尾
    if (queue.length === 0) {
      settleUpdateAll(set, get);
      return;
    }
    const done = await get().updateMarketPlugin(queue[0], { silent: true });
    if (get().marketPendingApproval || get().marketReleaseAgeConfirm) return;
    const ok = get().marketUpdateAllOk + (done ? 1 : 0);
    const failed = get().marketUpdateAllFailed + (done ? 0 : 1);
    const rest = get().marketUpdateAllQueue!.slice(1);
    set({ marketUpdateAllQueue: rest, marketUpdateAllOk: ok, marketUpdateAllFailed: failed });
    await get().resumeMarketUpdateAll();
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
  // 前端不必预判。只对 web 档有效——桌面档的安装在应用进程里，本应用够不着
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

  // 更新说明打开（G5）：仓库标识优先读 web 档已装记录的上游事实（Rust 侧统一归一：
  // spec 的 GitHub 形态，或本地路径安装包自述的 repository），目录条目 url
  // 只作兜底——目录里没有的手动安装（file: 等）也有更新说明可看；桌面档没有 spec，
  // 只有目录这一途。说明是显示性增强，查询失败按"未覆盖"处理，不阻塞更新
  openMarketReleaseNotes: async (target) => {
    if (get().marketReleaseNotes?.busy) return;
    const { surface, name } = target;
    const installed = surface === "web" ? (get().marketInstalled.find((p) => p.name === name) ?? null) : null;
    // 目录名与落盘键大小写可能不一致（目录保留作者原样、npm 键常小写），
    // 仓库标识派生按不区分大小写匹配
    const url = get().marketCatalog?.plugins.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    )?.url;
    const repo = installed?.upstreamRepo ?? repoIdFromCatalogUrl(url);
    set({ marketReleaseNotes: { target, notes: null, busy: true } });
    try {
      const notes = repo ? await cmd.marketReleaseNotes(repo) : null;
      set({ marketReleaseNotes: { target, notes, busy: false } });
    } catch {
      set({ marketReleaseNotes: { target, notes: null, busy: false } });
    }
  },

  dismissMarketReleaseNotes: () => set({ marketReleaseNotes: null }),

  // 说明框内确认更新：关框走既有更新管线（web 档可能再弹供应链窗口确认框）
  confirmMarketReleaseNotesUpdate: async () => {
    const pending = get().marketReleaseNotes;
    if (!pending) return;
    set({ marketReleaseNotes: null });
    await get().updateMarketPlugin(pending.target);
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
