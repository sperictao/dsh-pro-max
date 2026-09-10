// 添加/编辑 AI 服务对话框：服务预设选择器 + 基础字段 + 模型双栏 + 高级设置。
// 保存门控 = 路由键非空 + Base URL 形合法；Base URL 失焦时自动剥离尾部
// 路径（/chat/completions 等）。默认同步规则由 ModelsView 在 onSubmit 后处理。

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BTN, BTN_PRIMARY, BTN_SM, INPUT, INPUT_MONO, SELECT } from "@/shared/lib/ui";
import type { ModelCatalogEntry, ModelEntry, ProviderConfig } from "@/shared/types";
import { tErr } from "@/shared/i18n/error";
import { HeadersEditor } from "./HeadersEditor";
import { ModelPanes, fetchProviderModels } from "./ModelPanes";
import {
  API_OPTIONS,
  EFFORT_OPTIONS,
  emptyProvider,
  MODEL_PRESETS,
  normalizeBaseUrl,
  validateBaseUrl,
  type ModelPreset,
} from "./shared";

export type ProviderDialogState =
  | { mode: "add" }
  | { mode: "edit"; index: number; provider: ProviderConfig };

export function ProviderDialog({
  state,
  catalog,
  onClose,
  onSubmit,
}: {
  state: ProviderDialogState;
  catalog: ModelCatalogEntry[];
  onClose: () => void;
  onSubmit: (provider: ProviderConfig, originalRoute: string | null) => void;
}) {
  const { t } = useTranslation();
  const isEdit = state.mode === "edit";
  const [draft, setDraft] = useState<ProviderConfig>(
    isEdit ? structuredClone(state.provider) : emptyProvider(),
  );
  const [preset, setPreset] = useState<ModelPreset | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [remote, setRemote] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const patch = (p: Partial<ProviderConfig>) => setDraft((d) => ({ ...d, ...p }));

  // 路由键命中内置目录 = 只需凭据引用，端点/协议/模型目录由 dsh 继承
  const presetOfRoute = useMemo(
    () => MODEL_PRESETS.find((p) => p.id === draft.route.trim()) ?? null,
    [draft.route],
  );

  // 端点三元组变更后旧拉取结果不再可信，立即撤下
  const revokeRemote = () => {
    setRemote(null);
    setFetchError(null);
  };

  const onBaseURLBlur = () => {
    if (draft.baseURL) {
      const normalized = normalizeBaseUrl(draft.baseURL);
      patch({ baseURL: normalized || null });
      setUrlError(validateBaseUrl(normalized));
    } else {
      setUrlError(null);
    }
  };

  const canSave = draft.route.trim().length > 0 && !urlError && !saving;

  const save = () => {
    if (!canSave) return;
    setSaving(true);
    onSubmit(
      {
        ...draft,
        route: draft.route.trim(),
        displayName: draft.displayName?.trim() || null,
        baseURL: draft.baseURL?.trim() || null,
        apiKeyEnv: draft.apiKeyEnv?.trim() || null,
      },
      isEdit ? state.provider.route : null,
    );
  };

  const fetchModels = async () => {
    setFetching(true);
    setFetchError(null);
    try {
      setRemote(await fetchProviderModels(draft));
    } catch (e) {
      setRemote(null);
      setFetchError(tErr(String(e)));
    } finally {
      setFetching(false);
    }
  };

  const applyPreset = (p: ModelPreset | null) => {
    setPreset(p);
    if (!p) {
      // 自定义端点：清预设回默认，字段留白手填
      patch({ route: "", displayName: null, baseURL: null, api: "openai-completions" });
      return;
    }
    patch({
      route: p.id,
      displayName: draft.displayName || p.name,
      baseURL: draft.baseURL || p.baseUrl,
      api: p.api,
    });
    revokeRemote();
  };

  const setModels = (models: ModelEntry[]) => patch({ models });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? t("Edit provider") : t("Add provider")}
      id="provider-dialog"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !saving) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-lg"
        aria-busy={saving}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{isEdit ? t("Edit provider") : t("Add provider")}</h3>
          <button type="button" className={BTN_SM} onClick={onClose} aria-label={t("Close")}>
            ✕
          </button>
        </div>

        {/* —— 服务预设选择器（仅添加态；编辑态保留路由键即可）—— */}
        {!isEdit && (
          <div className="flex flex-col gap-1">
            <label className="text-xs opacity-70" htmlFor="preset-search">
              {t("Service")}
            </label>
            <PresetPicker onPick={applyPreset} picked={preset} />
            <p className="text-xs opacity-60">
              {t("Pick a known service to fill fields, or choose custom endpoint.")}
            </p>
          </div>
        )}

        {/* —— 基础字段 —— */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs opacity-70">
            {t("Route key")}
            <input
              className={`${INPUT_MONO} font-mono`}
              value={draft.route}
              onChange={(e) => {
                patch({ route: e.target.value });
                revokeRemote();
              }}
              placeholder="my-gateway"
              aria-label={t("Route key")}
              data-testid="route-input"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs opacity-70">
            {t("Display Name")}
            <input
              className={INPUT}
              value={draft.displayName ?? ""}
              onChange={(e) => patch({ displayName: e.target.value || null })}
              aria-label={t("Display Name")}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs opacity-70">
            Base URL
            <input
              className={`${INPUT_MONO} font-mono`}
              value={draft.baseURL ?? ""}
              onChange={(e) => {
                patch({ baseURL: e.target.value || null });
                revokeRemote();
              }}
              onBlur={onBaseURLBlur}
              placeholder="https://gw.example.com/v1"
              aria-label="Base URL"
            />
            {urlError && (
              <span role="alert" className="text-destructive">
                {t(urlError)}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-xs opacity-70">
            {t("API Key Env Var")}
            <input
              className={`${INPUT_MONO} font-mono`}
              value={draft.apiKeyEnv ?? ""}
              onChange={(e) => patch({ apiKeyEnv: e.target.value || null })}
              placeholder="MY_GATEWAY_API_KEY"
              aria-label={t("API Key Env Var")}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs opacity-70">
            {t("Wire Protocol")}
            <select
              className={SELECT}
              value={draft.api ?? ""}
              onChange={(e) => {
                patch({ api: e.target.value || null });
                revokeRemote();
              }}
              aria-label={t("Wire Protocol")}
            >
              <option value="">{t("Not set")}</option>
              {API_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {presetOfRoute && (
            <p className="col-span-2 self-end text-xs opacity-60" data-testid="catalog-route-hint">
              {t("Route matches the built-in catalog: endpoint, protocol and models are inherited; only the credential reference is required.")}
            </p>
          )}
        </div>

        {/* —— 模型双栏 —— */}
        <ModelPanes
          provider={draft}
          catalog={catalog}
          remote={remote}
          fetching={fetching}
          fetchError={fetchError}
          onModelsChange={setModels}
          onFetch={() => void fetchModels()}
        />

        {/* —— 高级设置 —— */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className={`${BTN_SM} self-start`}
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            {t("Advanced settings")}
          </button>
          {advancedOpen && (
            <div className="flex flex-col gap-3 rounded-md border border-border p-3" data-testid="provider-advanced">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-xs opacity-70">
                  {t("Request timeout (ms)")}
                  <input
                    type="number"
                    min={1}
                    className={INPUT_MONO}
                    value={draft.timeoutMs ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const n = raw === "" ? null : Number(raw);
                      patch({ timeoutMs: n != null && Number.isInteger(n) && n > 0 ? n : null });
                    }}
                    placeholder={t("Inherit")}
                    aria-label={t("Request timeout (ms)")}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs opacity-70">
                  {t("Default reasoning level")}
                  <select
                    className={SELECT}
                    value={draft.reasoning ?? ""}
                    onChange={(e) => patch({ reasoning: e.target.value || null })}
                    aria-label={t("Default reasoning level")}
                  >
                    <option value="">{t("Not set")}</option>
                    {EFFORT_OPTIONS.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs opacity-70">{t("Headers")}</span>
                <HeadersEditor
                  headers={draft.headers}
                  onChange={(headers) => patch({ headers })}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <button type="button" className={BTN} onClick={onClose} disabled={saving}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            id="btn-save-provider"
            disabled={!canSave}
            onClick={save}
          >
            {saving ? t("Saving…") : t("Save provider")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ 服务预设选择器（可搜索 + 键盘导航）============

function PresetPicker({
  onPick,
  picked,
}: {
  onPick: (p: ModelPreset | null) => void;
  picked: ModelPreset | null;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);

  const q = query.trim().toLowerCase();
  const matched = (
    q
      ? MODEL_PRESETS.filter(
          (p) =>
            p.id.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q) ||
            p.baseUrl.toLowerCase().includes(q),
        )
      : MODEL_PRESETS
  ).slice(0, 12);

  const pick = (p: ModelPreset | null) => {
    onPick(p);
    setOpen(false);
    setHi(-1);
    setQuery("");
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <input
          id="preset-search"
          className={INPUT}
          role="combobox"
          aria-expanded={open}
          value={query}
          placeholder={t("Choose a service or custom endpoint")}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHi(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setHi((h) => Math.min(h + 1, matched.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter" && open && hi >= 0 && matched[hi]) {
              e.preventDefault();
              pick(matched[hi]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          aria-label={t("Service")}
          data-testid="preset-input"
        />
        {open && (
          <ul
            role="listbox"
            aria-label={t("Choose a service or custom endpoint")}
            className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-background py-1 shadow-lg"
          >
            <li>
              <button
                type="button"
                role="option"
                aria-selected={hi === -1}
                className={`flex w-full flex-col items-start px-3 py-1.5 text-left text-sm ${hi === -1 ? "bg-accent" : ""} hover:bg-accent`}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  pick(null);
                }}
                onMouseEnter={() => setHi(-1)}
              >
                {t("Custom endpoint")}
              </button>
            </li>
            {matched.map((p, i) => (
              <li key={p.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === hi}
                  className={`flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-sm ${i === hi ? "bg-accent" : ""} hover:bg-accent`}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    pick(p);
                  }}
                  onMouseEnter={() => setHi(i)}
                >
                  <span className="font-mono text-xs">{p.id}</span>
                  <span className="shrink-0 text-xs opacity-60">
                    {p.name} · {p.models}
                  </span>
                </button>
              </li>
            ))}
            {matched.length === 0 && (
              <li className="px-3 py-2 text-xs opacity-60">{t("No matching models")}</li>
            )}
          </ul>
        )}
      </div>
      {picked && (
        <p className="text-xs opacity-60" data-testid="picked-preset">
          {picked.name} · {picked.baseUrl}
        </p>
      )}
    </div>
  );
}
