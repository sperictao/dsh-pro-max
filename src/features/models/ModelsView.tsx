// 模型配置视图：编辑 ~/.dsh/settings.yaml 的模型域（agent-default-model +
// llm-pi-ai.providers）。信息架构对齐 PI-Desktop：默认模型行 + 更改锚定菜单、
// AI 服务列表（徽标/设为默认/编辑/两步删除）、目录状态行 + 手动刷新、
// 添加/编辑对话框（含模型双栏与高级设置）、配置导入。settings.yaml 为热加载
// （dsh-settings-file 监听 + llm-pi-ai 按请求解析），保存后即时生效。

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

export function ModelsView() {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  const loadModelConfig = useAppStore((s) => s.loadModelConfig);
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [saved, setSaved] = useState<ModelConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [catalogFetchedAt, setCatalogFetchedAt] = useState<number | null>(null);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [dialog, setDialog] = useState<ProviderDialogState | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // 两步删除：已武装的 route；3 秒未确认自动还原
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const cfg = await loadModelConfig();
        if (!disposed) {
          setConfig(cfg);
          setSaved(cfg);
        }
      } catch (e) {
        if (!disposed) toast(tErr(String(e)), "error");
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 目录快照：立即可用，缺失/过期自动后台刷新；失败静默（缓存不是事实来源）
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

  const refreshCatalog = async (background: boolean) => {
    setCatalogRefreshing(true);
    try {
      const fresh = await cmd.modelCatalogRefresh();
      setCatalog(fresh.entries);
      setCatalogFetchedAt(fresh.fetchedAt);
      setCatalogState("ready");
    } catch (e) {
      // 自动刷新静默；手动刷新给出提示但不打断编辑
      if (!background) toast(tErr(String(e)), "error");
    } finally {
      setCatalogRefreshing(false);
    }
  };

  const dirty = useMemo(
    () => config != null && saved != null && JSON.stringify(config) !== JSON.stringify(saved),
    [config, saved],
  );

  const patch = (p: Partial<ModelConfig>) => setConfig((c) => (c ? { ...c, ...p } : c));

  const armDelete = (route: string) => {
    setArmedDelete(route);
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
    deleteTimer.current = setTimeout(() => setArmedDelete(null), DELETE_CONFIRM_MS);
  };

  const disarmDelete = () => {
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
    setArmedDelete(null);
  };

  const removeProvider = (route: string) => {
    disarmDelete();
    setConfig((c) => {
      if (!c) return c;
      const providers = c.providers.filter((p) => p.route !== route);
      // 删除默认服务：回退到下一个可用服务的首个模型；无可用则清空
      if (c.defaultProvider === route) {
        const next = providers[0];
        return {
          ...c,
          providers,
          defaultProvider: next?.route ?? null,
          defaultModel: next?.models[0]?.id ?? null,
        };
      }
      return { ...c, providers };
    });
  };

  const submitProvider = (provider: ProviderConfig, originalRoute: string | null) => {
    setConfig((c) => {
      if (!c) return c;
      // 编辑态以原路由键定位（路由键改名 = 原位替换而非新增）；新增按路由键查重
      const locate = originalRoute ?? provider.route;
      const existing = c.providers.findIndex((p) => p.route === locate);
      const providers =
        existing >= 0
          ? c.providers.map((p, i) => (i === existing ? provider : p))
          : [...c.providers, provider];
      // 改名的是默认服务：默认引用同步到新路由键
      if (originalRoute && c.defaultProvider === originalRoute && provider.route !== originalRoute) {
        return { ...c, providers, defaultProvider: provider.route };
      }
      // 保存首个服务且当前无默认：自动设为默认（PI 同款）
      if (!c.defaultProvider?.trim() && provider.models.length > 0) {
        return {
          ...c,
          providers,
          defaultProvider: provider.route,
          defaultModel: provider.models[0]?.id ?? c.defaultModel,
        };
      }
      // 默认服务仍在但默认模型已被删掉：回落到该服务首个模型
      const defaultProvider = providers.find((p) => p.route === c.defaultProvider);
      const defaultModel =
        defaultProvider && !defaultProvider.models.some((m) => m.id === c.defaultModel)
          ? defaultProvider.models[0]?.id ?? null
          : c.defaultModel;
      return { ...c, providers, defaultModel };
    });
    setDialog(null);
  };

  const save = async () => {
    if (!config) return;
    if (config.defaultProvider?.trim() && !config.defaultModel?.trim()) {
      toast(t("Default model provider and model are required"), "error");
      return;
    }
    if (config.providers.some((p) => !p.route.trim())) {
      toast(t("Provider route key cannot be empty"), "error");
      return;
    }
    const routes = config.providers.map((p) => p.route.trim());
    if (new Set(routes).size !== routes.length) {
      toast(t("Provider route keys must be unique"), "error");
      return;
    }
    setSaving(true);
    try {
      await cmd.modelConfigSave(config);
      setSaved(config);
      toast(t("Model configuration saved — changes take effect immediately"), "success");
    } catch (e) {
      toast(tErr(String(e)), "error");
    } finally {
      setSaving(false);
    }
  };

  const openImport = () => {
    if (dirty) {
      toast(t("Save or discard your changes before importing."), "error");
      return;
    }
    setImportOpen(true);
  };

  if (loading) {
    return (
      <main className="flex-1 overflow-y-auto p-6" id="models-view">
        <p className="text-sm opacity-60">{t("Detecting…")}</p>
      </main>
    );
  }
  const cfg = config ?? {
    defaultProvider: null,
    defaultModel: null,
    defaultReasoningEffort: null,
    providers: [],
  };

  const defaultProvider = cfg.providers.find(
    (p) => p.route === (cfg.defaultProvider ?? "").trim(),
  );

  return (
    <main className="flex-1 overflow-y-auto p-6" id="models-view">
      <h2 className="mb-1 text-base font-semibold">{t("Model Configuration")}</h2>
      <p className="mb-4 text-xs opacity-60">
        {t(
          "Edit the model settings of ~/.dsh/settings.yaml. API keys are stored as environment variable names, never as values.",
        )}
      </p>

      {/* —— 默认模型 —— */}
      <section className="mb-6 border-b border-border pb-6" id="models-default">
        <h3 className="mb-3 text-sm font-semibold">{t("Default Model")}</h3>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <label className="w-32 shrink-0 text-sm opacity-70">{t("Default model")}</label>
            <span className="flex-1 text-sm" data-testid="default-model-summary">
              {defaultProvider && cfg.defaultModel
                ? `${defaultProvider.displayName ?? defaultProvider.route} · ${cfg.defaultModel}`
                : t("No AI provider ready")}
            </span>
            <DefaultModelMenu
              providers={cfg.providers}
              currentRoute={cfg.defaultProvider}
              currentModel={cfg.defaultModel}
              disabled={cfg.providers.length === 0}
              onPick={(route, model) => patch({ defaultProvider: route, defaultModel: model })}
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="w-32 shrink-0 text-sm opacity-70">{t("Reasoning Effort")}</label>
            <select
              className={`${SELECT} max-w-64`}
              value={cfg.defaultReasoningEffort ?? ""}
              onChange={(e) => patch({ defaultReasoningEffort: e.target.value || null })}
              aria-label={t("Reasoning Effort")}
            >
              <option value="">{t("Not set")}</option>
              {EFFORT_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* —— AI 服务列表 —— */}
      <section className="mb-6" id="models-providers">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            {t("AI providers")}
            <span className="rounded bg-muted px-1.5 text-xs opacity-70">{cfg.providers.length}</span>
          </h3>
          <div className="flex items-center gap-2">
            <button className={BTN} id="btn-import-models" onClick={openImport}>
              {t("Import configuration")}
            </button>
            <button
              className={BTN_PRIMARY}
              id="btn-add-provider"
              onClick={() => setDialog({ mode: "add" })}
            >
              {t("Add provider")}
            </button>
          </div>
        </div>
        {cfg.providers.length === 0 && (
          <div
            className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-10"
            id="models-empty"
          >
            <p className="text-sm font-medium">{t("No AI providers yet")}</p>
            <p className="text-xs opacity-60">{t("Add an AI provider to start.")}</p>
            <button
              className={BTN_PRIMARY}
              onClick={() => setDialog({ mode: "add" })}
              data-testid="empty-add-provider"
            >
              {t("Add provider")}
            </button>
          </div>
        )}
        <div className="flex flex-col gap-2">
          {cfg.providers.map((p, i) => {
            const isDefault = p.route === (cfg.defaultProvider ?? "").trim();
            const armed = armedDelete === p.route;
            return (
              <div
                key={p.route}
                className="flex items-center gap-3 rounded-lg border border-border px-4 py-3"
                id={`provider-row-${i}`}
                data-route={p.route}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) disarmDelete();
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {p.displayName ?? p.route}
                    </span>
                    {isDefault && (
                      <span className="rounded bg-primary/10 px-1.5 text-xs text-primary" id={`badge-default-${i}`}>
                        {t("default")}
                      </span>
                    )}
                    {!p.apiKeyEnv && (
                      <span className="rounded bg-muted px-1.5 text-xs opacity-70">
                        {t("No API key reference yet")}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs opacity-60">
                    {hostOf(p.baseURL) ?? t("Inherits the built-in catalog")}
                    {" · "}
                    {p.models.length > 0
                      ? t("{{count}} models", { count: p.models.length })
                      : t("Inherits catalog models")}
                  </div>
                </div>
                {!isDefault && p.models.length > 0 && (
                  <button
                    className={BTN_SM}
                    onClick={() => {
                      patch({
                        defaultProvider: p.route,
                        defaultModel: p.models[0]?.id ?? null,
                      });
                    }}
                  >
                    {t("Make default")}
                  </button>
                )}
                <button
                  className={BTN_SM}
                  aria-label={t("Edit provider")}
                  onClick={() => setDialog({ mode: "edit", index: i, provider: p })}
                >
                  {t("Edit")}
                </button>
                {armed ? (
                  <button
                    className={BTN_DANGER_SM}
                    id={`btn-confirm-delete-${i}`}
                    onClick={() => removeProvider(p.route)}
                  >
                    {t("Delete?")}
                  </button>
                ) : (
                  <button
                    className={BTN_DANGER_SM}
                    aria-label={t("Remove provider")}
                    onClick={() => armDelete(p.route)}
                  >
                    {t("Delete")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* —— 目录状态行 —— */}
      <div className="mb-4 flex items-center justify-between text-xs opacity-70" id="models-catalog">
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

      <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
        <p className="text-xs opacity-60">
          {dirty
            ? t("Unsaved changes — save to apply. Changes take effect immediately (hot reload).")
            : t("Changes take effect immediately after saving (hot reload).")}
        </p>
        <button className={BTN_PRIMARY} id="btn-save-models" disabled={saving} onClick={() => void save()}>
          {saving ? t("Working…") : t("Save")}
        </button>
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
                setSaved(fresh);
              } catch {
                // 重载失败保持现状；下次进入页面自动重读
              }
            })();
            toast(
              t("Import finished: {{imported}} imported, {{skipped}} skipped, {{failed}} failed", {
                imported: result.imported,
                skipped: result.skipped,
                failed: result.failed,
              }) + (result.literal > 0 ? ` · ${t("{{count}} with literal keys left credential-free", { count: result.literal })}` : ""),
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
  onPick: (route: string, model: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 候选 = 已配置路由的模型，按服务分组；搜索过滤（服务名 + 模型 id）
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers
      .map((p) => ({
        name: p.displayName ?? p.route,
        route: p.route,
        models: p.models.filter(
          (m) =>
            !q ||
            m.id.toLowerCase().includes(q) ||
            (p.displayName ?? p.route).toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.models.length > 0);
  }, [providers, query]);

  const flat = useMemo(
    () => groups.flatMap((g) => g.models.map((m) => ({ route: g.route, id: m.id, name: g.name }))),
    [groups],
  );

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (route: string, model: string) => {
    onPick(route, model);
    setOpen(false);
    setQuery("");
    setHi(-1);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        className={BTN}
        id="btn-change-default-model"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
      >
        {t("Change")}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-80 rounded-md border border-border bg-background shadow-lg">
          <div className="border-b border-border p-2">
            <input
              ref={inputRef}
              className={INPUT}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHi(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHi((h) => Math.min(h + 1, flat.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHi((h) => Math.max(h - 1, 0));
                } else if (e.key === "Enter" && flat[hi]) {
                  e.preventDefault();
                  pick(flat[hi].route, flat[hi].id);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder={t("Filter models")}
              aria-label={t("Filter models")}
            />
          </div>
          <ul role="listbox" aria-label={t("Default model")} className="max-h-64 overflow-y-auto py-1">
            {groups.map((g) => (
              <li key={g.route}>
                <div className="px-3 py-1 text-xs font-medium opacity-60" data-provider-group={g.route}>
                  {g.name}
                </div>
                <ul>
                  {g.models.map((m) => {
                    const idx = flat.findIndex((f) => f.route === g.route && f.id === m.id);
                    const isCurrent = g.route === (currentRoute ?? "").trim() && m.id === currentModel;
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={isCurrent}
                          className={`flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-sm ${idx === hi ? "bg-accent" : ""}`}
                          onMouseDown={(ev) => {
                            ev.preventDefault();
                            pick(g.route, m.id);
                          }}
                          onMouseEnter={() => setHi(idx)}
                        >
                          <span className="truncate font-mono text-xs">
                            {isCurrent ? "✓ " : ""}
                            {m.id}
                          </span>
                          {fmtTokens(m.contextWindow)}
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

function hostOf(baseURL: string | null): string | null {
  if (!baseURL?.trim()) return null;
  try {
    return new URL(baseURL.trim()).host;
  } catch {
    return baseURL.trim();
  }
}
