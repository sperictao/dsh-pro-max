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
    {
      id: "glm-5.2",
      name: "GLM-5.2",
      family: "openai",
      context: 262144,
      maxTokens: 32768,
      input: ["text", "image"],
      reasoning: true,
      reasoningLevels: ["low", "medium", "high", "max"],
      capabilities: ["text", "vision", "reasoning"],
    },
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      family: "openai",
      context: 131072,
      maxTokens: 16384,
      input: ["text"],
      reasoning: false,
      reasoningLevels: [],
      capabilities: ["text"],
    },
    {
      id: "claude-opus-4",
      name: "Claude Opus 4",
      family: "anthropic",
      context: null,
      reasoning: true,
      reasoningLevels: ["low", "medium", "high"],
      capabilities: ["text", "reasoning"],
    },
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
      models: [
        {
          id: "glm-5.2",
          name: null,
          contextWindow: null,
          maxTokens: null,
          input: null,
          reasoningEfforts: null,
          extra: null,
        },
        richModel,
      ],
      headers: { "X-Title": "my-app" },
      timeoutMs: null,
      reasoning: null,
      extra: { retryPolicy: { mode: "normal" } },
    },
  ],
};

function loadWith(value: ModelConfig = config) {
  return vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(structuredClone(value));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [], modelConfigBusy: false });
  vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(catalog);
  vi.spyOn(cmd, "modelCatalogRefresh").mockResolvedValue(catalog);
  vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue(null);
  vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
  vi.spyOn(cmd, "modelCredentialSet").mockResolvedValue({ configured: true, source: "file", writable: true });
  vi.spyOn(cmd, "modelCredentialDescribe").mockImplementation(async (names) =>
    Object.fromEntries(names.map((name) => [name, { configured: true, source: "file", writable: true }])),
  );
  vi.spyOn(cmd, "modelCredentialUnset").mockResolvedValue({ configured: false, source: null, writable: true });
  vi.spyOn(cmd, "modelEnvStatus").mockImplementation(async (names) =>
    Object.fromEntries(names.map((name) => [name, true])),
  );
});

describe("ModelsView provider studio", () => {
  it("renders compact defaults and provider facts without a page-level Save action", async () => {
    loadWith();
    render(createElement(ModelsView));

    await waitFor(() => expect(screen.getByTestId("default-model-summary")).toBeInTheDocument());
    expect(screen.getByTestId("default-model-summary")).toHaveTextContent("Spero AI · glm-5.2");
    expect(screen.getByTestId("default-provider-readiness")).toHaveAttribute("data-readiness", "ready");
    expect(screen.getByText("default")).toBeInTheDocument();
    expect(screen.getByText(/proxy\.example\.com/)).toBeInTheDocument();
    expect(screen.getByText("glm-5.2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("persists a grouped default-model change immediately", async () => {
    loadWith();
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByTestId("default-model-summary")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Change" }));
    const listbox = await screen.findByRole("listbox", { name: "Default model" });
    expect(within(listbox).getByText("Spero AI")).toBeInTheDocument();
    await user.click(within(listbox).getByRole("option", { name: /Spero AI · kimi-for-coding/ }));

    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());
    const saved = vi.mocked(cmd.modelConfigSave).mock.calls[0][0];
    expect(saved.defaultProvider).toBe("spero-ai");
    expect(saved.defaultModel).toBe("kimi-for-coding");
    expect(saved.defaultReasoningEffort).toBeNull();
    expect(screen.getByTestId("default-model-summary")).toHaveTextContent("Spero AI · kimi-for-coding");
  });

  it("gates global reasoning options to the default model capability", async () => {
    loadWith();
    render(createElement(ModelsView));
    const select = await screen.findByLabelText("Reasoning Effort");

    expect(select).toHaveAttribute("data-reasoning-capability", "supported");
    expect(Array.from((select as HTMLSelectElement).options).map((option) => option.value)).toEqual([
      "",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("persists the global reasoning level immediately", async () => {
    loadWith();
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByLabelText("Reasoning Effort")).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText("Reasoning Effort"), "medium");
    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());
    expect(vi.mocked(cmd.modelConfigSave).mock.calls[0][0].defaultReasoningEffort).toBe("medium");
  });

  it("adds a preset provider through the progressive composer and saves immediately", async () => {
    loadWith({
      defaultProvider: null,
      defaultModel: null,
      defaultReasoningEffort: null,
      providers: [],
    });
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByTestId("empty-add-provider")).toBeInTheDocument());

    await user.click(screen.getByTestId("empty-add-provider"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("Route key")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Base URL")).not.toBeInTheDocument();

    const presetInput = within(dialog).getByTestId("preset-input");
    await user.type(presetInput, "deepseek");
    const picker = within(dialog).getByRole("listbox", { name: "Choose a service or custom endpoint" });
    await user.click(within(picker).getAllByRole("option").find((item) => /deepseek/i.test(item.getAttribute("aria-label") ?? item.textContent ?? ""))!);

    expect(within(dialog).getByLabelText("API Key")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Route key")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("API Key"), "sk-deepseek-test");

    const leftList = within(dialog).getByRole("list", { name: "Models from this service" });
    await user.click(within(leftList).getByRole("checkbox", { name: "deepseek-v4-pro" }));
    await user.click(within(dialog).getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(cmd.modelCredentialSet).toHaveBeenCalledWith("DEEPSEEK_API_KEY", "sk-deepseek-test");
    expect(cmd.modelConfigSave).toHaveBeenCalledTimes(2);
    const firstSaved = vi.mocked(cmd.modelConfigSave).mock.calls[0][0];
    expect(firstSaved.providers).toHaveLength(1);
    expect(firstSaved.providers[0].apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(JSON.stringify(firstSaved)).not.toContain("sk-deepseek-test");
    expect(firstSaved.defaultProvider).toBeNull();
    const saved = vi.mocked(cmd.modelConfigSave).mock.calls.at(-1)![0];
    expect(saved.providers[0].route).toMatch(/deepseek/i);
    expect(saved.defaultProvider).toBe(saved.providers[0].route);
    expect(saved.defaultModel).toBe("deepseek-v4-pro");
    expect(JSON.stringify(saved)).not.toContain("sk-deepseek-test");
  });

  it("shows full connection fields only after choosing a custom endpoint", async () => {
    loadWith({
      defaultProvider: null,
      defaultModel: null,
      defaultReasoningEffort: null,
      providers: [],
    });
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByTestId("empty-add-provider")).toBeInTheDocument());

    await user.click(screen.getByTestId("empty-add-provider"));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByTestId("preset-input"));
    await user.click(within(dialog).getByRole("option", { name: /Custom endpoint/ }));

    expect(within(dialog).getByLabelText("Route key")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Base URL")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Wire Protocol")).toBeInTheDocument();
  });

  it("fetches provider models inside the edit dialog and invalidates stale discovery when the write-only key changes", async () => {
    loadWith();
    const remote = vi
      .spyOn(cmd, "modelRemoteList")
      .mockResolvedValueOnce(["kimi-k2", "glm-5.2"])
      .mockResolvedValueOnce(["glm-5.2"]);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit provider" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit provider" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Fetch list" }));
    await waitFor(() => expect(remote).toHaveBeenCalledTimes(1));
    expect(remote.mock.calls[0][3]).toEqual({ "X-Title": "my-app" });
    expect(within(dialog).getByRole("list", { name: "Models from this service" })).toHaveTextContent("kimi-k2");

    await user.type(within(dialog).getByLabelText("API Key"), "sk-new-key");
    expect(within(dialog).getByRole("list", { name: "Models from this service" })).not.toHaveTextContent("kimi-k2");
    await waitFor(() => expect(remote).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(remote.mock.calls[1][2]).toBe("SPERO_AI_API_KEY");
    expect(remote.mock.calls[1][3]).toEqual({ "X-Title": "my-app" });
    expect(remote.mock.calls[1][4]).toBe("sk-new-key");
  });

  it("probes a configured provider directly from its row", async () => {
    loadWith();
    const remote = vi.spyOn(cmd, "modelRemoteList").mockResolvedValue(["a", "b"]);
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByRole("button", { name: "Fetch list" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Fetch list" }));
    await waitFor(() =>
      expect(remote).toHaveBeenCalledWith(
        "https://proxy.example.com/v1",
        "openai-responses",
        "SPERO_AI_API_KEY",
        { "X-Title": "my-app" },
      ),
    );
    expect(useAppStore.getState().toasts.at(-1)?.message).toContain("2 models");
  });

  it("keeps configured-but-keyless built-in providers runtime-ready without launcher probes", async () => {
    loadWith({
      defaultProvider: null,
      defaultModel: null,
      defaultReasoningEffort: null,
      providers: [
        {
          route: "openai",
          displayName: "OpenAI",
          baseURL: "https://api.openai.com/v1",
          api: "openai-responses",
          apiKeyEnv: null,
          models: [{ id: "gpt-test", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null }],
          headers: null,
          timeoutMs: null,
          reasoning: null,
          extra: null,
        },
      ],
    });
    const user = userEvent.setup();
    render(createElement(ModelsView));

    await waitFor(() =>
      expect(screen.getByTestId("provider-readiness-0")).toHaveAttribute("data-readiness", "provider-auth"),
    );
    expect(screen.getByTestId("provider-readiness-0")).toHaveTextContent("Ready · pi-ai");
    expect(screen.queryByRole("button", { name: "Test connection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fetch list" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Change" }));
    const listbox = await screen.findByRole("listbox", { name: "Default model" });
    expect(within(listbox).getByRole("option", { name: /OpenAI · gpt-test/ })).toBeInTheDocument();
  });

  it("excludes a provider with a missing credential from defaults while allowing an anonymous custom provider", async () => {
    loadWith({
      defaultProvider: "openai",
      defaultModel: "gpt-test",
      defaultReasoningEffort: null,
      providers: [
        {
          route: "openai",
          displayName: "OpenAI",
          baseURL: "https://api.openai.com/v1",
          api: "openai-responses",
          apiKeyEnv: "MISSING_OPENAI_KEY",
          models: [{ id: "gpt-test", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null }],
          headers: null,
          timeoutMs: null,
          reasoning: null,
          extra: null,
        },
        {
          route: "local-ai",
          displayName: "Local AI",
          baseURL: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          apiKeyEnv: null,
          models: [{ id: "local-model", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null }],
          headers: null,
          timeoutMs: null,
          reasoning: null,
          extra: null,
        },
      ],
    });
    vi.mocked(cmd.modelEnvStatus).mockResolvedValue({ MISSING_OPENAI_KEY: false });
    const user = userEvent.setup();
    render(createElement(ModelsView));

    await waitFor(() => expect(screen.getByTestId("provider-readiness-0")).toHaveAttribute("data-readiness", "missing-env"));
    expect(screen.getByTestId("provider-readiness-0")).toHaveTextContent("API key is not configured");
    expect(screen.getByTestId("provider-readiness-1")).toHaveAttribute("data-readiness", "anonymous");
    expect(screen.getByTestId("default-provider-readiness")).toHaveAttribute("data-readiness", "missing-env");

    await user.click(screen.getByRole("button", { name: "Change" }));
    const listbox = await screen.findByRole("listbox", { name: "Default model" });
    expect(within(listbox).queryByText("OpenAI")).not.toBeInTheDocument();
    expect(within(listbox).getByText("Local AI")).toBeInTheDocument();
    expect(within(listbox).getByRole("option", { name: /Local AI · local-model/ })).toBeInTheDocument();
  });

  it("edits a provider without losing unmanaged provider/model fields", async () => {
    loadWith();
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit provider" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit provider" }));
    const dialog = await screen.findByRole("dialog");
    const displayName = within(dialog).getByLabelText("Display Name");
    await user.clear(displayName);
    await user.type(displayName, "Spero Gateway");
    await user.click(within(dialog).getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());
    const saved = vi.mocked(cmd.modelConfigSave).mock.calls[0][0];
    expect(saved.providers[0].displayName).toBe("Spero Gateway");
    expect(saved.providers[0].extra).toEqual({ retryPolicy: { mode: "normal" } });
    expect(saved.providers[0].models[1].extra).toEqual({ compat: { supportsStore: true } });
    expect(saved.providers[0].models[1].input).toEqual(["text", "image"]);
  });

  it("removes the default provider with clear consequences and persists a valid fallback immediately", async () => {
    loadWith({
      ...config,
      providers: [
        ...config.providers,
        {
          route: "empty-ai",
          displayName: "Empty",
          baseURL: "https://empty.example.com",
          api: "openai-completions",
          apiKeyEnv: "EMPTY_KEY",
          models: [],
          headers: null,
          timeoutMs: null,
          reasoning: null,
          extra: null,
        },
        {
          route: "second-ai",
          displayName: "Second",
          baseURL: "https://second.example.com",
          api: "openai-completions",
          apiKeyEnv: "SECOND_KEY",
          models: [
            {
              id: "m2",
              name: null,
              contextWindow: null,
              maxTokens: null,
              input: null,
              reasoningEfforts: null,
              extra: null,
            },
          ],
          headers: null,
          timeoutMs: null,
          reasoning: null,
          extra: null,
        },
      ],
    });
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByText("Second")).toBeInTheDocument());

    await user.click(screen.getAllByRole("button", { name: "Remove provider" })[0]);
    const confirmation = screen.getByTestId("provider-remove-confirm-0");
    expect(within(confirmation).getByText("Remove Spero AI?")).toBeInTheDocument();
    expect(within(confirmation).getByText("Default model: Second · m2")).toBeInTheDocument();
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await user.click(within(confirmation).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());
    expect(cmd.modelCredentialDescribe).toHaveBeenCalledWith(["SPERO_AI_API_KEY"]);
    expect(cmd.modelCredentialUnset).toHaveBeenCalledWith("SPERO_AI_API_KEY");
    expect(vi.mocked(cmd.modelCredentialUnset).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(cmd.modelConfigSave).mock.invocationCallOrder[0],
    );
    const saved = vi.mocked(cmd.modelConfigSave).mock.calls[0][0];
    expect(saved.providers.map((provider) => provider.route)).toEqual(["empty-ai", "second-ai"]);
    expect(saved.defaultProvider).toBe("second-ai");
    expect(saved.defaultModel).toBe("m2");
    expect(screen.getByTestId("default-model-summary")).toHaveTextContent("Second · m2");
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
      "Remove provider: Spero AI · Default model: Second · m2",
    );
  });

  it("preserves custom and read-only launch credential references when removing providers", async () => {
    const user = userEvent.setup();
    const custom = { ...config.providers[0], apiKeyEnv: "SHARED_API_KEY" };
    loadWith({ ...config, defaultProvider: null, defaultModel: null, providers: [custom] });
    const view = render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByText("Spero AI")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove provider" }));
    await user.click(screen.getByRole("button", { name: "Remove", exact: true }));
    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());
    expect(cmd.modelCredentialDescribe).not.toHaveBeenCalled();
    expect(cmd.modelCredentialUnset).not.toHaveBeenCalled();

    view.unmount();
    vi.clearAllMocks();
    vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(catalog);
    vi.spyOn(cmd, "modelCatalogRefresh").mockResolvedValue(catalog);
    vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue(null);
    vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
    vi.spyOn(cmd, "modelCredentialDescribe").mockResolvedValue({
      SPERO_AI_API_KEY: { configured: true, source: "env", writable: false },
    });
    vi.spyOn(cmd, "modelCredentialUnset").mockResolvedValue({ configured: true, source: "env", writable: false });
    vi.spyOn(cmd, "modelEnvStatus").mockResolvedValue({ SPERO_AI_API_KEY: true });
    loadWith({ ...config, providers: [config.providers[0]] });
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByText("Spero AI")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove provider" }));
    await user.click(screen.getByRole("button", { name: "Remove", exact: true }));
    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());
    expect(cmd.modelCredentialDescribe).toHaveBeenCalledWith(["SPERO_AI_API_KEY"]);
    expect(cmd.modelCredentialUnset).not.toHaveBeenCalled();
  });

  it("keeps provider deletion retryable when owned credential cleanup fails", async () => {
    loadWith({ ...config, providers: [config.providers[0]] });
    vi.mocked(cmd.modelCredentialUnset)
      .mockRejectedValueOnce("Credential store busy")
      .mockResolvedValue({ configured: false, source: null, writable: true });
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByText("Spero AI")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Remove provider" }));
    const confirmation = screen.getByTestId("provider-remove-confirm-0");
    await user.click(within(confirmation).getByRole("button", { name: "Remove", exact: true }));
    await waitFor(() => expect(cmd.modelCredentialUnset).toHaveBeenCalledTimes(1));
    expect(cmd.modelConfigSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("provider-remove-confirm-0")).toBeInTheDocument();
    expect(useAppStore.getState().toasts.at(-1)?.message).toContain("Credential store busy");

    await user.click(within(screen.getByTestId("provider-remove-confirm-0")).getByRole("button", { name: "Remove", exact: true }));
    await waitFor(() => expect(cmd.modelCredentialUnset).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());
    expect(screen.queryByText("Spero AI")).not.toBeInTheDocument();
  });

  it("keeps a failed provider save inside the dialog with an actionable inline error", async () => {
    loadWith();
    vi.mocked(cmd.modelConfigSave).mockRejectedValueOnce("Failed to write settings.yaml");
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit provider" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit provider" }));
    const dialog = await screen.findByRole("dialog");
    const displayName = within(dialog).getByLabelText("Display Name");
    await user.clear(displayName);
    await user.type(displayName, "Spero Save Failure");
    await user.click(within(dialog).getByRole("button", { name: "Save provider" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Failed to write settings.yaml");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows the catalog status line and supports manual refresh", async () => {
    loadWith();
    vi.spyOn(cmd, "modelCatalogRefresh").mockResolvedValue({
      fetchedAt: Math.floor(Date.now() / 1000),
      entries: [{ id: "fresh-model", name: "Fresh", family: "openai", context: null }],
    });
    const user = userEvent.setup();
    render(createElement(ModelsView));
    await waitFor(() => expect(screen.getByText(/models · updated/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Refresh model catalog" }));
    await waitFor(() => expect(screen.getByText(/1 models/)).toBeInTheDocument());
  });
});
