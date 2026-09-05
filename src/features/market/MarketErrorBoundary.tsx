// 市场域错误边界（G3）：渲染崩溃落在恢复面板而不是白屏。三条出路——重载
// （重置边界状态重挂载）、复制错误（message + 组件栈，贴给任意 agent）、
// 原始错误 details 展开，与 B 方 dsh-market #514 同款形态。只包市场域：
// 崩溃是域内渲染事实，不拖累整壳其它页面
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import { BTN_OUTLINE, BTN_PRIMARY } from "@/shared/lib/ui";
import { useAppStore } from "@/shared/store";

interface BoundaryState {
  error: Error | null;
}

export class MarketErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  // 组件栈只在 componentDidCatch 可得，记入实例供复制出口取用
  componentStack: string | null = null;

  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(_error: Error, info: ErrorInfo) {
    this.componentStack = info.componentStack ?? null;
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <CrashPanel
        error={error}
        stack={this.componentStack}
        onReload={() => {
          this.componentStack = null;
          this.setState({ error: null });
        }}
      />
    );
  }
}

function CrashPanel({
  error,
  stack,
  onReload,
}: {
  error: Error;
  stack: string | null;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  const copy = async () => {
    // 修复上下文与 D2 同一哲学：稳定英文框架，只含错误事实（message + 组件栈）
    const text = [
      "Plugin market crashed — repair context",
      `Error: ${error.message}`,
      ...(stack ? ["", "Component stack:", stack] : []),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast(i18n.t("Error details copied"), "info");
    } catch (e) {
      toast(i18n.t("Failed to copy: {{error}}", { error: String(e) }), "error");
    }
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8" role="alert" id="market-crash-panel">
      <h2 className="text-sm font-semibold">{t("The plugin market crashed")}</h2>
      <p className="max-w-md text-center text-xs opacity-60">
        {t("A rendering error occurred. Reload the market, or copy the error to report it.")}
      </p>
      <div className="flex items-center gap-2">
        <button className={BTN_PRIMARY} onClick={onReload} id="market-crash-reload">
          {t("Reload")}
        </button>
        <button className={BTN_OUTLINE} onClick={() => void copy()} id="market-crash-copy">
          {t("Copy error")}
        </button>
      </div>
      <details className="max-w-xl">
        <summary className="cursor-pointer text-xs opacity-50">{t("Error details")}</summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs opacity-60">
          {error.message}
          {stack ? `\n${stack}` : ""}
        </pre>
      </details>
    </div>
  );
}
