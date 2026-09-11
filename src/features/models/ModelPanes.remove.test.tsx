import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ModelEntry, ProviderConfig } from "@/shared/types";
import { ModelPanes } from "./ModelPanes";

const model = (id: string): ModelEntry => ({
  id,
  name: null,
  contextWindow: null,
  maxTokens: null,
  input: null,
  reasoningEfforts: null,
  extra: null,
});

function Harness() {
  const [models, setModels] = useState<ModelEntry[]>([model("alpha-model"), model("beta-model")]);
  const provider: ProviderConfig = {
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
  };

  return (
    <ModelPanes
      provider={provider}
      catalog={[]}
      remote={["alpha-model", "beta-model"]}
      fetching={false}
      fetchError={null}
      onModelsChange={setModels}
      onFetch={vi.fn()}
    />
  );
}

describe("ModelPanes remove model", () => {
  it("marks the row action as destructive and keeps the model recoverable from the candidate list", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const settings = screen.getByRole("list", { name: "Model settings" });
    const beta = settings.querySelector('[data-model-id="beta-model"]');
    expect(beta).not.toBeNull();

    const row = within(beta as HTMLElement);
    const remove = row.getByRole("button", { name: "Remove model" });
    expect(remove).toHaveAttribute("title", "Remove model");
    expect(remove.className).toContain("text-destructive");
    expect(screen.getByRole("checkbox", { name: "beta-model" })).toBeChecked();

    await user.click(remove);

    expect(settings.querySelector('[data-model-id="beta-model"]')).toBeNull();
    expect(screen.getByRole("checkbox", { name: "beta-model" })).not.toBeChecked();
  });

  it("clears stale Advanced expansion when an expanded model is removed and re-added", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const settings = screen.getByRole("list", { name: "Model settings" });
    const beta = settings.querySelector('[data-model-id="beta-model"]');
    expect(beta).not.toBeNull();
    const betaRow = within(beta as HTMLElement);

    const advanced = betaRow.getByRole("button", { name: "Advanced" });
    await user.click(advanced);
    expect(advanced).toHaveAttribute("aria-expanded", "true");
    expect(betaRow.getByTestId("model-advanced")).toBeVisible();

    await user.click(betaRow.getByRole("button", { name: "Remove model" }));
    expect(settings.querySelector('[data-model-id="beta-model"]')).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: "beta-model" }));

    const restored = settings.querySelector('[data-model-id="beta-model"]');
    expect(restored).not.toBeNull();
    const restoredRow = within(restored as HTMLElement);
    expect(restoredRow.getByRole("button", { name: "Advanced" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(restoredRow.queryByTestId("model-advanced")).not.toBeInTheDocument();
  });
});
