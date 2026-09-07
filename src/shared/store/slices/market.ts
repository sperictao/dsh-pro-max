// 插件市场切片：目录（stale-while-revalidate）、已装列表、安装/审批/移除、
// 更新检测与收藏。catalog 跨页保留：27MB 目录解析结果不随切页重拉

import { i18n } from "../../i18n";
import { tErr } from "../../i18n/error";
import * as cmd from "../../commands";
import type { StoreApi } from "zustand";
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
import { githubRepoId } from "../../lib/specifier";
import type { AppStore } from "../../store";

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

/// 更新/重装的安装标识拼装：GitHub 仓库形态（github:/git+https: 落盘形态，
/// githubRepoId 认全）按 github:owner/repo 重装——pnpm 重新解析默认分支
/// HEAD，即"更到远端最新"；这些包多半不在 npm registry（或 registry 上只是
/// 占位），name@latest 要么 404 要么把 git 源覆盖成 registry 包。npm 形态
/// 维持原规则：latest 在 pnpm minimumReleaseAge 保护窗口内时钉版本（窗口内
/// @latest 会被静默拦回旧版、退出码仍为 0 造成假成功，钉版本是 pnpm 认的
/// 知情通道），否则 @latest。store 发起与卡片锚定 installError 共用此规则，
/// 两侧不得漂移
export function updateSpecifierFor(
  name: string,
  spec: string | null | undefined,
  info: PluginUpdateInfo | null | undefined,
): string {
  const repo = githubRepoId(spec ?? "");
  if (repo) return `github:${repo}`;
  return info?.updateAvailable && info.latestInReleaseAgeWindow && info.latestVersion
    ? `${name}@${info.latestVersion}`
    : `${name}@latest`;
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
  set({
    marketUpdateAllQueue: null,
    marketUpdateAllOk: 0,
    marketUpdateAllFailed: 0,
    marketUpdateAllPrefetching: false,
  });
  if (failed === 0 && ok > 0) {
    get().toast(i18n.t("Updated {{count}} plugins", { count: ok }), "success");
  } else if (failed > 0) {
    get().toast(i18n.t("Updated {{ok}} plugins, {{failed}} failed", { ok, failed }), "error");
  }
  void get().refreshMarketInstalled();
  void get().refreshMarketUpdates();
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
  // 批量更新中继态：剩余待处理候选（含当前撞上窗口/审批而挂起的队首项）+ 已
  // 成功/失败累计。null = 无批量进行。窗口项/审批项遇之挂起，confirm/dismiss
  // 后 queue 弹项续传下一个——批量绝不因单个需要确认的项而中断抛弃后续
  marketUpdateAllQueue: string[] | null;
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
  resumeMarketUpdateAll: () => Promise<void>;
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
  marketUpdateAllQueue: null,
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
      // 批量更新中撞审批后放行成功：弹队首（本项已装好）续传下一个。
      // 单卡安装路径无 marketUpdateAllQueue，不入此分支
      if (get().marketUpdateAllQueue) {
        set((s) => ({ marketUpdateAllQueue: s.marketUpdateAllQueue!.slice(1), marketUpdateAllOk: s.marketUpdateAllOk + 1 }));
        await get().resumeMarketUpdateAll();
      }
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

  // 更新单个插件 = 重跑安装：npm 形态以 name@latest（latest 落在 pnpm
  // minimumReleaseAge 保护窗口内时 @latest 会被静默解析回旧版（退出码仍为 0
  // 的假成功）——挂起弹供应链确认框（marketReleaseAgeConfirm），用户知情确认
  // 后经 releaseAgePin 钉版本重装（pnpm 认的知情通道，自动写
  // minimumReleaseAgeExclude））；GitHub 仓库形态按原仓 github:owner/repo
  // 重装（pnpm 重新解析默认分支 HEAD，见 updateSpecifierFor）。与安装同一
  // dsh 闸门、审计与审批路径，落盘 spec 形态也与市场安装一致（过程明细同
  // 通道进卡片）。silent 供批量更新跳过逐条成功/失败 toast；撞上 pnpm 构建
  // 脚本拦截时挂起审批对话框并提示（批量由调用方中止后续）。更新失败维持
  // toast，明细不驻留
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
    const spec = get().marketInstalled.find((p) => p.name === name)?.spec ?? null;
    const specifier =
      opts?.releaseAgePin ? `${name}@${opts.releaseAgePin}` : updateSpecifierFor(name, spec, info);
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

  // 用户确认承担供应链窗口风险：清挂起，以挂起时捕获的版本钉版本重装。
  // 若处于批量更新中，完成当前项后从队列弹出并续传下一个（项目前保留在
  // 队首）：批量绝不因单个需要确认的窗口项而终止，装完继续下一个
  confirmMarketReleaseAge: async () => {
    const pending = get().marketReleaseAgeConfirm;
    if (!pending || get().marketUpdating) return;
    set({ marketReleaseAgeConfirm: null });
    const done = await get().updateMarketPlugin(pending.name, { releaseAgePin: pending.latestVersion });
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

  // 一键全部更新：把所有可更新项（含窗口内插件）排队，逐个静默更新。顺序执行
  // （共享同一 profile 目录，pnpm 并发安装会争锁）。窗口项/构建脚本拦截项遇之
  // 挂起确认框，用户确认/放弃后由 resumeMarketUpdateAll 从队列续传——批量绝不
  // 因单个需要确认的项而中断抛弃后续（"只更新一个"的根因）。
  // 串行安装前先并发预下载（store 预热）：npm 形态更新包经 marketPrefetch 拉
  // tarball 进内容寻址 store，随后 dsh plugin add 直接从 store 复用（零下载）；
  // GitHub 形态无 registry tarball，跳过预热照旧串行时下载。预下载只读 store
  // 不写 profile，并发安全；失败容忍不中止，串行安装仍是唯一写盘路径
  updateAllMarketPlugins: async () => {
    const targets = Object.values(get().marketUpdates ?? {})
      // 兼容门禁判 false（目标要求更高 dsh 版本）的更新不进批量——单卡
      // Update 按钮已禁用，批量入口同样排除
      .filter((u) => u.updateAvailable && !u.managed && u.compatible !== false)
      .map((u) => u.name);
    if (targets.length === 0 || get().marketUpdating || get().marketUpdateAllPrefetching) return;
    // 预下载候选：与后续安装同源生成 specifier，npm 形态（githubRepoId(spec)
    // 为 null）才预热；窗口项生成 name@latestVersion 钉版本，同样可预热
    const npmSpecifiers = targets
      .map((name) => {
        const spec = get().marketInstalled.find((p) => p.name === name)?.spec ?? null;
        const info = get().marketUpdates?.[name] ?? null;
        return updateSpecifierFor(name, spec, info);
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
    set({ marketUpdateAllQueue: targets, marketUpdateAllOk: 0, marketUpdateAllFailed: 0 });
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
    const queue = get().marketUpdateAllQueue;
    if (!queue) return;
    // 队列已空但仍持中继态（最后一项经 confirm/dismiss 弹空后触发）：收尾
    if (queue.length === 0) {
      settleUpdateAll(set, get);
      return;
    }
    const name = queue[0];
    const done = await get().updateMarketPlugin(name, { silent: true });
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
