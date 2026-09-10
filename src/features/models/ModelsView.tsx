// 模型配置工作台：编辑 ~/.dsh/settings.yaml 的模型域（agent-default-model +
// llm-pi-ai.providers）。交互参考 PI-Desktop Provider Studio，但保持 dsh 自身
// 配置语义：默认模型/推理档与服务增删改均按动作即时落盘，settings.yaml 热加载
// 后立即生效；密钥仍只保存环境变量名。主页面只展示摘要、状态和快捷操作，
// 详细服务与模型配置进入 ProviderDialog 渐进披露。

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import * as cmd from "@/shared/commands";
import { BTN, BTN_DANGER_SM, BTN_PRIMARY, BTN_SM, INPUT, SELECT } from "@/shared/lib/ui";
import type { ModelCatalogEntry, ModelConfig, ProviderConfig } from "@/shared/types";
import { tErr } from "@/shared/i18n/error";
import { ProviderDialog, type ProviderDialogState } from "./ProviderDialog";
import { ImportDialog } from "./ImportDialog";
import {
  providerEnvNames,
  providerReadiness,
  type ProviderReadiness,
} from "./readiness";
import {
  CATALOG_STALE_SECS,
  DELETE_CONFIRM_MS,
  EFFORT_OPTIONS,
  firstProviderModelId,
  fmtTokens,
  modelReasoningCapability,
  providerConnectionTarget,
  providerModelChoices,
} from "./shared";

const EMPTY_CONFIG: ModelConfig = {
  defaultProvider: null,
  defaultModel: null,
  defaultReasoningEffort: null,
  providers: [],
};

function configValidationError(config: ModelConfig): string | null {
  if (config.defaultProvider?.trim() && !config.defaultModel?.trim()) {
    return "Default model provider and model are required";
  }
  if (config.providers.some((provider) => !provider.route.trim())) {
    return "Provider route key cannot be empty";
  }
  const routes = config.providers.map((provider) => provider.route.trim());
  if (new Set(routes).size !== routes.length) {
    return "Provider route keys must be unique";
  }
  return null;
}

async function resolveProviderEnvStatus(providers: ProviderConfig[]): Promise<Record<string, boolean>> {
  const names = providerEnvNames(providers);
  return names.length > 0 ? cmd.modelEnvStatus(names) : {};
}

/** 默认模型变化时同步清理已经不被新模型支持的全局 reasoning level。 */
function withValidDefaultReasoning(
  config: ModelConfig,
  catalog: ModelCatalogEntry[],
): ModelConfig {
  const effort = config.defaultReasoningEffort?.trim();
  if (!effort) return config;
  const provider = config.providers.find((item) => item.route === config.defaultProvider);
  const model = config.defaultModel?.trim();
  if (!provider || !model) return { ...config, defaultReasoningEffort: null };
  const capability = modelReasoningCapability(provider, model, catalog);
  if (capability.kind === "unknown" || capability.levels.includes(effort)) return config;
  return { ...config, defaultReasoningEffort: null };
}

/** 新增/编辑服务后同步默认引用；纯函数便于保持配置只有一个事实来源。 */
function upsertProvider(
  config: ModelConfig,
  provider: ProviderConfig,
  originalRoute: string | null,
  canAutoDefault: boolean,
): ModelConfig {
  const locate = originalRoute ?? provider.route;
  const existing = config.providers.findIndex((item) => item.route === locate);
  const providers =
    existing >= 0
      ? config.providers.map((item, index) => (index === existing ? provider : item))
      : [...config.providers, provider];

  let defaultProvider = config.defaultProvider;
  let defaultModel = config.defaultModel;

  // 默认服务改路由键时同步引用。
  if (originalRoute && defaultProvider === originalRoute && provider.route !== originalRoute) {
    defaultProvider = provider.route;
  }

  // 第一个 Ready 且拥有有效模型目录的服务自动成为默认。models=[] 的内置
  // Provider 从 pi-ai 同版本目录取首个模型，但不会把继承目录写回 settings.yaml。
  const firstModel = firstProviderModelId(provider);
  if (!defaultProvider?.trim() && firstModel && canAutoDefault) {
    defaultProvider = provider.route;
    defaultModel = firstModel;
  }

  // 显式 models 代表覆盖内置目录：编辑后旧默认不在覆盖集合时回落首个显式模型。
  // models=[] 则继续继承目录，并保留已存 defaultModel；DSH 允许引用目录未广告的 id。
  const active = providers.find((item) => item.route === defaultProvider);
  if (
    active &&
    active.models.length > 0 &&
    !active.models.some((model) => model.id === defaultModel)
  ) {
    defaultModel = active.models[0]?.id ?? null;
  }

  return { ...config, providers, defaultProvider, defaultModel };
}

function removeProviderFromConfig(
  config: ModelConfig,
  route: string,
  readyRoutes: ReadonlySet<string>,
): ModelConfig {
  const providers = config.providers.filter((provider) => provider.route !== route);
  if (config.defaultProvider !== route) return { ...config, providers };

  // 删除默认服务时回退到当前 Ready 且拥有有效模型目录的服务；继承目录与
  // 显式 models 使用同一选择语义。
  const next = providers.find(
    (provider) => readyRoutes.has(provider.route) && firstProviderModelId(provider),
  );
  return {
    ...config,
    providers,
    defaultProvider: next?.route ?? null,
    defaultModel: next ? firstProviderModelId(next) : null,
  };
}

export function ModelsView() {
  const { t } = useTranslation();
  const toast = useAppStore((state) => state.toast);
  const loadModelConfig = useAppStore((state) => state.loadModelConfig);
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [envStatus, setEnvStatus] = useState<Record<string, boolean> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyRoute, setBusyRoute] = useState<string | null>(null);
  const [testingRoute, setTestingRoute] = useState<string | null>(null);
  const [busyGlobal, setBusyGlobal] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [catalogFetchedAt, setCatalogFetchedAt] = useState<number | null>(null);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [dialog, setDialog] = useState<ProviderDialogState | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // 两步删除：已武装的 route；3 秒未确认自动还原。
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const loaded = await loadModelConfig();
        let status: Record<string, boolean> = {};
        try {
          status = await resolveProviderEnvStatus(loaded.providers);
        } catch {
          // IPC 已统一记日志；这里 fail-closed，避免把未知状态误标成 Ready。
        }
        if (!disposed) {
          setConfig(loaded);
          setEnvStatus(status);
        }
      } catch (error) {
        if (!disposed) toast(tErr(String(error)), "error");
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 目录快照：立即可用，缺失/过期自动后台刷新；失败静默（缓存不是事实来源）。
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const file = await cmd.modelCatalogLoad();
        if (disposed) return;
        if (file) {
          setCatalog(file.entries);
          setCatalogFetchedAt(file.fetchedAt);
          setCatalogState("ready");
        } else {
          setCatalogState("unavailable");
        }
        const missingCapabilityMetadata =
          file?.entries.some((entry) => entry.capabilities == null) ?? false;
        if (
          !file ||
          missingCapabilityMetadata ||
          Date.now() / 1000 - file.fetchedAt >= CATALOG_STALE_SECS
        ) {
          void refreshCatalog(true);
        }
      } catch {
        if (!disposed) setCatalogState("unavailable");
      }
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (deleteTimer.current) clearTimeout(deleteTimer.current);
    },
    [],
  );

  const cfg = config ?? EMPTY_CONFIG;
  const readinessByRoute = new Map(
    cfg.providers.map((provider) => [provider.route, providerReadiness(provider, envStatus)] as const),
  );
  const readyRoutes = new Set(
    cfg.providers
      .filter((provider) => readinessByRoute.get(provider.route)?.ready)
      .map((provider) => provider.route),
  );
  const hasReadyModel = cfg.providers.some(
    (provider) => readyRoutes.has(provider.route) && Boolean(firstProviderModelId(provider)),
  );

  const refreshCatalog = async (background: boolean) => {
    setCatalogRefreshing(true);
    try {
      const fresh = await cmd.modelCatalogRefresh();
      setCatalog(fresh.entries);
      setCatalogFetchedAt(fresh.fetchedAt);
      setCatalogState("ready");
    } catch (error) {
      if (!background) toast(tErr(String(error)), "error");
    } finally {
      setCatalogRefreshing(false);
    }
  };

  /**
   * 模型域唯一写入口：校验完整 ModelConfig 后原子覆盖本域。
   * UI 不保留“待保存副本”，成功即刷新内存事实；失败保持旧配置。
   */
  const persist = async (next: ModelConfig, route: string | null = null) => {
    const validation = configValidationError(next);
    if (validation) {
      toast(t(validation), "error");
      throw new Error(validation);
    }
    if (route) setBusyRoute(route);
    else setBusyGlobal(true);
    try {
      await cmd.modelConfigSave(next);
      let status: Record<string, boolean> = {};
      try {
        status = await resolveProviderEnvStatus(next.providers);
      } catch {
        // 保存事实仍成功；readiness 查询失败时保持 fail-closed。
      }
      setConfig(next);
      setEnvStatus(status);
    } catch (error) {
      toast(tErr(String(error)), "error");
      throw error;
    } finally {
      if (route) setBusyRoute(null);
      else setBusyGlobal(false);
    }
  };

  const persistDefault = async (route: string, model: string) => {
    if (!readyRoutes.has(route)) return;
    const current = config ?? EMPTY_CONFIG;
    const next = withValidDefaultReasoning(
      { ...current, defaultProvider: route, defaultModel: model },
      catalog,
    );
    await persist(next);
    toast(t("Model configuration saved — changes take effect immediately"), "success");
  };

  const persistReasoning = async (value: string) => {
    const current = config ?? EMPTY_CONFIG;
    if (value) {
      const provider = current.providers.find((item) => item.route === current.defaultProvider);
      const model = current.defaultModel?.trim();
      if (!provider || !model) return;
      const capability = modelReasoningCapability(provider, model, catalog);
      if (
        capability.kind === "unsupported" ||
        (capability.kind === "supported" && !capability.levels.includes(value))
      ) {
        return;
      }
    }
    await persist({ ...current, defaultReasoningEffort: value || null });
    toast(t("Model configuration saved — changes take effect immediately"), "success");
  };

  const submitProvider = async (provider: ProviderConfig, originalRoute: string | null) => {
    const current = config ?? EMPTY_CONFIG;
    let status = envStatus;
    const envName = provider.apiKeyEnv?.trim();
    if (envName && status?.[envName] === undefined) {
      try {
        status = { ...(status ?? {}), ...(await cmd.modelEnvStatus([envName])) };
      } catch {
        status = status ?? {};
      }
    }
    const next = withValidDefaultReasoning(
      upsertProvider(
        current,
        provider,
        originalRoute,
        providerReadiness(provider, status).ready,
      ),
      catalog,
    );
    await persist(next, provider.route);
    setDialog(null);
    toast(t("Model configuration saved — changes take effect immediately"), "success");
  };

  const makeDefault = async (provider: ProviderConfig) => {
    const model = firstProviderModelId(provider);
    if (!model || !readyRoutes.has(provider.route)) return;
    await persistDefault(provider.route, model);
  };

  const armDelete = (route: string) => {
    setArmedDelete(route);
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
    deleteTimer.current = setTimeout(() => setArmedDelete(null), DELETE_CONFIRM_MS);
  };

  const disarmDelete = () => {
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
    setArmedDelete(null);
  };

  const removeProvider = async (route: string) => {
    disarmDelete();
    const current = config ?? EMPTY_CONFIG;
    const next = withValidDefaultReasoning(
      removeProviderFromConfig(current, route, readyRoutes),
      catalog,
    );
    await persist(next, route);
    toast(t("Model configuration saved — changes take effect immediately"), "success");
  };

  /** 连接测试与模型发现分离：真实推理请求验证 endpoint/auth/model，绝不调用 /models。 */
  const testProvider = async (provider: ProviderConfig) => {
    const target = providerConnectionTarget(provider);
    if (!target || !readyRoutes.has(provider.route)) return;
    setTestingRoute(provider.route);
    try {
      await cmd.modelTestConnection(
        target.baseURL,
        target.api,
        provider.apiKeyEnv,
        provider.headers,
        target.model,
      );
      toast(t("Connection successful"), "success");
    } catch (error) {
      toast(tErr(String(error)), "error");
    } finally {
      setTestingRoute(null);
    }
  };

  /** 服务行模型发现：仅 Ready Provider 可请求；自定义无 apiKeyEnv 仍可匿名探测。 */
  const probeProvider = async (provider: ProviderConfig) => {
    if (!provider.baseURL?.trim() || !readyRoutes.has(provider.route)) return;
    setBusyRoute(provider.route);
    try {
      const models = await cmd.modelRemoteList(
        provider.baseURL,
        provider.api,
        provider.apiKeyEnv,
        provider.headers,
      );
      toast(`${t("Models from this service")}: ${t("{{count}} models", { count: models.length })}`, "success");
    } catch (error) {
      toast(tErr(String(error)), "error");
    } finally {
      setBusyRoute(null);
    }
  };

  const openImport = () => setImportOpen(true);

  if (loading) {
    return (
      <main className="flex-1 overflow-y-auto p-6" id="models-view">
        <p className="text-sm opacity-60">{t("Detecting…")}</p>
      </main>
    );
  }

  const defaultProvider = cfg.providers.find(
    (provider) => provider.route === (cfg.defaultProvider ?? "").trim(),
  );
  const defaultReadiness = defaultProvider
    ? readinessByRoute.get(defaultProvider.route) ?? null
    : null;
  const defaultReasoningCapability =
    defaultProvider && cfg.defaultModel
      ? modelReasoningCapability(defaultProvider, cfg.defaultModel, catalog)
      : { kind: "unsupported" as const, levels: [] as string[] };
  const reasoningOptions =
    defaultReasoningCapability.kind === "supported"
      ? defaultReasoningCapability.levels
      : defaultReasoningCapability.kind === "unknown"
        ? [...EFFORT_OPTIONS]
        : [];
  const currentReasoning = cfg.defaultReasoningEffort ?? "";
  const invalidCurrentReasoning =
    Boolean(currentReasoning) && !reasoningOptions.includes(currentReasoning);
  const reasoningDisabled =
    busyGlobal ||
    !defaultProvider ||
    !cfg.defaultModel ||
    (defaultReasoningCapability.kind === "unsupported" && !currentReasoning);

  return (
    <main className="flex-1 overflow-y-auto p-6" id="models-view">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t("Model Configuration")}</h2>
            <p className="mt-1 text-xs opacity-60">
              {t(
                "Edit the model settings of ~/.dsh/settings.yaml. API keys are stored as environment variable names, never as values.",
              )}
            </p>
          </div>
          <button className={BTN} id="btn-import-models" onClick={openImport} disabled={busyGlobal}>
            {t("Import configuration")}
          </button>
        </div>

        {/* —— Defaults：只呈现当前事实与两个高频选择 —— */}
        <section className="rounded-xl border border-border bg-card p-4" id="models-default">
          <h3 className="mb-1 text-sm font-medium">{t("Default Model")}</h3>
          <div className="divide-y divide-border">
            <div className="flex min-h-14 items-center gap-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm">{t("Default model")}</div>
                <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs">
                  <span className="truncate opacity-60" data-testid="default-model-summary">
                    {defaultProvider && cfg.defaultModel
                      ? `${defaultProvider.displayName ?? defaultProvider.route} · ${cfg.defaultModel}`
                      : hasReadyModel
                        ? t("Not set")
                        : t("No AI provider ready")}
                  </span>
                  {defaultProvider && cfg.defaultModel && defaultReadiness && (
                    <ReadinessBadge
                      readiness={defaultReadiness}
                      testId="default-provider-readiness"
                    />
                  )}
                </div>
              </div>
              <DefaultModelMenu
                providers={cfg.providers}
                readyRoutes={readyRoutes}
                currentRoute={cfg.defaultProvider}
                currentModel={cfg.defaultModel}
                disabled={busyGlobal || !hasReadyModel}
                onPick={persistDefault}
              />
            </div>
            <div className="flex min-h-14 items-center gap-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm">{t("Reasoning Effort")}</div>
                <div className="mt-0.5 text-xs opacity-60">{t("Default reasoning level")}</div>
              </div>
              <select
                className={`${SELECT} w-44`}
                value={currentReasoning}
                disabled={reasoningDisabled}
                onChange={(event) => void persistReasoning(event.target.value).catch(() => undefined)}
                aria-label={t("Reasoning Effort")}
                data-reasoning-capability={defaultReasoningCapability.kind}
              >
                <option value="">{t("Not set")}</option>
                {invalidCurrentReasoning && (
                  <option value={currentReasoning} disabled>
                    {currentReasoning}
                  </option>
                )}
                {reasoningOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* —— Provider Studio —— */}
        <section className="rounded-xl border border-border bg-card" id="models-providers">
          <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              {t("AI providers")}
              {cfg.providers.length > 0 && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs opacity-70">{cfg.providers.length}</span>
              )}
            </h3>
            <button
              className={BTN_PRIMARY}
              id="btn-add-provider"
              onClick={() => setDialog({ mode: "add" })}
              disabled={busyGlobal}
            >
              {t("Add provider")}
            </button>
          </div>

          {cfg.providers.length === 0 ? (
            <div
              className="flex flex-col items-center gap-2 px-6 py-10 text-center"
              id="models-empty"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-muted text-sm font-semibold">
                AI
              </div>
              <p className="text-sm font-medium">{t("No AI providers yet")}</p>
              <p className="text-xs opacity-60">{t("Add an AI provider to start.")}</p>
              <button
                className={`${BTN_PRIMARY} mt-1`}
                onClick={() => setDialog({ mode: "add" })}
                data-testid="empty-add-provider"
              >
                {t("Add provider")}
              </button>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {cfg.providers.map((provider, index) => {
                const isDefault = provider.route === (cfg.defaultProvider ?? "").trim();
                const armed = armedDelete === provider.route;
                const probing = busyRoute === provider.route;
                const testing = testingRoute === provider.route;
                const rowBusy = probing || testing;
                const firstModel = firstProviderModelId(provider);
                const displayModel = provider.models[0]?.id ?? null;
                const readiness =
                  readinessByRoute.get(provider.route) ?? providerReadiness(provider, envStatus);
                const canTest = Boolean(providerConnectionTarget(provider)) && readiness.ready;
                const canProbe = Boolean(provider.baseURL?.trim()) && readiness.ready;
                return (
                  <div
                    key={provider.route}
                    className="flex items-center gap-3 px-4 py-3"
                    id={`provider-row-${index}`}
                    data-route={provider.route}
                    aria-busy={rowBusy}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node)) disarmDelete();
                    }}
                  >
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-xs font-semibold uppercase"
                      aria-hidden
                    >
                      {providerInitial(provider)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {provider.displayName ?? provider.route}
                        </span>
                        {isDefault && (
                          <span
                            className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
                            id={`badge-default-${index}`}
                          >
                            {t("default")}
                          </span>
                        )}
                        <ReadinessBadge
                          readiness={readiness}
                          testId={`provider-readiness-${index}`}
                        />
                      </div>
                      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-xs opacity-60">
                        <span className="truncate">
                          {hostOf(provider.baseURL) ?? t("Inherits the built-in catalog")}
                        </span>
                        <span aria-hidden>·</span>
                        <span className="truncate font-mono">
                          {displayModel ?? t("Inherits catalog models")}
                        </span>
                        {provider.models.length > 0 && (
                          <>
                            <span aria-hidden>·</span>
                            <span>{t("{{count}} models", { count: provider.models.length })}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {!isDefault && firstModel && readiness.ready && (
                        <button
                          className={BTN_SM}
                          disabled={rowBusy || busyGlobal}
                          onClick={() => void makeDefault(provider).catch(() => undefined)}
                        >
                          {t("Make default")}
                        </button>
                      )}
                      {canTest && (
                        <button
                          className={BTN_SM}
                          disabled={rowBusy || busyGlobal}
                          onClick={() => void testProvider(provider)}
                          title={t("Sends a minimal model request to verify the endpoint and credentials.")}
                        >
                          {testing ? t("Testing…") : t("Test connection")}
                        </button>
                      )}
                      {canProbe && (
                        <button
                          className={BTN_SM}
                          disabled={rowBusy || busyGlobal}
                          onClick={() => void probeProvider(provider)}
                          title={t("Fetch models")}
                        >
                          {probing ? t("Loading models…") : t("Fetch list")}
                        </button>
                      )}
                      <button
                        className={BTN_SM}
                        aria-label={t("Edit provider")}
                        disabled={rowBusy || busyGlobal}
                        onClick={() => setDialog({ mode: "edit", index, provider })}
                      >
                        {t("Edit")}
                      </button>
                      {armed ? (
                        <button
                          className={BTN_DANGER_SM}
                          id={`btn-confirm-delete-${index}`}
                          disabled={rowBusy || busyGlobal}
                          onClick={() => void removeProvider(provider.route).catch(() => undefined)}
                        >
                          {t("Delete?")}
                        </button>
                      ) : (
                        <button
                          className={BTN_DANGER_SM}
                          aria-label={t("Remove provider")}
                          disabled={rowBusy || busyGlobal}
                          onClick={() => armDelete(provider.route)}
                        >
                          {t("Delete")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* —— 目录状态：辅助信息退到页面底部，不与配置主任务抢层级 —— */}
        <div className="flex items-center justify-between gap-4 text-xs opacity-70" id="models-catalog">
          <span>
            {catalogState === "ready"
              ? t("Catalog: {{source}} · {{models}} models · updated {{time}}", {
                  source: "models.dev",
                  models: catalog.length,
                  time: catalogFetchedAt ? new Date(catalogFetchedAt * 1000).toLocaleString() : "—",
                })
              : catalogState === "loading"
                ? t("Loading catalog…")
                : t("Catalog: unavailable")}
          </span>
          <button
            className={BTN_SM}
            id="btn-refresh-catalog"
            disabled={catalogRefreshing}
            onClick={() => void refreshCatalog(false)}
          >
            {catalogRefreshing ? t("Refreshing catalog…") : t("Refresh model catalog")}
          </button>
        </div>
        <p className="text-xs opacity-60">{t("Changes take effect immediately after saving (hot reload).")}</p>
      </div>

      {dialog && (
        <ProviderDialog
          state={dialog}
          catalog={catalog}
          onClose={() => setDialog(null)}
          onSubmit={submitProvider}
        />
      )}
      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={(result) => {
            void (async () => {
              try {
                const fresh = await loadModelConfig();
                let status: Record<string, boolean> = {};
                try {
                  status = await resolveProviderEnvStatus(fresh.providers);
                } catch {
                  // IPC 已记日志；导入配置本身仍有效，readiness fail-closed。
                }
                setConfig(fresh);
                setEnvStatus(status);
              } catch {
                // 重载失败保持现状；下次进入页面自动重读。
              }
            })();
            toast(
              t("Import finished: {{imported}} imported, {{skipped}} skipped, {{failed}} failed", {
                imported: result.imported,
                skipped: result.skipped,
                failed: result.failed,
              }) +
                (result.literal > 0
                  ? ` · ${t("{{count}} with literal keys left credential-free", { count: result.literal })}`
                  : ""),
              result.failed > 0 ? "error" : "success",
            );
          }}
        />
      )}
    </main>
  );
}

function ReadinessBadge({
  readiness,
  testId,
}: {
  readiness: ProviderReadiness;
  testId?: string;
}) {
  const { t } = useTranslation();
  const label =
    readiness.kind === "checking"
      ? t("Detecting…")
      : readiness.kind === "missing-credential"
        ? t("No API key reference yet")
        : readiness.kind === "missing-env"
          ? `${readiness.envName}: ${t("Not set")}`
          : readiness.kind === "anonymous"
            ? `${t("Ready")} · ${t("Custom endpoint")}`
            : t("Ready");
  const title =
    readiness.kind === "missing-env"
      ? t("Environment variable is not set in the environment where dsh-pro-max was launched")
      : readiness.kind === "missing-credential"
        ? t("No API key reference yet")
        : readiness.kind === "anonymous"
          ? t("Custom endpoint")
          : readiness.kind === "checking"
            ? t("Detecting…")
            : readiness.envName ?? t("Ready");
  const classes = readiness.ready
    ? "bg-primary/10 text-primary"
    : readiness.kind === "checking"
      ? "bg-muted opacity-70"
      : "bg-destructive/10 text-destructive";

  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${classes}`}
      data-testid={testId}
      data-readiness={readiness.kind}
      title={title}
    >
      {label}
    </span>
  );
}

// ============ 默认模型锚定菜单 ============

function DefaultModelMenu({
  providers,
  readyRoutes,
  currentRoute,
  currentModel,
  disabled,
  onPick,
}: {
  providers: ProviderConfig[];
  readyRoutes: ReadonlySet<string>;
  currentRoute: string | null;
  currentModel: string | null;
  disabled: boolean;
  onPick: (route: string, model: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(-1);
  const [picking, setPicking] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 候选 = Ready 路由的有效模型目录：显式 models 优先，空集合则读取同版本 pi-ai
  // 内置目录；这里只做选择视图，不物化继承模型。
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers
      .filter((provider) => readyRoutes.has(provider.route))
      .map((provider) => ({
        name: provider.displayName ?? provider.route,
        route: provider.route,
        models: providerModelChoices(provider).filter(
          (model) =>
            !q ||
            model.id.toLowerCase().includes(q) ||
            (provider.displayName ?? provider.route).toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.models.length > 0);
  }, [providers, readyRoutes, query]);

  const flat = useMemo(
    () => groups.flatMap((group) => group.models.map((model) => ({ route: group.route, model }))),
    [groups],
  );
  const indexByKey = useMemo(
    () => new Map(flat.map((item, index) => [`${item.route}\u0000${item.model.id}`, index])),
    [flat],
  );

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = async (route: string, model: string) => {
    setPicking(true);
    try {
      await onPick(route, model);
      setOpen(false);
      setQuery("");
      setHi(-1);
    } catch {
      // persist 已向用户展示错误；保持菜单打开，允许直接重试或选择其他模型。
    } finally {
      setPicking(false);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        className={BTN}
        id="btn-change-default-model"
        disabled={disabled || picking}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((value) => !value)}
      >
        {t("Change")}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-80 rounded-lg border border-border bg-background shadow-lg">
          <div className="border-b border-border p-2">
            <input
              ref={inputRef}
              className={INPUT}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHi(-1);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHi((value) => Math.min(value + 1, flat.length - 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHi((value) => Math.max(value - 1, 0));
                } else if (event.key === "Enter" && flat[hi]) {
                  event.preventDefault();
                  void pick(flat[hi].route, flat[hi].model.id);
                } else if (event.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder={t("Filter models")}
              aria-label={t("Filter models")}
            />
          </div>
          <ul role="listbox" aria-label={t("Default model")} className="max-h-72 overflow-y-auto py-1">
            {groups.map((group, groupIndex) => (
              <li key={group.route}>
                <div
                  className={`px-3 py-1.5 text-xs font-medium opacity-60 ${groupIndex > 0 ? "mt-1 border-t border-border pt-2" : ""}`}
                  data-provider-group={group.route}
                >
                  {group.name}
                </div>
                <ul>
                  {group.models.map((model) => {
                    const index = indexByKey.get(`${group.route}\u0000${model.id}`) ?? -1;
                    const isCurrent =
                      group.route === (currentRoute ?? "").trim() && model.id === currentModel;
                    return (
                      <li key={model.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={isCurrent}
                          aria-label={`${group.name} · ${model.id}`}
                          disabled={picking}
                          className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent ${index === hi ? "bg-accent" : ""}`}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            void pick(group.route, model.id);
                          }}
                          onMouseEnter={() => setHi(index)}
                        >
                          <span className="w-3 shrink-0 text-xs" aria-hidden>
                            {isCurrent ? "✓" : ""}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">{model.id}</span>
                          {fmtTokens(model.contextWindow) && (
                            <span className="shrink-0 text-xs opacity-60">{fmtTokens(model.contextWindow)}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
            {flat.length === 0 && (
              <li className="px-3 py-2 text-xs opacity-60">{t("No matching models")}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function providerInitial(provider: ProviderConfig): string {
  const label = (provider.displayName ?? provider.route).trim();
  return label ? Array.from(label)[0] ?? "AI" : "AI";
}

function hostOf(baseURL: string | null): string | null {
  if (!baseURL?.trim()) return null;
  try {
    return new URL(baseURL.trim()).host;
  } catch {
    return baseURL.trim();
  }
}