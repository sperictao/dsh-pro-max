// 集成视图：dsh 卡片（应用主视图）
// 卡片挂载时检测一次状态

import { useTranslation } from "react-i18next";
import { DshCard } from "./DshCard";

export function IntegrationView() {
  const { t } = useTranslation();
  return (
    <main className="flex-1 overflow-y-auto p-6" id="integration-view">
      <h2 className="mb-4 text-base font-semibold">{t("Integrations")}</h2>
      <DshCard />
    </main>
  );
}
