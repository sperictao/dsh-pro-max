// 插件市场视图：二级导航拆"发现 / 收藏 / 已安装 / 诊断"四页，发现（目录浏览）
// 为默认页。安装走 dsh plugin --profile web add（长操作），风险确认内联在卡片
// 上完成；渲染崩溃由 MarketErrorBoundary 兜成恢复面板（G3）。

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import { updateSpecifierFor } from "@/shared/store/slices/market";
import * as cmd from "@/shared/commands";
import { tErr } from "@/shared/i18n/error";
import {
  BTN,
  BTN_DANGER,
  BTN_OUTLINE,
  BTN_PRIMARY,
  BTN_SM,
  INPUT,
  INPUT_MONO,
} from "@/shared/lib/ui";
import type {
  DiscoveryCompat,
  InstalledPlugin,
  MarketCatalog,
  MarketDiagnostics,
  MarketPlugin,
  PluginUpdateInfo,
} from "@/shared/types";
import { i18n } from "@/shared/i18n";
import { restartDshWeb } from "@/features/integration/dshActions";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { MarketErrorBoundary } from "./MarketErrorBoundary";

// 每批渲染条数（2700+ 条目录全量渲染会卡），滚动到底加载下一批
const PAGE_SIZE = 60;

/// npm 形态 specifier 的包名部分（已装匹配用）："@scope/pkg@1.0" → "@scope/pkg"。
/// 任何带协议前缀的形态（github:、npm:、file: 等）安装后的 dependencies 键无法
/// 预知，返回 null（不参与已装匹配）。Rust 侧 package_name_from_specifier 同一套
/// 语义，改一侧必须同步另一侧
export function packageNameFromSpecifier(specifier: string): string | null {
  // npm 包名不含 ':'，带即协议形态
  if (specifier.includes(":")) return null;
  let s = specifier;
  const scopeStart = s.startsWith("@") ? s.indexOf("/") : 0;
  const at = s.lastIndexOf("@");
  if (at > scopeStart) s = s.slice(0, at);
  return s || null;
}

/// specifier → 目录条目的 name。目录条目与安装 specifier 同源于目录
/// install 命令串的 ` add ` 后缀，命名规范稳定（owner/name、github:owner/repo、
/// npm 裸包名）：prefix 形态取最后一段（github:owner/repo → repo），npm 形态
/// 即包名。Rust 侧 specifier_to_catalog_name 同一套语义，改一侧必须同步另一侧
export function specifierToCatalogName(specifier: string): string {
  const i = specifier.lastIndexOf("/");
  const last = i >= 0 ? specifier.slice(i + 1) : specifier;
  return packageNameFromSpecifier(last) ?? last;
}

/// Rust 侧 valid_identifier 的前端镜像（自定义安装输入时快速反馈；Rust 闸门
/// 仍是唯一事实来源，这里拦不住的会在安装时报错兜底）：npm/pnpm 合法字符集
/// + 长度上限 + 无危险前缀/路径段
function validCustomSpecifier(s: string): boolean {
  return (
    !!s &&
    s.length <= 214 &&
    /^[A-Za-z0-9@/._#:-]+$/.test(s) &&
    !/^[-#:.\/]/.test(s) &&
    !s.includes("..")
  );
}

/// 用户输入的地址 → dsh plugin add 认的 specifier；归一不出受支持形态返回
/// null。受支持：npm 包（pkg、pkg@1.2.3、@scope/pkg@1.2.3、npm:pkg@1.2.3）
/// 与 GitHub 仓库（github:owner/repo[#ref]）；GitHub 粘贴形态（网页网址、
/// .git 后缀、/tree/<ref>、git@ SSH、裸 owner/repo——npm 包名不含裸 `/`，
/// 无歧义）一律归一为显式 github: 前缀，落盘 spec 与日志一眼可读。其余协议
/// （git+https、gitlab 等）不被 valid_identifier 白名单接受（无 `+`），
/// 如实拒绝，不假装支持
export function normalizeCustomSpecifier(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let candidate = raw;
  const ssh = raw.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  const url = raw.match(
    /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w./-]+))?\/?$/i,
  );
  const shorthand = raw.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (ssh) candidate = `github:${ssh[1]}/${ssh[2]}`;
  else if (url) candidate = `github:${url[1]}/${url[2]}${url[3] ? `#${url[3]}` : ""}`;
  else if (shorthand) candidate = `github:${shorthand[1]}/${shorthand[2]}`;
  if (!validCustomSpecifier(candidate)) return null;
  if (candidate.startsWith("github:")) {
    // owner/repo 结构必须完整（ref 可带斜杠，如 #refs/heads/main）
    return /^([\w.-]+)\/([\w.-]+)(?:#([\w./-]+))?$/.test(candidate.slice(7)) ? candidate : null;
  }
  if (candidate.startsWith("npm:")) return candidate.slice(4) ? candidate : null;
  // 其余带协议的形态不支持（白名单能过的只剩 npm 裸形态）
  return candidate.includes(":") ? null : candidate;
}

/// 协议形态安装的已装匹配：specifier 非 npm 形态时按"spec 的仓库标识是
/// specifier 前缀、边界在 # / / ? - 或结尾"（git+https://... 与
/// github:owner/repo 同属仓库族；- 覆盖 dsh-relay 这类连字符前缀兄弟的
/// 误撞）再要求目录名在 spec 中出现（specifier 与落盘键名不一致的唯一
/// 信号）双条件判定；命中数量唯一才采信，如实不落猜。命中为 0 或 ≥2 → null
export function protocolInstalledMatch(
  specifier: string,
  catalogName: string,
  installed: InstalledPlugin[],
): InstalledPlugin | null {
  const hits = installed.filter(
    (p) =>
      (p.spec === specifier ||
        (p.spec.startsWith(specifier) && ["#", "/", "?", "-"].includes(p.spec.charAt(specifier.length)))) &&
      p.spec.includes(catalogName),
  );
  return hits.length === 1 ? hits[0] : null;
}

/// 目录分类表的语言键：目录只供应 en/zh 两语，界面语言映射到其一
function catalogLocale(language: string): "en" | "zh" {
  return language.startsWith("zh") ? "zh" : "en";
}

/// 失败安装的修复上下文（纯函数，供测试）：自包含事实——目标、错误、命令
/// 输出，贴给任意 agent 即可着手排查。框架用稳定英文（与审计台账同一哲学：
/// 不随界面语言漂移），只含 specifier/错误/输出，不含环境等本机信息
export function repairContextText(specifier: string, message: string, lines: string[]): string {
  return [
    "Plugin install failed — repair context",
    `Target: ${specifier}`,
    `Error: ${message}`,
    "",
    "Command output:",
    ...(lines.length > 0 ? lines : ["(no output captured)"]),
  ].join("\n");
}

/// 复制修复上下文到剪贴板（失败卡与自定义安装对话框共用），反馈与 DshCard
/// 的复制出口同一形态（toast，成功 info / 失败 error）。日志行只在锚定同一
/// specifier 时并入（跨卡错位防御与 store 同一规则）
async function copyInstallContext(
  error: { specifier: string; message: string },
  log: { specifier: string; lines: string[] } | null,
  toast: (message: string, type?: "info" | "error" | "success") => void,
): Promise<void> {
  const lines = log?.specifier === error.specifier ? log.lines : [];
  try {
    await navigator.clipboard.writeText(repairContextText(error.specifier, error.message, lines));
    toast(i18n.t("Install details copied"), "info");
  } catch (e) {
    toast(i18n.t("Failed to copy: {{error}}", { error: String(e) }), "error");
  }
}

/// 终端/CLI 类插件启发式（G6，B 方 looksTerminal 同源思路）：名称与描述匹配
/// 终端形态词（中英双语），否定从句先剔除——"不是 TUI"不该命中。纯展示警示
/// 不拦截安装：是否运行终端类插件是用户决策，风险在确认弹层如实告知
export function looksTerminal(name: string, description: string | null): boolean {
  const text = `${name} ${description ?? ""}`
    // 否定从句剔除到句末标点：词级误伤（如"不错"）可接受——警示宁可漏报
    // 不可误报
    .replace(/(?:not|no|without|never|非|无|不)[^.!?。！？]*/gi, " ");
  return /\b(?:tui|cli|terminal|shell|command[- ]?line)\b|终端|命令行/i.test(text);
}

type MarketTab = "discover" | "favorites" | "installed" | "diagnostics";

const MARKET_TABS: { id: MarketTab; labelKey: string }[] = [
  { id: "discover", labelKey: "Discover" },
  { id: "favorites", labelKey: "Favorites" },
  { id: "installed", labelKey: "Installed" },
  { id: "diagnostics", labelKey: "Diagnostics" },
];

export function MarketView() {
  // 渲染崩溃兜底（G3）：边界只包市场域，恢复面板内重载不拖累整壳
  return (
    <MarketErrorBoundary>
      <MarketViewInner />
    </MarketErrorBoundary>
  );
}

function MarketViewInner() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<MarketTab>("discover");
  const refreshCatalog = useAppStore((s) => s.refreshMarketCatalog);
  const refreshInstalled = useAppStore((s) => s.refreshMarketInstalled);
  const refreshUpdates = useAppStore((s) => s.refreshMarketUpdates);

  // 两个 tab 的数据进入市场页时一次拉齐（更新检测是自动检测的一部分，
  // 挂载即跑，已安装页可手动重跑）；tab 间切换不重拉（数据驻留 store）
  useEffect(() => {
    void refreshCatalog();
    void refreshInstalled();
    void refreshUpdates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="flex min-h-0 flex-1 flex-col" id="market-view">
      <nav className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-1.5">
        {MARKET_TABS.map((item) => (
          <button
            key={item.id}
            className={`header-btn${tab === item.id ? " active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </nav>
      {tab === "discover" ? (
        <DiscoverPane />
      ) : tab === "favorites" ? (
        <FavoritesPane />
      ) : tab === "installed" ? (
        <InstalledPane />
      ) : (
        <DiagnosticsPane />
      )}
      <BuildApprovalDialog />
      <ReleaseAgeConfirmDialog />
      <UpdateNotesDialog />
    </main>
  );
}

/// 发现/收藏页共用的目录卡网格：两页的卡片能力完全一致——浏览 + 星标 + 安装，
/// 已装匹配卡只读呈现启停状态与安装事实（无更新/移除/启停入口，那些归已装页）。
/// 两页差异只在插件清单来源：发现页 = 筛选后的目录切片，收藏页 = 收藏 ∩ 目录
/// （收藏页条目必然在收藏清单里，favorited 表达式两页同源恒真）。已装匹配
/// 双路径：npm 形态按包名精确对表，协议形态按仓库标识唯一命中
function BrowseCardGrid({ plugins, catalog }: { plugins: MarketPlugin[]; catalog: MarketCatalog | null }) {
  const { i18n } = useTranslation();
  const locale = catalogLocale(i18n.language);
  const installed = useAppStore((s) => s.marketInstalled);
  const updates = useAppStore((s) => s.marketUpdates);
  const installPlugin = useAppStore((s) => s.installMarketPlugin);
  const installing = useAppStore((s) => s.marketInstalling);
  const installLog = useAppStore((s) => s.marketInstallLog);
  const installError = useAppStore((s) => s.marketInstallError);
  const favorites = useAppStore((s) => s.marketFavorites);
  const toggleFavorite = useAppStore((s) => s.toggleMarketFavorite);
  // 发现期兼容性（G4）与用户取消（G2）：两页共用同一份事实与同一取消通道
  const marketCompat = useAppStore((s) => s.marketCompat);
  const cancelInstall = useAppStore((s) => s.cancelMarketInstall);

  const installedByName = useMemo(() => new Map(installed.map((p) => [p.name, p])), [installed]);

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      {plugins.map((p) => {
        const spec = p.installSpecifier ?? null;
        const pkg = spec !== null ? packageNameFromSpecifier(spec) : null;
        const installedPlugin =
          pkg !== null
            ? (installedByName.get(pkg) ?? null)
            : spec !== null
              ? protocolInstalledMatch(spec, specifierToCatalogName(spec), installed)
              : null;
        return (
          <MarketCard
            key={p.fullName}
            plugin={p}
            installed={installedPlugin}
            info={installedPlugin ? (updates?.[installedPlugin.name] ?? null) : null}
            catalog={catalog}
            locale={locale}
            installing={installing}
            installLog={installLog}
            installError={installError}
            compat={pkg && marketCompat[pkg] ? marketCompat[pkg] : null}
            onCancelInstall={cancelInstall}
            favorited={favorites.includes(p.fullName)}
            onToggleFavorite={() => toggleFavorite(p.fullName)}
            onInstall={() => void installPlugin(p.installSpecifier!, p.name)}
          />
        );
      })}
    </div>
  );
}

/// 发现页：awesome-dsh-plugin 目录浏览（搜索/分类/排序 + 卡片网格）
function DiscoverPane() {
  const { t, i18n } = useTranslation();
  const locale = catalogLocale(i18n.language);
  const catalog = useAppStore((s) => s.marketCatalog);
  const catalogBusy = useAppStore((s) => s.marketCatalogBusy);
  const refreshCatalog = useAppStore((s) => s.refreshMarketCatalog);

  // 发现期兼容性（G4）：可见卡片的 npm 包名按需批量查询；"仅看兼容"过滤
  // 只隐藏确认不兼容的条目（未声明/未查询保持可见，避免误判）
  const marketCompat = useAppStore((s) => s.marketCompat);
  const fetchMarketCompat = useAppStore((s) => s.fetchMarketCompat);
  const [compatibleOnly, setCompatibleOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<"stars" | "name">("stars");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [customOpen, setCustomOpen] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const categories = useMemo(() => {
    if (!catalog) return [];
    const counts = new Map<string, number>();
    for (const p of catalog.plugins) {
      if (p.category) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [catalog]);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    const list = catalog.plugins.filter((p) => {
      if (category && p.category !== category) return false;
      if (compatibleOnly && p.installSpecifier) {
        const pkg = packageNameFromSpecifier(p.installSpecifier);
        if (pkg && marketCompat[pkg]?.compatible === false) return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.fullName.toLowerCase().includes(q) ||
        // 描述覆盖全部语言：中文界面也能搜到只有英文描述的插件，反之亦然
        (p.description !== null && Object.values(p.description).some((d) => d.toLowerCase().includes(q)))
      );
    });
    // stars null = 目录暂无数据，排已知数量的后面（不静默当 0）
    return sort === "stars"
      ? [...list].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
      : [...list].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [catalog, query, category, sort, compatibleOnly, marketCompat]);

  // 过滤条件变化后回到列表头部
  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [query, category, sort, compatibleOnly]);

  // 可见卡片的兼容性按需拉取（G4）：滚动/筛选导致可见集合变化时补查缺失项；
  // store 侧会话去重防失败项循环重拉
  const visibleNames = useMemo(
    () =>
      filtered
        .slice(0, visible)
        .map((p) => (p.installSpecifier ? packageNameFromSpecifier(p.installSpecifier) : null))
        .filter((x): x is string => x !== null),
    [filtered, visible],
  );
  useEffect(() => {
    const missing = visibleNames.filter((n) => !(n in marketCompat));
    if (missing.length > 0) void fetchMarketCompat(missing);
  }, [visibleNames, marketCompat, fetchMarketCompat]);

  // 滚动到底自动加载下一批
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible((v) => (v < filtered.length ? v + PAGE_SIZE : v));
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [filtered.length]);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t("Plugin Marketplace")}</h2>
          <p className="text-xs opacity-60">{t("Curated catalog by awesome-dsh-plugin.com.")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button className={BTN} id="btn-market-custom-install" onClick={() => setCustomOpen(true)}>
            {t("Custom install")}
          </button>
          <button
            className={BTN}
            id="btn-market-refresh"
            disabled={catalogBusy}
            onClick={() => void refreshCatalog(true)}
          >
            {catalogBusy ? t("Working…") : t("Refresh")}
          </button>
        </div>
      </div>
      {/* 快照数据（首屏直读或断网降级）如实标注来源与时点；刷新进行中不标注，
          等结果落定：成功则替换为在线目录，失败则横幅如实说明 */}
      {catalog?.fromSnapshot && !catalogBusy && (
        <p
          className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
          id="market-snapshot-banner"
        >
          {t("Network unavailable — showing the local catalog snapshot from {{time}}.", {
            time: catalog.updated ?? t("unknown time"),
          })}
        </p>
      )}

      {/* 筛选区两行制：分类按钮组一行；搜索框 + 排序按钮组（计数左侧）+ 计数徽章一行 */}
      <div className="mb-4 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <FilterBtn active={category === ""} onClick={() => setCategory("")}>
            {t("All Categories")}
          </FilterBtn>
          {categories.map(([c, n]) => (
            <FilterBtn key={c} active={category === c} onClick={() => setCategory(c)}>
              {`${catalog?.categories?.[c]?.[locale] ?? c} (${n})`}
            </FilterBtn>
          ))}
        </div>
        {/* 搜索框与排序组之间留大间隔（gap-3 + mr-6），计数紧随排序组（gap-3） */}
        <div className="flex items-center gap-3">
          <input
            className={`${INPUT} mr-6 flex-1`}
            placeholder={t("Search plugins…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            id="market-search"
          />
          <FilterBtn active={sort === "stars"} onClick={() => setSort("stars")}>
            {t("Most Stars")}
          </FilterBtn>
          <FilterBtn active={sort === "name"} onClick={() => setSort("name")}>
            {t("By Name")}
          </FilterBtn>
          <FilterBtn active={compatibleOnly} onClick={() => setCompatibleOnly((v) => !v)}>
            {t("Compatible only")}
          </FilterBtn>
          <span
            className="shrink-0 whitespace-nowrap rounded bg-muted px-3.5 py-1.5 text-sm font-medium tabular-nums text-muted-foreground"
            id="market-count"
          >
            {t("{{count}} plugins", { count: filtered.length })}
          </span>
        </div>
      </div>

      {!catalog && catalogBusy && <p className="text-sm opacity-60">{t("Loading catalog…")}</p>}
      {catalog && filtered.length === 0 && <p className="text-sm opacity-60">{t("No plugins match your filters.")}</p>}

      <BrowseCardGrid plugins={filtered.slice(0, visible)} catalog={catalog} />
      <div ref={sentinelRef} className="h-4" />
      {customOpen && <CustomInstallDialog onClose={() => setCustomOpen(false)} />}
      {visible < filtered.length && (
        <div className="mt-2 flex justify-center">
          <button className={BTN_SM} onClick={() => setVisible((v) => v + PAGE_SIZE)}>
            {t("Show more")}
          </button>
        </div>
      )}
    </div>
  );
}

/// 收藏页：收藏清单 × 目录条目按收藏顺序取交集（星标可就地取消，取消即从
/// 本页消失）。卡片网格与能力与发现页完全一致（BrowseCardGrid），差异只在
/// 插件清单来源。目录未拉到时不谎称"没有收藏"——只渲染交集，如实留白
function FavoritesPane() {
  const { t } = useTranslation();
  const catalog = useAppStore((s) => s.marketCatalog);
  const catalogBusy = useAppStore((s) => s.marketCatalogBusy);
  const favorites = useAppStore((s) => s.marketFavorites);

  const byFullName = useMemo(() => new Map((catalog?.plugins ?? []).map((p) => [p.fullName, p])), [catalog]);
  const plugins = useMemo(() => favorites.flatMap((f) => byFullName.get(f) ?? []), [favorites, byFullName]);

  return (
    <div className="flex-1 overflow-y-auto p-6" id="market-favorites">
      <div className="mb-4">
        <h2 className="text-base font-semibold">{t("Favorites")}</h2>
        <p className="text-xs opacity-60">{t("{{count}} plugins", { count: plugins.length })}</p>
      </div>

      {!catalog && catalogBusy && <p className="text-sm opacity-60">{t("Loading catalog…")}</p>}
      {catalog && plugins.length === 0 && (
        <p className="text-sm opacity-60">{t("No favorites yet. Star plugins on the Discover tab to pin them here.")}</p>
      )}

      <BrowseCardGrid plugins={plugins} catalog={catalog} />
    </div>
  );
}

/// 已安装页：与发现页同一卡片观感，npm 形态插件自动比对 registry latest，
/// 有更新出 Update 按钮，可一键全部更新；受管插件只读，其余可移除
function InstalledPane() {
  const { t, i18n } = useTranslation();
  const locale = catalogLocale(i18n.language);
  const catalog = useAppStore((s) => s.marketCatalog);
  const installed = useAppStore((s) => s.marketInstalled);
  const installedBusy = useAppStore((s) => s.marketInstalledBusy);
  const removing = useAppStore((s) => s.marketRemoving);
  const removePlugin = useAppStore((s) => s.removeMarketPlugin);
  const updates = useAppStore((s) => s.marketUpdates);
  const updatesBusy = useAppStore((s) => s.marketUpdatesBusy);
  const refreshUpdates = useAppStore((s) => s.refreshMarketUpdates);
  const updatePlugin = useAppStore((s) => s.updateMarketPlugin);
  const updateAll = useAppStore((s) => s.updateAllMarketPlugins);
  const setPluginEnabled = useAppStore((s) => s.setMarketPluginEnabled);
  // 重启 dsh web（启停生效的就近入口）：复用 Shell 域一键重启（busy 守卫、
  // 时间轴认领、托盘同步都在 dshActions），busy 镜像与 DshCard 同一套标志
  const dshStartBusy = useAppStore((s) => s.dshStartBusy);
  const dshStopBusy = useAppStore((s) => s.dshStopBusy);
  const dshRestartBusy = useAppStore((s) => s.dshRestartBusy);
  const dshRecheckBusy = useAppStore((s) => s.dshRecheckBusy);
  const updating = useAppStore((s) => s.marketUpdating);
  const installLog = useAppStore((s) => s.marketInstallLog);
  const installError = useAppStore((s) => s.marketInstallError);
  const favorites = useAppStore((s) => s.marketFavorites);
  const toggleFavorite = useAppStore((s) => s.toggleMarketFavorite);
  const cancelInstall = useAppStore((s) => s.cancelMarketInstall);
  const openNotes = useAppStore((s) => s.openMarketReleaseNotes);

  // 目录匹配表：给已装卡片补全描述/分类/星标/链接（目录没有的如实留白）
  const byName = useMemo(() => new Map((catalog?.plugins ?? []).map((p) => [p.name, p])), [catalog]);
  const pendingCount = useMemo(
    // 兼容门禁判 false 的更新不进批量计数（单卡按钮已禁用，批量入口同样排除）
    () => Object.values(updates ?? {}).filter((u) => u.updateAvailable && !u.managed && u.compatible !== false).length,
    [updates],
  );

  return (
    <div className="flex-1 overflow-y-auto p-6" id="market-installed">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t("Installed Plugins (web profile)")}</h2>
          <p className="text-xs opacity-60">{t("{{count}} plugins", { count: installed.length })}</p>
        </div>
        <div className="flex items-center gap-2">
          <button className={BTN_OUTLINE} disabled={updatesBusy} onClick={() => void refreshUpdates()} id="btn-updates-check">
            {updatesBusy ? t("Working…") : t("Check updates")}
          </button>
          {pendingCount > 0 && (
            <button
              className={BTN_PRIMARY}
              disabled={updating !== null || updatesBusy}
              onClick={() => void updateAll()}
              id="btn-updates-all"
            >
              {updating !== null ? t("Working…") : t("Update all ({{count}})", { count: pendingCount })}
            </button>
          )}
          {/* 启停/更新落盘后重启生效的就近入口；启停开关的「重启后生效」
              提示即指向这里。流程复用 Shell 域一键重启（先关后启 + 启动时间线） */}
          <button
            className={BTN_OUTLINE}
            disabled={dshStartBusy || dshStopBusy || dshRestartBusy || dshRecheckBusy}
            onClick={() => void restartDshWeb()}
            id="btn-market-restart-dsh"
          >
            {dshRestartBusy ? t("Restarting...") : t("Restart dsh web")}
          </button>
        </div>
      </div>

      {installedBusy && <p className="text-sm opacity-60">{t("Working…")}</p>}
      {!installedBusy && installed.length === 0 && <p className="text-sm opacity-60">{t("No plugins installed yet.")}</p>}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {installed.map((p) => {
          const catalogPlugin = byName.get(p.name) ?? null;
          return (
            <MarketCard
              key={p.name}
              plugin={catalogPlugin}
              installed={p}
              info={updates?.[p.name] ?? null}
              catalog={catalog}
              locale={locale}
              updating={updating}
              removing={removing}
              installLog={installLog}
              installError={installError}
              favorited={catalogPlugin !== null && favorites.includes(catalogPlugin.fullName)}
              onToggleFavorite={() => {
                if (catalogPlugin) toggleFavorite(catalogPlugin.fullName);
              }}
              onUpdate={() => void updatePlugin(p.name)}
              onNotes={() => void openNotes(p.name)}
              onCancelInstall={cancelInstall}
              onRemove={() => void removePlugin(p.name)}
              onSetEnabled={p.managed ? undefined : (enabled) => void setPluginEnabled(p.name, enabled)}
            />
          );
        })}
      </div>
    </div>
  );
}

/// 市场卡片：发现/收藏/已安装三页唯一实现。数据进、状态机出——目录条目
/// plugin 与落盘条目 installed 推导出唯一卡片状态；页面能力差异由回调决定，
/// 未接回调的操作不渲染：
///   发现/收藏（BrowseCardGrid 接线）——浏览 + 星标 + 安装；已装匹配卡只读
///   （启停状态以只读胶囊呈现，无更新/移除/启停开关）；
///   已安装（InstalledPane 接线）——更新/重装/移除/启停开关（重启入口在页头）。
/// 布局分区（三页一致）：右上角 = 安装事实胶囊（Installed/Not installed）+
/// 收藏星标；左下角 = 启停状态条（开关即状态，无开关入口回退只读胶囊）+
/// 版本 + 兼容门禁；右下角 = 该状态的操作按钮。目录缺位（已装但目录没有）
/// 时如实只展示落盘事实
type CardState =
  | "managed"
  | "removing"
  | "updating"
  | "outdated"
  | "installed"
  | "installing"
  | "installFailed"
  | "manual"
  | "confirm"
  | "idle";

/// 描述按界面语言取，无对应翻译时回退英文、再回退第一条（唯一一份）
function localizedDescription(
  d: NonNullable<MarketPlugin["description"]>,
  locale: "en" | "zh",
): string {
  return d[locale] ?? d.en ?? Object.values(d)[0] ?? "";
}

/// 筛选按钮组单元：选中实底主色、未选描边——结构对比在 42 主题族下稳健
function FilterBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={active ? BTN_PRIMARY : BTN_OUTLINE} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

/// 状态胶囊（圆点 + 词）：安装事实（卡片右上角）与启停状态（状态条）共用
/// 同一视觉语言——绿点主色底 / 灰点灰底
function StateBadge({ tone, label }: { tone: "ok" | "muted"; label: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium ${
        tone === "ok" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${tone === "ok" ? "bg-emerald-500" : "bg-muted-foreground"}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

function MarketCard({
  plugin,
  installed,
  info = null,
  catalog = null,
  locale,
  installing = null,
  updating = null,
  removing = null,
  installLog = null,
  installError = null,
  compat = null,
  favorited,
  onToggleFavorite,
  onInstall,
  onUpdate,
  onNotes,
  onCancelInstall,
  onRemove,
  onSetEnabled,
}: {
  /** 目录条目；已装但目录没有（如 file: 手动装）为 null */
  plugin: MarketPlugin | null;
  /** 落盘条目；未安装为 null */
  installed: InstalledPlugin | null;
  /** 更新检测结果（按已装 name 键），未检测为 null */
  info?: PluginUpdateInfo | null;
  catalog?: MarketCatalog | null;
  locale: "en" | "zh";
  installing?: string | null;
  updating?: string | null;
  removing?: string | null;
  /** 单飞安装的流式输出（安装中/更新中/失败明细共用） */
  installLog?: { specifier: string; lines: string[] } | null;
  /** 最近一次安装失败（specifier 锚定卡片；重试/关闭时清除） */
  installError?: { specifier: string; message: string } | null;
  /** 发现期兼容性事实（G4，npm 包名键）：确认不兼容时红字明示要求 */
  compat?: DiscoveryCompat | null;
  favorited: boolean;
  onToggleFavorite: () => void;
  onInstall?: () => void;
  /** 重装（无更新态）：以 name@latest 重跑安装，latest 在 pnpm
      minimumReleaseAge 窗口内时先弹供应链确认框、确认后钉版本（见
      updateSpecifierFor）；同一命令通道。已装页必传，发现/收藏页不传
      （永不渲染对应分支） */
  onUpdate?: () => void;
  /** 更新（有更新态）：先弹更新说明对话框（G5），确认后走既有更新管线。
      缺省时 Update 回退 onUpdate（不弹说明） */
  onNotes?: () => void;
  /** 取消当前安装/更新（G2）：后端置位取消令牌杀子进程，幂等。已装/
      更新中的长操作按钮旁渲染 */
  onCancelInstall?: () => void;
  onRemove?: () => void;
  /** 翻转下次启动启用状态（disabled 覆盖行，重启生效）。已装页对非受管
      插件传入；受管插件由修复流程管理，不出开关 */
  onSetEnabled?: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const dismissMarketInstallError = useAppStore((s) => s.dismissMarketInstallError);
  const toast = useAppStore((s) => s.toast);
  const name = plugin?.name ?? installed?.name ?? "";
  const url = plugin?.url ?? null;
  const description = plugin?.description ? localizedDescription(plugin.description, locale) : null;
  // 版本号读已装列表的磁盘事实（installed.version），更新成功后随
  // refreshMarketInstalled 即时正确；info（registry 比对）只负责更新判定，
  // 不再是版本号的来源
  const current = installed?.version ?? null;
  const latest = info?.latestVersion ?? null;
  // 卡片的安装身份：未装卡片是目录安装标识；已装卡片是更新重装标识
  // （与 updateMarketPlugin 共用 updateSpecifierFor——specifier 是
  // installError/installLog 锚回本卡的键，两处必须一致）
  const ownSpecifier = installed ? updateSpecifierFor(installed.name, info) : (plugin?.installSpecifier ?? null);

  // 状态推导（自上而下首个命中）：受管 > 移除中 > 更新中 > 安装失败 > 已装
  // （比对更新）> 安装中 > 仅手动 > 确认中 > 可装。失败优先于已装/未装：
  // 错误是最新事实，且失败=未落盘，已装页不会有无主失败卡
  let state: CardState;
  if (installed?.managed) state = "managed";
  else if (removing !== null && installed?.name === removing) state = "removing";
  else if (updating !== null && installed?.name === updating) state = "updating";
  else if (installError !== null && installError.specifier === ownSpecifier) state = "installFailed";
  else if (installed) state = info?.updateAvailable ? "outdated" : "installed";
  else if (installing !== null && plugin?.installSpecifier === installing) state = "installing";
  else if (!plugin?.installSpecifier) state = "manual";
  else if (confirming) state = "confirm";
  else state = "idle";

  const outdated = state === "outdated";
  // 分类用目录本地化名（与筛选下拉同一事实），目录没有该分类时如实透传原 key
  const categoryLabel = plugin?.category
    ? (catalog?.categories?.[plugin.category]?.[locale] ?? plugin.category)
    : null;
  // meta 行尾部：装前关心谁家的仓库（owner），装后关心落盘 spec
  const metaTail = installed ? installed.spec : (plugin?.fullName.split("/")[0] ?? null);
  // 终端/CLI 类插件警示（G6）：确认态如实告知风险，不拦截安装
  const terminalWarning = plugin !== null && looksTerminal(name, description);

  const removeBtn = onRemove && (
    <button
      className={BTN_DANGER}
      disabled={state === "removing" || updating !== null}
      onClick={onRemove}
      aria-label={`${t("Remove")} ${name}`}
    >
      {state === "removing" ? t("Removing…") : t("Remove")}
    </button>
  );

  // 启停开关（带状态文字的胶囊开关 text-switch，样式同 codex-pro-max
  // 配置看守参数行）：写入是本地文件操作（瞬时，无 busy 态；重复点击幂等——
  // 判定核内容未变化即免写盘）。移除中禁用——翻转启停与移除后的孤儿行
  // 清理写同一 patch 文件，二者并发会互相覆盖。开关置于状态条左下角、
  // 胶囊文字即启停状态（Enabled/Disabled）；安装/更新/移除等操作在右下
  // 角操作区
  const toggleEnabledBtn = onSetEnabled && installed && !installed.managed && (
    <input
      type="checkbox"
      className="text-switch"
      role="switch"
      data-state-text={installed.enabled ? t("Enabled") : t("Disabled")}
      checked={installed.enabled}
      disabled={state === "removing"}
      onChange={() => onSetEnabled(!installed.enabled)}
      aria-checked={installed.enabled}
      aria-label={`${installed.enabled ? t("Disable") : t("Enable")} ${name}`}
      title={t("Takes effect after dsh web restarts.")}
    />
  );

  const statusLeft: ReactNode =
    state === "managed" ? (
      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] opacity-50">{t("managed by launcher")}</span>
    ) : state === "manual" ? (
      <span className="text-xs opacity-50">{t("Manual install only")}</span>
    ) : state === "confirm" ? (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs opacity-70">{t("Install this plugin?")}</span>
        {terminalWarning && (
          <span className="text-[11px] text-amber-700 dark:text-amber-400">
            {t("Looks like a terminal/CLI plugin — it will run shell commands in your environment.")}
          </span>
        )}
      </span>
    ) : state === "installing" ? (
      <span className="text-xs">{t("Installing…")}</span>
    ) : state === "installFailed" ? (
      <span
        className="min-w-0 flex-1 truncate text-xs text-red-600 dark:text-red-400"
        title={installError?.message}
      >
        {t("Install failed: {{error}}", { error: installError?.message ?? "" })}
      </span>
    ) : installed ? (
      // 左下角启停状态条：有开关入口（已安装页）时开关即状态呈现；发现/
      // 收藏页的已装匹配卡无开关入口，回退只读状态胶囊。安装事实胶囊在
      // 右上角。更新目标声明了更高 dsh 最低版本（engines.dsh 门禁判 false）
      // 时红字明示要求，更新按钮同时禁用
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        {toggleEnabledBtn ?? (
          <StateBadge tone={installed.enabled ? "ok" : "muted"} label={t(installed.enabled ? "Enabled" : "Disabled")} />
        )}
        {current && (
          <span className="font-mono">
            v{current}
            {outdated && <span className="ml-1 text-emerald-600 dark:text-emerald-400">→ v{latest}</span>}
          </span>
        )}
        {outdated && info?.compatible === false && info?.requiresDsh && (
          <span className="shrink-0 text-red-600 dark:text-red-400">
            {t("dsh {{version}} required", { version: info.requiresDsh })}
          </span>
        )}
      </span>
    ) : compat?.compatible === false && compat.requiresDsh ? (
      // 发现期兼容门禁（G4）：目录卡片在安装前就明示 dsh 版本要求（安装/更新
      // 期的 fail-closed 门禁另有判定，这里只是把"点了才发现"提前）
      <span className="shrink-0 text-xs text-red-600 dark:text-red-400">
        {t("dsh {{version}} required", { version: compat.requiresDsh })}
      </span>
    ) : null;

  const actions: ReactNode =
    state === "idle" ? (
      <button className={BTN_PRIMARY} onClick={() => setConfirming(true)}>
        {t("Install")}
      </button>
    ) : state === "confirm" ? (
      <>
        <button
          className={BTN_PRIMARY}
          disabled={installing !== null}
          onClick={() => {
            setConfirming(false);
            onInstall?.();
          }}
        >
          {installing !== null ? t("Working…") : t("Confirm")}
        </button>
        <button className={BTN_SM} onClick={() => setConfirming(false)}>
          {t("Cancel")}
        </button>
      </>
    ) : state === "installing" ? (
      <>
        <button className={BTN_PRIMARY} disabled>
          {t("Installing…")}
        </button>
        {/* 用户取消（G2）：后端置位取消令牌杀子进程，取消走失败路径（幂等） */}
        {onCancelInstall && (
          <button className={BTN_SM} onClick={onCancelInstall}>
            {t("Cancel")}
          </button>
        )}
      </>
    ) : state === "installFailed" ? (
      <>
        <button className={BTN_PRIMARY} onClick={onInstall ?? onUpdate}>
          {t("Retry")}
        </button>
        {/* 复制修复上下文：把目标/错误/输出组装成自包含文本贴给任意 agent；
            状态机保证此分支 installError 非空，守卫只为类型收窄 */}
        <button
          className={BTN_SM}
          onClick={() => installError && void copyInstallContext(installError, installLog, toast)}
        >
          {t("Copy error")}
        </button>
        <button className={BTN_SM} onClick={dismissMarketInstallError}>
          {t("Dismiss")}
        </button>
      </>
    ) : state === "manual" ? (
      url && (
        <button
          className={BTN_SM}
          onClick={() => void openUrl(url).catch(() => {})}
          aria-label={`${t("README ↗")} ${name}`}
        >
          {t("README ↗")}
        </button>
      )
    ) : outdated || state === "updating" ? (
      <>
        {(onNotes ?? onUpdate) && (
          <button
            className={BTN_PRIMARY}
            disabled={updating !== null || info?.compatible === false}
            onClick={onNotes ?? onUpdate}
            aria-label={`${t("Update")} ${name}`}
            title={
              info?.compatible === false && info?.requiresDsh
                ? t("Requires dsh {{version}} or newer.", { version: info.requiresDsh })
                : undefined
            }
          >
            {state === "updating" ? t("Working…") : t("Update")}
          </button>
        )}
        {/* 更新中的用户取消（G2）：与安装共用同一取消通道 */}
        {state === "updating" && onCancelInstall && (
          <button className={BTN_SM} onClick={onCancelInstall}>
            {t("Cancel")}
          </button>
        )}
        {removeBtn}
      </>
    ) : state === "removing" ? (
      <>
        {removeBtn}
        {/* 移除中的用户取消（G2）：与安装/更新共用同一取消通道 */}
        {onCancelInstall && (
          <button className={BTN_SM} onClick={onCancelInstall}>
            {t("Cancel")}
          </button>
        )}
      </>
    ) : state === "installed" ? (
      <>
        {current && latest !== null && <span className="text-xs opacity-50">{t("Up to date")}</span>}
        {/* 无更新时提供重装：与 Update 同一回调（onUpdate = name@latest 重跑安装），
            覆盖终端手动 add 被拦构建脚本留下的半成品（依赖已写入但构建未跑）；
            与 Update 所在 outdated 分支互斥，永不共存 */}
        {state === "installed" && onUpdate && (
          <button
            className={BTN_OUTLINE}
            disabled={updating !== null}
            onClick={onUpdate}
            aria-label={`${t("Reinstall")} ${name}`}
          >
            {t("Reinstall")}
          </button>
        )}
        {removeBtn}
      </>
    ) : null;

  // meta 行：本地化分类 · owner/落盘spec · ★计数，缺位的部分不占位
  const metaParts: ReactNode[] = [];
  if (categoryLabel) metaParts.push(<span key="cat">{categoryLabel}</span>);
  if (metaTail) metaParts.push(<span key="tail" className={installed ? "font-mono" : undefined}>{metaTail}</span>);
  if (plugin?.stars != null) metaParts.push(<span key="stars">★ {plugin.stars.toLocaleString()}</span>);

  return (
    // group 供收藏星标悬浮显隐；已装卡以 emerald 描边与未装区分
    <article
      className={`group flex flex-col gap-1.5 rounded-lg border p-4 ${
        installed ? "border-emerald-500/30 dark:border-emerald-500/40" : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {url ? (
            <button
              className="cursor-pointer truncate text-sm font-semibold hover:underline"
              onClick={() => void openUrl(url).catch(() => {})}
              title={url}
            >
              {name}
            </button>
          ) : (
            <span className="truncate text-sm font-semibold">{name}</span>
          )}
          {plugin?.deprecated && (
            <span className="shrink-0 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-600 dark:text-red-400">
              {t("Deprecated")}
            </span>
          )}
        </div>
        {/* 右上角：收藏星标 + 安装事实胶囊（绿 Installed / 灰 Not installed，
            与状态条的启停状态分家）。星标未悬浮时藏起，胶囊恒显；
            内层 span 以 favorited 为 key，切换时重挂载重播 pop 动画，按钮本体
            不重挂载、焦点保留。纯落盘卡片（目录缺位）无星标 */}
        <div className="flex shrink-0 items-center gap-1.5">
          {plugin && (
            <button
              type="button"
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                favorited ? "text-amber-500" : "text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              }`}
              onClick={onToggleFavorite}
              aria-pressed={favorited}
              aria-label={`${favorited ? t("Remove from favorites") : t("Add to favorites")} ${name}`}
              title={favorited ? t("Remove from favorites") : t("Add to favorites")}
            >
              <span key={favorited ? "on" : "off"} className="star-pop flex">
                <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                  <path
                    d="M12 2.5l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.05 1.1-6.5-4.7-4.6 6.5-.95z"
                    fill={favorited ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </button>
          )}
          {installed ? <StateBadge tone="ok" label={t("Installed")} /> : <StateBadge tone="muted" label={t("Not installed")} />}
        </div>
      </div>
      {metaParts.length > 0 && (
        <p className="truncate text-xs opacity-60">
          {metaParts.map((node, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="mx-1.5">·</span>}
              {node}
            </Fragment>
          ))}
        </p>
      )}
      {(description || (plugin?.deprecated && plugin.replacement)) && (
        <div className="flex flex-col gap-0.5">
          {description && <p className="line-clamp-2 text-xs opacity-70">{description}</p>}
          {plugin?.deprecated && plugin.replacement && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t("Deprecated — consider {{replacement}} instead.", { replacement: plugin.replacement })}
            </p>
          )}
        </div>
      )}
      {/* 安装过程明细：安装中/更新中实时流式输出；失败留存供排查（重试/关闭清除）。
          状态推导已保证此区间只会命中发起操作的那张卡 */}
      {(state === "installing" || state === "updating" || state === "installFailed") && installLog && (
        <InstallLogView log={installLog} failed={state === "installFailed"} />
      )}
      {/* 状态条：mt-auto + 上边线，grid 拉伸行内所有卡片状态条底对齐。
          操作区用 ml-auto 而非容器 justify-between：未装卡的状态条左侧为空
          （安装事实胶囊在右上角），justify-between 会让仅剩的操作区落到
          左端——安装按钮必须恒在右下角 */}
      <div className="mt-auto flex items-center gap-2 border-t border-border pt-2.5">
        {statusLeft}
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </div>
    </article>
  );
}

/// 卡内安装明细区：首行是执行的命令（Rust 侧与实际 argv 同一拼装推来），
/// 其余为 dsh/pnpm 输出；新行到达贴底滚动，限高防长输出撑爆卡片
function InstallLogView({ log, failed }: { log: { specifier: string; lines: string[] }; failed: boolean }) {
  const boxRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.lines.length]);
  const [first, ...rest] = log.lines;
  return (
    <div
      className={`rounded border px-2.5 py-2 ${failed ? "border-red-500/40 bg-red-500/5" : "border-border bg-muted/40"}`}
      aria-busy={!failed}
    >
      <p className="truncate font-mono text-[11px] opacity-60">
        {first ?? `\$ dsh plugin --profile web add ${log.specifier}`}
      </p>
      <pre
        ref={boxRef}
        aria-live="polite"
        className="install-log max-h-28 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed"
      >
        {rest.length > 0 ? rest.join("\n") : failed ? "" : "…"}
      </pre>
    </div>
  );
}

/// 构建脚本审批对话框：pnpm 10+ 默认拦截第三方安装脚本，放行即允许其以
/// 当前用户身份执行任意代码——这是用户决策点，launcher 不静默代劳。焦点
/// 默认取消（安全默认），Esc 等价取消；放行重试期间（busy，失败保留挂起
/// 可重试）禁撤。取消的去向（依赖已下载、脚本未跑、可后补放行）在框内
/// 预告知，具体命令与路径由取消后的 toast 给出
function BuildApprovalDialog() {
  const { t } = useTranslation();
  const pending = useAppStore((s) => s.marketPendingApproval);
  const installing = useAppStore((s) => s.marketInstalling);
  const approve = useAppStore((s) => s.approveMarketBuilds);
  const dismiss = useAppStore((s) => s.dismissMarketApproval);
  if (!pending) return null;
  const busy = installing === pending.specifier;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      id="build-approval-dialog"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) dismiss();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-lg" aria-busy={busy}>
        <h3 className="text-sm font-semibold">{t("Allow build scripts?")}</h3>
        <p className="mt-2 text-xs opacity-70">
          {t("{{plugin}} needs to run install scripts from these dependencies:", { plugin: pending.label })}
        </p>
        <ul className="mt-2 rounded bg-muted px-3 py-2 font-mono text-xs">
          {pending.packages.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
          {t(
            "Install scripts run arbitrary code as your user. pnpm blocks them by default; approving writes your choice to {{path}} and retries the install.",
            { path: pending.workspaceYaml },
          )}
        </p>
        <p className="mt-2 text-xs opacity-50">
          {t("If you cancel, no scripts run — the packages stay downloaded and you can approve them later.")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button className={BTN_OUTLINE} disabled={busy} onClick={dismiss} id="build-approval-cancel" autoFocus>
            {t("Keep scripts blocked")}
          </button>
          <button className={BTN_PRIMARY} disabled={busy} onClick={() => void approve()} id="build-approval-approve">
            {busy ? t("Working…") : t("Approve & install")}
          </button>
        </div>
      </div>
    </div>
  );
}

/// 发布时间 → 本地化时长标签（"5 小时前"），供应链确认框展示发布新鲜度用。
/// 时间缺失/不可解析/时钟偏移为负/不足 1 小时返回 null——调用方回退"刚发布"
/// 文案（窗口以小时计，更细粒度对"等还是装"的决策没有信息量）
function publishAgeLabel(publishTime: string | null, t: ReturnType<typeof useTranslation>["t"]): string | null {
  if (!publishTime) return null;
  const ms = Date.now() - Date.parse(publishTime);
  const HOUR_MS = 60 * 60 * 1000;
  if (!Number.isFinite(ms) || ms < HOUR_MS) return null;
  const hours = Math.floor(ms / HOUR_MS);
  if (hours === 1) return t("an hour ago");
  if (hours < 24) return t("{{n}} hours ago", { n: hours });
  const days = Math.floor(hours / 24);
  return days === 1 ? t("a day ago") : t("{{n}} days ago", { n: days });
}

/// 供应链窗口确认对话框：latest 落在 pnpm 11 minimumReleaseAge 保护窗口
/// （内置默认 24h）时，@latest 会被静默拦回旧版造成假成功。钉版本是 pnpm
/// 认的知情意图通道（自动写入 minimumReleaseAgeExclude）——是否抢跑新版
/// 是用户决策点，launcher 不静默代劳。版本过渡与发布时长帮助决策；焦点
/// 落在取消（安全默认），Esc 等价取消
function ReleaseAgeConfirmDialog() {
  const { t } = useTranslation();
  const pending = useAppStore((s) => s.marketReleaseAgeConfirm);
  const updating = useAppStore((s) => s.marketUpdating);
  const confirm = useAppStore((s) => s.confirmMarketReleaseAge);
  const dismiss = useAppStore((s) => s.dismissMarketReleaseAge);
  if (!pending) return null;
  const busy = updating === pending.name;
  const age = publishAgeLabel(pending.publishTime, t);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      id="release-age-dialog"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) dismiss();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-lg">
        <h3 className="text-sm font-semibold">{t("Install a freshly published version?")}</h3>
        <div className="mt-2 rounded bg-muted px-3 py-2 font-mono text-xs">
          {pending.installedVersion ? (
            <>
              {pending.installedVersion} <span className="opacity-50">→</span> {pending.latestVersion}
            </>
          ) : (
            pending.latestVersion
          )}
        </div>
        <p className="mt-3 text-xs opacity-70">
          {age
            ? t("{{plugin}} was published {{age}} and is still inside pnpm's supply-chain protection window.", {
                plugin: pending.name,
                age,
              })
            : t("{{plugin}} was published very recently and is still inside pnpm's supply-chain protection window.", {
                plugin: pending.name,
              })}
        </p>
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
          {t(
            "A normal update would be silently held back by pnpm and stay on the current version. Updating anyway pins this exact version, and pnpm records the exception in minimumReleaseAgeExclude.",
          )}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button className={BTN_OUTLINE} disabled={busy} onClick={dismiss} id="release-age-cancel" autoFocus>
            {t("Keep current version")}
          </button>
          <button className={BTN_PRIMARY} disabled={busy} onClick={() => void confirm()} id="release-age-confirm">
            {busy ? t("Working…") : t("Update anyway")}
          </button>
        </div>
      </div>
    </div>
  );
}

/// 自定义安装对话框：目录之外的长尾来源（npm 包 / GitHub 仓库）复用目录安装
/// 同一闸门、审计、构建脚本审批与流式日志管线（installMarketPlugin 全局单飞，
/// z-40 让审批对话框与 toast 覆于其上）。地址在提交前归一（normalizeCustomSpecifier），
/// 安装按钮贴输入框右侧，进度明细复用卡片同款 InstallLogView。终态从 store
/// 推导而非只看本次调用返回：needsApproval 时 installing 已被清空、审批放行
/// 后的重装又由 approveMarketBuilds 独立跑完（不经本对话框），store 态是
/// 唯一能同时覆盖三条路径的事实——busy 中 installing 落空即本次结束（有锚定
/// 错误为 failed，否则 done）；approval 态由审批去留下推
type CustomInstallPhase = "input" | "busy" | "approval" | "done" | "failed";

function CustomInstallDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [phase, setPhase] = useState<CustomInstallPhase>("input");
  const installPlugin = useAppStore((s) => s.installMarketPlugin);
  const installing = useAppStore((s) => s.marketInstalling);
  const installLog = useAppStore((s) => s.marketInstallLog);
  const installError = useAppStore((s) => s.marketInstallError);
  const pendingApproval = useAppStore((s) => s.marketPendingApproval);
  const dismissError = useAppStore((s) => s.dismissMarketInstallError);
  const toast = useAppStore((s) => s.toast);

  const candidate = useMemo(() => normalizeCustomSpecifier(address), [address]);
  const invalid = address.trim() !== "" && candidate === null;
  const busy = phase === "busy" || phase === "approval";

  useEffect(() => {
    if (phase === "busy") {
      if (installing !== null) return;
      // 被拦构建脚本：转审批对话框（覆盖本框），由其去留推进
      if (pendingApproval?.specifier === submitted) setPhase("approval");
      else setPhase(installError?.specifier === submitted ? "failed" : "done");
    } else if (phase === "approval") {
      // 放行：重装已由 approveMarketBuilds 启动（installing 重新挂上），
      // 回 busy 走同一终态推导；拒绝：回输入态（toast 已给出手动路径）
      if (installing === submitted) setPhase("busy");
      else if (pendingApproval === null && installing === null) setPhase("input");
    }
  }, [phase, installing, pendingApproval, installError, submitted]);

  // spec 缺省取当前输入的归一结果；Retry 固定重跑原 specifier（输入可能已被改掉）
  const install = (spec: string | null = candidate) => {
    if (spec === null || installing !== null || busy) return;
    setSubmitted(spec);
    setPhase("busy");
    void installPlugin(spec, spec);
  };

  // 失败态随对话框关闭一并清（错误 + 留存明细），不留孤儿 store 态；
  // 与同名 specifier 的目录卡片共用同一安装身份，一并消失是预期行为
  const close = () => {
    if (installError?.specifier === submitted) dismissError();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      id="custom-install-dialog"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) close();
      }}
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-lg" aria-busy={busy}>
        <h3 className="text-sm font-semibold">{t("Install a custom plugin")}</h3>
        <p className="mt-2 text-xs opacity-70">
          {t(
            "Install from outside the curated catalog — same install gate, audit and build-script approval as catalog plugins.",
          )}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <input
            className={`${INPUT_MONO} flex-1`}
            placeholder={t("e.g. github:owner/repo or pkg@1.2.3")}
            value={address}
            disabled={busy}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") install();
            }}
            id="custom-install-input"
          />
          <button
            className={BTN_PRIMARY}
            disabled={busy || candidate === null}
            onClick={() => install()}
            id="custom-install-button"
          >
            {busy ? t("Working…") : t("Install")}
          </button>
        </div>
        {invalid && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400" id="custom-install-invalid">
            {t(
              "Unsupported address — use an npm package (pkg@1.2.3), a GitHub repo (github:owner/repo), or a GitHub URL.",
            )}
          </p>
        )}
        {/* 安装进度/结果区：安装中流式明细、失败原因+留存明细+重试、成功回执；
            锚定本次提交的 specifier，与目录卡片共用同一 store 通道 */}
        {(phase === "busy" || phase === "failed") && installLog?.specifier === submitted && (
          <div className="mt-3">
            {phase === "failed" && installError && (
              <p className="mb-2 text-xs text-red-600 dark:text-red-400" id="custom-install-failed">
                {t("Install failed: {{error}}", { error: installError.message })}
              </p>
            )}
            <InstallLogView log={installLog} failed={phase === "failed"} />
            {phase === "failed" && (
              <div className="mt-2 flex justify-end gap-2">
                <button
                  className={BTN_OUTLINE}
                  onClick={() => installError && void copyInstallContext(installError, installLog, toast)}
                >
                  {t("Copy error")}
                </button>
                <button
                  className={BTN_PRIMARY}
                  disabled={installing !== null}
                  onClick={() => submitted && install(submitted)}
                  id="custom-install-retry"
                >
                  {t("Retry")}
                </button>
              </div>
            )}
          </div>
        )}
        {phase === "done" && (
          <p className="mt-3 flex min-w-0 items-center gap-1.5" id="custom-install-done">
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              {t("Installed")}
            </span>
            <span className="truncate font-mono text-xs opacity-70">{submitted}</span>
          </p>
        )}
        <div className="mt-4 flex justify-end">
          <button className={BTN_OUTLINE} disabled={busy} onClick={close} id="custom-install-close" autoFocus>
            {t("Close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/// 更新说明对话框（G5）：更新前展示目录侧探针的 release 正文与最近提交，
/// 用户知情后确认走既有更新管线（可能再弹供应链窗口确认框）。数据缺失
/// （探针未覆盖/查询失败）如实显示"暂无说明"，不阻塞更新。焦点落取消
/// （安全默认），Esc 等价取消
function UpdateNotesDialog() {
  const { t } = useTranslation();
  const pending = useAppStore((s) => s.marketReleaseNotes);
  const updating = useAppStore((s) => s.marketUpdating);
  const updates = useAppStore((s) => s.marketUpdates);
  const confirm = useAppStore((s) => s.confirmMarketReleaseNotesUpdate);
  const dismiss = useAppStore((s) => s.dismissMarketReleaseNotes);
  if (!pending) return null;
  const busy = updating === pending.name;
  const info = updates?.[pending.name] ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      id="update-notes-dialog"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) dismiss();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-lg">
        <h3 className="text-sm font-semibold">{t("Update notes")}</h3>
        <div className="mt-2 rounded bg-muted px-3 py-2 font-mono text-xs">
          {info?.installedVersion ? (
            <>
              {info.installedVersion} <span className="opacity-50">→</span> {info.latestVersion ?? "?"}
            </>
          ) : (
            (info?.latestVersion ?? pending.name)
          )}
        </div>
        {pending.busy ? (
          <p className="mt-3 text-xs opacity-60">{t("Loading notes…")}</p>
        ) : pending.notes?.release ? (
          <div className="mt-3 max-h-64 overflow-y-auto rounded border border-border bg-muted/40 px-3 py-2">
            <p className="text-xs font-medium">
              {pending.notes.release.name ?? pending.notes.release.tag ?? pending.name}
            </p>
            <pre className="mt-1 whitespace-pre-wrap break-words text-xs opacity-80">
              {pending.notes.release.body}
            </pre>
          </div>
        ) : (
          <p className="mt-3 text-xs opacity-60">{t("No release notes for this plugin.")}</p>
        )}
        {!pending.busy && pending.notes !== null && pending.notes.commits.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-medium opacity-70">{t("Recent commits")}</p>
            <ul className="mt-1 max-h-32 overflow-y-auto text-xs opacity-70">
              {pending.notes.commits.map((c) => (
                <li key={c.sha} className="truncate">
                  <span className="font-mono opacity-60">{c.sha.slice(0, 7)}</span> {c.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button className={BTN_OUTLINE} disabled={busy} onClick={dismiss} id="update-notes-cancel" autoFocus>
            {t("Cancel")}
          </button>
          <button className={BTN_PRIMARY} disabled={busy} onClick={() => void confirm()} id="update-notes-confirm">
            {busy ? t("Working…") : t("Update")}
          </button>
        </div>
      </div>
    </div>
  );
}

/// 诊断页（G7）：组合事实读 dsh --dump-config 的自有输出（重复入口 id /
/// 孤儿 patch 行 / 禁用计数），零组合语义复刻——随上游升级零漂移。进入
/// 页面自动跑一次；诊断失败原样上报（组合跑不起来正是要暴露的事实）。
/// 复制出口（D2 同一哲学）组装自包含修复上下文
function DiagnosticsPane() {
  const { t } = useTranslation();
  const [diag, setDiag] = useState<MarketDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useAppStore((s) => s.toast);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    cmd.marketDiagnostics()
      .then((d) => {
        if (alive) setDiag(d);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const rerun = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    cmd.marketDiagnostics()
      .then((d) => setDiag(d))
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const copyDiagnostics = () => {
    if (!diag) return;
    const lines = [
      "Plugin profile diagnostics — repair context",
      "Entries: " + diag.entries + " (" + diag.disabled + " disabled)",
      ...(diag.duplicates.length > 0
        ? ["Duplicate entry ids:", ...diag.duplicates.map((d) => "- " + d.id + " x" + d.count + " (" + d.layers.join(", ") + ")")]
        : []),
      ...(diag.orphans.length > 0 ? ["Orphan patch rows:", ...diag.orphans.map((o) => "- " + o)] : []),
    ];
    navigator.clipboard
      .writeText(lines.join("\n"))
      .then(() => toast(i18n.t("Diagnostics copied"), "info"))
      .catch((e) => toast(i18n.t("Failed to copy: {{error}}", { error: String(e) }), "error"));
  };

  return (
    <div className="flex-1 overflow-y-auto p-6" id="market-diagnostics">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t("Diagnostics")}</h2>
          <p className="text-xs opacity-60">{t("Composition facts read from dsh --dump-config.")}</p>
        </div>
        <div className="flex items-center gap-2">
          {diag && (
            <button className={BTN} onClick={() => copyDiagnostics()} id="market-diagnostics-copy">
              {t("Copy diagnostics")}
            </button>
          )}
          <button className={BTN} disabled={busy} onClick={() => rerun()} id="market-diagnostics-rerun">
            {busy ? t("Working…") : t("Rerun")}
          </button>
        </div>
      </div>

      {busy && <p className="text-sm opacity-60">{t("Working…")}</p>}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400" title={error}>
          {t("Diagnostics failed: {{error}}", { error: tErr(error) })}
        </p>
      )}
      {diag && (
        <>
          <p className="text-sm">
            {t("{{count}} entries", { count: diag.entries })}
            <span className="mx-1.5 opacity-40">·</span>
            {t("{{count}} disabled", { count: diag.disabled })}
          </p>
          {diag.duplicates.length === 0 && diag.orphans.length === 0 && (
            <p className="mt-3 text-sm opacity-60">{t("No problems found.")}</p>
          )}
          {diag.duplicates.length > 0 && (
            <section className="mt-4">
              <h3 className="text-sm font-semibold text-red-600 dark:text-red-400">{t("Duplicate entry ids")}</h3>
              <p className="mt-1 text-xs opacity-60">{t("The next dsh boot will fail until these are resolved.")}</p>
              <ul className="mt-2 space-y-1">
                {diag.duplicates.map((d) => (
                  <li key={d.id} className="rounded border border-border px-3 py-2 font-mono text-xs">
                    {d.id}
                    <span className="ml-2 opacity-60">×{d.count}</span>
                    <span className="ml-2 opacity-60">{d.layers.join(" · ")}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {diag.orphans.length > 0 && (
            <section className="mt-4">
              <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400">{t("Orphan patch rows")}</h3>
              <ul className="mt-2 space-y-1">
                {diag.orphans.map((o) => (
                  <li key={o} className="rounded border border-border px-3 py-2 text-xs">
                    <span className="font-mono">{o}</span>
                    <span className="ml-2 opacity-60">
                      {t("Referenced by a patch row but missing — remove the override row from cordis.patch.yml.")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
