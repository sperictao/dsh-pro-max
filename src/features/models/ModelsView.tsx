// 模型配置视图：编辑 ~/.dsh/settings.yaml 的模型域（agent-default-model +
// llm-pi-ai.providers）。高级字段（extra）不在 UI 展示，保存时原样透传。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/shared/store";
import * as cmd from "@/shared/commands";
import { BTN, BTN_DANGER_SM, BTN_PRIMARY, INPUT, INPUT_MONO, SELECT } from "@/shared/lib/ui";
import type { ModelConfig, ProviderConfig } from "@/shared/types";
import { tErr } from "@/shared/i18n/error";

// dsh pi-ai 适配器支持的 wire 协议（PROTOCOLS 表，most-reached first）
const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages"];
// pi-ai ModelThinkingLevel 全集；空 = 不设置（读目录默认）
const EFFORT_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const emptyProvider = (): ProviderConfig => ({
  route: "",
  displayName: null,
  baseURL: null,
  api: "openai-completions",
  apiKeyEnv: null,
  models: [],
  extra: null,
});

export function ModelsView() {
  const { t } = useTranslation();
  const toast = useAppStore((s) => s.toast);
  const loadModelConfig = useAppStore((s) => s.loadModelConfig);
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
            <input
              className={INPUT_MONO}
              list={`provider-models-${cfg.defaultProvider ?? ""}`}
              value={cfg.defaultModel ?? ""}
              onChange={(e) => patch({ defaultModel: e.target.value })}
              placeholder="deepseek-v4-pro"
            />
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

function ProviderCard({
  index,
  provider,
  onChange,
  onRemove,
}: {
  index: number;
  provider: ProviderConfig;
  onChange: (p: Partial<ProviderConfig>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const modelsText = provider.models.join("\n");
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
      <label className="mt-3 flex flex-col gap-1 text-xs opacity-70">
        {t("Models (one per line)")}
        <textarea
          className={`${INPUT} h-24 py-2 font-mono`}
          value={modelsText}
          onChange={(e) => onChange({ models: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
          spellCheck={false}
        />
      </label>
    </div>
  );
}
