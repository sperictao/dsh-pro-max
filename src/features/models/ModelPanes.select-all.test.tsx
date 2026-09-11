import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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

function SelectionHarness({
  initialModels,
  remote,
}: {
  initialModels: ModelEntry[];
  remote: string[];
}) {
  const [models, setModels] = useState(initialModels);
  return (
    <ModelPanes
      provider={provider(models)}
      catalog={[]}
      remote={remote}
      fetching={false}
      fetchError={null}
      onModelsChange={setModels}
      onFetch={() => {}}
    />
  );
}

describe("ModelPanes Select all interaction", () => {
  it("moves continuously from mixed to all selected to none selected", async () => {
    const user = userEvent.setup();
    render(
      <SelectionHarness
        initialModels={[model("alpha-model")]}
        remote={["alpha-model", "beta-model", "gamma-model"]}
      />,
    );

    const selectAll = screen.getByRole("checkbox", { name: "Select all" });
    const settings = screen.getByRole("list", { name: "Model settings" });

    expect(selectAll).not.toBeChecked();
    expect(selectAll).toBePartiallyChecked();
    expect(within(settings).getByText("alpha-model")).toBeInTheDocument();
    expect(within(settings).queryByText("beta-model")).not.toBeInTheDocument();

    await user.click(selectAll);

    expect(selectAll).toBeChecked();
    expect(selectAll).not.toBePartiallyChecked();
    expect(within(settings).getByText("alpha-model")).toBeInTheDocument();
    expect(within(settings).getByText("beta-model")).toBeInTheDocument();
    expect(within(settings).getByText("gamma-model")).toBeInTheDocument();

    await user.click(selectAll);

    expect(selectAll).not.toBeChecked();
    expect(selectAll).not.toBePartiallyChecked();
    expect(within(settings).queryByText("alpha-model")).not.toBeInTheDocument();
    expect(within(settings).queryByText("beta-model")).not.toBeInTheDocument();
    expect(within(settings).queryByText("gamma-model")).not.toBeInTheDocument();
    expect(screen.getByText("No models chosen yet. Pick one from the list.")).toBeInTheDocument();
  });

  it("uses the current search results as the bulk-selection scope and preserves hidden selections", async () => {
    const user = userEvent.setup();
    render(
      <SelectionHarness
        initialModels={[
          model("pro-alpha", "Pinned Pro"),
          model("chat-model", "Pinned Chat"),
          model("legacy-custom", "Legacy"),
        ]}
        remote={["pro-alpha", "pro-beta", "chat-model"]}
      />,
    );

    const search = screen.getByRole("searchbox", { name: "Search model ID…" });
    await user.type(search, "pro-");

    const selectAll = screen.getByRole("checkbox", { name: "Select all" });
    const settings = screen.getByRole("list", { name: "Model settings" });
    const candidates = screen.getByRole("list", { name: "Models from this service" });

    expect(selectAll).toBePartiallyChecked();
    expect(within(candidates).getByRole("checkbox", { name: "pro-alpha" })).toBeChecked();
    expect(within(candidates).getByRole("checkbox", { name: "pro-beta" })).not.toBeChecked();

    await user.click(selectAll);

    expect(selectAll).toBeChecked();
    expect(within(settings).getByText("pro-alpha")).toBeInTheDocument();
    expect(within(settings).getByText("pro-beta")).toBeInTheDocument();
    expect(within(settings).getByText("chat-model")).toBeInTheDocument();
    expect(within(settings).getByText("legacy-custom")).toBeInTheDocument();

    await user.click(selectAll);

    expect(selectAll).not.toBeChecked();
    expect(within(settings).queryByText("pro-alpha")).not.toBeInTheDocument();
    expect(within(settings).queryByText("pro-beta")).not.toBeInTheDocument();
    expect(within(settings).getByText("chat-model")).toBeInTheDocument();
    expect(within(settings).getByText("legacy-custom")).toBeInTheDocument();

    await user.type(search, "{Escape}");

    expect(search).toHaveValue("");
    expect(selectAll).toBePartiallyChecked();
    expect(within(candidates).getByRole("checkbox", { name: "chat-model" })).toBeChecked();
    expect(within(candidates).getByRole("checkbox", { name: "legacy-custom" })).toBeChecked();
    expect(within(candidates).getByRole("checkbox", { name: "pro-alpha" })).not.toBeChecked();
    expect(within(candidates).getByRole("checkbox", { name: "pro-beta" })).not.toBeChecked();
  });
});
