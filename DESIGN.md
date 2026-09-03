# DESIGN.md

从现有代码捕获的视觉系统（dsh-pro-max，Tauri + React + Tailwind v4）。
（2026-09-03：首页曾短暂重设计为状态英雄区 + 双卡，已按用户决定回退到 v0.6.2 单卡形态；
同日重新引入 codex-pro-max 状态球并美化——eyebrow 标题行、模式行两行制、Restart 描边、
max-w-3xl 单列居中。本文件描述该次美化后的现状。）

## Theme

- 双模式（亮/暗）× 42 主题族（`src/themes.css`，构建产物勿手改，由 `scripts/build-themes.mjs` 产出）。默认族 **vercel**。
- 一切颜色经 shadcn 语义 token：`background/card/muted/primary/secondary/accent/destructive/border/input/ring`（`@theme inline` 桥接 Tailwind）。
- 固定语义色不随族：`--status-ok`（绿，运行）、`--status-warn`（黄，进行中）；错误随 `--destructive`。

## Typography

- 单一字族，由主题族 `--font-sans` 提供；等宽 `--font-mono`（版本号、URL、代码）。
- rem 固定刻度（产品寄存器，无 fluid clamp）：卡头标题 `text-sm font-medium`；区块标题 `text-sm font-medium`；正文/状态 `text-sm`；辅助 `text-xs opacity-60`；市场页标题 `text-base font-semibold`。

## Color & Components

- 按钮（`src/shared/lib/ui.ts` 共享配方）：`BTN_PRIMARY`（实心主色，禁用落 muted 灰）、`BTN_DESTRUCTIVE`（实心 destructive，整体半透明禁用；首页 Stop 在用）、`BTN_DANGER`/`BTN_OUTLINE`（实心危险/描边次操作；首页 Restart 与市场页在用）、`BTN`/`BTN_SM`（小描边）、`BTN_DANGER_SM`。
- 卡片：区块卡 `rounded-xl border border-border bg-card p-4`；行内盒 `rounded-lg border`；胶囊 `rounded-full border px-2.5 py-0.5 text-xs`；地址芯片 `rounded-full bg-primary/15 font-mono text-xs text-primary`。
- 导航：`header-btn`（顶栏）/ `nav-item`（设置侧栏 w-52）；active 态 `bg-accent`。
- 时间轴 `.timeline-node[data-state]`：done 绿✓ / pending 虚线圈 / running 黄脉冲 / failed 红✕ + problem/solution 盒（卡内 `border-t` 分隔，标题「Setup Progress」）。
- Toggle：原生 checkbox + `TOGGLE` 配方（label 包裹）。

## Layout

- 各视图统一：顶栏（border-b，px-4 py-2.5）+ `p-6` 内容区 + `overflow-y-auto`。
- 首页：单列居中 `max-w-3xl`，四段自上而下——eyebrow 标题行（`text-xs tracking-widest opacity-60` 服务名 + 版本胶囊随行，右侧仅条件操作胶囊）→ 状态球区（170px 呼吸球 + 24px 状态文字 + 模式说明小字，视觉重心）→ 访问模式行卡（两行制：模式名即 toggle 语义标签 + 说明小字）→ 主卡（条件诊断块 + 地址行 + 三按钮行 Start/Stop/Restart 主次分明 + 卡内时间轴）。
- 市场：全宽 `grid-cols-1 xl:grid-cols-2` 卡片网格；设置：`w-52` 侧栏 + 内容列；模型：`p-6` 单列 + `grid-cols-2` 表单格。

## Motion

- 150–200ms `transition-colors` 为默认；状态动画仅两处（timeline running 脉冲、spinner）。
- 无入场编排、无装饰动效。
