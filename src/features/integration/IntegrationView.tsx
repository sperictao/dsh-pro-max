// 集成视图：dsh 首页主视图（标题行 + 状态球 + dsh 卡片，组合见 DshCard）
// 卡片挂载时检测一次状态

import { DshCard } from "./DshCard";

export function IntegrationView() {
  return (
    <main className="flex-1 overflow-y-auto p-6" id="integration-view">
      <DshCard />
    </main>
  );
}
