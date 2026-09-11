// 模型双栏：左栏该服务的候选模型（上游拉取 ∪ models.dev 目录，搜索/全选/点选），
// 右栏已选模型（每条可展开高级面板：显示名/上下文窗口/最大输出/推理档/原生图片输入/目录 PDF 能力）。
// 候选列表由 useProviderModels 以 cache-first SWR 提供；连接指纹变化时旧结果立即失效。

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BTN_DANGER_SM, BTN_SM, INPUT, INPUT_MONO, SELECT } from "@/shared/lib/ui";
import type { ModelCatalogEntry, ModelEntry, ProviderConfig } from "@/shared/types";
import {
  EFFORT_OPTIONS,
  MODEL_PRESETS,
  emptyModelEntry,
  fmtTokens,
  familyOf,
  inputView,
  reasoningView,
  validateBaseUrl,
} from "./shared";

const modelIdKey = (id: string) => id.toLowerCase();
const effortLabel = (level: string) =>
  level === "xhigh" ? "XHigh" : level.charAt(0).toUpperCase() + level.slice(1);

// 左侧候选行是单行 28px；大列表只渲染视口附近节点，完整 candidates 仍承担搜索/全选语义。
const CANDIDATE_ROW_HEIGHT = 28;
const CANDIDATE_VIEWPORT_HEIGHT = 256;
const CANDIDATE_OVERSCAN = 4;
const CANDIDATE_VIRTUALIZE_AT = 40;

export function ModelPanes({
  provider,
  catalog,
  remote,
  fetching,
  fetchError,
  onModelsChange,
  onFetch,
}: {
  provider: ProviderConfig;
  catalog: ModelCatalogEntry[];
  remote: string[] | null;
  fetching: boolean;
  fetchError: string | null;
  onModelsChange: (models: ModelEntry[]) => void;
  onFetch: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [customId, setCustomId] = useState("");
  const [customError, setCustomError] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [candidateScrollTop, setCandidateScrollTop] = useState(0);
  const candidateListRef = useRef<HTMLUListElement>(null);
  const index = useMemo(
    () => new Map(catalog.map((entry) => [modelIdKey(entry.id), entry] as const)),
    [catalog],
  );

  const selectedIds = new Set(provider.models.map((m) => modelIdKey(m.id)));
  const family = familyOf(provider.api);
  const preset = MODEL_PRESETS.find((entry) => entry.id === provider.route.trim()) ?? null;
  // 与 useProviderModels 的 active/canDiscover 边界保持一致：已知服务在 Add/Edit
  // 没有显式凭据时不会发匿名探测，自定义端点仍允许无鉴权服务。
  const connectionReadyForFetch =
    Boolean(provider.baseURL?.trim()) &&
    validateBaseUrl(provider.baseURL ?? "") == null &&
    (!preset || Boolean(provider.apiKeyEnv?.trim()));

  // 候选池：live 结果优先；已知服务尚未 live 拉取时只回落该服务自己的内置目录，
  // 不再把同协议家族的其它 Provider 模型冒充成“Models from this service”。
  const candidates = useMemo(() => {
    const pool = new Map<string, { id: string; name: string; context: number | null }>();
    const push = (id: string, name?: string, context?: number | null) => {
      const key = modelIdKey(id);
      pool.set(key, {
        id,
        name: name ?? id,
        context: context ?? index.get(key)?.context ?? null,
      });
    };
    if (remote) {
      for (const id of remote) push(id);
    } else if (preset) {
      for (const id of preset.modelIds) {
        const published = index.get(modelIdKey(id));
        push(id, published?.name, published?.context);
      }
    } else {
      for (const e of catalog) {
        if (!family || e.family === family) push(e.id, e.name, e.context);
      }
    }
    // Model ID identity follows PI-Desktop: case-insensitive for merging/selection, original spelling for display/save.
    // 已选但上游/目录不再返回的模型仍保留在完整候选池，未搜索时可继续对照和取消。
    for (const m of provider.models) {
      const key = modelIdKey(m.id);
      if (!pool.has(key)) {
        pool.set(key, {
          id: m.id,
          name: index.get(key)?.name ?? m.name ?? m.id,
          context: index.get(key)?.context ?? null,
        });
      }
    }
    const q = query.trim().toLowerCase();
    const rows = [...pool.values()];
    // 搜索控件明确承诺 Search model ID，因此只按 ID 做大小写不敏感包含匹配；
    // display name 继续只作为展示元数据，避免出现“看似按 ID 搜索、实际命中名称”的隐藏语义。
    const visible = q ? rows.filter((e) => e.id.toLowerCase().includes(q)) : rows;
    return visible;
  }, [remote, catalog, family, query, provider.models, index, preset]);

  useEffect(() => {
    // 上游/目录切换会改变候选顺序；回到顶部避免保留一个已经无意义的旧滚动位置。
    setCandidateScrollTop(0);
    if (candidateListRef.current) candidateListRef.current.scrollTop = 0;
  }, [remote, catalog, family, preset?.id]);

  const candidateWindow = useMemo(() => {
    if (candidates.length <= CANDIDATE_VIRTUALIZE_AT) {
      return { start: 0, end: candidates.length, top: 0, bottom: 0 };
    }
    const visibleRows = Math.ceil(CANDIDATE_VIEWPORT_HEIGHT / CANDIDATE_ROW_HEIGHT);
    const firstVisible = Math.floor(candidateScrollTop / CANDIDATE_ROW_HEIGHT);
    const start = Math.max(0, firstVisible - CANDIDATE_OVERSCAN);
    const end = Math.min(
      candidates.length,
      firstVisible + visibleRows + CANDIDATE_OVERSCAN,
    );
    return {
      start,
      end,
      top: start * CANDIDATE_ROW_HEIGHT,
      bottom: (candidates.length - end) * CANDIDATE_ROW_HEIGHT,
    };
  }, [candidates.length, candidateScrollTop]);
  const renderedCandidates = candidates.slice(candidateWindow.start, candidateWindow.end);
  const isSearching = query.trim().length > 0;

  const visibleSelected = candidates.filter((e) => selectedIds.has(modelIdKey(e.id)));
  const allChecked = visibleSelected.length > 0 && visibleSelected.length === candidates.length;
  const someChecked = visibleSelected.length > 0 && visibleSelected.length < candidates.length;

  const toggle = (id: string) => {
    const key = modelIdKey(id);
    if (selectedIds.has(key)) {
      if (expanded != null && modelIdKey(expanded) === key) setExpanded(null);
      onModelsChange(provider.models.filter((m) => modelIdKey(m.id) !== key));
    } else {
      onModelsChange([...provider.models, emptyModelEntry(id)]);
    }
  };

  const removeModel = (id: string) => {
    const key = modelIdKey(id);
    if (expanded != null && modelIdKey(expanded) === key) setExpanded(null);
    onModelsChange(provider.models.filter((m) => modelIdKey(m.id) !== key));
  };

  const toggleAll = () => {
    if (allChecked) {
      const visible = new Set(candidates.map((e) => modelIdKey(e.id)));
      onModelsChange(provider.models.filter((m) => !visible.has(modelIdKey(m.id))));
    } else {
      const additions = candidates
        .filter((e) => !selectedIds.has(modelIdKey(e.id)))
        .map((e) => emptyModelEntry(e.id));
      onModelsChange([...provider.models, ...additions]);
    }
  };

  const addCustom = () => {
    const id = customId.trim();
    if (!id) {
      setCustomError(true);
      return;
    }
    if (selectedIds.has(modelIdKey(id))) {
      setCustomError(true);
      return;
    }
    setCustomError(false);
    setCustomId("");
    setExpanded(id);
    onModelsChange([...provider.models, emptyModelEntry(id)]);
  };

  const patchModel = (id: string, patch: Partial<ModelEntry>) => {
    onModelsChange(provider.models.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  };

  return (
    <div className="grid grid-cols-2 gap-4" data-testid="model-panes">
      {/* —— 左栏：候选 —— */}
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={allChecked}
                disabled={candidates.length === 0}
                ref={(el) => {
                  if (el) el.indeterminate = someChecked;
                }}
                onChange={toggleAll}
                aria-label={t("Select all")}
              />
              {t("Models from this service")}
            </label>
            {isSearching && (
              <span
                className="shrink-0 rounded bg-muted px-1.5 text-xs opacity-70"
                role="status"
                aria-live="polite"
              >
                {t("{{count}} models", { count: candidates.length })}
              </span>
            )}
          </div>
          <button
            type="button"
            className={BTN_SM}
            disabled={fetching || !connectionReadyForFetch}
            onClick={onFetch}
            title={t("Fetch models")}
          >
            {fetching ? t("Loading models…") : t("Fetch list")}
          </button>
        </div>
        <input
          type="search"
          className={INPUT}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCandidateScrollTop(0);
            if (candidateListRef.current) candidateListRef.current.scrollTop = 0;
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
              setCandidateScrollTop(0);
              if (candidateListRef.current) candidateListRef.current.scrollTop = 0;
            }
          }}
          placeholder={t("Search model ID…")}
          aria-label={t("Search model ID…")}
        />
        {fetchError && (
          <p role="alert" className="text-xs text-destructive">
            {fetchError}
            <button type="button" className={BTN_SM + " ml-2"} onClick={onFetch}>
              {t("Retry")}
            </button>
          </p>
        )}
        {!remote && !fetching && !fetchError && !provider.baseURL?.trim() && (
          <p className="text-xs opacity-60">{t("Enter a base URL to load models.")}</p>
        )}
        {remote && remote.length === 0 && !fetchError && (
          <p className="text-xs opacity-60">
            {t("This service returned no models. Add a model ID below.")}
          </p>
        )}
        <ul
          ref={candidateListRef}
          className="max-h-64 overflow-y-auto"
          aria-label={t("Models from this service")}
          onScroll={(event) => setCandidateScrollTop(event.currentTarget.scrollTop)}
          data-total-count={candidates.length}
          data-rendered-count={renderedCandidates.length}
        >
          {candidateWindow.top > 0 && (
            <li aria-hidden="true" role="presentation" style={{ height: candidateWindow.top }} />
          )}
          {renderedCandidates.map((e, offset) => {
            const checked = selectedIds.has(modelIdKey(e.id));
            const tokens = fmtTokens(e.context);
            const absoluteIndex = candidateWindow.start + offset;
            return (
              <li
                key={e.id}
                aria-posinset={absoluteIndex + 1}
                aria-setsize={candidates.length}
              >
                <label
                  className="flex cursor-pointer items-baseline gap-2 rounded px-1 py-1 text-sm hover:bg-accent"
                  style={{ height: CANDIDATE_ROW_HEIGHT }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(e.id)}
                    aria-label={e.id}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{e.id}</span>
                  {e.name !== e.id && (
                    <span className="max-w-24 truncate text-xs opacity-60">{e.name}</span>
                  )}
                  {tokens && <span className="shrink-0 text-xs opacity-60">{tokens}</span>}
                </label>
              </li>
            );
          })}
          {candidateWindow.bottom > 0 && (
            <li aria-hidden="true" role="presentation" style={{ height: candidateWindow.bottom }} />
          )}
          {candidates.length === 0 && isSearching && (
            <li className="px-1 py-2 text-xs opacity-60">{t("No matching models")}</li>
          )}
        </ul>
        <div className="mt-1 flex flex-col gap-1 border-t border-border pt-2">
          <div className="flex items-center gap-2">
            <input
              className={`${INPUT_MONO} flex-1`}
              value={customId}
              onChange={(e) => {
                setCustomId(e.target.value);
                setCustomError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom();
                }
              }}
              placeholder={t("Enter a model ID, e.g. my-model-v2")}
              aria-label={t("Custom model ID")}
            />
            <button type="button" className={BTN_SM} onClick={addCustom}>
              {t("Add custom model")}
            </button>
          </div>
          {customError && (
            <p role="alert" className="text-xs text-destructive">
              {customId.trim() ? t("Model already added") : t("Enter a model ID first")}
            </p>
          )}
          <p className="text-xs opacity-60">{t("Add an ID the catalog does not publish yet.")}</p>
        </div>
      </div>

      {/* —— 右栏：已选 —— */}
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          {t("Model settings")}
          <span className="rounded bg-muted px-1.5 text-xs opacity-70">{provider.models.length}</span>
        </div>
        {provider.models.length === 0 && (
          <p className="text-xs opacity-60">{t("No models chosen yet. Pick one from the list.")}</p>
        )}
        <ul className="flex flex-col gap-1 overflow-y-auto" aria-label={t("Model settings")}>
          {provider.models.map((m) => {
            const catalogEntry = index.get(modelIdKey(m.id));
            const contextTokens = fmtTokens(m.contextWindow ?? catalogEntry?.context ?? null);
            const outputTokens = fmtTokens(m.maxTokens ?? catalogEntry?.maxTokens ?? null);
            const isExpanded = expanded === m.id;
            const view = reasoningView(m);
            const alias = m.name?.trim();
            return (
              <li key={m.id} className="rounded border border-border" data-model-id={m.id}>
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs" title={m.id}>
                      {m.id}
                    </span>
                    {alias && alias !== m.id && (
                      <span className="block truncate text-xs opacity-60" title={alias}>
                        {alias}
                      </span>
                    )}
                  </div>
                  {(contextTokens || outputTokens) && (
                    <span className="shrink-0 text-xs opacity-60">
                      {contextTokens ?? "—"} · {outputTokens ?? "—"}
                    </span>
                  )}
                  <button
                    type="button"
                    className={BTN_SM}
                    aria-expanded={isExpanded}
                    onClick={() => setExpanded(isExpanded ? null : m.id)}
                  >
                    {t("Advanced")}
                  </button>
                  <button
                    type="button"
                    className={BTN_DANGER_SM}
                    onClick={() => removeModel(m.id)}
                    aria-label={t("Remove model")}
                    title={t("Remove model")}
                  >
                    ✕
                  </button>
                </div>
                {isExpanded && (
                  <ModelAdvancedPanel
                    model={m}
                    catalogEntry={catalogEntry ?? null}
                    onChange={(patch) => patchModel(m.id, patch)}
                  />
                )}
                {view.kind === "disabled" && (
                  <p className="px-2 pb-1.5 text-xs opacity-60">
                    {t("Hand-written declaration: reasoning disabled (kept as-is).")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ============ 每模型高级面板 ============

function ModelAdvancedPanel({
  model,
  catalogEntry,
  onChange,
}: {
  model: ModelEntry;
  catalogEntry: ModelCatalogEntry | null;
  onChange: (patch: Partial<ModelEntry>) => void;
}) {
  const { t } = useTranslation();
  const view = reasoningView(model);
  const levels = view.kind === "levels" ? view.levels : new Map<string, string | null>();
  const enabledLevels = EFFORT_OPTIONS.filter((l) => levels.has(l));
  const publishedReasoningLevels = EFFORT_OPTIONS.filter((level) =>
    catalogEntry?.reasoningLevels?.includes(level),
  );
  // 与 modelReasoningCapability 保持同一继承语义：目录明确支持 reasoning 但未给出
  // 档位时，仍使用 low / medium / high 的兼容默认。按钮继续只表示“显式覆盖”，
  // 不把继承档位伪装成已按下的 override。
  const inheritedReasoningLevels =
    catalogEntry?.reasoning === true
      ? publishedReasoningLevels.length > 0
        ? publishedReasoningLevels
        : (["low", "medium", "high"] as const)
      : [];
  const thinkingInheritId = `thinking-levels-inherit-${model.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const iview = inputView(model);
  const publishedCapabilities = new Set(catalogEntry?.capabilities ?? []);
  const publishedVision =
    publishedCapabilities.has("vision") || Boolean(catalogEntry?.input?.includes("image"));
  const publishedPdf =
    publishedCapabilities.has("pdf") || Boolean(catalogEntry?.input?.includes("pdf"));
  const publishedImageInputKnown = catalogEntry?.input != null || catalogEntry?.capabilities != null;
  const inheritedInputLabel = publishedImageInputKnown
    ? `${t("Follow catalog")} · ${publishedVision ? t("Text and images") : t("Text only")}`
    : t("Follow catalog");

  const toggleLevel = (level: string) => {
    const base = view.kind === "levels" ? levels : new Map<string, string | null>();
    const next = new Map(base);
    if (next.has(level)) {
      next.delete(level);
    } else {
      next.set(level, level === "off" ? null : level);
    }
    onChange({ reasoningEfforts: next.size > 0 ? Object.fromEntries(next) : null });
  };

  const setSpelling = (level: string, spelling: string) => {
    const next = new Map(levels);
    next.set(level, spelling.trim() ? spelling.trim() : null);
    onChange({ reasoningEfforts: Object.fromEntries(next) });
  };

  const setInputView = (next: "inherit" | "text" | "text-image" | "custom") => {
    // custom = 非 llm-pi-ai 原生模态（如 pdf/audio）或无法无损投影的手写列表：保持原样。
    if (next === "custom") return;
    onChange({ input: next === "inherit" ? null : next === "text" ? ["text"] : ["text", "image"] });
  };

  const numberField = (
    label: string,
    value: number | null,
    onApply: (v: number | null) => void,
    ariaLabel: string,
  ) => (
    <label className="flex flex-col gap-1 text-xs opacity-70">
      {label}
      <input
        type="number"
        min={1}
        className={INPUT_MONO}
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          const n = raw === "" ? null : Number(raw);
          onApply(n != null && Number.isInteger(n) && n > 0 ? n : null);
        }}
        placeholder={t("Inherit")}
        aria-label={ariaLabel}
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-3 border-t border-border px-2 py-2" data-testid="model-advanced">
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-xs opacity-70">
          {t("Alias")}
          <input
            className={INPUT}
            value={model.name ?? ""}
            onChange={(e) => onChange({ name: e.target.value || null })}
            placeholder={t("Inherit")}
            aria-label={t("Alias")}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          {numberField(t("Context window"), model.contextWindow, (v) => onChange({ contextWindow: v }), t("Context window"))}
          {numberField(t("Max output"), model.maxTokens, (v) => onChange({ maxTokens: v }), t("Max output"))}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs opacity-70">{t("Thinking levels")}</span>
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t("Thinking levels")}
          aria-describedby={view.kind === "inherit" ? thinkingInheritId : undefined}
        >
          {EFFORT_OPTIONS.map((level) => {
            const on = levels.has(level);
            return (
              <button
                key={level}
                type="button"
                className={`${BTN_SM} ${on ? "bg-primary text-primary-foreground" : ""}`}
                aria-label={level}
                aria-pressed={on}
                onClick={() => toggleLevel(level)}
              >
                {effortLabel(level)}
              </button>
            );
          })}
        </div>
        {view.kind === "inherit" && (
          <p
            id={thinkingInheritId}
            data-testid="thinking-levels-inherit"
            className="text-xs opacity-60"
          >
            {t("Follow catalog")}
            {inheritedReasoningLevels.length > 0 &&
              ` · ${inheritedReasoningLevels.map(effortLabel).join(", ")}`}
          </p>
        )}
        {enabledLevels.filter((l) => l !== "off").length > 0 && (
          <div className="flex flex-wrap gap-2">
            {enabledLevels
              .filter((l) => l !== "off")
              .map((level) => (
                <label key={level} className="flex items-center gap-1 text-xs opacity-70">
                  {effortLabel(level)}
                  <input
                    className={`${INPUT_MONO} h-6 w-24 px-1 text-xs`}
                    value={levels.get(level) ?? ""}
                    onChange={(e) => setSpelling(level, e.target.value)}
                    placeholder={level}
                    aria-label={t("Wire spelling for {{level}}", { level })}
                  />
                </label>
              ))}
          </div>
        )}
      </div>
      {(publishedVision || publishedPdf) && (
        <div className="flex flex-col gap-1" data-testid="published-input-capabilities">
          <span className="text-xs opacity-70">{t("Published capabilities")}</span>
          <div className="flex flex-wrap gap-1">
            {publishedVision && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{t("Vision")}</span>
            )}
            {publishedPdf && <span className="rounded bg-muted px-1.5 py-0.5 text-xs">PDF</span>}
          </div>
          {publishedPdf && (
            <p className="text-xs opacity-60">
              {t(
                "PDF is catalog metadata only. DSH uploads documents as file references; llm-pi-ai does not send PDF content blocks.",
              )}
            </p>
          )}
        </div>
      )}
      <label className="flex flex-col gap-1 text-xs opacity-70">
        {t("Image input")}
        <select
          className={SELECT}
          value={iview === "custom" ? "custom" : iview}
          onChange={(e) => setInputView(e.target.value as "inherit" | "text" | "text-image")}
          aria-label={t("Image input")}
        >
          <option value="inherit">{inheritedInputLabel}</option>
          <option value="text">{t("Text only")}</option>
          <option value="text-image">{t("Text and images")}</option>
          {iview === "custom" && <option value="custom">{t("Custom (kept as-is)")}</option>}
        </select>
      </label>
    </div>
  );
}
