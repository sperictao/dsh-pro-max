// 设置行原语：统一"标题+描述 / 控件"版式。
// 行间分隔线由 SettingsCard 的 divide-y 提供，行自身不画边框。

import type { ReactNode } from "react";

// 分组卡片：一组设置行的容器
export function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex max-w-2xl flex-col divide-y divide-border/60 rounded-xl border border-border bg-card p-4 text-card-foreground">
      {children}
    </div>
  );
}

// 水平行：标题+描述在左，紧凑控件（开关/按钮/选择卡）在右
export function SettingRow({ label, description, htmlFor, control }: {
  label: string;
  description?: string;
  htmlFor?: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>
        {description && <span className="text-xs leading-relaxed opacity-60">{description}</span>}
      </div>
      {control}
    </div>
  );
}

// 纵向字段：标题+描述在上，宽控件（文本输入）在下，错误提示随控件
export function SettingField({ label, description, htmlFor, error, children }: {
  label: string;
  description?: string;
  htmlFor?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
      <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>
      {description && <span className="text-xs leading-relaxed opacity-60">{description}</span>}
      {children}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
