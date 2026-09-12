import type { ProviderConfig } from "@/shared/types";

export type CredentialWrite = { ref: string; value: string };
export type ApiKeyFailure = "API key cannot be blank" | "API key contains invalid characters";

const LEGAL_API_KEY = /^[\x21-\x7E]+$/;
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/;

export function deriveCredentialRef(route: string): string {
  return `${route.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

export function credentialRefFor(provider: Pick<ProviderConfig, "route" | "apiKeyEnv">): string {
  return provider.apiKeyEnv?.trim() || deriveCredentialRef(provider.route.trim());
}

function isQuoted(value: string): boolean {
  const first = value[0];
  if (first !== '"' && first !== "'" && first !== "`") return false;
  return value.length > 1 && value.endsWith(first);
}

export function apiKeyFailure(draft: string): ApiKeyFailure | null {
  if (draft.length === 0) return null;
  const value = draft.trim();
  if (value.length === 0) return "API key cannot be blank";
  if (ENV_LINE.test(value) || isQuoted(value) || !LEGAL_API_KEY.test(value)) {
    return "API key contains invalid characters";
  }
  return null;
}
