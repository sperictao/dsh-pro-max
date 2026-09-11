import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

function Harness({
  initialModels = [model("alpha-model", "Pinned Alpha")],
  remote = ["alpha-model", "beta-model", "gamma-model"],
}: {
  initialModels?: ModelEntry[];
  remote?: string[];
}) {
  const [models, setModels] = useState(initialModels);
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
      remote={remote}
      fetching={false}
      fetchError={null}
      onModelsChange={setModels}
      onFetch={() => {}}
    />
  );
}

const candidateList = () => screen.getByRole("list", { name: "Models from this service" });
const settingsList = () => screen.getByRole("list", { name: "Model settings" });

describe("ModelPanes individual model checkbox", () => {
  it("selects and deselects one candidate without disturbing another configured model", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const alpha = within(candidateList()).getByRole("checkbox", { name: "alpha-model" });
    const beta = within(candidateList()).getByRole("checkbox", { name: "beta-model" });
    expect(alpha).toBeChecked();
    expect(beta).not.toBeChecked();
    expect(within(settingsList()).getByText("Pinned Alpha")).toBeInTheDocument();

    await user.click(beta);
    expect(beta).toBeChecked();
    expect(alpha).toBeChecked();
    expect(settingsList()).toHaveTextContent("beta-model");
    expect(screen.getByText("2", { selector: "span" })).toBeInTheDocument();

    await user.click(beta);
    expect(beta).not.toBeChecked();
    expect(alpha).toBeChecked();
    expect(within(settingsList()).queryByText("beta-model")).not.toBeInTheDocument();
    expect(within(settingsList()).getByText("Pinned Alpha")).toBeInTheDocument();
  });

  it("clears stale Advanced expansion when the same model is unchecked and reselected", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const settings = settingsList();
    const alphaRow = within(settings).getByText("alpha-model").closest("li");
    expect(alphaRow).not.toBeNull();
    const advanced = within(alphaRow!).getByRole("button", { name: "Advanced" });
    await user.click(advanced);
    expect(advanced).toHaveAttribute("aria-expanded", "true");
    expect(within(alphaRow!).getByTestId("model-advanced")).toBeInTheDocument();

    const alpha = within(candidateList()).getByRole("checkbox", { name: "alpha-model" });
    await user.click(alpha);
    expect(within(settingsList()).queryByText("alpha-model")).not.toBeInTheDocument();

    await user.click(alpha);
    const restoredRow = within(settingsList()).getByText("alpha-model").closest("li");
    expect(restoredRow).not.toBeNull();
    expect(within(restoredRow!).getByRole("button", { name: "Advanced" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(restoredRow!).queryByTestId("model-advanced")).not.toBeInTheDocument();
  });

  it("keeps a single searched selection after Escape restores the full candidate list", async () => {
    const user = userEvent.setup();
    render(<Harness initialModels={[]} />);

    const search = screen.getByRole("searchbox", { name: "Search model ID…" });
    await user.type(search, "beta");
    expect(candidateList()).toHaveAttribute("data-total-count", "1");

    const beta = within(candidateList()).getByRole("checkbox", { name: "beta-model" });
    await user.click(beta);
    expect(beta).toBeChecked();
    expect(within(settingsList()).getByText("beta-model")).toBeInTheDocument();

    await user.type(search, "{Escape}");
    expect(candidateList()).toHaveAttribute("data-total-count", "3");
    expect(within(candidateList()).getByRole("checkbox", { name: "beta-model" })).toBeChecked();
    expect(within(candidateList()).getByRole("checkbox", { name: "alpha-model" })).not.toBeChecked();
  });

  it("toggles an individually selected deep row in the virtualized candidate list", async () => {
    const user = userEvent.setup();
    const remote = Array.from({ length: 90 }, (_, index) => `model-${String(index).padStart(3, "0")}`);
    render(<Harness initialModels={[]} remote={remote} />);

    const list = candidateList();
    expect(within(list).queryByRole("checkbox", { name: "model-089" })).not.toBeInTheDocument();
    Object.defineProperty(list, "scrollTop", { value: 82 * 28, writable: true, configurable: true });
    fireEvent.scroll(list);

    const deep = within(list).getByRole("checkbox", { name: "model-089" });
    await user.click(deep);
    expect(deep).toBeChecked();
    expect(within(settingsList()).getByText("model-089")).toBeInTheDocument();
    expect(deep.closest("li")).toHaveAttribute("aria-posinset", "90");
    expect(deep.closest("li")).toHaveAttribute("aria-setsize", "90");
  });
});
