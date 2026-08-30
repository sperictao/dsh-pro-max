// 插件市场视图：浏览 dsh-plugins-store 社区目录，一键安装/移除 web profile 插件。
// 安装走 dsh plugin --profile web add（长操作），风险确认内联在卡片上完成。

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import { BTN, BTN_DANGER_SM, BTN_PRIMARY, BTN_SM, INPUT, SELECT } from "@/shared/lib/ui";
import type { MarketPlugin } from "@/shared/types";
import { open as openUrl } from "@tauri-apps/plugin-shell";

// 每批渲染条数（7400+ 条目录全量渲染会卡），滚动到底加载下一批
const PAGE_SIZE = 60;

/// npm 形态 specifier 的包名部分（已装匹配用）：
/// "npm:dsh-better-sidebar@latest" → "dsh-better-sidebar"；"@scope/pkg@1.0" → "@scope/pkg"。
/// github: 安装的 dependencies 键无法从目录预知，返回 null（不参与已装匹配）
export function packageNameFromSpecifier(specifier: string): string | null {
  let s = specifier;
  if (s.startsWith("npm:")) {
    s = s.slice(4);
  } else if (s.startsWith("github:")) {
    return null;
  }
  const scopeStart = s.startsWith("@") ? s.indexOf("/") : 0;
  const at = s.lastIndexOf("@");
  if (at > scopeStart) s = s.slice(0, at);
  return s || null;
}

export function MarketView() {
  const { t } = useTranslation();
  const catalog = useAppStore((s) => s.marketCatalog);
  const catalogBusy = useAppStore((s) => s.marketCatalogBusy);
  const installed = useAppStore((s) => s.marketInstalled);
  const installedBusy = useAppStore((s) => s.marketInstalledBusy);
  const installing = useAppStore((s) => s.marketInstalling);
  const removing = useAppStore((s) => s.marketRemoving);
  const refreshCatalog = useAppStore((s) => s.refreshMarketCatalog);
  const refreshInstalled = useAppStore((s) => s.refreshMarketInstalled);
  const installPlugin = useAppStore((s) => s.installMarketPlugin);
  const removePlugin = useAppStore((s) => s.removeMarketPlugin);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<"stars" | "name">("stars");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void refreshCatalog();
    void refreshInstalled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        (p.description ?? "").toLowerCase().includes(q)
      );
    });
    return sort === "stars" ? [...list].sort((a, b) => b.stars - a.stars) : [...list].sort((a, b) => a.fullName.localeCompare(b.fullName));
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
    <main className="flex-1 overflow-y-auto p-6" id="market-view">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t("Plugin Marketplace")}</h2>
          <p className="text-xs opacity-60">
            {t("Community catalog by dshmk.com. Verified means sandbox-checked, not a security audit.")}
          </p>
        </div>
        <button className={BTN} id="btn-market-refresh" disabled={catalogBusy} onClick={() => void refreshCatalog(true)}>
          {catalogBusy ? t("Working…") : t("Refresh")}
        </button>
      </div>

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
              {`${c} (${n})`}
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

      {/* 已装插件管理 */}
      <section className="mb-4 rounded-lg border border-border p-4" id="market-installed">
        <h3 className="mb-2 text-sm font-semibold">{t("Installed Plugins (web profile)")}</h3>
        {installedBusy && <p className="text-sm opacity-60">{t("Working…")}</p>}
        {!installedBusy && installed.length === 0 && <p className="text-sm opacity-60">{t("No plugins installed yet.")}</p>}
        <ul className="flex flex-col gap-1">
          {installed.map((p) => (
            <li key={p.name} className="flex items-center justify-between gap-2 text-sm">
              <span className="font-mono text-xs">
                {p.name}
                {p.managed && <span className="ml-2 opacity-50">{t("managed by launcher")}</span>}
              </span>
              {!p.managed && (
                <button
                  className={BTN_DANGER_SM}
                  disabled={removing === p.name}
                  onClick={() => void removePlugin(p.name)}
                  aria-label={`${t("Remove")} ${p.name}`}
                >
                  {removing === p.name ? t("Working…") : t("Remove")}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {!catalog && catalogBusy && <p className="text-sm opacity-60">{t("Loading catalog…")}</p>}
      {catalog && filtered.length === 0 && <p className="text-sm opacity-60">{t("No plugins match your filters.")}</p>}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {filtered.slice(0, visible).map((p) => {
          const pkg = packageNameFromSpecifier(p.installSpecifier ?? "");
          return (
            <PluginCard
              key={p.repositoryId || p.fullName}
              plugin={p}
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
    </main>
  );
}

function PluginCard({
  plugin,
  installed,
  installing,
  onInstall,
}: {
  plugin: MarketPlugin;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const installable = !!plugin.installSpecifier && plugin.installExecutable;

  return (
    <article className="flex flex-col gap-1.5 rounded-lg border border-border p-4" id={`plugin-${plugin.repositoryId}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <button
            className="cursor-pointer truncate text-sm font-semibold hover:underline"
            onClick={() => void openUrl(plugin.url).catch(() => {})}
            title={plugin.url}
          >
            {plugin.name}
          </button>
          <p className="truncate text-xs opacity-50">{plugin.fullName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {plugin.verified && (
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
              {t("Verified")}
            </span>
          )}
          <span className="text-xs opacity-60">★ {plugin.stars.toLocaleString()}</span>
        </div>
      </div>
      {plugin.description && <p className="line-clamp-2 text-xs opacity-70">{plugin.description}</p>}
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] opacity-60">
          {plugin.category && <span className="rounded bg-muted px-1.5 py-0.5">{plugin.category}</span>}
          {plugin.language && <span>{plugin.language}</span>}
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
    </article>
  );
}
