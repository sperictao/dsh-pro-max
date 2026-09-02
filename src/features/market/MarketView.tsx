// 插件市场视图：二级导航拆"发现 / 已安装"两页，发现（目录浏览）为默认页。
// 安装走 dsh plugin --profile web add（长操作），风险确认内联在卡片上完成。

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import { BTN, BTN_DANGER, BTN_OUTLINE, BTN_PRIMARY, BTN_SM, INPUT, SELECT } from "@/shared/lib/ui";
import type { InstalledPlugin, MarketCatalog, MarketPlugin, PluginUpdateInfo } from "@/shared/types";
import { open as openUrl } from "@tauri-apps/plugin-shell";

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

/// 目录分类表的语言键：目录只供应 en/zh 两语，界面语言映射到其一
function catalogLocale(language: string): "en" | "zh" {
  return language.startsWith("zh") ? "zh" : "en";
}

type MarketTab = "discover" | "favorites" | "installed";

const MARKET_TABS: { id: MarketTab; labelKey: string }[] = [
  { id: "discover", labelKey: "Discover" },
  { id: "favorites", labelKey: "Favorites" },
  { id: "installed", labelKey: "Installed" },
];

export function MarketView() {
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
      {tab === "discover" ? <DiscoverPane /> : tab === "favorites" ? <FavoritesPane /> : <InstalledPane />}
      <BuildApprovalDialog />
    </main>
  );
}

/// 发现页：awesome-dsh-plugin 目录浏览（搜索/分类/排序 + 卡片网格）
function DiscoverPane() {
  const { t, i18n } = useTranslation();
  const locale = catalogLocale(i18n.language);
  const catalog = useAppStore((s) => s.marketCatalog);
  const catalogBusy = useAppStore((s) => s.marketCatalogBusy);
  const installed = useAppStore((s) => s.marketInstalled);
  const installPlugin = useAppStore((s) => s.installMarketPlugin);
  const refreshCatalog = useAppStore((s) => s.refreshMarketCatalog);
  const favorites = useAppStore((s) => s.marketFavorites);
  const toggleFavorite = useAppStore((s) => s.toggleMarketFavorite);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<"stars" | "name">("stars");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const installedByName = useMemo(() => new Map(installed.map((p) => [p.name, p])), [installed]);
  const updates = useAppStore((s) => s.marketUpdates);

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
  }, [catalog, query, category, sort]);

  // 过滤条件变化后回到列表头部
  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [query, category, sort]);

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
        <button className={BTN} id="btn-market-refresh" disabled={catalogBusy} onClick={() => void refreshCatalog(true)}>
          {catalogBusy ? t("Working…") : t("Refresh")}
        </button>
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

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          className={`${INPUT} max-w-72`}
          placeholder={t("Search plugins…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          id="market-search"
        />
        <select className={`${SELECT} w-44`} value={category} onChange={(e) => setCategory(e.target.value)} id="market-category">
          <option value="">{t("All Categories")}</option>
          {categories.map(([c, n]) => (
            <option key={c} value={c}>
              {`${catalog?.categories?.[c]?.[locale] ?? c} (${n})`}
            </option>
          ))}
        </select>
        <select className={`${SELECT} w-40`} value={sort} onChange={(e) => setSort(e.target.value as "stars" | "name")} id="market-sort">
          <option value="stars">{t("Most Stars")}</option>
          <option value="name">{t("By Name")}</option>
        </select>
        <span className="ml-auto text-xs opacity-60" id="market-count">
          {t("{{count}} plugins", { count: filtered.length })}
        </span>
      </div>

      {!catalog && catalogBusy && <p className="text-sm opacity-60">{t("Loading catalog…")}</p>}
      {catalog && filtered.length === 0 && <p className="text-sm opacity-60">{t("No plugins match your filters.")}</p>}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {filtered.slice(0, visible).map((p) => {
          const pkg = packageNameFromSpecifier(p.installSpecifier ?? "");
          const installedPlugin = pkg !== null ? (installedByName.get(pkg) ?? null) : null;
          return (
            <MarketCard
              key={p.fullName}
              plugin={p}
              installed={installedPlugin}
              info={installedPlugin ? (updates?.[installedPlugin.name] ?? null) : null}
              catalog={catalog}
              locale={locale}
              favorited={favorites.includes(p.fullName)}
              onToggleFavorite={() => toggleFavorite(p.fullName)}
              onInstall={() => void installPlugin(p.installSpecifier!, p.name)}
            />
          );
        })}
      </div>
      <div ref={sentinelRef} className="h-4" />
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

/// 收藏页：收藏清单 × 目录条目按收藏顺序取交集，复用发现页同一 PluginCard
/// （星标可就地取消）。目录未拉到时不谎称"没有收藏"——只渲染交集，如实留白
function FavoritesPane() {
  const { t, i18n } = useTranslation();
  const locale = catalogLocale(i18n.language);
  const catalog = useAppStore((s) => s.marketCatalog);
  const catalogBusy = useAppStore((s) => s.marketCatalogBusy);
  const installed = useAppStore((s) => s.marketInstalled);
  const installPlugin = useAppStore((s) => s.installMarketPlugin);
  const favorites = useAppStore((s) => s.marketFavorites);
  const toggleFavorite = useAppStore((s) => s.toggleMarketFavorite);

  const installedByName = useMemo(() => new Map(installed.map((p) => [p.name, p])), [installed]);
  const updates = useAppStore((s) => s.marketUpdates);
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

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {plugins.map((p) => {
          const pkg = packageNameFromSpecifier(p.installSpecifier ?? "");
          const installedPlugin = pkg !== null ? (installedByName.get(pkg) ?? null) : null;
          return (
            <MarketCard
              key={p.fullName}
              plugin={p}
              installed={installedPlugin}
              info={installedPlugin ? (updates?.[installedPlugin.name] ?? null) : null}
              catalog={catalog}
              locale={locale}
              favorited
              onToggleFavorite={() => toggleFavorite(p.fullName)}
              onInstall={() => void installPlugin(p.installSpecifier!, p.name)}
            />
          );
        })}
      </div>
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
  const updating = useAppStore((s) => s.marketUpdating);
  const favorites = useAppStore((s) => s.marketFavorites);
  const toggleFavorite = useAppStore((s) => s.toggleMarketFavorite);

  // 目录匹配表：给已装卡片补全描述/分类/星标/链接（目录没有的如实留白）
  const byName = useMemo(() => new Map((catalog?.plugins ?? []).map((p) => [p.name, p])), [catalog]);
  const pendingCount = useMemo(
    () => Object.values(updates ?? {}).filter((u) => u.updateAvailable && !u.managed).length,
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
              favorited={catalogPlugin !== null && favorites.includes(catalogPlugin.fullName)}
              onToggleFavorite={() => {
                if (catalogPlugin) toggleFavorite(catalogPlugin.fullName);
              }}
              onUpdate={() => void updatePlugin(p.name)}
              onRemove={() => void removePlugin(p.name)}
            />
          );
        })}
      </div>
    </div>
  );
}

/// 市场卡片：发现/收藏/已安装三页唯一实现。数据进、状态机出——目录条目
/// plugin 与落盘条目 installed 推导出唯一卡片状态，状态条左侧恒为安装事实、
/// 右侧为该状态下可用的操作（未接回调的操作不出现：发现/收藏页只管浏览与安装，
/// 更新/移除归已安装页）。目录缺位（已装但目录没有）时如实只展示落盘事实。
/// 收藏星标独占右上角，★ 计数在 meta 行——两个五角星不再并排撞义
type CardState =
  | "managed"
  | "removing"
  | "updating"
  | "outdated"
  | "installed"
  | "installing"
  | "manual"
  | "confirm"
  | "idle";

/// 描述按界面语言取，无对应翻译时回退英文、再回退第一条（唯一一份）
function localizedDescription(
  d: NonNullable<MarketPlugin["description"]>,
  locale: "en" | "zh",
): string {
  return d[locale] ?? d.en ?? Object.values(d)[0];
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
  favorited,
  onToggleFavorite,
  onInstall,
  onUpdate,
  onRemove,
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
  favorited: boolean;
  onToggleFavorite: () => void;
  onInstall?: () => void;
  onUpdate?: () => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const name = plugin?.name ?? installed?.name ?? "";
  const url = plugin?.url ?? null;
  const description = plugin?.description ? localizedDescription(plugin.description, locale) : null;
  const current = info?.installedVersion ?? null;
  const latest = info?.latestVersion ?? null;

  // 状态推导（自上而下首个命中）：受管 > 移除中 > 更新中 > 已装（比对更新）>
  // 安装中 > 仅手动 > 确认中 > 可装
  let state: CardState;
  if (installed?.managed) state = "managed";
  else if (removing !== null && installed?.name === removing) state = "removing";
  else if (updating !== null && installed?.name === updating) state = "updating";
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

  const removeBtn = onRemove && (
    <button
      className={BTN_DANGER}
      disabled={state === "removing" || updating !== null}
      onClick={onRemove}
      aria-label={`${t("Remove")} ${name}`}
    >
      {state === "removing" ? t("Working…") : t("Remove")}
    </button>
  );

  const statusLeft: ReactNode =
    state === "managed" ? (
      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] opacity-50">{t("managed by launcher")}</span>
    ) : state === "manual" ? (
      <span className="text-xs opacity-50">{t("Manual install only")}</span>
    ) : state === "confirm" ? (
      <span className="text-xs opacity-70">{t("Install this plugin?")}</span>
    ) : installed ? (
      <span className="text-xs">
        {t("Installed")}
        {current && (
          <span className="ml-1.5 font-mono">
            v{current}
            {outdated && <span className="ml-1 text-emerald-600 dark:text-emerald-400">→ v{latest}</span>}
          </span>
        )}
      </span>
    ) : (
      <span className="text-xs opacity-50">{t("Not installed")}</span>
    );

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
      <button className={BTN_PRIMARY} disabled>
        {t("Installing…")}
      </button>
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
        {onUpdate && (
          <button
            className={BTN_PRIMARY}
            disabled={updating !== null}
            onClick={onUpdate}
            aria-label={`${t("Update")} ${name}`}
          >
            {state === "updating" ? t("Working…") : t("Update")}
          </button>
        )}
        {removeBtn}
      </>
    ) : state === "installed" || state === "removing" ? (
      <>
        {current && latest !== null && <span className="text-xs opacity-50">{t("Up to date")}</span>}
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
        {/* 收藏星标：未收藏随整卡悬浮/键盘聚焦显隐，已收藏常驻（amber 实心）；
            纯落盘卡片（目录缺位）无星标 */}
        {plugin && (
          <button
            className={`shrink-0 text-sm leading-none ${
              favorited ? "text-amber-500" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            }`}
            onClick={onToggleFavorite}
            aria-label={`${favorited ? t("Remove from favorites") : t("Add to favorites")} ${name}`}
            title={favorited ? t("Remove from favorites") : t("Add to favorites")}
          >
            {favorited ? "★" : "☆"}
          </button>
        )}
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
      {/* 状态条：mt-auto + 上边线，grid 拉伸行内所有卡片状态条底对齐 */}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2.5">
        {statusLeft}
        <div className="flex items-center gap-1.5">{actions}</div>
      </div>
    </article>
  );
}

/// 构建脚本审批对话框：pnpm 10+ 默认拦截第三方安装脚本，放行即允许其以
/// 当前用户身份执行任意代码——这是用户决策点，launcher 不静默代劳
function BuildApprovalDialog() {
  const { t } = useTranslation();
  const pending = useAppStore((s) => s.marketPendingApproval);
  const installing = useAppStore((s) => s.marketInstalling);
  const approve = useAppStore((s) => s.approveMarketBuilds);
  const dismiss = useAppStore((s) => s.dismissMarketApproval);
  if (!pending) return null;
  const busy = installing === pending.specifier;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" role="dialog" aria-modal="true" id="build-approval-dialog">
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-lg">
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
        <div className="mt-4 flex justify-end gap-2">
          <button className={BTN_SM} disabled={busy} onClick={dismiss} id="build-approval-cancel">
            {t("Cancel")}
          </button>
          <button className={BTN_PRIMARY} disabled={busy} onClick={() => void approve()} id="build-approval-approve">
            {busy ? t("Working…") : t("Approve & install")}
          </button>
        </div>
      </div>
    </div>
  );
}

