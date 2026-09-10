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
import { CATALOG_STALE_SECS, DELETE_CONFIRM_MS, EFFORT_OPTIONS, fmtTokens } from "./shared";

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

/** 新增/编辑服务后同步默认引用；纯函数便于保持配置只有一个事实来源。 */
function upsertProvider(config: ModelConfig, provider: ProviderConfig, originalRoute: string | null): ModelConfig {
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

  // 第一个真正拥有显式模型的服务自动成为默认；继承目录但未选择模型的服务
  // 不猜默认模型，避免写入一个不存在的 id。
  if (!defaultProvider?.trim() && provider.models.length > 0) {
    defaultProvider = provider.route;
    defaultModel = provider.models[0]?.id ?? null;
  }

  // 默认服务的模型集合被编辑后，若旧默认模型已不存在则回落到首个模型。
  const active = providers.find((item) => item.route === defaultProvider);
  if (active && !active.models.some((model) => model.id === defaultModel)) {
    defaultModel = active.models[0]?.id ?? null;
  }

  return { ...config, providers, defaultProvider, defaultModel };
}

function removeProviderFromConfig(config: ModelConfig, route: string): ModelConfig {
  const providers = config.providers.filter((provider) => provider.route !== route);
  if (config.defaultProvider !== route) return { ...config, providers };

  // 优先回退到有显式模型的服务，避免产生 provider 有值但 model 为空的无效默认。
  const next = providers.find((provider) => provider.models.length > 0);
  return {
    ...config,
    providers,
    defaultProvider: next?.route ?? null,
    defaultModel: next?.models[0]?.id ?? null,
  };
}

export function ModelsView() {
  const { t } = useTranslation();
  const toast = useAppStore((state) => state.toast);
  const loadModelConfig = useAppStore((state) => state.loadModelConfig);
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyRoute, setBusyRoute] = useState<string | null>(null);
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
        if (!disposed) setConfig(loaded);
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
        if (!file || Date.now() / 1000 - file.fetchedAt >= CATALOG_STALE_SECS) {
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
      setConfig(next);
    } catch (error) {
      toast(tErr(String(error)), "error");
      throw error;
    } finally {
      if (route) setBusyRoute(null);
      else setBusyGlobal(false);
    }
  };

  const persistDefault = async (route: string, model: string) => {
    const current = config ?? EMPTY_CONFIG;
    await persist({ ...current, defaultProvider: route, defaultModel: model });
    toast(t("Model configuration saved — changes take effect immediately"), "success");
  };

  const persistReasoning = async (value: string) => {
    const current = config ?? EMPTY_CONFIG;
    await persist({ ...current, defaultReasoningEffort: value || null });
    toast(t("Model configuration saved — changes take effect immediately"), "success");
  };

  const submitProvider = async (provider: ProviderConfig, originalRoute: string | null) => {
    const current = config ?? EMPTY_CONFIG;
    const next = upsertProvider(current, provider, originalRoute);
    await persist(next, provider.route);
    setDialog(null);
    toast(t("Model configuration saved — changes take effect immediately"), "success");
  };

  const makeDefault = async (provider: ProviderConfig) => {
    const model = provider.models[0]?.id;
    if (!model) return;
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
    const next = removeProviderFromConfig(current, route);
    await persist(next, route);
    toast(t("Model configuration saved — changes take effect immediately"), "success");
  };

  /** 服务行快捷探测：复用 model_remote_list。成功既证明凭据/端点可达，也返回模型数。 */
  const probeProvider = async (provider: ProviderConfig) => {
    if (!provider.baseURL?.trim() || !provider.apiKeyEnv?.trim()) return;
    setBusyRoute(provider.route);
    try {
      const models = await cmd.modelRemoteList(provider.baseURL, provider.api, provider.apiKeyEnv);
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

  const cfg = config ?? EMPTY_CONFIG;
  const defaultProvider = cfg.providers.find(
    (provider) => provider.route === (cfg.defaultProvider ?? "").trim(),
  );

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
                <div className="mt-0.5 truncate text-xs opacity-60" data-testid="default-model-summary">
                  {defaultProvider && cfg.defaultModel
                    ? `${defaultProvider.displayName ?? defaultProvider.route} · ${cfg.defaultModel}`
                    : t("No AI provider ready")}
                </div>
              </div>
              <DefaultModelMenu
                providers={cfg.providers}
                currentRoute={cfg.defaultProvider}
                currentModel={cfg.defaultModel}
                disabled={busyGlobal || cfg.providers.every((provider) => provider.models.length === 0)}
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
                value={cfg.defaultReasoningEffort ?? ""}
                disabled={busyGlobal}
                onChange={(event) => void persistReasoning(event.target.value).catch(() => undefined)}
                aria-label={t("Reasoning Effort")}
              >
                <option value="">{t("Not set")}</option>
                {EFFORT_OPTIONS.map((value) => (
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
                const rowBusy = busyRoute === provider.route;
                const firstModel = provider.models[0]?.id ?? null;
                const canProbe = Boolean(provider.baseURL?.trim() && provider.apiKeyEnv?.trim());
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
                        {!provider.apiKeyEnv && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs opacity-70">
                            {t("No API key reference yet")}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-xs opacity-60">
                        <span className="truncate">
                          {hostOf(provider.baseURL) ?? t("Inherits the built-in catalog")}
                        </span>
                        <span aria-hidden>·</span>
                        <span className="truncate font-mono">
                          {firstModel ?? t("Inherits catalog models")}
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
                      {!isDefault && firstModel && (
                        <button
                          className={BTN_SM}
                          disabled={rowBusy || busyGlobal}
                          onClick={() => void makeDefault(provider).catch(() => undefined)}
                        >
                          {t("Make default")}
                        </button>
                      )}
                      {canProbe && (
                        <button
                          className={BTN_SM}
                          disabled={rowBusy || busyGlobal}
                          onClick={() => void probeProvider(provider)}
                          title={t("Fetch models")}
                        >
                          {rowBusy ? t("Loading models…") : t("Fetch list")}
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
                setConfig(fresh);
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

// ============ 默认模型锚定菜单 ============

function DefaultModelMenu({
  providers,
  currentRoute,
  currentModel,
  disabled,
  onPick,
}: {
  providers: ProviderConfig[];
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

  // 候选 = 已配置路由的显式模型，按服务分组；搜索过滤（服务名 + 模型 id）。
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers
      .map((provider) => ({
        name: provider.displayName ?? provider.route,
        route: provider.route,
        models: provider.models.filter(
          (model) =>
            !q ||
            model.id.toLowerCase().includes(q) ||
            (provider.displayName ?? provider.route).toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.models.length > 0);
  }, [providers, query]);

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
