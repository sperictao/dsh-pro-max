# DESIGN.md

从现有代码捕获的视觉系统（dsh-pro-max，Tauri + React + Tailwind v4）。
（2026-09-03：首页曾短暂重设计为状态英雄区 + 双卡，已按用户决定回退到 v0.6.2 单卡形态；
同日重新引入 codex-pro-max 状态球并美化——eyebrow 标题行、模式行两行制、Restart 描边、
max-w-3xl 单列居中。本文件描述该次美化后的现状。）

## Theme

- 双模式（亮/暗）× 42 主题族（`src/themes.css`，构建产物勿手改，由 `scripts/build-themes.mjs` 产出）。默认族 **vercel**。
- 一切颜色经 shadcn 语义 token：`background/card/muted/primary/secondary/accent/destructive/border/input/ring`（`@theme inline` 桥接 Tailwind）。
- 固定语义色不随族：`--status-ok`（绿，运行）、`--status-warn`（黄，进行中）；错误随 `--destructive`。状态球渐变、更新徽标、状态徽章、时间轴等一切状态指示均由这三个 token 派生（`color-mix`），亮暗/主题族切换不变语义角色。

## Typography

- 单一字族，由主题族 `--font-sans` 提供；等宽 `--font-mono`（版本号、URL、代码）。
- rem 固定刻度（产品寄存器，无 fluid clamp）：卡头标题 `text-sm font-medium`；区块标题 `text-sm font-medium`；正文/状态 `text-sm`；辅助文字走 `ui.ts` 的 `MUTED`（text-xs opacity-60）/ `MUTED_STRONG`（强调 70），业务 TSX 禁止 `text-[9px]`/`text-[11px]` 等随意字号；市场页标题 `text-base font-semibold`。

## Color & Components

- 按钮（`src/shared/lib/ui.ts` 共享配方）：`BTN_PRIMARY`（实心主色，禁用落 muted 灰）、`BTN_DANGER`（实心 destructive，危险按钮唯一配方，禁用同 BTN_PRIMARY）、`BTN_OUTLINE`/`BTN`/`BTN_SM`（描边次操作，小档统一 `text-xs`）、`BTN_DANGER_SM`（小描边危险）、`ROW_ICON_BUTTON`（行内图标方钮，危险悬停色在使用处追加）。
- 状态徽章 `.status-badge`：dot 变体 running/failed/starting/stopping + `ok` 变体（语义绿，市场页安装/启用事实共用），`StateBadge`（市场卡）是其薄包装。
- Toggle：原生 checkbox + `TOGGLE`（设置侧）与 `TOGGLE_LABELED`（带状态文字胶囊，市场启停）配方，同一 `ui.ts` 事实来源。
- 卡片：区块卡 `rounded-xl border border-border bg-card p-4`（`ui.ts` 的 `PANEL`）；行内盒 `rounded-lg border`；胶囊 `rounded-full border px-2.5 py-0.5 text-xs`；地址芯片 `rounded-full bg-primary/15 font-mono text-xs text-primary`。
- 模态：遮罩/面板单一配方 `MODAL_OVERLAY`/`MODAL_PANEL`（`z-50` + `bg-black/50` + 面板 `rounded-xl border-border bg-card`）；同层多模态按 DOM 序叠放（后渲染者在上），Toaster 位于 App 树末位故 toast 恒浮于对话框上。z 阶梯唯一例外：ProviderDialog 高级设置叠层面板 `z-70`、关闭键 `z-80`（`advanced-settings.css`，scrim 同步 `rgb(0 0 0 / 0.5)`）。
- 导航：顶栏与市场二级 tab 同用 `APP_NAV*` segmented（muted 圆角底无外框，active 白底 `shadow-xs`；二级嵌在整行分隔条内，激活态带无样式的 `active` 字面量类，是 market-tabs-a11y 的判定契约）；设置侧栏 `SETTINGS_NAV_ITEM`（w-52，ui.ts 配方），active 态 `bg-accent`。
- 时间轴 `.timeline-node[data-state]`：done 绿✓ / pending 虚线圈 / running 黄脉冲 / failed 红✕ + problem/solution 盒（卡内 `border-t` 分隔，标题「Setup Progress」）。
- Toggle：原生 checkbox + `TOGGLE` 配方（label 包裹）。

## Layout

- 各视图统一：顶栏（border-b，px-4 py-2.5）+ `p-6` 内容区 + `overflow-y-auto`。
- 首页：单列居中，默认 `max-w-3xl`、宽屏按断点放宽（lg→4xl、xl→5xl、2xl→6xl，永不拉满边缘），四段自上而下——eyebrow 标题行（`text-xs tracking-widest opacity-60` 服务名 + 版本胶囊随行，右侧仅条件操作胶囊）→ 状态球区（170px 呼吸球 + 24px 状态文字 + 模式说明小字，视觉重心）→ 访问模式行卡（两行制：模式名即 toggle 语义标签 + 说明小字）→ 主卡（条件诊断块 + 地址行 + 三按钮行 Start/Stop/Restart 主次分明 + 卡内时间轴）。
- 市场：全宽 `grid-cols-1 xl:grid-cols-2` 卡片网格；设置：`w-52` 侧栏 + 内容列。
- 模型：`p-6`、`max-w-4xl` 单列 Provider Studio。主视图只保留 Defaults 卡、AI services 管理卡与 models.dev 状态行；服务行展示名称/默认与凭据状态/host/首个模型，并提供设默认、连通性探测、编辑、两步删除。新增/编辑进入居中对话框：先选服务，预设服务只暴露高频字段，自定义服务展示完整连接字段；模型双栏与高级设置按需渐进披露。模型域操作保存即落盘并热加载，不再设置页面级二次 Save。

## Motion

- 150–200ms `transition-colors` 为默认；状态动画仅两处（timeline running 脉冲、spinner）。
- 无入场编排、无装饰动效。

## Intentional exceptions

- `.mode-preview`（模式卡预览）：亮/暗固定灰阶硬编码，预览的是模式本身而非主题族，不随主题切换（style.css 内有醒目注释）。
- 状态球 `stopped` 态：中性灰硬编码（灰=停用的视觉惯例，无语义变量对应）。
- 收藏星标等非状态装饰色一律取既有语义 token（如星标金色走 `--status-warn`），不引入新调色板类。
