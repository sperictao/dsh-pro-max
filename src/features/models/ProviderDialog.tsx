// 添加/编辑 AI 服务：参考 PI-Desktop Provider Setup 的渐进披露。
// 添加已知服务时只保留主路径需要的服务、凭据和模型；连接细节退到高级设置。
// Custom endpoint 也保持“身份 → 连接 → 模型”的顺序，并避免把本地目录误当远端结果。
// 编辑态同样聚焦高频字段；测试与高级连接细节保持独立入口。

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as cmd from "@/shared/commands";
import { BTN, BTN_DANGER, BTN_PRIMARY, BTN_SM, INPUT, INPUT_MONO, SELECT } from "@/shared/lib/ui";
import type { ModelCatalogEntry, ModelEntry, ProviderConfig } from "@/shared/types";
import { tErr } from "@/shared/i18n/error";
import { HeadersEditor } from "./HeadersEditor";
import { ModelPanes } from "./ModelPanes";
import { useProviderModels } from "./useProviderModels";
import {
  API_OPTIONS,
  EFFORT_OPTIONS,
  emptyProvider,
  MODEL_PRESETS,
  normalizeBaseUrl,
  providerConnectionTarget,
  validateBaseUrl,
  type ModelPreset,
} from "./shared";

export type ProviderDialogState =
  | { mode: "add" }
  | { mode: "edit"; index: number; provider: ProviderConfig };

/** 与最终写盘规范化保持一致，用于判断 Edit 是否真的产生了配置变化。 */
function comparableProvider(provider: ProviderConfig): string {
  return JSON.stringify({
    ...provider,
    route: provider.route.trim(),
    displayName: provider.displayName?.trim() || null,
    baseURL: provider.baseURL?.trim() ? normalizeBaseUrl(provider.baseURL) : null,
    apiKeyEnv: provider.apiKeyEnv?.trim() || null,
  });
}

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
  const displayNameInputRef = useRef<HTMLInputElement>(null);
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  // Dialog 关闭后把焦点还给原触发控件；无需让 ModelsView 为每个入口维护第二份状态。
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const closeOriginRef = useRef<HTMLElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const keepEditingButtonRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<ProviderConfig>(
    isEdit ? structuredClone(state.provider) : emptyProvider(),
  );
  const [pickedPreset, setPickedPreset] = useState<ModelPreset | null>(null);
  const [serviceChosen, setServiceChosen] = useState(isEdit);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [discardPending, setDiscardPending] = useState(false);

  const patch = (value: Partial<ProviderConfig>) =>
    setDraft((current) => ({ ...current, ...value }));

  // 编辑态按路由识别既有目录服务；添加态一旦明确选择“自定义”，即使用户
  // 手工输入与目录同名的 route，也不突然切换回预设服务布局。
  const presetOfRoute = useMemo(
    () => MODEL_PRESETS.find((preset) => preset.id === draft.route.trim()) ?? null,
    [draft.route],
  );
  const effectivePreset = pickedPreset ?? (isEdit ? presetOfRoute : null);
  const knownService = effectivePreset != null;
  const showComposer = isEdit || serviceChosen;
  const editChanged = !isEdit || comparableProvider(draft) !== comparableProvider(state.provider);
  // Add 尚未选服务时只有临时搜索文本，不算配置工作；一旦选定服务就保护这段进度。
  const hasUnsavedChanges = isEdit ? editChanged : serviceChosen;

  const updateConnection = (value: Partial<ProviderConfig>) => {
    patch(value);
    setTestResult(null);
    setSubmitError(null);
  };

  const updateCustomDisplayName = (name: string) => {
    if (isEdit) {
      patch({ displayName: name || null });
      setSubmitError(null);
      return;
    }
    // route 是配置身份而不是用户主任务。只要用户没有显式改写它，就跟随显示名生成，
    // 既减少一次重复输入，也保留专家直接覆盖 route 的能力。
    const previousAutoRoute = routeKeyFromDisplayName(draft.displayName ?? "");
    const routeIsAuto = !draft.route.trim() || draft.route === previousAutoRoute;
    patch({
      displayName: name || null,
      ...(routeIsAuto ? { route: routeKeyFromDisplayName(name) } : {}),
    });
    setSubmitError(null);
  };

  const currentUrlIssue = validateBaseUrl(draft.baseURL ?? "");
  // 托管预设无显式 apiKeyEnv 时可能由 dsh/pi-ai 的 ambient/已存登录认证；
  // Launcher 自身拿不到那条凭据 seam，因此不主动撞匿名请求。自定义端点仍允许匿名发现。
  const discoveryActive =
    showComposer &&
    !currentUrlIssue &&
    Boolean(draft.baseURL?.trim()) &&
    (!knownService || Boolean(draft.apiKeyEnv?.trim()));
  const discovery = useProviderModels(discoveryActive, draft);
  const testTarget = providerConnectionTarget(draft);
  const launcherCanTest = !knownService || Boolean(draft.apiKeyEnv?.trim());
  const canTest =
    showComposer && launcherCanTest && !currentUrlIssue && Boolean(testTarget) && !saving && !testing;

  const onBaseURLBlur = () => {
    if (draft.baseURL) {
      const normalized = normalizeBaseUrl(draft.baseURL);
      patch({ baseURL: normalized || null });
      setUrlError(validateBaseUrl(normalized));
    } else {
      setUrlError(null);
    }
  };

  const testConnection = async () => {
    const target = providerConnectionTarget(draft);
    if (!target || currentUrlIssue) return;
    setTesting(true);
    setTestResult(null);
    try {
      await cmd.modelTestConnection(
        target.baseURL,
        target.api,
        draft.apiKeyEnv,
        draft.headers,
        target.model,
      );
      setTestResult({ kind: "success", text: t("Connection successful") });
    } catch (error) {
      setTestResult({ kind: "error", text: tErr(String(error)) });
    } finally {
      setTesting(false);
    }
  };

  const applyPreset = (preset: ModelPreset | null) => {
    setServiceChosen(true);
    setPickedPreset(preset);
    setAdvancedOpen(false);
    setUrlError(null);
    setSubmitError(null);
    setTestResult(null);

    if (!preset) {
      // 自定义端点从干净连接配置开始；extra 等初始为空，不产生第二份事实。
      setDraft(emptyProvider());
      // Custom 的下一步是命名服务；与 PI-Desktop 一致，选择后直接把焦点交给名称。
      window.setTimeout(() => displayNameInputRef.current?.focus(), 0);
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

    // 已知服务的下一步就是凭据；参考 PI-Desktop，选择服务后直接把焦点送到凭据字段。
    window.setTimeout(() => apiKeyInputRef.current?.focus(), 0);
  };

  const setModels = (models: ModelEntry[]) => {
    patch({ models });
    setTestResult(null);
  };

  const canSave =
    showComposer &&
    draft.route.trim().length > 0 &&
    !currentUrlIssue &&
    (knownService || Boolean(draft.baseURL?.trim())) &&
    // 新增 Provider 至少选择一个模型才是可用配置；编辑态仅在确有变更时允许保存。
    (isEdit || draft.models.length > 0) &&
    editChanged &&
    !saving;

  const finishClose = () => {
    const opener = openerRef.current;
    onClose();
    window.setTimeout(() => {
      if (opener?.isConnected) opener.focus();
    }, 0);
  };

  const requestClose = () => {
    if (saving) return;
    if (!hasUnsavedChanges) {
      finishClose();
      return;
    }
    closeOriginRef.current =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setDiscardPending(true);
    // 风险动作出现时先把焦点放在安全的“Cancel”上，而不是 destructive action。
    window.setTimeout(() => keepEditingButtonRef.current?.focus(), 0);
  };

  const keepEditing = () => {
    const origin = closeOriginRef.current;
    setDiscardPending(false);
    window.setTimeout(() => {
      if (origin?.isConnected) origin.focus();
      else cancelButtonRef.current?.focus();
    }, 0);
  };

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
          event.preventDefault();
          event.stopPropagation();
          if (discardPending) keepEditing();
          else if (advancedOpen) setAdvancedOpen(false);
          else requestClose();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) requestClose();
      }}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-lg"
        aria-busy={saving}
      >
        <div className="shrink-0 border-b border-border">
          <div className="flex items-center justify-between gap-4 px-5 py-4">
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
              {/* 已知服务 Add 主路径不提前制造诊断任务；Custom endpoint 与 Edit 保持原测试入口。 */}
              {showComposer && (isEdit || !knownService) && (
                <button
                  type="button"
                  className={BTN_SM}
                  disabled={!canTest}
                  onClick={() => void testConnection()}
                  title={t("Sends a minimal model request to verify the endpoint and credentials.")}
                >
                  {testing ? t("Testing…") : t("Test connection")}
                </button>
              )}
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
            </div>
          </div>

          {/* 连接测试由头部动作触发；结果留在同一固定上下文，避免正文滚动后反馈跑出视野。 */}
          {testResult && (
            <div className="px-5 pb-3" data-testid="provider-test-result">
              <div
                className={`rounded-md border px-3 py-2 text-xs ${
                  testResult.kind === "success"
                    ? "border-primary/30 bg-primary/5 text-primary"
                    : "border-destructive/40 bg-destructive/5 text-destructive"
                }`}
                role={testResult.kind === "error" ? "alert" : "status"}
              >
                {testResult.text}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          {submitError && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              {submitError}
            </div>
          )}

          {/* 添加路径第一步：先选择服务，不提前暴露连接细节。 */}
          {!isEdit && (
            <section className="rounded-lg border border-border bg-card p-4">
              <label className="mb-1 block text-xs opacity-70" htmlFor="preset-search">
                {t("Service")}
              </label>
              <PresetPicker onPick={applyPreset} />
              <p className="mt-1 text-xs opacity-60">
                {t("Pick a known service to fill fields, or choose custom endpoint.")}
              </p>
            </section>
          )}

          {showComposer && (
            <>
              {/* 已知服务的高频字段保留在主路径；底层连接细节统一留给 Advanced。 */}
              <section className="rounded-lg border border-border bg-card p-4">
                {knownService ? (
                  isEdit ? (
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
                          ref={apiKeyInputRef}
                          className={`${INPUT_MONO} font-mono`}
                          value={draft.apiKeyEnv ?? ""}
                          onChange={(event) =>
                            updateConnection({ apiKeyEnv: event.target.value || null })
                          }
                          placeholder="MY_PROVIDER_API_KEY"
                          aria-label={t("API Key Env Var")}
                        />
                      </label>
                    </div>
                  ) : (
                    <label className="flex flex-col gap-1 text-xs opacity-70">
                      {t("API Key Env Var")}
                      <input
                        ref={apiKeyInputRef}
                        className={`${INPUT_MONO} font-mono`}
                        value={draft.apiKeyEnv ?? ""}
                        onChange={(event) =>
                          updateConnection({ apiKeyEnv: event.target.value || null })
                        }
                        placeholder="MY_PROVIDER_API_KEY"
                        aria-label={t("API Key Env Var")}
                      />
                    </label>
                  )
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-xs opacity-70">
                      {t("Display Name")}
                      <input
                        ref={displayNameInputRef}
                        className={INPUT}
                        value={draft.displayName ?? ""}
                        onChange={(event) => updateCustomDisplayName(event.target.value)}
                        aria-label={t("Display Name")}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs opacity-70">
                      {t("Route key")}
                      <input
                        className={`${INPUT_MONO} font-mono`}
                        value={draft.route}
                        onChange={(event) => updateConnection({ route: event.target.value })
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
                        ref={apiKeyInputRef}
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
                // Custom endpoint 只有拿到远端结果后才可声称“Models from this service”。
                // catalog 仍用于远端结果的名称/上下文元数据，但不再充当未连接时的候选池。
                catalog={knownService || discovery.models !== null ? catalog : []}
                remote={discovery.models}
                fetching={discovery.status === "loading"}
                fetchError={
                  discovery.error
                    ? discovery.source === "cache"
                      ? `${tErr(discovery.error)} · ${t("Local snapshot")}`
                      : tErr(discovery.error)
                    : null
                }
                onModelsChange={setModels}
                onFetch={discovery.reload}
              />

              {advancedOpen && (
                <section
                  className="rounded-lg border border-border bg-card p-4"
                  data-testid="provider-advanced"
                >
                  <div className="flex flex-col gap-4">
                    {/* 已知预设把底层连接字段放进高级区；仍允许专家覆盖。 */}
                    {knownService && (
                      <div className="grid grid-cols-3 gap-3">
                        {!isEdit && (
                          <label className="col-span-3 flex flex-col gap-1 text-xs opacity-70">
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
                        )}
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
                              <option key={value}>
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
                      <HeadersEditor
                        headers={draft.headers}
                        onChange={(headers) => updateConnection({ headers })}
                      />
                    </div>
                  </div>
                </section>
              )}
            </>
          )}
        </div>

        <div
          className={`flex shrink-0 items-center gap-3 border-t border-border px-5 py-3 ${
            discardPending ? "justify-between" : "justify-end"
          }`}
        >
          {discardPending ? (
            <>
              <div className="min-w-0 text-sm" role="alert" data-testid="provider-discard-confirm">
                <div className="font-medium">{t("You have unsaved changes")}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  ref={keepEditingButtonRef}
                  type="button"
                  className={BTN}
                  onClick={keepEditing}
                >
                  {t("Cancel")}
                </button>
                <button type="button" className={BTN_DANGER} onClick={finishClose}>
                  {t("Discard")}
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                ref={cancelButtonRef}
                type="button"
                className={BTN}
                onClick={requestClose}
                disabled={saving}
              >
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============ 服务预设选择器（可搜索 + 键盘导航）============

function PresetPicker({ onPick }: { onPick: (preset: ModelPreset | null) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  // null = no active option; -1 = Custom endpoint; >= 0 = index in the filtered preset list.
  // Keeping “no active option” distinct prevents Enter after typing from accidentally choosing Custom.
  const [highlighted, setHighlighted] = useState<number | null>(null);

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
  const listboxId = "provider-preset-options";
  const activeDescendant =
    open && highlighted === -1
      ? "provider-preset-custom"
      : open && highlighted != null && matched[highlighted]
        ? `provider-preset-${matched[highlighted].id}`
        : undefined;

  const pick = (preset: ModelPreset | null) => {
    onPick(preset);
    setOpen(false);
    setHighlighted(null);
    // 选择完成后让输入框继续表达“当前服务”，而不是退回空白 placeholder。
    setQuery(preset?.name ?? t("Custom endpoint"));
  };

  return (
    <div className="relative">
      <input
        id="preset-search"
        className={INPUT}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDescendant}
        value={query}
        placeholder={t("Choose a service or custom endpoint")}
        onFocus={(event) => {
          setOpen(true);
          setHighlighted(null);
          if (query) event.currentTarget.select();
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setHighlighted(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setHighlighted((value) => {
              if (value == null) return matched.length > 0 ? 0 : -1;
              return Math.min(value + 1, matched.length - 1);
            });
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setHighlighted((value) => {
              if (value == null) return -1;
              return Math.max(value - 1, -1);
            });
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            if (highlighted === -1) pick(null);
            else if (highlighted != null && matched[highlighted]) pick(matched[highlighted]);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            setHighlighted(null);
          }
        }}
        aria-label={t("Service")}
        data-testid="preset-input"
      />
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={t("Choose a service or custom endpoint")}
          className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-background py-1 shadow-lg"
        >
          <li>
            <button
              id="provider-preset-custom"
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
                id={`provider-preset-${preset.id}`}
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
            <li className="px-3 py-2 text-xs opacity-60">{t("Nothing found")}</li>
          )}
        </ul>
      )}
    </div>
  );
}

function routeKeyFromDisplayName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hostOf(baseURL: string | null): string | null {
  if (!baseURL?.trim()) return null;
  try {
    return new URL(baseURL.trim()).host;
  } catch {
    return baseURL.trim();
  }
}
