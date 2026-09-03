// 集成视图：dsh 首页主视图（标题行 + 状态球 + dsh 卡片，组合见 DshCard）
// 卡片挂载时检测一次状态。单列居中：默认窗宽 max-w-3xl，宽屏按断点放宽（lg→4xl、xl→5xl、2xl→6xl），永不拉满边缘

import { DshCard } from "./DshCard";

export function IntegrationView() {
  return (
    <main className="flex-1 overflow-y-auto p-6" id="integration-view">
      <div className="mx-auto w-full max-w-3xl lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl">
        <DshCard />
      </div>
    </main>
  );
}
