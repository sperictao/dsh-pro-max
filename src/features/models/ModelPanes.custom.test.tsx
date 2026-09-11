import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry, ModelEntry, ProviderConfig } from "@/shared/types";
import { ModelPanes } from "./ModelPanes";

const catalog: ModelCatalogEntry[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    family: "openai",
    context: 65536,
    maxTokens: 8192,
    input: ["text"],
    reasoning: false,
    reasoningLevels: [],
    capabilities: ["text"],
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    family: "openai",
    context: 65536,
    maxTokens: 8192,
    input: ["text"],
    reasoning: true,
    reasoningLevels: ["low", "medium", "high"],
    capabilities: ["text", "reasoning"],
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
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      contextWindow: 65536,
      maxTokens: 8192,
      input: ["text"],
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
      remote={["deepseek-chat", "deepseek-reasoner"]}
      fetching={false}
      fetchError={null}
      onModelsChange={onModelsChange}
      onFetch={vi.fn()}
    />
  );
}

describe("ModelPanes custom model", () => {
  it("adds a manual model id and immediately opens its settings row", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole("textbox", { name: "Custom model ID" });
    await user.type(input, "deepseek-preview-2026");
    await user.click(screen.getByRole("button", { name: "Add custom model" }));

    expect(input).toHaveValue("");
    const settings = screen.getByRole("list", { name: "Model settings" });
    const added = settings.querySelector('[data-model-id="deepseek-preview-2026"]');
    expect(added).not.toBeNull();
    const addedRow = within(added as HTMLElement);
    expect(addedRow.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "true");
    expect(addedRow.getByTestId("model-advanced")).toBeVisible();

    const existing = settings.querySelector('[data-model-id="deepseek-chat"]');
    expect(existing).not.toBeNull();
    expect(within(existing as HTMLElement).getByRole("button", { name: "Advanced" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps case-insensitive duplicate validation unchanged", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole("textbox", { name: "Custom model ID" });
    await user.type(input, "DEEPSEEK-CHAT");
    await user.click(screen.getByRole("button", { name: "Add custom model" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Model already added");
    expect(input).toHaveValue("DEEPSEEK-CHAT");
    expect(screen.getByRole("list", { name: "Model settings" }).querySelectorAll("[data-model-id]")).toHaveLength(1);
  });
});
