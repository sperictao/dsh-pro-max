import { describe, expect, it } from "vitest";
import { apiKeyFailure, deriveCredentialRef } from "./credentials";

describe("model credentials", () => {
  it("derives the same conventional credential ref as DSH", () => {
    expect(deriveCredentialRef("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(deriveCredentialRef("minimax-cn")).toBe("MINIMAX_CN_API_KEY");
    expect(deriveCredentialRef("my.gateway/v2")).toBe("MY_GATEWAY_V2_API_KEY");
  });

  it("accepts a bare printable key and rejects wrapped/env-line/whitespace input", () => {
    expect(apiKeyFailure("")).toBeNull();
    expect(apiKeyFailure("sk-test_123.ABC")).toBeNull();
    expect(apiKeyFailure("   ")).toBe("API key cannot be blank");
    expect(apiKeyFailure("OPENAI_API_KEY=sk-test")).toBe("API key contains invalid characters");
    expect(apiKeyFailure("'sk-test'")).toBe("API key contains invalid characters");
    expect(apiKeyFailure("sk test")).toBe("API key contains invalid characters");
  });
});
