// 共用 Tailwind 类串（从旧 index.html/模板字符串原样提取，保像素级一致）

// 交互控件统一约定：
// - focus-visible 使用 2px ring + background offset，键盘焦点在浅/深主题与卡片面都清晰；
// - active 只做 1px 下压，不改变布局尺寸；
// - transition 只覆盖颜色 / 阴影 / transform，避免 transition-all 带来的意外动画。
export const BTN =
  "inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-xs font-medium whitespace-nowrap outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 hover:bg-accent hover:text-accent-foreground active:not-disabled:translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";

// 小号文字按钮由 24px 提升到 28px：仍保持紧凑，但减少密集工具区的误点概率。
export const BTN_SM =
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-md border border-input bg-background px-2 text-xs font-medium whitespace-nowrap outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 hover:bg-accent hover:text-accent-foreground active:not-disabled:translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";

export const BTN_DANGER_SM =
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-destructive/50 bg-background px-2 text-xs font-medium whitespace-nowrap text-destructive outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 hover:bg-destructive/10 active:not-disabled:translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";

// 禁用态落 muted 灰而非整体半透明：高饱和主题族（如 neo-brutalism）里
// 半透明主色会反向成为最扎眼元素，且前景白字对比崩塌
export const BTN_PRIMARY =
  "inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium whitespace-nowrap text-primary-foreground outline-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-primary/90 active:not-disabled:translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:bg-muted disabled:text-muted-foreground";

// 与 BTN_PRIMARY 同尺寸的幽灵描边按钮：同排非主导操作（如首页 Restart）
export const BTN_OUTLINE =
  "inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium whitespace-nowrap outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 hover:bg-accent hover:text-accent-foreground active:not-disabled:translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";

// 与 BTN_PRIMARY 同尺寸的危险按钮：实心 destructive 填充，与描边按钮形成结构对比，
// destructive 偏黑的主题族（如 neo-brutalism）也能与普通描边按钮一眼区分；
// 禁用态同 BTN_PRIMARY 落 muted 灰：深色 destructive 族下半透明实心会反向扎眼
export const BTN_DANGER =
  "inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md bg-destructive px-4 text-sm font-medium whitespace-nowrap text-destructive-foreground outline-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-destructive/90 active:not-disabled:translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:bg-muted disabled:text-muted-foreground";

// 应用壳层：顶栏保持轻量，窄窗口允许导航换行；背景使用语义 token，避免主题族分叉。
export const APP_HEADER =
  "flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-background/95 px-4 py-2.5 backdrop-blur sm:flex-nowrap";

export const APP_BRAND =
  "inline-flex min-w-0 cursor-pointer items-center rounded-md px-1 py-1 text-sm font-semibold tracking-tight text-foreground outline-none transition-[color,box-shadow,transform] duration-150 hover:text-foreground/75 active:not-disabled:translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

// 顶级页面导航采用 segmented-control 结构。active/inactive 样式拆出独立常量，调用方只表达状态，
// 避免同一元素同时存在 text-foreground / text-muted-foreground 时依赖 Tailwind 生成顺序。
export const APP_NAV =
  "flex w-full max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-border bg-muted/40 p-1 sm:w-auto";
export const APP_NAV_ITEM =
  "inline-flex h-8 flex-1 shrink-0 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap outline-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-background/70 hover:text-foreground active:not-disabled:translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:flex-none";
export const APP_NAV_ITEM_ACTIVE = "bg-background text-foreground shadow-xs";
export const APP_NAV_ITEM_INACTIVE = "text-muted-foreground";

// 行内图标按钮（模型页服务行编辑/测试/拉取/删除共用）：图标方钮，危险变体
// 在使用处以 ${ROW_ICON_BUTTON} 前缀追加 destructive 悬停色
export const ROW_ICON_BUTTON =
  "inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-background text-foreground outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 hover:bg-accent hover:text-accent-foreground active:not-disabled:translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";

export const INPUT =
  "h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

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
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none transition-[border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

export const TOGGLE =
  "relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-input outline-none transition-colors duration-150 checked:bg-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 before:absolute before:left-0.5 before:top-0.5 before:h-4 before:w-4 before:rounded-full before:bg-background before:shadow-sm before:transition-transform before:duration-150 checked:before:translate-x-4 active:not-disabled:before:scale-90";

// 带状态文字的胶囊开关（市场「启/停」状态条在用）：胶囊内居中显示 data-state-text，
// 旋钮位移随 --sw-width 自动计算；v4 的 translate 与 scale 是独立属性，
// checked + active 时位移与按下缩小自动叠加，无需成对规则
// 用法：<input type="checkbox" className={TOGGLE_LABELED} data-state-text="Enabled">
// - data-state-text：胶囊内文字（随状态切换由调用方更新）
// - --sw-width：胶囊宽度（默认 6.25rem，容纳最长英文 "Disabled"）
export const TOGGLE_LABELED =
  "relative h-6 w-[var(--sw-width,6.25rem)] shrink-0 cursor-pointer appearance-none rounded-full bg-input outline-none transition-colors duration-200 checked:bg-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 before:absolute before:left-0.5 before:top-0.5 before:h-5 before:w-5 before:rounded-full before:bg-background before:shadow-sm before:transition-transform before:duration-[250ms] before:ease-[cubic-bezier(0.34,1.56,0.64,1)] checked:before:translate-x-[calc(var(--sw-width,6.25rem)_-_24px)] after:pointer-events-none after:absolute after:left-1/2 after:top-1/2 after:z-[1] after:-translate-x-1/2 after:-translate-y-1/2 after:whitespace-nowrap after:text-xs after:font-medium after:leading-none after:opacity-70 after:transition-[color,opacity] after:duration-200 after:content-[attr(data-state-text)] checked:after:text-primary-foreground checked:after:opacity-100 active:not-disabled:before:scale-85";
