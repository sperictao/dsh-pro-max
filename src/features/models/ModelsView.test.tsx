import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { ModelCatalogFile, ModelConfig } from "@/shared/types";
import { ModelsView } from "./ModelsView";

const catalog: ModelCatalogFile = {
  fetchedAt: Math.floor(Date.now() / 1000),
  entries: [
    { id: "glm-5.2", name: "GLM-5.2", family: "openai" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", family: "openai" },
    { id: "claude-opus-4", name: "Claude Opus 4", family: "anthropic" },
  ],
};

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

  it("offers fuzzy search suggestions for the default model input", async () => {
    vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(config);
    vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(catalog);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByLabelText("Route key")).toBeInTheDocument());

    // 默认模型输入框触发模糊搜索：大小写不敏感、id 与 name 都可命中
    const modelInput = screen.getByPlaceholderText("deepseek-v4-pro");
    await user.clear(modelInput);
    await user.type(modelInput, "GLM");
    const listbox = await screen.findByRole("listbox");
    expect(listbox).toHaveTextContent("glm-5.2");
    // 按 provider 协议过滤：openai-responses 不出现 anthropic 家族候选
    expect(listbox).not.toHaveTextContent("claude-opus-4");
    // 键盘选中
    await user.keyboard("{ArrowDown}{Enter}");
    expect(modelInput).toHaveValue("glm-5.2");
  });

  it("appends a picked model to a provider via the add-model search", async () => {
    vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(config);
    vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(catalog);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByLabelText("Route key")).toBeInTheDocument());

    const addInput = screen.getByPlaceholderText("Search models…");
    await user.type(addInput, "deepseek");
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText("deepseek-v4-pro"));
    // 追加进 models 且去重（glm-5.2 已在列表中，不重复出现）
    expect(screen.getByLabelText("Models (one per line)")).toHaveValue("glm-5.2\nkimi-for-coding\ndeepseek-v4-pro");
  });

  it("degrades to configured models when the catalog is unavailable", async () => {
    vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(config);
    vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(null);
    vi.spyOn(cmd, "modelCatalogRefresh").mockRejectedValue("network down");
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByLabelText("Route key")).toBeInTheDocument());

    // 刷新失败静默：不弹 toast，已配模型仍可联想
    expect(useAppStore.getState().toasts).toHaveLength(0);
    const modelInput = screen.getByPlaceholderText("deepseek-v4-pro");
    await user.click(modelInput);
    const listbox = await screen.findByRole("listbox");
    expect(listbox).toHaveTextContent("glm-5.2");
  });

  it("refreshes a stale catalog in the background", async () => {
    vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(config);
    vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue({
      fetchedAt: Math.floor(Date.now() / 1000) - 25 * 60 * 60,
      entries: [{ id: "old-model", name: "Old", family: "openai" }],
    });
    const refresh = vi.spyOn(cmd, "modelCatalogRefresh").mockResolvedValue({
      fetchedAt: Math.floor(Date.now() / 1000),
      entries: [{ id: "fresh-model", name: "Fresh", family: "openai" }],
    });
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    const modelInput = screen.getByPlaceholderText("deepseek-v4-pro");
    await user.click(modelInput);
    await user.clear(modelInput);
    const listbox = await screen.findByRole("listbox");
    await waitFor(() => expect(listbox).toHaveTextContent("fresh-model"));
  });

  it("fetches remote models and appends a picked one", async () => {
    vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(config);
    vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(catalog);
    const remote = vi.spyOn(cmd, "modelRemoteList").mockResolvedValue(["kimi-k2", "glm-5.2"]);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByLabelText("Route key")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Fetch models" }));
    await waitFor(() => expect(remote).toHaveBeenCalledOnce());
    const list = await screen.findByRole("group", { name: "Available upstream models" });
    await user.click(within(list).getByRole("button", { name: "kimi-k2" }));
    expect(screen.getByLabelText("Models (one per line)")).toHaveValue(
      "glm-5.2\nkimi-for-coding\nkimi-k2",
    );
    // 已存在的 glm-5.2 标记为已添加且禁用
    expect(within(list).getByRole("button", { name: "glm-5.2 ✓" })).toBeDisabled();
  });

  it("toasts a readable error when fetching remote models fails", async () => {
    vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(config);
    vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(catalog);
    vi.spyOn(cmd, "modelRemoteList").mockRejectedValue("Environment variable SPERO_AI_API_KEY is not set");
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByLabelText("Route key")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Fetch models" }));
    await waitFor(() =>
      expect(useAppStore.getState().toasts.some((t) => t.type === "error")).toBe(true),
    );
  });
});
