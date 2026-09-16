// segmented 盒子（nav 本体）嵌在整行分隔条 div 内，非 #market-view 直接子元素
const MARKET_NAV_SELECTOR = "#market-view nav";
const MARKET_TAB_IDS = ["discover", "favorites", "installed", "diagnostics"] as const;

function marketTabs(nav: HTMLElement): HTMLButtonElement[] {
  return Array.from(nav.querySelectorAll<HTMLButtonElement>(":scope > button"));
}

function activeTabIndex(tabs: HTMLButtonElement[]): number {
  const active = tabs.findIndex((tab) => tab.classList.contains("active"));
  return active >= 0 ? active : 0;
}

export function nextMarketTabIndex(
  key: string,
  currentIndex: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight") return (currentIndex + 1) % count;
  if (key === "ArrowLeft") return (currentIndex - 1 + count) % count;
  return null;
}

function syncMarketTabSemantics(): void {
  const nav = document.querySelector<HTMLElement>(MARKET_NAV_SELECTOR);
  if (!nav) return;

  const tabs = marketTabs(nav);
  if (tabs.length === 0) return;

  const activeIndex = activeTabIndex(tabs);
  const activeId = MARKET_TAB_IDS[activeIndex] ?? `tab-${activeIndex}`;
  // pane 是整行分隔条（nav 的父级）的下一个兄弟，而非 nav 的
  const host = nav.parentElement instanceof HTMLElement ? nav.parentElement : nav;
  const panel = host.nextElementSibling instanceof HTMLElement ? host.nextElementSibling : null;

  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-orientation", "horizontal");

  let panelId: string | null = null;
  if (panel) {
    // Feature panes already own stable IDs such as `market-installed`. Preserve them:
    // existing selectors and audit contracts must not be replaced by the ARIA layer.
    if (!panel.id) panel.id = `market-tabpanel-${activeId}`;
    panelId = panel.id;
    panel.setAttribute("role", "tabpanel");
    panel.tabIndex = 0;
  }

  tabs.forEach((tab, index) => {
    const id = MARKET_TAB_IDS[index] ?? `tab-${index}`;
    const selected = index === activeIndex;
    tab.setAttribute("role", "tab");
    tab.id = `market-tab-${id}`;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;

    // Only the mounted/selected panel can be referenced truthfully because MarketView
    // conditionally mounts one pane at a time. Do not point inactive tabs at the wrong pane.
    if (selected && panelId) tab.setAttribute("aria-controls", panelId);
    else tab.removeAttribute("aria-controls");
  });

  if (panel) panel.setAttribute("aria-labelledby", tabs[activeIndex].id);
}

/**
 * Progressive accessibility layer for the existing MarketView tab switcher.
 * React remains the state owner: keyboard navigation activates the same button
 * click handlers as pointer input instead of duplicating market state here.
 */
export function installMarketTabAccessibility(): () => void {
  let frame: number | null = null;

  const scheduleSync = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      syncMarketTabSemantics();
    });
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;

    const nav = target.parentElement;
    if (!(nav instanceof HTMLElement) || !nav.matches(MARKET_NAV_SELECTOR)) return;

    const tabs = marketTabs(nav);
    const currentIndex = tabs.indexOf(target);
    if (currentIndex < 0) return;

    const nextIndex = nextMarketTabIndex(event.key, currentIndex, tabs.length);
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    nextTab.focus();
    nextTab.click();
    scheduleSync();
  };

  document.addEventListener("click", scheduleSync, true);
  document.addEventListener("focusin", scheduleSync, true);
  document.addEventListener("keydown", handleKeyDown, true);
  scheduleSync();

  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    document.removeEventListener("click", scheduleSync, true);
    document.removeEventListener("focusin", scheduleSync, true);
    document.removeEventListener("keydown", handleKeyDown, true);
  };
}
