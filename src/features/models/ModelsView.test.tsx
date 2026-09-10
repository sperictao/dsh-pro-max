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
    { id: "glm-5.2", name: "GLM-5.2", family: "openai", context: 262144 },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", family: "openai", context: 131072 },
    { id: "claude-opus-4", name: "Claude Opus 4", family: "anthropic", context: null },
  ],
};

const richModel = {
  id: "kimi-for-coding",
  name: "Kimi",
  contextWindow: 262144,
  maxTokens: 32768,
  input: ["text", "image"],
  reasoningEfforts: { off: null, high: "high" },
  extra: { compat: { supportsStore: true } },
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
      models: [{ id: "glm-5.2", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null }, richModel],
      headers: { "X-Title": "my-app" },
      timeoutMs: null,
      reasoning: null,
      extra: { retryPolicy: { mode: "normal" } },
    },
  ],
};

function loadWith(cfg: ModelConfig | null = config) {
  return vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(cfg as ModelConfig);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [], modelConfigBusy: false });
  vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(catalog);
  vi.spyOn(cmd, "modelCatalogRefresh").mockResolvedValue(catalog);
});

describe("ModelsView", () => {
  it("loads and renders the service list with badges and default row", async () => {
    loadWith();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByTestId("default-model-summary")).toBeInTheDocument());

    expect(screen.getByTestId("default-model-summary")).toHaveTextContent("Spero AI · glm-5.2");
    expect(screen.getByText("default")).toBeInTheDocument();
    expect(screen.getByText(/2 models/)).toBeInTheDocument();
    expect(screen.getByText(/proxy\.example\.com/)).toBeInTheDocument();
    // 无凭据引用的徽标：本配置有 env 引用，不出现
    expect(screen.queryByText("No API key reference yet")).not.toBeInTheDocument();
  });

  it("saves with structured model fields and provider extra passed through", async () => {
    loadWith();
    const save = vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByTestId("default-model-summary")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const saved = save.mock.calls[0][0] as ModelConfig;
    expect(saved.defaultReasoningEffort).toBe("max");
    expect(saved.providers[0].extra).toEqual({ retryPolicy: { mode: "normal" } });
    expect(saved.providers[0].headers).toEqual({ "X-Title": "my-app" });
    expect(saved.providers[0].models[1]).toMatchObject({ id: "kimi-for-coding", contextWindow: 262144 });
    await waitFor(() =>
      expect(useAppStore.getState().toasts.map((x) => x.message)).toContain(
        "Model configuration saved — changes take effect immediately",
      ),
    );
  });

  it("blocks saving when the default provider is set without a model", async () => {
    loadWith({ ...config, defaultModel: null });
    const save = vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByTestId("default-model-summary")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).not.toHaveBeenCalled();
    expect(useAppStore.getState().toasts.map((x) => x.message)).toContain(
      "Default model provider and model are required",
    );
  });

  it("switches the default model through the grouped change menu", async () => {
    loadWith();
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByTestId("default-model-summary")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Change" }));
    const listbox = await screen.findByRole("listbox");
    // 按服务分组：组头是显示名
    expect(within(listbox).getByText("Spero AI")).toBeInTheDocument();
    await user.click(within(listbox).getByRole("option", { name: /kimi-for-coding/ }));
    expect(screen.getByTestId("default-model-summary")).toHaveTextContent("Spero AI · kimi-for-coding");
  });

  it("adds a provider from a preset and auto-sets it as default", async () => {
    loadWith({ defaultProvider: null, defaultModel: null, defaultReasoningEffort: null, providers: [] });
    const save = vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByTestId("empty-add-provider")).toBeInTheDocument());

    await user.click(screen.getByTestId("empty-add-provider"));
    // 选预设：搜索 deepseek 回车选中（预设表由 pi-ai 目录生成，deepseek 必在）
    const presetInput = await screen.findByTestId("preset-input");
    await user.type(presetInput, "deepseek");
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByRole("option", { name: /deepseek/ }));
    // 勾选一个目录模型（继承形态不选模型 = 不自动设默认）
    const leftList = await within(screen.getByRole("dialog")).findByRole("list", { name: "Models from this service" });
    await user.click(within(leftList).getByRole("checkbox", { name: "deepseek-v4-pro" }));
    await user.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("default-model-summary")).toHaveTextContent(/DeepSeek/);
    await user.click(screen.getByRole("button", { name: "Save" }));
    const saved = save.mock.calls[0][0] as ModelConfig;
    expect(saved.providers[0].baseURL).toContain("deepseek");
    expect(saved.defaultProvider).toBe(saved.providers[0].route);
  });

  it("fetches remote models in the dialog and picks one via the left pane", async () => {
    loadWith();
    const remote = vi.spyOn(cmd, "modelRemoteList").mockResolvedValue(["kimi-k2", "glm-5.2"]);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Edit provider" })).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Edit provider" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Fetch list" }));
    await waitFor(() => expect(remote).toHaveBeenCalledOnce());
    const leftList = await within(dialog).findByRole("list", { name: "Models from this service" });
    await user.click(within(leftList).getByRole("checkbox", { name: "kimi-k2" }));
    // 右栏出现已选模型
    expect(within(dialog).getByTestId("model-panes")).toHaveTextContent("kimi-k2");
  });

  it("shows a classified inline error with retry when fetching fails", async () => {
    loadWith();
    vi.spyOn(cmd, "modelRemoteList").mockRejectedValue(
      "Environment variable is not set in the environment where dsh-pro-max was launched",
    );
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit provider" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit provider" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Fetch list" }));
    // 测试环境语言为 en：tErr 回落英文 key 原文（zh 下查表翻译）
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Environment variable is not set in the environment where dsh-pro-max was launched",
    );
  });

  it("edits per-model advanced fields in the right pane", async () => {
    loadWith();
    const save = vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit provider" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit provider" }));
    const dialog = await screen.findByRole("dialog");
    const panes = within(dialog).getByTestId("model-panes");
    const kimiRow = panes.querySelector('[data-model-id="kimi-for-coding"]') as HTMLElement;
    const row = within(kimiRow);
    await user.click(row.getByRole("button", { name: "Advanced" }));
    // 别名与上下文窗口来自已保存字段
    const alias = row.getByLabelText("Alias") as HTMLInputElement;
    expect(alias).toHaveValue("Kimi");
    const ctx = row.getByLabelText("Context window") as HTMLInputElement;
    expect(ctx).toHaveValue(262144);
    // 思考档 chips：off/high 已启用；补充 medium 档
    const medium = row.getByRole("button", { name: "medium" });
    await user.click(medium);
    await user.click(within(dialog).getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Save" }));
    const saved = save.mock.calls[0][0] as ModelConfig;
    const kimi = saved.providers[0].models.find((m) => m.id === "kimi-for-coding");
    expect(kimi?.reasoningEfforts).toEqual({ off: null, high: "high", medium: "medium" });
    // 条目级未管理字段保存后原样保留
    expect(kimi?.extra).toEqual({ compat: { supportsStore: true } });
  });

  it("round-trips unmanaged fields when editing an unrelated field", async () => {
    loadWith();
    const save = vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit provider" })).toBeInTheDocument());

    // 只改显示名：模型条目与 provider 的未管理字段必须原样保留
    await user.click(screen.getByRole("button", { name: "Edit provider" }));
    const dialog = await screen.findByRole("dialog");
    await user.clear(within(dialog).getByLabelText("Display Name"));
    await user.type(within(dialog).getByLabelText("Display Name"), "Spero Gateway");
    await user.click(within(dialog).getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Save" }));

    const saved = save.mock.calls[0][0] as ModelConfig;
    expect(saved.providers[0].displayName).toBe("Spero Gateway");
    expect(saved.providers[0].extra).toEqual({ retryPolicy: { mode: "normal" } });
    expect(saved.providers[0].models[1].extra).toEqual({ compat: { supportsStore: true } });
    expect(saved.providers[0].models[1].input).toEqual(["text", "image"]);
  });

  it("removes a provider via two-step delete and falls back the default", async () => {
    loadWith({
      ...config,
      providers: [
        ...config.providers,
        {
          route: "second-ai",
          displayName: "Second",
          baseURL: "https://second.example.com",
          api: "openai-completions",
          apiKeyEnv: "SECOND_KEY",
          models: [{ id: "m2", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null }],
          headers: null,
          timeoutMs: null,
          reasoning: null,
          extra: null,
        },
      ],
    });
    const save = vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByText("Second")).toBeInTheDocument());

    // 两步删除：先武装（Delete?），确认后移除
    await user.click(screen.getAllByRole("button", { name: "Remove provider" })[0]);
    await user.click(screen.getByRole("button", { name: "Delete?" }));
    expect(screen.queryByText("Second")).toBeInTheDocument();
    // 默认回退到 second-ai
    expect(screen.getByTestId("default-model-summary")).toHaveTextContent("Second · m2");

    await user.click(screen.getByRole("button", { name: "Save" }));
    const saved = save.mock.calls[0][0] as ModelConfig;
    expect(saved.providers.map((p) => p.route)).toEqual(["second-ai"]);
    expect(saved.defaultProvider).toBe("second-ai");
  });

  it("shows the catalog status line and supports manual refresh", async () => {
    loadWith();
    const refresh = vi.spyOn(cmd, "modelCatalogRefresh").mockResolvedValue({
      fetchedAt: Math.floor(Date.now() / 1000),
      entries: [{ id: "fresh-model", name: "Fresh", family: "openai", context: null }],
    });
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByText(/models · updated/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Refresh model catalog" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("degrades silently when the catalog is unavailable", async () => {
    vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(null);
    vi.spyOn(cmd, "modelCatalogRefresh").mockRejectedValue("Failed to reach the model catalog");
    loadWith();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByText("Catalog: unavailable")).toBeInTheDocument());
    // 静默降级：不弹 toast
    expect(useAppStore.getState().toasts).toHaveLength(0);
  });

  it("scans, selects and imports provider configurations", async () => {
    loadWith();
    const scan = vi.spyOn(cmd, "modelConfigImportScan").mockResolvedValue([
      {
        source: "codex",
        entries: [
          {
            key: "codex:my-gateway",
            route: "my-gateway",
            name: "My Gateway",
            baseURL: "https://gw.example.com/v1",
            api: "openai-completions",
            apiKeyEnv: "GW_API_KEY",
            credential: "env",
            models: ["gpt-5"],
          },
        ],
      },
      { source: "claude-code", entries: [] },
    ]);
    const run = vi
      .spyOn(cmd, "modelConfigImportRun")
      .mockResolvedValue({ imported: 1, skipped: 0, failed: 0, literal: 0 });
    const reload = vi.spyOn(cmd, "modelConfigLoad");
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import configuration" })).toBeInTheDocument());
    const loadCallsBefore = reload.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Import configuration" }));
    const dialog = await screen.findByRole("dialog");
    expect(scan).toHaveBeenCalledOnce();
    expect(within(dialog).getByText("Codex")).toBeInTheDocument();
    expect(within(dialog).getByText(/Providers found: 1/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Import selected (1)" }));

    await waitFor(() => expect(run).toHaveBeenCalledWith(["codex:my-gateway"]));
    // 导入成功后重读配置并 toast 计数
    await waitFor(() => expect(reload.mock.calls.length).toBeGreaterThan(loadCallsBefore));
    await waitFor(() =>
      expect(useAppStore.getState().toasts.some((x) => x.message.includes("导入完成") || x.message.includes("Import finished"))).toBe(true),
    );
  });

  it("blocks the import entry while the draft has unsaved changes", async () => {
    loadWith();
    const scan = vi.spyOn(cmd, "modelConfigImportScan");
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import configuration" })).toBeInTheDocument());

    // 改推理档 → dirty
    await user.selectOptions(screen.getByLabelText("Reasoning Effort"), "high");
    await user.click(screen.getByRole("button", { name: "Import configuration" }));
    expect(scan).not.toHaveBeenCalled();
    expect(useAppStore.getState().toasts.map((x) => x.message)).toContain(
      "Save or discard your changes before importing.",
    );
  });
});
