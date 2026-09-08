// 模型配置视图：编辑 ~/.dsh/settings.yaml 的模型域（agent-default-model +
// llm-pi-ai.providers）。高级字段（extra）不在 UI 展示，保存时原样透传。
// 模型联想 = market 同款模糊搜索（toLowerCase 子串匹配），候选源 = models.dev
// 全量目录快照（缺失/超 24h 自动后台刷新，失败静默降级）+ 已配置模型。

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import * as cmd from "@/shared/commands";
import { BTN, BTN_DANGER_SM, BTN_PRIMARY, INPUT, INPUT_MONO, SELECT } from "@/shared/lib/ui";
import type { ModelCatalogEntry, ModelConfig, ProviderConfig } from "@/shared/types";
import { tErr } from "@/shared/i18n/error";

// dsh pi-ai 适配器支持的 wire 协议（PROTOCOLS 表，most-reached first）
const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages"];
// pi-ai ModelThinkingLevel 全集；空 = 不设置（读目录默认）
const EFFORT_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
// 目录快照过期窗口与候选截断（浮层不渲染全量 4000+ 条）
const CATALOG_STALE_SECS = 24 * 60 * 60;
const SUGGESTION_LIMIT = 50;

const emptyProvider = (): ProviderConfig => ({
  route: "",
  displayName: null,
  baseURL: null,
  api: "openai-completions",
  apiKeyEnv: null,
  models: [],
  extra: null,
});

// wire 协议 → 目录家族；协议未设置时不过滤（null）
const familyOf = (api: string | null): "anthropic" | "openai" | null =>
  api === "anthropic-messages" ? "anthropic" : api ? "openai" : null;

export function ModelsView() {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  const loadModelConfig = useAppStore((s) => s.loadModelConfig);
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const cfg = await loadModelConfig();
        if (!disposed) setConfig(cfg);
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
        if (file && !disposed) setCatalog(file.entries);
        if (!file || Date.now() / 1000 - file.fetchedAt >= CATALOG_STALE_SECS) {
          const fresh = await cmd.modelCatalogRefresh();
          if (!disposed) setCatalog(fresh.entries);
        }
      } catch {
        // 刷新失败不打断配置编辑；下次进入重试
      }
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (p: Partial<ModelConfig>) => setConfig((c) => (c ? { ...c, ...p } : c));
  const patchProvider = (index: number, p: Partial<ProviderConfig>) =>
    setConfig((c) =>
      c ? { ...c, providers: c.providers.map((pr, i) => (i === index ? { ...pr, ...p } : pr)) } : c,
    );

  const save = async () => {
    if (!config) return;
    if (!config.defaultProvider?.trim() || !config.defaultModel?.trim()) {
      toast(t("Default model provider and model are required"), "error");
      return;
    }
    if (config.providers.some((p) => !p.route.trim())) {
      toast(t("Provider route key cannot be empty"), "error");
      return;
    }
    setSaving(true);
    try {
      await cmd.modelConfigSave(config);
      toast(t("Model configuration saved"), "success");
    } catch (e) {
      toast(tErr(String(e)), "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <main className="flex-1 overflow-y-auto p-6" id="models-view">
        <p className="text-sm opacity-60">{t("Detecting…")}</p>
      </main>
    );
  }
  const cfg = config ?? { defaultProvider: null, defaultModel: null, defaultReasoningEffort: null, providers: [] };
  const providerIds = [cfg.defaultProvider ?? "", ...cfg.providers.map((p) => p.route)].filter(Boolean);
  const defaultProvider = cfg.providers.find((p) => p.route === (cfg.defaultProvider ?? "").trim());

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
            <label className="w-32 shrink-0 text-sm opacity-70">{t("Provider")}</label>
            <input
              className={INPUT_MONO}
              list="model-provider-ids"
              value={cfg.defaultProvider ?? ""}
              onChange={(e) => patch({ defaultProvider: e.target.value })}
              placeholder="deepseek-official"
            />
            <datalist id="model-provider-ids">
              {providerIds.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          </div>
          <div className="flex items-center gap-3">
            <label className="w-32 shrink-0 text-sm opacity-70">{t("Model")}</label>
            <div className="flex-1">
              <ModelSearchInput
                value={cfg.defaultModel ?? ""}
                onValueChange={(v) => patch({ defaultModel: v })}
                onPick={(id) => patch({ defaultModel: id })}
                catalog={catalog}
                family={familyOf(defaultProvider?.api ?? null)}
                configured={defaultProvider?.models ?? []}
                placeholder="deepseek-v4-pro"
                ariaLabel={t("Default model")}
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="w-32 shrink-0 text-sm opacity-70">{t("Reasoning Effort")}</label>
            <select
              className={SELECT}
              value={cfg.defaultReasoningEffort ?? ""}
              onChange={(e) => patch({ defaultReasoningEffort: e.target.value || null })}
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

      {/* —— 提供商列表 —— */}
      <section className="mb-6" id="models-providers">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t("Providers")}</h3>
          <button className={BTN} id="btn-add-provider" onClick={() => setConfig((c) => ({ ...c!, providers: [...c!.providers, emptyProvider()] }))}>
            {t("Add Provider")}
          </button>
        </div>
        {cfg.providers.length === 0 && (
          <p className="text-sm opacity-60">{t("No custom providers. Add one to point dsh at your own LLM gateway.")}</p>
        )}
        <div className="flex flex-col gap-4">
          {cfg.providers.map((p, i) => (
            <ProviderCard
              key={i}
              index={i}
              provider={p}
              catalog={catalog}
              onChange={(patchP) => patchProvider(i, patchP)}
              onRemove={() => setConfig((c) => ({ ...c!, providers: c!.providers.filter((_, j) => j !== i) }))}
            />
          ))}
        </div>
      </section>

      <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
        <p className="text-xs opacity-60">{t("Restart the dsh web service after saving to apply changes.")}</p>
        <button className={BTN_PRIMARY} id="btn-save-models" disabled={saving} onClick={() => void save()}>
          {saving ? t("Working…") : t("Save")}
        </button>
      </div>
    </main>
  );
}

// market 同款模糊搜索：query.trim().toLowerCase() 子串匹配 id/name，无第三方库。
// 候选 = 已配置模型（始终保留）∪ 目录按协议家族过滤，去重后截断前 50 条。
function ModelSearchInput({
  value,
  onValueChange,
  onPick,
  catalog,
  family,
  configured,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onValueChange: (v: string) => void;
  onPick: (id: string) => void;
  catalog: ModelCatalogEntry[];
  family: "anthropic" | "openai" | null;
  configured: string[];
  placeholder: string;
  ariaLabel: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  const candidates = useMemo(() => {
    const seen = new Set(configured);
    const pool: { id: string; name: string }[] = [
      ...configured.map((id) => ({ id, name: id })),
      ...catalog.filter((e) => (!family || e.family === family) && !seen.has(e.id)),
    ];
    const q = value.trim().toLowerCase();
    const matched = q
      ? pool.filter((e) => e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q))
      : pool;
    return matched.slice(0, SUGGESTION_LIMIT);
  }, [configured, catalog, family, value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (id: string) => {
    onPick(id);
    setOpen(false);
    setHi(-1);
  };

  return (
    <div ref={rootRef} className="relative">
      <input
        className={INPUT_MONO}
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onValueChange(e.target.value);
          setOpen(true);
          setHi(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHi((h) => Math.min(h + 1, candidates.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            if (open && hi >= 0 && candidates[hi]) {
              e.preventDefault();
              pick(candidates[hi].id);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && candidates.length > 0 && (
        <ul
          role="listbox"
          aria-label={t("Model suggestions")}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-background py-1 shadow-lg"
        >
          {candidates.map((e, i) => (
            <li key={e.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === hi}
                className={`flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-sm ${i === hi ? "bg-accent" : ""}`}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  pick(e.id);
                }}
                onMouseEnter={() => setHi(i)}
              >
                <span className="font-mono">{e.id}</span>
                {e.name !== e.id && <span className="shrink-0 text-xs opacity-60">{e.name}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && candidates.length === 0 && value.trim() && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 rounded-md border border-border bg-background px-3 py-2 text-xs opacity-60 shadow-lg">
          {t("No matching models")}
        </div>
      )}
    </div>
  );
}

function ProviderCard({
  index,
  provider,
  catalog,
  onChange,
  onRemove,
}: {
  index: number;
  provider: ProviderConfig;
  catalog: ModelCatalogEntry[];
  onChange: (p: Partial<ProviderConfig>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  const modelsText = provider.models.join("\n");
  const [draft, setDraft] = useState("");
  const [fetching, setFetching] = useState(false);
  const [remote, setRemote] = useState<string[] | null>(null);

  const appendModel = (id: string) => {
    if (!provider.models.includes(id)) onChange({ models: [...provider.models, id] });
  };

  const fetchModels = async () => {
    setFetching(true);
    try {
      setRemote(await cmd.modelRemoteList(provider.baseURL ?? "", provider.api ?? null, provider.apiKeyEnv ?? null));
    } catch (e) {
      setRemote(null);
      toast(tErr(String(e)), "error");
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="rounded-lg border border-border p-4" id={`provider-card-${index}`}>
      <div className="mb-3 flex items-center justify-between">
        <input
          className={`${INPUT_MONO} max-w-64 font-semibold`}
          value={provider.route}
          onChange={(e) => onChange({ route: e.target.value })}
          placeholder="my-gateway"
          aria-label={t("Route key")}
        />
        <button className={BTN_DANGER_SM} onClick={onRemove} aria-label={t("Remove provider")}>
          {t("Remove")}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs opacity-70">
          {t("Display Name")}
          <input className={INPUT} value={provider.displayName ?? ""} onChange={(e) => onChange({ displayName: e.target.value || null })} />
        </label>
        <label className="flex flex-col gap-1 text-xs opacity-70">
          {t("Wire Protocol")}
          <select className={SELECT} value={provider.api ?? ""} onChange={(e) => onChange({ api: e.target.value || null })}>
            <option value="">{t("Not set")}</option>
            {API_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs opacity-70">
          Base URL
          <input className={`${INPUT_MONO} font-mono`} value={provider.baseURL ?? ""} onChange={(e) => onChange({ baseURL: e.target.value || null })} placeholder="https://gw.example.com/v1" />
        </label>
        <label className="flex flex-col gap-1 text-xs opacity-70">
          {t("API Key Env Var")}
          <input className={`${INPUT_MONO} font-mono`} value={provider.apiKeyEnv ?? ""} onChange={(e) => onChange({ apiKeyEnv: e.target.value || null })} placeholder="MY_GATEWAY_API_KEY" />
        </label>
      </div>
      <div className="mt-3 flex flex-col gap-1 text-xs opacity-70">
        <div className="flex items-center justify-between">
          <span>{t("Models (one per line)")}</span>
          <button className={BTN} id={`btn-fetch-models-${index}`} disabled={fetching} onClick={() => void fetchModels()}>
            {fetching ? t("Fetching…") : t("Fetch models")}
          </button>
        </div>
        <ModelSearchInput
          value={draft}
          onValueChange={setDraft}
          onPick={(id) => {
            appendModel(id);
            setDraft("");
          }}
          catalog={catalog}
          family={familyOf(provider.api)}
          configured={provider.models}
          placeholder={t("Search models…")}
          ariaLabel={t("Add model")}
        />
        <textarea
          className={`${INPUT} h-24 py-2 font-mono`}
          value={modelsText}
          onChange={(e) => onChange({ models: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
          spellCheck={false}
          aria-label={t("Models (one per line)")}
        />
      </div>
      {remote && (
        <div role="group" aria-label={t("Available upstream models")} className="mt-2 rounded-md border border-border p-2">
          {remote.length === 0 ? (
            <p className="text-xs opacity-60">{t("Upstream returned no models")}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {remote.map((id) => {
                const added = provider.models.includes(id);
                return (
                  <button
                    key={id}
                    className={BTN}
                    disabled={added}
                    onClick={() => appendModel(id)}
                    aria-label={added ? `${id} ✓` : id}
                  >
                    {added ? `${id} ✓` : id}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
