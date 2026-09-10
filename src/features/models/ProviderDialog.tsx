// 添加/编辑 AI 服务：参考 PI-Desktop Provider Setup 的渐进披露。
// 添加时先选服务；已知预设的主路径只暴露显示名 + API Key 环境变量，端点、
// 路由和协议退到高级设置；自定义服务才直接展示完整连接字段。模型选择保持双栏，
// 服务级高级配置继续无损映射 dsh llm-pi-ai schema。

import { useMemo, useState } from "react";
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
  onSubmit: (provider: ProviderConfig, originalRoute: string | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const isEdit = state.mode === "edit";
  const [draft, setDraft] = useState<ProviderConfig>(
    isEdit ? structuredClone(state.provider) : emptyProvider(),
  );
  const [pickedPreset, setPickedPreset] = useState<ModelPreset | null>(null);
  const [serviceChosen, setServiceChosen] = useState(isEdit);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [remote, setRemote] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const patch = (value: Partial<ProviderConfig>) => setDraft((current) => ({ ...current, ...value }));

  // 编辑态或手工修改路由键时仍按路由识别已知目录服务。
  const presetOfRoute = useMemo(
    () => MODEL_PRESETS.find((preset) => preset.id === draft.route.trim()) ?? null,
    [draft.route],
  );
  const effectivePreset = pickedPreset ?? presetOfRoute;
  const knownService = effectivePreset != null;
  const showComposer = isEdit || serviceChosen;
  const customService = showComposer && !knownService;

  // 连接三元组/凭据引用变化后，旧拉取结果不再可信。
  const revokeRemote = () => {
    setRemote(null);
    setFetchError(null);
  };

  const updateConnection = (value: Partial<ProviderConfig>) => {
    patch(value);
    revokeRemote();
    setSubmitError(null);
  };

  const currentUrlIssue = validateBaseUrl(draft.baseURL ?? "");

  const onBaseURLBlur = () => {
    if (draft.baseURL) {
      const normalized = normalizeBaseUrl(draft.baseURL);
      patch({ baseURL: normalized || null });
      setUrlError(validateBaseUrl(normalized));
    } else {
      setUrlError(null);
    }
  };

  const fetchModels = async () => {
    setFetching(true);
    setFetchError(null);
    try {
      setRemote(await fetchProviderModels(draft));
    } catch (error) {
      setRemote(null);
      setFetchError(tErr(String(error)));
    } finally {
      setFetching(false);
    }
  };

  const applyPreset = (preset: ModelPreset | null) => {
    setServiceChosen(true);
    setPickedPreset(preset);
    setAdvancedOpen(false);
    setUrlError(null);
    setSubmitError(null);
    revokeRemote();

    if (!preset) {
      // 自定义端点从干净连接配置开始；extra 等初始为空，不产生第二份事实。
      setDraft(emptyProvider());
      return;
    }

    setDraft((current) => ({
      ...current,
      route: preset.id,
      displayName: preset.name,
      baseURL: preset.baseUrl,
      api: preset.api,
      apiKeyEnv: null,
      models: [],
    }));
  };

  const setModels = (models: ModelEntry[]) => patch({ models });

  const canSave =
    showComposer &&
    draft.route.trim().length > 0 &&
    !currentUrlIssue &&
    (knownService || Boolean(draft.baseURL?.trim())) &&
    !saving;

  const save = async () => {
    if (!canSave) {
      if (currentUrlIssue) setUrlError(currentUrlIssue);
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      await onSubmit(
        {
          ...draft,
          route: draft.route.trim(),
          displayName: draft.displayName?.trim() || null,
          baseURL: draft.baseURL?.trim() ? normalizeBaseUrl(draft.baseURL) : null,
          apiKeyEnv: draft.apiKeyEnv?.trim() || null,
        },
        isEdit ? state.provider.route : null,
      );
    } catch (error) {
      setSubmitError(tErr(String(error)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? t("Edit provider") : t("Add provider")}
      id="provider-dialog"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !saving) {
          if (advancedOpen) setAdvancedOpen(false);
          else onClose();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-lg"
        aria-busy={saving}
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">
              {isEdit ? t("Edit provider") : t("Add provider")}
            </h3>
            {showComposer && (
              <p className="mt-0.5 truncate text-xs opacity-60">
                {knownService
                  ? `${effectivePreset?.name ?? draft.displayName ?? draft.route} · ${hostOf(draft.baseURL) ?? t("Inherits the built-in catalog")}`
                  : draft.displayName || draft.route || t("Custom endpoint")}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {showComposer && (
              <button
                type="button"
                className={BTN_SM}
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((value) => !value)}
                disabled={saving}
              >
                {t("Advanced settings")}
              </button>
            )}
            <button type="button" className={BTN_SM} onClick={onClose} disabled={saving}>
              {t("Close")}
            </button>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          {submitError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
              {submitError}
            </div>
          )}

          {/* 添加路径第一步：先选择服务，不提前暴露连接细节。 */}
          {!isEdit && (
            <section className="rounded-lg border border-border bg-card p-4">
              <label className="mb-1 block text-xs opacity-70" htmlFor="preset-search">
                {t("Service")}
              </label>
              <PresetPicker onPick={applyPreset} picked={pickedPreset} />
              <p className="mt-1 text-xs opacity-60">
                {t("Pick a known service to fill fields, or choose custom endpoint.")}
              </p>
            </section>
          )}

          {showComposer && (
            <>
              {/* 已知服务的高频路径保持极简；自定义服务才展示完整连接字段。 */}
              <section className="rounded-lg border border-border bg-card p-4">
                {knownService ? (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-xs opacity-70">
                      {t("Display Name")}
                      <input
                        className={INPUT}
                        value={draft.displayName ?? ""}
                        onChange={(event) => {
                          patch({ displayName: event.target.value || null });
                          setSubmitError(null);
                        }}
                        aria-label={t("Display Name")}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs opacity-70">
                      {t("API Key Env Var")}
                      <input
                        className={`${INPUT_MONO} font-mono`}
                        value={draft.apiKeyEnv ?? ""}
                        onChange={(event) =>
                          updateConnection({ apiKeyEnv: event.target.value || null })
                        }
                        placeholder="MY_PROVIDER_API_KEY"
                        aria-label={t("API Key Env Var")}
                      />
                    </label>
                    <div className="col-span-2 flex flex-wrap gap-x-2 gap-y-1 rounded-md bg-muted px-3 py-2 text-xs opacity-70">
                      <span className="font-mono">{draft.route}</span>
                      <span aria-hidden>·</span>
                      <span>{hostOf(draft.baseURL) ?? t("Inherits the built-in catalog")}</span>
                      {draft.api && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="font-mono">{draft.api}</span>
                        </>
                      )}
                    </div>
                    {presetOfRoute && (
                      <p className="col-span-2 text-xs opacity-60" data-testid="catalog-route-hint">
                        {t(
                          "Route matches the built-in catalog: endpoint, protocol and models are inherited; only the credential reference is required.",
                        )}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-xs opacity-70">
                      {t("Display Name")}
                      <input
                        className={INPUT}
                        value={draft.displayName ?? ""}
                        onChange={(event) => patch({ displayName: event.target.value || null })}
                        aria-label={t("Display Name")}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs opacity-70">
                      {t("Route key")}
                      <input
                        className={`${INPUT_MONO} font-mono`}
                        value={draft.route}
                        onChange={(event) => updateConnection({ route: event.target.value })}
                        placeholder="my-gateway"
                        aria-label={t("Route key")}
                        data-testid="route-input"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs opacity-70">
                      Base URL
                      <input
                        className={`${INPUT_MONO} font-mono`}
                        value={draft.baseURL ?? ""}
                        onChange={(event) => {
                          updateConnection({ baseURL: event.target.value || null });
                          setUrlError(null);
                        }}
                        onBlur={onBaseURLBlur}
                        placeholder="https://gw.example.com/v1"
                        aria-label="Base URL"
                        aria-invalid={Boolean(urlError)}
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
                        onChange={(event) =>
                          updateConnection({ apiKeyEnv: event.target.value || null })
                        }
                        placeholder="MY_GATEWAY_API_KEY"
                        aria-label={t("API Key Env Var")}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs opacity-70">
                      {t("Wire Protocol")}
                      <select
                        className={SELECT}
                        value={draft.api ?? ""}
                        onChange={(event) => updateConnection({ api: event.target.value || null })}
                        aria-label={t("Wire Protocol")}
                      >
                        <option value="">{t("Not set")}</option>
                        {API_OPTIONS.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </section>

              <ModelPanes
                provider={draft}
                catalog={catalog}
                remote={remote}
                fetching={fetching}
                fetchError={fetchError}
                onModelsChange={setModels}
                onFetch={() => void fetchModels()}
              />

              {advancedOpen && (
                <section className="rounded-lg border border-border bg-card p-4" data-testid="provider-advanced">
                  <div className="flex flex-col gap-4">
                    {/* 已知预设把底层连接字段放进高级区；仍允许专家覆盖。 */}
                    {knownService && (
                      <div className="grid grid-cols-3 gap-3">
                        <label className="flex flex-col gap-1 text-xs opacity-70">
                          {t("Route key")}
                          <input
                            className={`${INPUT_MONO} font-mono`}
                            value={draft.route}
                            onChange={(event) => updateConnection({ route: event.target.value })}
                            aria-label={t("Route key")}
                            data-testid="route-input"
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-xs opacity-70">
                          Base URL
                          <input
                            className={`${INPUT_MONO} font-mono`}
                            value={draft.baseURL ?? ""}
                            onChange={(event) => {
                              updateConnection({ baseURL: event.target.value || null });
                              setUrlError(null);
                            }}
                            onBlur={onBaseURLBlur}
                            aria-label="Base URL"
                            aria-invalid={Boolean(urlError)}
                          />
                          {urlError && (
                            <span role="alert" className="text-destructive">
                              {t(urlError)}
                            </span>
                          )}
                        </label>
                        <label className="flex flex-col gap-1 text-xs opacity-70">
                          {t("Wire Protocol")}
                          <select
                            className={SELECT}
                            value={draft.api ?? ""}
                            onChange={(event) => updateConnection({ api: event.target.value || null })}
                            aria-label={t("Wire Protocol")}
                          >
                            <option value="">{t("Not set")}</option>
                            {API_OPTIONS.map((value) => (
                              <option key={value} value={value}>
                                {value}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex flex-col gap-1 text-xs opacity-70">
                        {t("Request timeout (ms)")}
                        <input
                          type="number"
                          min={1}
                          className={INPUT_MONO}
                          value={draft.timeoutMs ?? ""}
                          onChange={(event) => {
                            const raw = event.target.value;
                            const parsed = raw === "" ? null : Number(raw);
                            patch({
                              timeoutMs:
                                parsed != null && Number.isInteger(parsed) && parsed > 0
                                  ? parsed
                                  : null,
                            });
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
                          onChange={(event) => patch({ reasoning: event.target.value || null })}
                          aria-label={t("Default reasoning level")}
                        >
                          <option value="">{t("Not set")}</option>
                          {EFFORT_OPTIONS.map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs opacity-70">{t("Headers")}</span>
                      <HeadersEditor headers={draft.headers} onChange={(headers) => patch({ headers })} />
                    </div>
                  </div>
                </section>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" className={BTN} onClick={onClose} disabled={saving}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            id="btn-save-provider"
            disabled={!canSave}
            onClick={() => void save()}
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
  onPick: (preset: ModelPreset | null) => void;
  picked: ModelPreset | null;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);

  const q = query.trim().toLowerCase();
  const matched = (
    q
      ? MODEL_PRESETS.filter(
          (preset) =>
            preset.id.toLowerCase().includes(q) ||
            preset.name.toLowerCase().includes(q) ||
            preset.baseUrl.toLowerCase().includes(q),
        )
      : MODEL_PRESETS
  ).slice(0, 12);

  const pick = (preset: ModelPreset | null) => {
    onPick(preset);
    setOpen(false);
    setHighlighted(-1);
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
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setHighlighted(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setHighlighted((value) => Math.min(value + 1, matched.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlighted((value) => Math.max(value - 1, -1));
            } else if (event.key === "Enter" && open) {
              event.preventDefault();
              if (highlighted >= 0 && matched[highlighted]) pick(matched[highlighted]);
              else if (highlighted === -1) pick(null);
            } else if (event.key === "Escape") {
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
            className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-background py-1 shadow-lg"
          >
            <li>
              <button
                type="button"
                role="option"
                aria-selected={highlighted === -1}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent ${highlighted === -1 ? "bg-accent" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(null);
                }}
                onMouseEnter={() => setHighlighted(-1)}
              >
                <span>{t("Custom endpoint")}</span>
                <span className="text-xs opacity-60">{t("Wire Protocol")}</span>
              </button>
            </li>
            {matched.map((preset, index) => (
              <li key={preset.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlighted}
                  aria-label={`${preset.name} ${preset.id}`}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent ${index === highlighted ? "bg-accent" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(preset);
                  }}
                  onMouseEnter={() => setHighlighted(index)}
                >
                  <span className="min-w-0 truncate">{preset.name}</span>
                  <span className="shrink-0 font-mono text-xs opacity-60">{preset.id}</span>
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
          {picked.name} · {hostOf(picked.baseUrl) ?? picked.baseUrl}
        </p>
      )}
    </div>
  );
}

function hostOf(baseURL: string | null): string | null {
  if (!baseURL?.trim()) return null;
  try {
    return new URL(baseURL.trim()).host;
  } catch {
    return baseURL.trim();
  }
}
