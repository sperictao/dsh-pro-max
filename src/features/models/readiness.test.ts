import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@/shared/types";
import { providerEnvNames, providerReadiness } from "./readiness";

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
      envName: null,
    });
  });

  it("requires a credential reference for built-in catalog providers", () => {
    expect(providerReadiness(provider({ route: "openai" }), {})).toEqual({
      kind: "missing-credential",
      ready: false,
      envName: null,
    });
  });

  it("distinguishes checking, missing env and available env", () => {
    const configured = provider({ apiKeyEnv: "MY_KEY" });
    expect(providerReadiness(configured, null).kind).toBe("checking");
    expect(providerReadiness(configured, {}).kind).toBe("missing-env");
    expect(providerReadiness(configured, { MY_KEY: true })).toEqual({
      kind: "ready",
      ready: true,
      envName: "MY_KEY",
    });
  });

  it("normalizes and deduplicates env names before IPC", () => {
    expect(
      providerEnvNames([
        provider({ route: "a", apiKeyEnv: " SAME_KEY " }),
        provider({ route: "b", apiKeyEnv: "SAME_KEY" }),
        provider({ route: "c", apiKeyEnv: null }),
      ]),
    ).toEqual(["SAME_KEY"]);
  });
});
