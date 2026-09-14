import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@/shared/types";
import { launcherRemoteProbeAllowed, providerCredentialRefs, providerReadiness } from "./readiness";

const provider = (patch: Partial<ProviderConfig>): ProviderConfig => ({
  route: "custom",
  displayName: null,
  baseURL: "http://127.0.0.1:11434/v1",
  api: "openai-completions",
  apiKeyEnv: null,
  models: [],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
  ...patch,
});

describe("provider readiness", () => {
  it("treats custom endpoints without a credential reference as explicit anonymous providers", () => {
    expect(providerReadiness(provider({}), {})).toEqual({
      kind: "anonymous",
      ready: true,
      credentialRef: null,
    });
  });

  it("defers built-in providers without apiKeyEnv to dsh/pi-ai provider auth", () => {
    const readiness = providerReadiness(provider({ route: "openai" }), {});
    expect(readiness).toEqual({
      kind: "provider-auth",
      ready: true,
      credentialRef: null,
    });
    expect(launcherRemoteProbeAllowed(readiness)).toBe(false);
  });

  it("distinguishes checking, missing and available credentials", () => {
    const configured = provider({ apiKeyEnv: "MY_KEY" });
    expect(providerReadiness(configured, null).kind).toBe("checking");
    expect(providerReadiness(configured, {}).kind).toBe("missing-env");
    expect(providerReadiness(configured, { MY_KEY: true })).toEqual({
      kind: "ready",
      ready: true,
      credentialRef: "MY_KEY",
    });
    expect(launcherRemoteProbeAllowed(providerReadiness(configured, { MY_KEY: true }))).toBe(true);
  });

  it("normalizes and deduplicates credential refs before IPC", () => {
    expect(
      providerCredentialRefs([
        provider({ route: "a", apiKeyEnv: " SAME_KEY " }),
        provider({ route: "b", apiKeyEnv: "SAME_KEY" }),
        provider({ route: "c", apiKeyEnv: null }),
      ]),
    ).toEqual(["SAME_KEY"]);
  });
});
