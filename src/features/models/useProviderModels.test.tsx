import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import type { ProviderConfig } from "@/shared/types";
import { MODEL_DISCOVERY_DEBOUNCE_MS, useProviderModels } from "./useProviderModels";

const provider: ProviderConfig = {
  route: "my-gateway",
  displayName: "My Gateway",
  baseURL: "https://gateway.example.com/v1",
  api: "openai-responses",
  apiKeyEnv: "MY_KEY",
  models: [],
  headers: { "X-Tenant": "desktop" },
  timeoutMs: null,
  reasoning: null,
  extra: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useProviderModels", () => {
  it("paints persistent cache first and replaces it after the 600ms live refresh", async () => {
    vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue({ models: ["cached-model"], fetchedAt: 1 });
    const remote = vi.spyOn(cmd, "modelRemoteList").mockResolvedValue(["fresh-model"]);
    const { result } = renderHook(() => useProviderModels(true, provider));

    await flush();
    expect(result.current.models).toEqual(["cached-model"]);
    expect(result.current.source).toBe("cache");
    expect(remote).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_DISCOVERY_DEBOUNCE_MS);
    });
    await flush();
    expect(result.current.models).toEqual(["fresh-model"]);
    expect(result.current.source).toBe("remote");
  });

  it("keeps cached rows visible when the live refresh fails", async () => {
    vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue({ models: ["cached-model"], fetchedAt: 1 });
    vi.spyOn(cmd, "modelRemoteList").mockRejectedValue("upstream unavailable");
    const { result } = renderHook(() => useProviderModels(true, provider));

    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_DISCOVERY_DEBOUNCE_MS);
    });
    await flush();
    expect(result.current.status).toBe("error");
    expect(result.current.models).toEqual(["cached-model"]);
    expect(result.current.error).toBe("upstream unavailable");
  });

  it("manual reload skips the remaining debounce window", async () => {
    vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue(null);
    const remote = vi.spyOn(cmd, "modelRemoteList").mockResolvedValue(["manual-model"]);
    const { result } = renderHook(() => useProviderModels(true, provider));
    await flush();

    act(() => result.current.reload());
    await flush();
    expect(remote).toHaveBeenCalledOnce();
    expect(result.current.models).toEqual(["manual-model"]);
  });

  it("drops a slow response from an older connection fingerprint", async () => {
    vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue(null);
    let resolveOld!: (models: string[]) => void;
    const oldResult = new Promise<string[]>((resolve) => { resolveOld = resolve; });
    const remote = vi
      .spyOn(cmd, "modelRemoteList")
      .mockReturnValueOnce(oldResult)
      .mockResolvedValueOnce(["new-model"]);

    const { result, rerender } = renderHook(
      ({ value }) => useProviderModels(true, value),
      { initialProps: { value: provider } },
    );
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_DISCOVERY_DEBOUNCE_MS);
    });
    expect(remote).toHaveBeenCalledTimes(1);

    const changed = { ...provider, apiKeyEnv: "NEW_KEY" };
    rerender({ value: changed });
    await flush();
    expect(result.current.models).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_DISCOVERY_DEBOUNCE_MS);
    });
    await flush();
    expect(result.current.models).toEqual(["new-model"]);

    await act(async () => resolveOld(["stale-model"]));
    expect(result.current.models).toEqual(["new-model"]);
  });
});
