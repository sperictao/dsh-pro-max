// 集成视图：dsh 控制台（应用主视图）
// 居中窄栏 + 顶部淡光晕；卡片挂载时检测一次状态

import { DshCard } from "./DshCard";

export function IntegrationView() {
  return (
    <main className="relative flex-1 overflow-y-auto p-6" id="integration-view">
      <div aria-hidden className="home-backdrop pointer-events-none absolute inset-x-0 top-0 h-60" />
      <div className="relative mx-auto flex w-full max-w-3xl flex-col">
        <DshCard />
      </div>
    </main>
  );
}
