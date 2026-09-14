// Provider 可用性只由现有配置 + DSH credential describe 事实推导，不写回 settings.yaml。
// 内置目录 route 省略 apiKeyEnv 时遵循 dsh llm-pi-ai 原生语义：保持 configured-but-keyless，
// 由 pi-ai / harness 的 ambient 或已存登录凭据完成认证；自定义 route 无 apiKeyEnv 时
// 仍按显式匿名端点处理（Ollama / LM Studio / 本地兼容网关等）。

import type { ProviderConfig } from "@/shared/types";
import { MODEL_PRESETS } from "@/shared/lib/model-presets.generated";

const BUILTIN_ROUTES = new Set(MODEL_PRESETS.map((preset) => preset.id));

export type ProviderReadinessKind =
  | "checking"
  | "ready"
  | "anonymous"
  | "provider-auth"
  | "missing-env";

export type ProviderReadiness = {
  kind: ProviderReadinessKind;
  ready: boolean;
  credentialRef: string | null;
};

export function providerCredentialRefs(providers: ProviderConfig[]): string[] {
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
  credentialStatus: Record<string, boolean> | null,
): ProviderReadiness {
  const credentialRef = provider.apiKeyEnv?.trim() || null;
  const builtin = BUILTIN_ROUTES.has(provider.route.trim());

  if (!credentialRef) {
    return builtin
      ? { kind: "provider-auth", ready: true, credentialRef: null }
      : { kind: "anonymous", ready: true, credentialRef: null };
  }

  if (credentialStatus == null) {
    return { kind: "checking", ready: false, credentialRef };
  }

  return credentialStatus[credentialRef]
    ? { kind: "ready", ready: true, credentialRef }
    : { kind: "missing-env", ready: false, credentialRef };
}


/**
 * Launcher 自己的 HTTP Test/Fetch 只能使用显式 apiKeyEnv 或匿名端点；
 * provider-auth 由 dsh/pi-ai 内部解析，不能被 launcher 伪装成匿名请求。
 */
export function launcherRemoteProbeAllowed(readiness: ProviderReadiness): boolean {
  return readiness.ready && readiness.kind !== "provider-auth";
}
