import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry, ModelEntry, ProviderConfig } from "@/shared/types";
import { ModelPanes } from "./ModelPanes";

const catalog: ModelCatalogEntry[] = [
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    family: "openai",
    context: 65536,
    maxTokens: 8192,
    input: ["text", "image"],
    reasoning: true,
    reasoningLevels: ["low", "medium", "high"],
    capabilities: ["text", "reasoning", "vision", "pdf"],
  },
];

const initialProvider: ProviderConfig = {
  route: "deepseek",
  displayName: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1",
  api: "openai-completions",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  models: [
    {
      id: "deepseek-reasoner",
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

function Harness() {
  const [provider, setProvider] = useState(initialProvider);
  const onModelsChange = (models: ModelEntry[]) => setProvider((current) => ({ ...current, models }));
  return (
    <ModelPanes
      provider={provider}
      catalog={catalog}
      remote={["deepseek-reasoner"]}
      fetching={false}
      fetchError={null}
      onModelsChange={onModelsChange}
      onFetch={vi.fn()}
    />
  );
}

describe("ModelPanes per-model Advanced", () => {
  it("keeps canonical identity and shows effective limits while editing overrides", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const settings = screen.getByRole("list", { name: "Model settings" });
    const row = settings.querySelector('[data-model-id="deepseek-reasoner"]');
    expect(row).not.toBeNull();
    const scoped = within(row as HTMLElement);

    expect(scoped.getByText("deepseek-reasoner")).toBeVisible();
    expect(scoped.getByText("65.5K · 8.2K")).toBeVisible();

    await user.click(scoped.getByRole("button", { name: "Advanced" }));
    const panel = scoped.getByTestId("model-advanced");
    await user.type(within(panel).getByRole("textbox", { name: "Alias" }), "Reasoner Preview");
    await user.type(within(panel).getByRole("spinbutton", { name: "Context window" }), "131072");
    await user.type(within(panel).getByRole("spinbutton", { name: "Max output" }), "32768");

    expect(scoped.getByText("deepseek-reasoner")).toBeVisible();
    expect(scoped.getByText("Reasoner Preview")).toBeVisible();
    expect(scoped.getByText("131.1K · 32.8K")).toBeVisible();
  });

  it("renders friendly effort labels without changing canonical button names", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const row = screen.getByRole("list", { name: "Model settings" }).querySelector(
      '[data-model-id="deepseek-reasoner"]',
    );
    expect(row).not.toBeNull();
    const scoped = within(row as HTMLElement);
    await user.click(scoped.getByRole("button", { name: "Advanced" }));

    const thinking = scoped.getByRole("group", { name: "Thinking levels" });
    expect(within(thinking).getByRole("button", { name: "off" })).toHaveTextContent("Off");
    expect(within(thinking).getByRole("button", { name: "minimal" })).toHaveTextContent("Minimal");
    expect(within(thinking).getByRole("button", { name: "high" })).toHaveTextContent("High");
    expect(within(thinking).getByRole("button", { name: "xhigh" })).toHaveTextContent("XHigh");
  });

  it("distinguishes inherited catalog levels from explicit thinking overrides", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const row = screen.getByRole("list", { name: "Model settings" }).querySelector(
      '[data-model-id="deepseek-reasoner"]',
    );
    expect(row).not.toBeNull();
    const scoped = within(row as HTMLElement);
    await user.click(scoped.getByRole("button", { name: "Advanced" }));

    const panel = scoped.getByTestId("model-advanced");
    const thinking = within(panel).getByRole("group", { name: "Thinking levels" });
    const inherit = within(panel).getByTestId("thinking-levels-inherit");
    expect(inherit).toHaveTextContent("Follow catalog · Low, Medium, High");
    expect(thinking).toHaveAttribute("aria-describedby", inherit.id);
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(within(thinking).getByRole("button", { name: level })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }

    const high = within(thinking).getByRole("button", { name: "high" });
    await user.click(high);
    expect(high).toHaveAttribute("aria-pressed", "true");
    expect(within(panel).queryByTestId("thinking-levels-inherit")).not.toBeInTheDocument();
    const spelling = within(panel).getByRole("textbox", { name: "Wire spelling for high" });
    expect(spelling).toHaveValue("high");
    await user.clear(spelling);
    await user.type(spelling, "reasoner-high");
    expect(spelling).toHaveValue("reasoner-high");

    await user.click(high);
    expect(high).toHaveAttribute("aria-pressed", "false");
    expect(within(panel).queryByRole("textbox", { name: "Wire spelling for high" })).not.toBeInTheDocument();
    expect(within(panel).getByTestId("thinking-levels-inherit")).toHaveTextContent(
      "Follow catalog · Low, Medium, High",
    );
  });
});
