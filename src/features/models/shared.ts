// 模型模块共享常量与纯函数：协议/推理档枚举、目录家族过滤、token 缩写、
// URL 规整与校验。组件只做呈现，可断言的逻辑都收在这里。

import type { ModelCatalogEntry, ModelEntry, ProviderConfig } from "@/shared/types";
import { MODEL_PRESETS } from "@/shared/lib/model-presets.generated";

// dsh pi-ai 适配器支持的 wire 协议（PROTOCOLS 表，most-reached first）
export const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
// pi-ai ModelThinkingLevel 全集（escalation order）
export const EFFORT_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// 目录快照过期窗口与候选截断（浮层不渲染全量 4000+ 条）
export const CATALOG_STALE_SECS = 24 * 60 * 60;
export const SUGGESTION_LIMIT = 50;
// 两步删除的还原窗口（PI 同款交互：3 秒未确认自动还原）
export const DELETE_CONFIRM_MS = 3000;

export { MODEL_PRESETS };
export type { ModelPreset } from "@/shared/lib/model-presets.generated";

const PRESET_BY_ROUTE = new Map(MODEL_PRESETS.map((preset) => [preset.id, preset] as const));

export type ProviderModelChoice = {
  id: string;
  contextWindow: number | null;
  inherited: boolean;
};

/**
 * Provider 的有效模型目录：显式 models 一旦存在即覆盖内置目录；只有 models=[]
 * 且 route 命中同版本 pi-ai 预设时，才投影继承目录。这里只返回选择视图，绝不
 * 把继承模型物化回 settings.yaml。
 */
export function providerModelChoices(provider: ProviderConfig): ProviderModelChoice[] {
  if (provider.models.length > 0) {
    return provider.models.map((model) => ({
      id: model.id,
      contextWindow: model.contextWindow ?? null,
      inherited: false,
    }));
  }

  const preset = PRESET_BY_ROUTE.get(provider.route.trim());
  return (preset?.modelIds ?? []).map((id) => ({
    id,
    contextWindow: null,
    inherited: true,
  }));
}

export function firstProviderModelId(provider: ProviderConfig): string | null {
  return providerModelChoices(provider)[0]?.id ?? null;
}

export type ProviderConnectionTarget = {
  baseURL: string;
  api: string;
  model: string;
};

/**
 * 连接测试所需的有效路由：显式连接字段优先，内置 route 缺字段时继承同版本预设。
 * 只做运行时投影，不把继承值写回 settings.yaml。
 */
export function providerConnectionTarget(provider: ProviderConfig): ProviderConnectionTarget | null {
  const preset = PRESET_BY_ROUTE.get(provider.route.trim());
  const rawBaseURL = provider.baseURL?.trim() || preset?.baseUrl?.trim() || "";
  const baseURL = rawBaseURL ? normalizeBaseUrl(rawBaseURL) : "";
  const api = provider.api?.trim() || preset?.api?.trim() || "";
  const model = firstProviderModelId(provider);
  if (!baseURL || !api || !model) return null;
  return { baseURL, api, model };
}

export const emptyProvider = (): ProviderConfig => ({
  route: "",
  displayName: null,
  baseURL: null,
  api: "openai-completions",
  apiKeyEnv: null,
  models: [],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
});

export const emptyModelEntry = (id: string): ModelEntry => ({
  id,
  name: null,
  contextWindow: null,
  maxTokens: null,
  input: null,
  reasoningEfforts: null,
  extra: null,
});

// wire 协议 → 目录家族；协议未设置时不过滤（null）
export const familyOf = (api: string | null): "anthropic" | "openai" | null =>
  api === "anthropic-messages" ? "anthropic" : api ? "openai" : null;

/** token 数缩写：262144 → "262K"、1048576 → "1M"（目录缺失返回 null） */
export function fmtTokens(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return String(n);
}

/** Base URL 失焦规整：剥离 /chat/completions、/responses、/messages、/models 尾路径与尾斜杠 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  url = url.replace(/\/(chat\/completions|responses|messages|models)$/i, "");
  return url.replace(/\/+$/, "");
}

export function validateBaseUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "Enter a valid http:// or https:// URL.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Enter a valid http:// or https:// URL.";
  }
  if (!parsed.hostname) return "Enter a valid http:// or https:// URL.";
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return "Enter a valid http:// or https:// URL.";
  }
  return null;
}

/** 推理档声明在 UI 可编辑形态上的投影：null=继承，false=手写声明不支持（保留），map=档位表 */
export type ReasoningView =
  | { kind: "inherit" }
  | { kind: "disabled" }
  | { kind: "levels"; levels: Map<string, string | null> };

export function reasoningView(entry: ModelEntry): ReasoningView {
  if (entry.reasoningEfforts == null) return { kind: "inherit" };
  if (typeof entry.reasoningEfforts === "boolean") return { kind: "disabled" };
  // 绑定类型是可选属性（string | null | undefined）：归一化为 null=不发参
  const levels = new Map<string, string | null>();
  for (const [k, v] of Object.entries(entry.reasoningEfforts)) {
    levels.set(k, v ?? null);
  }
  return { kind: "levels", levels };
}

/** 输入模态三态投影：null=继承目录；["text"]=关；含 image=开；其余=手写自定义（保留） */
export type InputView = "inherit" | "text" | "text-image" | "custom";

export function inputView(entry: ModelEntry): InputView {
  const input = entry.input;
  if (input == null) return "inherit";
  const set = new Set(input);
  if (set.size === 1 && set.has("text")) return "text";
  if (set.has("image")) return "text-image";
  return "custom";
}

/** 目录按 id 索引（候选元数据查询） */
export function catalogIndex(catalog: ModelCatalogEntry[]): Map<string, ModelCatalogEntry> {
  return new Map(catalog.map((e) => [e.id, e]));
}
