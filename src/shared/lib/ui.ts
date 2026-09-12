// 共用 Tailwind 类串（从旧 index.html/模板字符串原样提取，保像素级一致）

export const BTN =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 px-3 text-xs";

export const BTN_SM =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-md font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-6 px-2 text-xs";

export const BTN_DANGER_SM =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-destructive/50 bg-background text-destructive hover:bg-destructive/10 h-6 px-2 text-xs";

// 禁用态落 muted 灰而非整体半透明：高饱和主题族（如 neo-brutalism）里
// 半透明主色会反向成为最扎眼元素，且前景白字对比崩塌
export const BTN_PRIMARY =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:bg-muted disabled:text-muted-foreground bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4";

// 与 BTN_PRIMARY 同尺寸的幽灵描边按钮：同排非主导操作（如首页 Restart）
export const BTN_OUTLINE =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-4";

// 与 BTN_PRIMARY 同尺寸的危险按钮：实心 destructive 填充，与描边按钮形成结构对比，
// destructive 偏黑的主题族（如 neo-brutalism）也能与普通描边按钮一眼区分；
// 禁用态同 BTN_PRIMARY 落 muted 灰：深色 destructive 族下半透明实心会反向扎眼
export const BTN_DANGER =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:bg-muted disabled:text-muted-foreground bg-destructive text-destructive-foreground hover:bg-destructive/90 h-9 px-4";

// 行内图标按钮（模型页服务行编辑/测试/拉取/删除共用）：图标方钮，危险变体
// 在使用处以 ${ROW_ICON_BUTTON} 前缀追加 destructive 悬停色
export const ROW_ICON_BUTTON =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50";

export const INPUT =
  "h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export const INPUT_MONO = `${INPUT} font-mono`;

// 区块卡表面（SettingsCard / DshCard 主卡 / 模式行卡 / 模型页区块 / 市场卡同一事实）；
// 需要覆盖边框色时后置 border-* 任意值类（编译序在具名 border-border 之后，天然生效）
export const PANEL = "rounded-xl border border-border bg-card text-card-foreground";

// 模态对话框单一配方：遮罩统一 z-50（同层按 DOM 序叠放，后渲染者在上，Toaster
// 在 App 树末位故 toast 恒浮其上）；面板为浮起卡面 bg-card。z 阶梯中仅有的例外
// 是 ProviderDialog 高级设置叠层（z-70 面板 / z-80 关闭键，见 advanced-settings.css
// 与 DESIGN.md）
export const MODAL_OVERLAY =
  "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6";
export const MODAL_PANEL = "rounded-xl border border-border bg-card shadow-lg";

// 辅助文字刻度（DESIGN「辅助 text-xs opacity-60」唯一配方）：默认 60，强调 70；
// 50/80 不再使用，业务 TSX 禁止 text-[9px]/text-[11px] 等随意字号
export const MUTED = "text-xs opacity-60";
export const MUTED_STRONG = "text-xs opacity-70";

export const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export const TOGGLE =
  "relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-input transition-colors outline-none checked:bg-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 before:absolute before:left-0.5 before:top-0.5 before:h-4 before:w-4 before:rounded-full before:bg-background before:shadow-sm before:transition-transform checked:before:translate-x-4";

// 带状态文字的胶囊开关（市场「启/停」状态条在用）：胶囊内居中显示 data-state-text，
// 旋钮位移随 --sw-width 自动计算；v4 的 translate 与 scale 是独立属性，
// checked + active 时位移与按下缩小自动叠加，无需成对规则
// 用法：<input type="checkbox" className={TOGGLE_LABELED} data-state-text="Enabled">
// - data-state-text：胶囊内文字（随状态切换由调用方更新）
// - --sw-width：胶囊宽度（默认 6.25rem，容纳最长英文 "Disabled"）
export const TOGGLE_LABELED =
  "relative h-6 w-[var(--sw-width,6.25rem)] shrink-0 cursor-pointer appearance-none rounded-full bg-input outline-none transition-colors duration-200 checked:bg-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 before:absolute before:left-0.5 before:top-0.5 before:h-5 before:w-5 before:rounded-full before:bg-background before:shadow-sm before:transition-transform before:duration-[250ms] before:ease-[cubic-bezier(0.34,1.56,0.64,1)] checked:before:translate-x-[calc(var(--sw-width,6.25rem)_-_24px)] after:pointer-events-none after:absolute after:left-1/2 after:top-1/2 after:z-[1] after:-translate-x-1/2 after:-translate-y-1/2 after:whitespace-nowrap after:text-xs after:font-medium after:leading-none after:opacity-70 after:transition-[color,opacity] after:duration-200 after:content-[attr(data-state-text)] checked:after:text-primary-foreground checked:after:opacity-100 active:not-disabled:before:scale-85";
