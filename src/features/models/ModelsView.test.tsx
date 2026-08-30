import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { ModelConfig } from "@/shared/types";
import { ModelsView } from "./ModelsView";

const config: ModelConfig = {
  defaultProvider: "spero-ai",
  defaultModel: "glm-5.2",
  defaultReasoningEffort: "max",
  providers: [
    {
      route: "spero-ai",
      displayName: "Spero AI",
      baseURL: "https://proxy.example.com/v1",
      api: "openai-responses",
      apiKeyEnv: "SPERO_AI_API_KEY",
      models: ["glm-5.2", "kimi-for-coding"],
      extra: { timeoutMs: 60000 },
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [], modelConfigBusy: false });
});

describe("ModelsView", () => {
  it("loads and renders the current model configuration", async () => {
    const load = vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(config);
    render(createElement(ModelsView));
    await waitFor(() => expect(load).toHaveBeenCalledOnce());

    // 默认模型 provider（placeholder 定位避免与 provider 卡片 route 同值冲突）
    expect(screen.getByPlaceholderText("deepseek-official")).toHaveValue("spero-ai");
    expect(screen.getByPlaceholderText("deepseek-v4-pro")).toHaveValue("glm-5.2");
    expect(screen.getByLabelText("Route key")).toHaveValue("spero-ai");
    expect(screen.getByDisplayValue("SPERO_AI_API_KEY")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://proxy.example.com/v1")).toBeInTheDocument();
  });

  it("saves edited providers with extra fields passed through", async () => {
    vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(config);
    const save = vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByLabelText("Route key")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const saved = save.mock.calls[0][0];
    expect(saved.defaultProvider).toBe("spero-ai");
    expect(saved.defaultReasoningEffort).toBe("max");
    expect(saved.providers[0].extra).toEqual({ timeoutMs: 60000 });
    // 结果 toast 经全局 store 送达 Toaster
    await waitFor(() =>
      expect(useAppStore.getState().toasts.map((t) => t.message)).toContain("Model configuration saved"),
    );
  });

  it("blocks saving when the default model selection is incomplete", async () => {
    vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue({ ...config, defaultModel: null });
    const save = vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByLabelText("Route key")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).not.toHaveBeenCalled();
    expect(useAppStore.getState().toasts.map((t) => t.message)).toContain(
      "Default model provider and model are required",
    );
  });
});
