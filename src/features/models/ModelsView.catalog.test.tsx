import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { ModelCatalogFile, ModelConfig } from "@/shared/types";
import { ModelsView } from "./ModelsView";

const now = () => Math.floor(Date.now() / 1000);
const emptyConfig: ModelConfig = {
  defaultProvider: null,
  defaultModel: null,
  defaultReasoningEffort: null,
  providers: [],
};
const snapshot = (providerCount: number): ModelCatalogFile => ({
  fetchedAt: now(),
  providerCount,
  entries: [],
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [], modelConfigBusy: false });
  vi.spyOn(cmd, "modelConfigLoad").mockResolvedValue(structuredClone(emptyConfig));
  vi.spyOn(cmd, "modelEnvStatus").mockResolvedValue({});
  vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(snapshot(7));
  vi.spyOn(cmd, "modelCatalogRefresh").mockResolvedValue(snapshot(7));
});

describe("ModelsView catalog observability", () => {
  it("labels a loaded cache as a local snapshot and exposes provider coverage", async () => {
    render(createElement(ModelsView));

    const status = await screen.findByTestId("catalog-status-line");
    expect(status).toHaveAttribute("data-catalog-source", "snapshot");
    expect(status).toHaveAttribute("data-provider-count", "7");
    expect(status).toHaveTextContent("Local snapshot");
    expect(status).toHaveTextContent("7 providers");
    expect(status).toHaveTextContent("0 models");
    expect(cmd.modelCatalogRefresh).not.toHaveBeenCalled();
  });

  it("announces manual refresh progress, switches to models.dev, and confirms success", async () => {
    let resolveRefresh: ((value: ModelCatalogFile) => void) | undefined;
    vi.mocked(cmd.modelCatalogRefresh).mockImplementation(
      () =>
        new Promise<ModelCatalogFile>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const fresh: ModelCatalogFile = {
      fetchedAt: now(),
      providerCount: 9,
      entries: [{ id: "gpt-test", name: "GPT Test", family: "openai", context: null }],
    };
    const user = userEvent.setup();
    render(createElement(ModelsView));
    const status = await screen.findByTestId("catalog-status-line");
    const region = document.getElementById("models-catalog");

    expect(region).toHaveAttribute("aria-busy", "false");
    await user.click(screen.getByRole("button", { name: "Refresh model catalog" }));

    expect(region).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Refreshing catalog…");
    expect(screen.getByRole("button", { name: "Refreshing catalog…" })).toBeDisabled();
    expect(useAppStore.getState().toasts).toHaveLength(0);

    await act(async () => {
      resolveRefresh?.(fresh);
    });

    await waitFor(() => expect(status).toHaveAttribute("data-catalog-source", "remote"));
    expect(region).toHaveAttribute("aria-busy", "false");
    expect(status).toHaveAttribute("data-provider-count", "9");
    expect(status).toHaveTextContent("models.dev");
    expect(status).toHaveTextContent("9 providers");
    expect(status).toHaveTextContent("1 models");
    expect(screen.queryByTestId("catalog-error")).not.toBeInTheDocument();
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
      "Refresh model catalog · models.dev · 1 models",
    );
    expect(useAppStore.getState().toasts.at(-1)?.type).toBe("success");
  });

  it("keeps a failed refresh contextual, offers Retry, and retires the stale error during recovery", async () => {
    let resolveRetry: ((value: ModelCatalogFile) => void) | undefined;
    vi.mocked(cmd.modelCatalogRefresh)
      .mockRejectedValueOnce("Failed to reach the model catalog")
      .mockImplementationOnce(
        () =>
          new Promise<ModelCatalogFile>((resolve) => {
            resolveRetry = resolve;
          }),
      );
    const user = userEvent.setup();
    render(createElement(ModelsView));
    const status = await screen.findByTestId("catalog-status-line");

    await user.click(screen.getByRole("button", { name: "Refresh model catalog" }));

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Catalog error: Failed to reach the model catalog");
    expect(status).toHaveAttribute("data-catalog-source", "snapshot");
    expect(status).toHaveTextContent("7 providers");
    expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute(
      "aria-describedby",
      "models-catalog-error",
    );
    expect(useAppStore.getState().toasts).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByTestId("catalog-error")).not.toBeInTheDocument());
    expect(status).toHaveTextContent("Refreshing catalog…");
    expect(screen.getByRole("button", { name: "Refreshing catalog…" })).toBeDisabled();

    await act(async () => {
      resolveRetry?.(snapshot(9));
    });

    await waitFor(() => expect(status).toHaveAttribute("data-catalog-source", "remote"));
    expect(status).toHaveAttribute("data-provider-count", "9");
    expect(screen.getByRole("button", { name: "Refresh model catalog" })).toBeEnabled();
    expect(useAppStore.getState().toasts.at(-1)?.type).toBe("success");
  });

  it("background-refreshes a legacy snapshot that lacks providerCount", async () => {
    vi.mocked(cmd.modelCatalogLoad).mockResolvedValue({ fetchedAt: now(), entries: [] });
    vi.mocked(cmd.modelCatalogRefresh).mockResolvedValue(snapshot(8));
    render(createElement(ModelsView));

    await waitFor(() => expect(cmd.modelCatalogRefresh).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("catalog-status-line")).toHaveAttribute("data-catalog-source", "remote"),
    );
    expect(screen.getByTestId("catalog-status-line")).toHaveAttribute("data-provider-count", "8");
    expect(useAppStore.getState().toasts).toHaveLength(0);
  });
});
