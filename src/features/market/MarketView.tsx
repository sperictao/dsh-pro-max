// 插件市场视图：二级导航拆"发现 / 已安装"两页，发现（目录浏览）为默认页。
// 安装走 dsh plugin --profile web add（长操作），风险确认内联在卡片上完成。

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import { BTN, BTN_DANGER_SM, BTN_PRIMARY, BTN_SM, INPUT, SELECT } from "@/shared/lib/ui";
import type { InstalledPlugin, MarketPlugin, PluginUpdateInfo } from "@/shared/types";
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

type MarketTab = "discover" | "installed";

const MARKET_TABS: { id: MarketTab; labelKey: string }[] = [
  { id: "discover", labelKey: "Discover" },
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
    <main className="flex flex-1 flex-col" id="market-view">
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
      {tab === "discover" ? <DiscoverPane /> : <InstalledPane />}
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
  const installing = useAppStore((s) => s.marketInstalling);
  const installPlugin = useAppStore((s) => s.installMarketPlugin);
  const refreshCatalog = useAppStore((s) => s.refreshMarketCatalog);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<"stars" | "name">("stars");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const installedNames = useMemo(() => new Set(installed.map((p) => p.name)), [installed]);

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
          return (
            <PluginCard
              key={p.fullName}
              plugin={p}
              locale={locale}
              installed={pkg !== null && installedNames.has(pkg)}
              installing={installing === p.installSpecifier}
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
          <button className={BTN} disabled={updatesBusy} onClick={() => void refreshUpdates()} id="btn-updates-check">
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
        {installed.map((p) => (
          <InstalledCard
            key={p.name}
            plugin={p}
            catalogPlugin={byName.get(p.name) ?? null}
            locale={locale}
            info={updates?.[p.name] ?? null}
            updating={updating === p.name}
            busy={updating !== null}
            removing={removing === p.name}
            onUpdate={() => void updatePlugin(p.name)}
            onRemove={() => void removePlugin(p.name)}
          />
        ))}
      </div>
    </div>
  );
}

/// 已安装卡片：同一 PluginCardFrame 骨架保证与发现页观感一致；目录能匹配上
/// 的插件透传描述/分类/星标/链接，匹配不上的如实只展示落盘事实（name+spec）。
/// 版本行只在可检形态展示：有更新出 v当前 → v最新 + Update，已最新如实标注
function InstalledCard({
  plugin,
  catalogPlugin,
  locale,
  info,
  updating,
  busy,
  removing,
  onUpdate,
  onRemove,
}: {
  plugin: InstalledPlugin;
  catalogPlugin: MarketPlugin | null;
  locale: "en" | "zh";
  info: PluginUpdateInfo | null;
  updating: boolean;
  busy: boolean;
  removing: boolean;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const current = info?.installedVersion ?? null;
  const latest = info?.latestVersion ?? null;
  const hasUpdate = !!info?.updateAvailable;
  const description = catalogPlugin?.description
    ? (catalogPlugin.description[locale] ?? catalogPlugin.description.en ?? Object.values(catalogPlugin.description)[0])
    : null;

  return (
    <PluginCardFrame
      name={plugin.name}
      url={catalogPlugin?.url ?? null}
      subtitle={<span className="truncate font-mono">{plugin.spec}</span>}
      badges={
        <>
          {plugin.managed && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] opacity-50">{t("managed by launcher")}</span>
          )}
          {catalogPlugin?.deprecated && (
            <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-600 dark:text-red-400">
              {t("Deprecated")}
            </span>
          )}
          {catalogPlugin?.stars != null && <span className="text-xs opacity-60">★ {catalogPlugin.stars.toLocaleString()}</span>}
        </>
      }
      description={description ? <p className="line-clamp-2 text-xs opacity-70">{description}</p> : null}
      footer={
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] opacity-60">
            {current && (
              <span className="font-mono">
                v{current}
                {hasUpdate && latest && (
                  <span className="ml-1 text-emerald-600 dark:text-emerald-400">→ v{latest}</span>
                )}
              </span>
            )}
            {catalogPlugin?.category && <span className="rounded bg-muted px-1.5 py-0.5">{catalogPlugin.category}</span>}
          </div>
          <div className="flex items-center gap-1.5">
            {hasUpdate && !plugin.managed && (
              <button className={BTN_PRIMARY} disabled={busy} onClick={onUpdate} aria-label={`${t("Update")} ${plugin.name}`}>
                {updating ? t("Working…") : t("Update")}
              </button>
            )}
            {!hasUpdate && current && latest !== null && !plugin.managed && (
              <span className="text-xs opacity-50">{t("Up to date")}</span>
            )}
            {!plugin.managed && (
              <button
                className={BTN_DANGER_SM}
                disabled={removing || busy}
                onClick={onRemove}
                aria-label={`${t("Remove")} ${plugin.name}`}
              >
                {removing ? t("Working…") : t("Remove")}
              </button>
            )}
          </div>
        </div>
      }
    />
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

/// 市场卡片共用骨架：发现与已安装两页同一观感——头部名称区 + 右上徽章、
/// 描述、底部左信息右操作。结构只此一处，改卡片样式两页同步
function PluginCardFrame({
  name,
  url,
  subtitle,
  badges,
  description,
  footer,
}: {
  name: string;
  /** 插件主页链接；null = 无处可去，名称退化为纯文本 */
  url: string | null;
  subtitle: ReactNode;
  badges: ReactNode;
  description: ReactNode;
  footer: ReactNode;
}) {
  return (
    <article className="flex flex-col gap-1.5 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {url ? (
            <button
              className="cursor-pointer truncate text-sm font-semibold hover:underline"
              onClick={() => void openUrl(url).catch(() => {})}
              title={url}
            >
              {name}
            </button>
          ) : (
            <span className="text-sm font-semibold">{name}</span>
          )}
          <p className="truncate text-xs opacity-50">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{badges}</div>
      </div>
      {description}
      {footer}
    </article>
  );
}

function PluginCard({
  plugin,
  locale,
  installed,
  installing,
  onInstall,
}: {
  plugin: MarketPlugin;
  locale: "en" | "zh";
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const installable = !!plugin.installSpecifier;
  // 描述按界面语言取，无对应翻译时回退英文、再回退第一条
  const description = plugin.description
    ? (plugin.description[locale] ?? plugin.description.en ?? Object.values(plugin.description)[0])
    : null;

  return (
    <PluginCardFrame
      name={plugin.name}
      url={plugin.url}
      subtitle={plugin.fullName}
      badges={
        <>
          {/* 目录侧弃用标记原样透传（raw badge，不做二次加工） */}
          {plugin.deprecated && (
            <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-600 dark:text-red-400">
              {t("Deprecated")}
            </span>
          )}
          {plugin.stars !== null && <span className="text-xs opacity-60">★ {plugin.stars.toLocaleString()}</span>}
        </>
      }
      description={
        <>
          {description && <p className="line-clamp-2 text-xs opacity-70">{description}</p>}
          {plugin.deprecated && plugin.replacement && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t("Deprecated — consider {{replacement}} instead.", { replacement: plugin.replacement })}
            </p>
          )}
        </>
      }
      footer={
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] opacity-60">
            {plugin.category && <span className="rounded bg-muted px-1.5 py-0.5">{plugin.category}</span>}
          </div>
          {installed ? (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">{t("Installed")}</span>
          ) : installable ? (
            confirming ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs opacity-60">{t("Install this plugin?")}</span>
                <button className={BTN_PRIMARY} disabled={installing} onClick={() => { setConfirming(false); onInstall(); }}>
                  {installing ? t("Working…") : t("Confirm")}
                </button>
                <button className={BTN_SM} onClick={() => setConfirming(false)}>
                  {t("Cancel")}
                </button>
              </div>
            ) : (
              <button className={BTN_PRIMARY} disabled={installing} onClick={() => setConfirming(true)}>
                {installing ? t("Installing…") : t("Install")}
              </button>
            )
          ) : (
            <span className="text-xs opacity-50">{t("Manual install only")}</span>
          )}
        </div>
      }
    />
  );
}
