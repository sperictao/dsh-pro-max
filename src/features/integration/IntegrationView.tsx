// 集成视图：dsh 首页主视图（标题行 + 状态球 + dsh 卡片，组合见 DshCard）
// 卡片挂载时检测一次状态。单列居中，页面宽度与 gutter 由 page-layout.css 统一控制。
// 只渲染被纳管的形态：两档都不纳管不成立（Rust 侧归一化保证至少一档）

import { useAppStore } from "@/shared/store";
import { DesktopCard } from "./DesktopCard";
import { DshCard } from "./DshCard";

export function IntegrationView() {
  const surfaces = useAppStore((s) => s.config?.managed_surfaces);
  const webManaged = surfaces?.includes("web") ?? true;
  const desktopManaged = surfaces?.includes("desktop") ?? false;

  return (
    <main className="flex-1 overflow-y-auto py-6" id="integration-view">
      <div className="app-page-width mx-auto flex w-full flex-col gap-4">
        {webManaged && <DshCard />}
        {desktopManaged && <DesktopCard />}
      </div>
    </main>
  );
}
