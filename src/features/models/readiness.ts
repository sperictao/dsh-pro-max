// Provider 可用性只由现有配置 + launcher 进程环境事实推导，不写回 settings.yaml。
// 内置目录 route 代表托管服务，必须配置 apiKeyEnv；自定义 route 未配置
// apiKeyEnv 时按显式匿名端点处理（Ollama / LM Studio / 本地兼容网关等）。

import type { ProviderConfig } from "@/shared/types";
import { MODEL_PRESETS } from "@/shared/lib/model-presets.generated";

const BUILTIN_ROUTES = new Set(MODEL_PRESETS.map((preset) => preset.id));

export type ProviderReadinessKind =
  | "checking"
  | "ready"
  | "anonymous"
  | "missing-credential"
  | "missing-env";

export type ProviderReadiness = {
  kind: ProviderReadinessKind;
  ready: boolean;
  envName: string | null;
};

export function providerEnvNames(providers: ProviderConfig[]): string[] {
  return [
    ...new Set(
      providers
        .map((provider) => provider.apiKeyEnv?.trim() ?? "")
        .filter((name) => name.length > 0),
    ),
  ];
}

export function providerReadiness(
  provider: ProviderConfig,
  envStatus: Record<string, boolean> | null,
): ProviderReadiness {
  const envName = provider.apiKeyEnv?.trim() || null;
  const builtin = BUILTIN_ROUTES.has(provider.route.trim());

  if (!envName) {
    return builtin
      ? { kind: "missing-credential", ready: false, envName: null }
      : { kind: "anonymous", ready: true, envName: null };
  }

  if (envStatus == null) {
    return { kind: "checking", ready: false, envName };
  }

  return envStatus[envName]
    ? { kind: "ready", ready: true, envName }
    : { kind: "missing-env", ready: false, envName };
}
