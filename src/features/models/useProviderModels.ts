import { useEffect, useRef, useState } from "react";
import * as cmd from "@/shared/commands";
import type { ProviderConfig } from "@/shared/types";
import { validateBaseUrl } from "./shared";

export const MODEL_DISCOVERY_DEBOUNCE_MS = 600;

export type ProviderModelsSource = "cache" | "remote";
export type ProviderModelsState = {
  status: "idle" | "loading" | "ready" | "error";
  models: string[] | null;
  source?: ProviderModelsSource;
  error?: string;
};

export type ProviderModelsDiscovery = ProviderModelsState & {
  reload: () => void;
  canReload: boolean;
};

const IDLE: ProviderModelsState = { status: "idle", models: null };

function headersKey(headers: ProviderConfig["headers"]): string {
  return JSON.stringify(
    Object.entries(headers ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function canDiscover(provider: ProviderConfig): boolean {
  const baseURL = provider.baseURL?.trim() ?? "";
  return Boolean(baseURL) && validateBaseUrl(baseURL) == null;
}

async function fetchRemote(provider: ProviderConfig, apiKey: string | null): Promise<string[]> {
  return await cmd.modelRemoteList(
    provider.baseURL ?? "",
    provider.api ?? null,
    provider.apiKeyEnv ?? null,
    provider.headers,
    apiKey,
  );
}

/**
 * Cache-first stale-while-revalidate discovery. The connection fingerprint is
 * the effect boundary, so stale rows disappear immediately after URL/protocol/
 * credential/header edits. Only the newest request may publish its result.
 */
export function useProviderModels(
  active: boolean,
  provider: ProviderConfig,
  apiKey: string | null = null,
): ProviderModelsDiscovery {
  const [state, setState] = useState<ProviderModelsState>(IDLE);
  const requestSeq = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const paramsRef = useRef(provider);
  paramsRef.current = provider;
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;

  const baseURL = provider.baseURL ?? "";
  const api = provider.api ?? null;
  const apiKeyEnv = provider.apiKeyEnv ?? null;
  const hKey = headersKey(provider.headers);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const run = async (requestId: number) => {
    if (requestSeq.current !== requestId) return;
    const current = paramsRef.current;
    const previous = stateRef.current;
    setState({
      status: "loading",
      models: previous.models,
      ...(previous.source ? { source: previous.source } : {}),
    });
    try {
      const models = await fetchRemote(current, apiKeyRef.current);
      if (requestSeq.current !== requestId) return;
      if (models.length > 0) {
        setState({ status: "ready", models, source: "remote" });
      } else if (previous.models && previous.models.length > 0) {
        setState({
          status: "error",
          models: previous.models,
          source: previous.source ?? "cache",
          error: "This service returned no models. Add a model ID below.",
        });
      } else {
        setState({ status: "ready", models: [], source: "remote" });
      }
    } catch (cause) {
      if (requestSeq.current !== requestId) return;
      setState({
        status: "error",
        models: previous.models,
        ...(previous.source ? { source: previous.source } : {}),
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  useEffect(() => {
    clearTimer();
    const requestId = ++requestSeq.current;
    if (!active || !canDiscover(provider)) {
      setState(IDLE);
      return;
    }

    // Connection edits revoke the old rows immediately. Then paint a matching
    // persistent cache entry, if one exists, before the debounced live probe.
    setState(IDLE);
    void (async () => {
      // A typed-but-unsaved key is a new credential boundary. Do not paint a cache
      // produced by another key; the secret itself is never persisted in the cache key.
      if (!apiKey) {
        try {
          const cached = await cmd.modelRemoteCacheGet(baseURL, api, apiKeyEnv, provider.headers);
          if (requestSeq.current !== requestId) return;
          if (cached?.models.length) {
            setState({ status: "loading", models: cached.models, source: "cache" });
          }
        } catch {
          // Cache is an optimization only; a damaged/unavailable cache never blocks live discovery.
        }
      }
      if (requestSeq.current !== requestId) return;
      timerRef.current = setTimeout(() => void run(requestId), MODEL_DISCOVERY_DEBOUNCE_MS);
    })();

    return () => {
      requestSeq.current += 1;
      clearTimer();
    };
  }, [active, baseURL, api, apiKeyEnv, hKey, apiKey]);

  const reload = () => {
    if (!active || !canDiscover(paramsRef.current)) return;
    clearTimer();
    const requestId = ++requestSeq.current;
    void run(requestId);
  };

  return {
    ...state,
    reload,
    canReload: active && canDiscover(provider) && state.status !== "loading",
  };
}
