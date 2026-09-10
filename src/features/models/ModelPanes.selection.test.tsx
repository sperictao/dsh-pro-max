import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ModelEntry, ProviderConfig } from "@/shared/types";
import { ModelPanes } from "./ModelPanes";

const model = (id: string, name: string | null = null): ModelEntry => ({
  id,
  name,
  contextWindow: null,
  maxTokens: null,
  input: null,
  reasoningEfforts: null,
  extra: null,
});

const provider = (models: ModelEntry[]): ProviderConfig => ({
  route: "acme",
  displayName: "Acme",
  baseURL: "https://acme.example/v1",
  api: "openai-completions",
  apiKeyEnv: null,
  models,
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
});

const renderPanes = (models: ModelEntry[], onModelsChange: (models: ModelEntry[]) => void) =>
  render(
    <ModelPanes
      provider={provider(models)}
      catalog={[]}
      remote={["alpha-model", "beta-model"]}
      fetching={false}
      fetchError={null}
      onModelsChange={onModelsChange}
      onFetch={() => {}}
    />,
  );

describe("ModelPanes visible selection semantics", () => {
  it("filters selected rows off-screen and selects only the visible matches", async () => {
    const user = userEvent.setup();
    const onModelsChange = vi.fn();
    renderPanes([model("beta-model", "Beta override"), model("legacy-custom", "Legacy")], onModelsChange);

    await user.type(screen.getByLabelText("Search model ID…"), "alpha");
    const list = screen.getByRole("list", { name: "Models from this service" });
    expect(within(list).getByRole("checkbox", { name: "alpha-model" })).not.toBeChecked();
    expect(within(list).queryByRole("checkbox", { name: "beta-model" })).not.toBeInTheDocument();
    expect(within(list).queryByRole("checkbox", { name: "legacy-custom" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select all" }));

    expect(onModelsChange).toHaveBeenCalledOnce();
    expect(onModelsChange.mock.calls[0][0].map((entry: ModelEntry) => entry.id)).toEqual([
      "beta-model",
      "legacy-custom",
      "alpha-model",
    ]);
    expect(onModelsChange.mock.calls[0][0][0].name).toBe("Beta override");
  });

  it("clears only visible selected matches and preserves hidden configured models", async () => {
    const user = userEvent.setup();
    const onModelsChange = vi.fn();
    renderPanes(
      [model("alpha-model", "Alpha override"), model("beta-model", "Beta override"), model("legacy-custom", "Legacy")],
      onModelsChange,
    );

    await user.type(screen.getByLabelText("Search model ID…"), "alpha");
    const selectAll = screen.getByRole("checkbox", { name: "Select all" });
    expect(selectAll).toBeChecked();

    await user.click(selectAll);

    expect(onModelsChange).toHaveBeenCalledOnce();
    expect(onModelsChange.mock.calls[0][0]).toEqual([
      model("beta-model", "Beta override"),
      model("legacy-custom", "Legacy"),
    ]);
  });
});
