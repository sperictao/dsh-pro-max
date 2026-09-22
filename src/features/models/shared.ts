// 模型模块共享常量与纯函数：协议/推理档枚举、目录家族过滤、token 缩写、
// URL 规整与校验。组件只做呈现，可断言的逻辑都收在这里。

import type {
  ModelCatalogEntry,
  ModelCatalogFile,
  ModelCatalogProvider,
  ModelEntry,
  ProviderConfig,
} from "@/shared/types";
import { MODEL_PRESETS } from "@/shared/lib/model-presets.generated";

// dsh pi-ai 适配器支持的 wire 协议（PROTOCOLS 表，most-reached first）
export const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
// pi-ai ModelThinkingLevel 全集（escalation order）
export const EFFORT_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// 目录快照过期窗口
export const CATALOG_STALE_SECS = 24 * 60 * 60;
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
 * 把继承模型物化回 profile 补丁。
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
 * 只做运行时投影，不把继承值写回 profile 补丁。
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

/**
 * DSH llm-pi-ai 当前原生请求模态只有 text/image。空数组与未声明在上游均表示继承；
 * UI 只投影能无损往返的两种显式集合。任何额外模态（pdf/audio/...）都视为 custom，
 * 保持原值，避免用户编辑图片能力时静默丢失手写配置。
 */
export type InputView = "inherit" | "text" | "text-image" | "custom";

export function inputView(entry: ModelEntry): InputView {
  const input = entry.input;
  if (input == null || input.length === 0) return "inherit";
  if (input.length === 1 && input[0] === "text") return "text";
  if (input.length === 2) {
    const set = new Set(input);
    if (set.size === 2 && set.has("text") && set.has("image")) return "text-image";
  }
  return "custom";
}

export type ModelReasoningCapability = {
  kind: "supported" | "unsupported" | "unknown";
  levels: string[];
};

const ALL_EFFORTS = new Set<string>(EFFORT_OPTIONS);

/**
 * 当前 provider/model 的有效推理能力。显式 reasoningEfforts 是最高优先级；
 * 未声明时继承 models.dev（由调用方经 catalogEntryFor 解析出该服务自己的记录，
 * 没有时才回落 canonical 模型）。显式自定义模型又无目录记录时 fail-closed；
 * 继承 dsh 内置目录但 models.dev 暂无记录时保持 unknown，避免错误禁用上游能力。
 */
export function modelReasoningCapability(
  provider: ProviderConfig,
  modelId: string,
  published: ModelCatalogEntry | null,
): ModelReasoningCapability {
  const configured = provider.models.find((model) => model.id === modelId);
  if (configured?.reasoningEfforts != null) {
    if (typeof configured.reasoningEfforts === "boolean") {
      return { kind: "unsupported", levels: [] };
    }
    const levels = EFFORT_OPTIONS.filter((level) =>
      Object.prototype.hasOwnProperty.call(configured.reasoningEfforts, level),
    );
    return levels.length > 0
      ? { kind: "supported", levels: [...levels] }
      : { kind: "unsupported", levels: [] };
  }

  if (published?.reasoning === false) return { kind: "unsupported", levels: [] };
  if (published?.reasoning === true) {
    const levels = (published.reasoningLevels ?? []).filter((level) => ALL_EFFORTS.has(level));
    const normalized = EFFORT_OPTIONS.filter((level) => levels.includes(level));
    return {
      kind: "supported",
      levels: normalized.length > 0 ? [...normalized] : ["low", "medium", "high"],
    };
  }
  if (published) return { kind: "unknown", levels: [...EFFORT_OPTIONS] };

  return provider.models.length > 0
    ? { kind: "unsupported", levels: [] }
    : { kind: "unknown", levels: [...EFFORT_OPTIONS] };
}

// ============ models.dev 目录查询 ============
// 目录与站点同构：providers 是服务商页（每个服务自己发布的模型），models 是
// provider-agnostic 模型页。服务的模型列表优先取它自己的 provider 记录，
// canonical 模型只在服务未命中时兜底，避免把别家的同名 id 当成这家的事实。

const MODEL_KEY = (id: string) => id.trim().toLowerCase();

/** 端点归一：URL 去掉尾斜杠，另给出主机用于同域名匹配 */
function catalogEndpoint(raw: string | null | undefined): { url: string; host: string } | null {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return null;
  try {
    return { url: value.toLowerCase(), host: new URL(value).host.toLowerCase() };
  } catch {
    return { url: value.toLowerCase(), host: "" };
  }
}

/**
 * 服务 → models.dev provider：route 精确命中目录服务商键优先；否则按端点 URL
 * 匹配，退一步按主机匹配（同一主机对应多个目录服务时不猜，回落到家族候选池）。
 */
export function catalogProviderFor(
  catalog: ModelCatalogFile | null,
  provider: ProviderConfig,
): ModelCatalogProvider | null {
  if (!catalog) return null;
  const route = provider.route.trim().toLowerCase();
  if (route) {
    const exact = catalog.providers.find((entry) => entry.id.toLowerCase() === route);
    if (exact) return exact;
  }
  const target = catalogEndpoint(provider.baseURL);
  if (!target) return null;
  const byUrl = catalog.providers.find((entry) => catalogEndpoint(entry.api)?.url === target.url);
  if (byUrl) return byUrl;
  if (!target.host) return null;
  const byHost = catalog.providers.filter(
    (entry) => catalogEndpoint(entry.api)?.host === target.host,
  );
  return byHost.length === 1 ? byHost[0] : null;
}

/**
 * 目录条目：优先该服务自己发布的记录（含它自己的容量与能力数字），
 * 没有才回落 canonical 模型；两侧都没有即 null（调用方 fail-closed 或保持 unknown）。
 */
export function catalogEntryFor(
  catalog: ModelCatalogFile | null,
  provider: ProviderConfig,
  modelId: string,
): ModelCatalogEntry | null {
  if (!catalog) return null;
  const key = MODEL_KEY(modelId);
  if (!key) return null;
  const own = catalogProviderFor(catalog, provider)?.models.find(
    (entry) => MODEL_KEY(entry.id) === key,
  );
  if (own) return own;
  return catalog.models.find((entry) => MODEL_KEY(entry.id) === key) ?? null;
}

/**
 * 目录索引：canonical 模型打底，命中服务的记录覆盖同名 id，供候选元数据与
 * 已选模型的高级设置查询（大小写不敏感）。
 */
export function catalogIndex(
  catalog: ModelCatalogFile | null,
  provider: ProviderConfig,
): Map<string, ModelCatalogEntry> {
  const index = new Map<string, ModelCatalogEntry>();
  for (const entry of catalog?.models ?? []) index.set(MODEL_KEY(entry.id), entry);
  for (const entry of catalogProviderFor(catalog, provider)?.models ?? []) {
    index.set(MODEL_KEY(entry.id), entry);
  }
  return index;
}

/**
 * 服务自己的目录模型列表；服务未命中目录时回落到同协议家族的 provider 模型
 * （协议未设置则全目录按 id 去重），与旧版行为一致但家族按服务自己的声明归类。
 */
export function catalogCandidates(
  catalog: ModelCatalogFile | null,
  provider: ProviderConfig,
): ModelCatalogEntry[] {
  if (!catalog) return [];
  const matched = catalogProviderFor(catalog, provider);
  if (matched) return matched.models;
  const family = familyOf(provider.api);
  const seen = new Set<string>();
  const pool: ModelCatalogEntry[] = [];
  for (const entry of catalog.providers) {
    if (family && entry.family !== family) continue;
    for (const model of entry.models) {
      const key = MODEL_KEY(model.id);
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(model);
    }
  }
  return pool;
}
