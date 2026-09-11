import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { ModelCatalogFile, ModelConfig, ProviderConfig } from "@/shared/types";
import { ModelsView } from "./ModelsView";

const primary: ProviderConfig = {
  route: "primary-api",
  displayName: "Primary API",
  baseURL: "https://primary.example.com/v1",
  api: "openai-responses",
  apiKeyEnv: "PRIMARY_API_KEY",
  models: [
    {
      id: "primary-model",
      name: null,
      contextWindow: null,
      maxTokens: null,
      input: null,
      reasoningEfforts: null,
      extra: null,
    },
  ],
  headers: { "X-Title": "dsh-pro-max" },
  timeoutMs: null,
  reasoning: null,
  extra: null,
};

const backup: ProviderConfig = {
  route: "backup-api",
  displayName: "Backup API",
  baseURL: "https://backup.example.com/v1",
  api: "openai-completions",
  apiKeyEnv: "BACKUP_API_KEY",
  models: [
    {
      id: "backup-model",
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
};

const config: ModelConfig = {
  defaultProvider: primary.route,
  defaultModel: primary.models[0]!.id,
  defaultReasoningEffort: null,
  providers: [primary, backup],
};

const catalog: ModelCatalogFile = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 2,
  entries: [],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [], modelConfigBusy: false });
  vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(structuredClone(config));
  vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(catalog);
  vi.spyOn(cmd, "modelCatalogRefresh").mockResolvedValue(catalog);
  vi.spyOn(cmd, "modelEnvStatus").mockResolvedValue({
    PRIMARY_API_KEY: true,
    BACKUP_API_KEY: true,
  });
  vi.spyOn(cmd, "modelRemoteList").mockResolvedValue([]);
  vi.spyOn(cmd, "modelTestConnection").mockResolvedValue(undefined);
  vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
});

async function providerRows() {
  await screen.findAllByRole("button", { name: "Fetch list" });
  return {
    primaryRow: document.querySelector('[data-route="primary-api"]') as HTMLElement,
    backupRow: document.querySelector('[data-route="backup-api"]') as HTMLElement,
  };
}

describe("ModelsView provider card Fetch list", () => {
  it("discovers models directly from the card without opening the dialog or saving", async () => {
    const user = userEvent.setup();
    vi.mocked(cmd.modelRemoteList).mockResolvedValueOnce(["alpha", "beta", "gamma"]);
    render(createElement(ModelsView));

    const { primaryRow } = await providerRows();
    await user.click(within(primaryRow).getByRole("button", { name: "Fetch list" }));

    await waitFor(() => expect(cmd.modelRemoteList).toHaveBeenCalledOnce());
    expect(cmd.modelRemoteList).toHaveBeenCalledWith(
      "https://primary.example.com/v1",
      "openai-responses",
      "PRIMARY_API_KEY",
      { "X-Title": "dsh-pro-max" },
    );
    expect(cmd.modelConfigSave).not.toHaveBeenCalled();
    expect(cmd.modelTestConnection).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
      "Primary API · Models from this service: 3 models",
    );
  });

  it("keeps one card discovery active at a time and restores every Fetch action", async () => {
    const user = userEvent.setup();
    let resolveFetch!: (models: string[]) => void;
    vi.mocked(cmd.modelRemoteList).mockImplementationOnce(
      () => new Promise<string[]>((resolve) => { resolveFetch = resolve; }),
    );
    render(createElement(ModelsView));

    const { primaryRow, backupRow } = await providerRows();
    const primaryFetch = within(primaryRow).getByRole("button", { name: "Fetch list" });
    const backupFetch = within(backupRow).getByRole("button", { name: "Fetch list" });

    await user.click(primaryFetch);
    expect(await within(primaryRow).findByRole("button", { name: "Loading models…" })).toBeDisabled();
    expect(primaryRow).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(backupFetch).toBeDisabled());

    await user.click(backupFetch);
    expect(cmd.modelRemoteList).toHaveBeenCalledTimes(1);

    resolveFetch(["alpha", "beta"]);
    await waitFor(() => {
      expect(primaryRow).toHaveAttribute("aria-busy", "false");
      expect(within(primaryRow).getByRole("button", { name: "Fetch list" })).toBeEnabled();
      expect(within(backupRow).getByRole("button", { name: "Fetch list" })).toBeEnabled();
    });
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
      "Primary API · Models from this service: 2 models",
    );
  });

  it("restores the card after a failed discovery and identifies the provider", async () => {
    const user = userEvent.setup();
    vi.mocked(cmd.modelRemoteList).mockRejectedValueOnce(new Error("503 Service Unavailable"));
    render(createElement(ModelsView));

    const { backupRow } = await providerRows();
    await user.click(within(backupRow).getByRole("button", { name: "Fetch list" }));

    await waitFor(() =>
      expect(within(backupRow).getByRole("button", { name: "Fetch list" })).toBeEnabled(),
    );
    expect(backupRow).toHaveAttribute("aria-busy", "false");
    const feedback = useAppStore.getState().toasts.at(-1);
    expect(feedback?.type).toBe("error");
    expect(feedback?.message).toContain("Backup API");
    expect(feedback?.message).toContain("503 Service Unavailable");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cmd.modelConfigSave).not.toHaveBeenCalled();
  });
});
