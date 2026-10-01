// 目标形态的两件共享界面（ADR 0012）：形态切换（模型页）与形态角标（插件卡片）。
// 同一个形态在全应用只有一个叫法，改文案不会只改一半。

import { useTranslation } from "react-i18next";
import { APP_NAV, APP_NAV_ITEM, APP_NAV_ITEM_ACTIVE, APP_NAV_ITEM_INACTIVE } from "../lib/ui";
import type { DshSurface } from "../types";

/// 形态的界面叫法
export function useSurfaceLabel(): (surface: DshSurface) => string {
  const { t } = useTranslation();
  return (surface) => (surface === "web" ? t("Web") : t("Desktop"));
}

/// 形态切换：与顶栏导航同一 segmented 配方。只纳管一档时调用方不渲染它——没有可切的
export function SurfaceSwitch({
  surfaces,
  value,
  onChange,
  id,
}: {
  surfaces: DshSurface[];
  value: DshSurface;
  onChange: (surface: DshSurface) => void;
  id: string;
}) {
  const label = useSurfaceLabel();
  return (
    <nav className={APP_NAV} id={id}>
      {surfaces.map((surface) => {
        const active = surface === value;
        return (
          <button
            key={surface}
            type="button"
            className={`${APP_NAV_ITEM} ${active ? APP_NAV_ITEM_ACTIVE : APP_NAV_ITEM_INACTIVE}`}
            aria-pressed={active}
            onClick={() => onChange(surface)}
          >
            {label(surface)}
          </button>
        );
      })}
    </nav>
  );
}

/// 一个形态上的安装事实：true 已装 / false 未装 / null 不可知（desktop 档桥接未连接）
export type SurfaceFact = { surface: DshSurface; installed: boolean | null };

/// 形态角标：装在哪几档就并列哪几个；不可知的那档显示弱化的「?」角标并给出原因，
/// 绝不缺省成「未安装」。unknownReason 是那档不可知的原因与下一步
export function SurfaceBadges({ facts, unknownReason }: { facts: SurfaceFact[]; unknownReason: string | null }) {
  const { t } = useTranslation();
  const label = useSurfaceLabel();
  return (
    <>
      {facts
        .filter((fact) => fact.installed !== false)
        .map((fact) =>
          fact.installed ? (
            <span
              key={fact.surface}
              className="rounded border border-(--status-ok)/35 px-1.5 py-0.5 text-xs text-(--status-ok)"
              title={fact.surface === "web" ? t("Installed in the web profile") : t("Installed in DeepSeek Harness")}
              data-surface={fact.surface}
            >
              {label(fact.surface)}
            </span>
          ) : (
            <span
              key={fact.surface}
              className={`rounded border border-dashed border-border px-1.5 py-0.5 text-xs text-muted-foreground`}
              title={unknownReason ?? undefined}
              data-surface={fact.surface}
              data-unknown="true"
            >
              {`${label(fact.surface)} ?`}
            </span>
          ),
        )}
    </>
  );
}
