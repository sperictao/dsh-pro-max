// 模型双栏：左栏该服务的候选模型（上游拉取 ∪ models.dev 目录，搜索/全选/点选），
// 右栏已选模型（每条可展开高级面板：显示名/上下文窗口/最大输出/推理档/图片输入）。
// 端点三元组变更后旧拉取结果不可信，由父组件在变更时撤下（remote 置 null）。

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as cmd from "@/shared/commands";
import { BTN_SM, INPUT, INPUT_MONO, SELECT } from "@/shared/lib/ui";
import type { ModelCatalogEntry, ModelEntry, ProviderConfig } from "@/shared/types";
import {
  catalogIndex,
  EFFORT_OPTIONS,
  emptyModelEntry,
  fmtTokens,
  familyOf,
  inputView,
  reasoningView,
  SUGGESTION_LIMIT,
} from "./shared";

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
  const index = useMemo(() => catalogIndex(catalog), [catalog]);

  const selectedIds = new Set(provider.models.map((m) => m.id));
  const family = familyOf(provider.api);

  // 候选池：上游拉取优先；未拉取时回落目录按协议家族过滤
  const candidates = useMemo(() => {
    const pool: { id: string; name: string; context: number | null }[] = [];
    const push = (id: string, name?: string, context?: number | null) => {
      pool.push({ id, name: name ?? id, context: context ?? index.get(id)?.context ?? null });
    };
    if (remote) {
      for (const id of remote) push(id);
    } else {
      for (const e of catalog) {
        if (!family || e.family === family) push(e.id, e.name, e.context);
      }
    }
    const q = query.trim().toLowerCase();
    const matched = q
      ? pool.filter((e) => e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q))
      : pool;
    // 已选模型也出现在左栏（勾选态），便于对照
    for (const m of provider.models) {
      if (!matched.some((e) => e.id === m.id)) {
        matched.push({ id: m.id, name: index.get(m.id)?.name ?? m.name ?? m.id, context: index.get(m.id)?.context ?? null });
      }
    }
    return matched.slice(0, SUGGESTION_LIMIT);
  }, [remote, catalog, family, query, provider.models, index]);

  const visibleSelected = candidates.filter((e) => selectedIds.has(e.id));
  const allChecked = visibleSelected.length > 0 && visibleSelected.length === candidates.length;
  const someChecked = visibleSelected.length > 0 && visibleSelected.length < candidates.length;

  const toggle = (id: string) => {
    if (selectedIds.has(id)) {
      onModelsChange(provider.models.filter((m) => m.id !== id));
    } else {
      onModelsChange([...provider.models, emptyModelEntry(id)]);
    }
  };

  const toggleAll = () => {
    if (allChecked) {
      const visible = new Set(candidates.map((e) => e.id));
      onModelsChange(provider.models.filter((m) => !visible.has(m.id)));
    } else {
      const additions = candidates
        .filter((e) => !selectedIds.has(e.id))
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
    if (selectedIds.has(id)) {
      setCustomError(true);
      return;
    }
    setCustomError(false);
    setCustomId("");
    onModelsChange([...provider.models, emptyModelEntry(id)]);
  };

  const patchModel = (id: string, patch: Partial<ModelEntry>) => {
    onModelsChange(provider.models.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  };

  return (
    <div className="grid grid-cols-2 gap-4" data-testid="model-panes">
      {/* —— 左栏：候选 —— */}
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = someChecked;
              }}
              onChange={toggleAll}
              aria-label={t("Select all")}
            />
            {t("Models from this service")}
          </label>
          <button
            type="button"
            className={BTN_SM}
            disabled={fetching || !provider.baseURL}
            onClick={onFetch}
            title={t("Fetch models")}
          >
            {fetching ? t("Loading models…") : t("Fetch list")}
          </button>
        </div>
        <input
          className={INPUT}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
        {!remote && !fetching && !fetchError && (
          <p className="text-xs opacity-60">{t("Enter a base URL to load models.")}</p>
        )}
        {remote && remote.length === 0 && !fetchError && (
          <p className="text-xs opacity-60">
            {t("This service returned no models. Add a model ID below.")}
          </p>
        )}
        <ul className="max-h-64 overflow-y-auto" aria-label={t("Models from this service")}>
          {candidates.map((e) => {
            const checked = selectedIds.has(e.id);
            const tokens = fmtTokens(e.context);
            return (
              <li key={e.id}>
                <label className="flex cursor-pointer items-baseline gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
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
          {candidates.length === 0 && query.trim() && (
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
            const tokens = fmtTokens(index.get(m.id)?.context ?? null);
            const isExpanded = expanded === m.id;
            const view = reasoningView(m);
            return (
              <li key={m.id} className="rounded border border-border" data-model-id={m.id}>
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={m.id}>
                    {m.name ?? m.id}
                  </span>
                  {tokens && <span className="shrink-0 text-xs opacity-60">{tokens}</span>}
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
                    className={BTN_SM}
                    onClick={() => toggle(m.id)}
                    aria-label={t("Remove model")}
                  >
                    ✕
                  </button>
                </div>
                {isExpanded && (
                  <ModelAdvancedPanel model={m} onChange={(patch) => patchModel(m.id, patch)} />
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
  onChange,
}: {
  model: ModelEntry;
  onChange: (patch: Partial<ModelEntry>) => void;
}) {
  const { t } = useTranslation();
  const view = reasoningView(model);
  const levels = view.kind === "levels" ? view.levels : new Map<string, string | null>();
  const enabledLevels = EFFORT_OPTIONS.filter((l) => levels.has(l));
  const iview = inputView(model);

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
    // custom = 手写模态列表（如 ["audio"]）：无对应三态投影，保持原样不动
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
      <div className="grid grid-cols-3 gap-2">
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
        {numberField(t("Context window"), model.contextWindow, (v) => onChange({ contextWindow: v }), t("Context window"))}
        {numberField(t("Max output"), model.maxTokens, (v) => onChange({ maxTokens: v }), t("Max output"))}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs opacity-70">{t("Thinking levels")}</span>
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("Thinking levels")}>
          {EFFORT_OPTIONS.map((level) => {
            const on = levels.has(level);
            return (
              <button
                key={level}
                type="button"
                className={`${BTN_SM} ${on ? "bg-primary text-primary-foreground" : ""}`}
                aria-pressed={on}
                onClick={() => toggleLevel(level)}
              >
                {level}
              </button>
            );
          })}
        </div>
        {enabledLevels.filter((l) => l !== "off").length > 0 && (
          <div className="flex flex-wrap gap-2">
            {enabledLevels
              .filter((l) => l !== "off")
              .map((level) => (
                <label key={level} className="flex items-center gap-1 text-xs opacity-70">
                  {level}
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
      <label className="flex flex-col gap-1 text-xs opacity-70">
        {t("Image input")}
        <select
          className={SELECT}
          value={iview === "custom" ? "custom" : iview}
          onChange={(e) => setInputView(e.target.value as "inherit" | "text" | "text-image")}
          aria-label={t("Image input")}
        >
          <option value="inherit">{t("Follow catalog")}</option>
          <option value="text">{t("Text only")}</option>
          <option value="text-image">{t("Text and images")}</option>
          {iview === "custom" && <option value="custom">{t("Custom (kept as-is)")}</option>}
        </select>
      </label>
    </div>
  );
}

export async function fetchProviderModels(provider: ProviderConfig): Promise<string[]> {
  return await cmd.modelRemoteList(
    provider.baseURL ?? "",
    provider.api ?? null,
    provider.apiKeyEnv ?? null,
  );
}
