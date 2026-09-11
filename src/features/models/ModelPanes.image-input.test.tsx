import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry, ModelEntry, ProviderConfig } from "@/shared/types";
import { ModelPanes } from "./ModelPanes";

const MODEL_ID = "vision-model";

function providerWith(input: string[] | null): ProviderConfig {
  return {
    route: "custom-ai",
    displayName: "Custom AI",
    baseURL: "https://api.example.com/v1",
    api: "openai-completions",
    apiKeyEnv: "CUSTOM_AI_KEY",
    models: [
      {
        id: MODEL_ID,
        name: null,
        contextWindow: null,
        maxTokens: null,
        input,
        reasoningEfforts: null,
        extra: null,
      },
    ],
    headers: null,
    timeoutMs: null,
    reasoning: null,
    extra: null,
  };
}

function catalogEntry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: MODEL_ID,
    name: "Vision Model",
    family: "openai",
    context: 128000,
    ...overrides,
  };
}

function Harness({
  initialInput = null,
  catalog = [catalogEntry({ input: ["text", "image"], capabilities: ["text", "vision"] })],
}: {
  initialInput?: string[] | null;
  catalog?: ModelCatalogEntry[];
}) {
  const [provider, setProvider] = useState(() => providerWith(initialInput));
  const onModelsChange = (models: ModelEntry[]) => setProvider((current) => ({ ...current, models }));
  return (
    <>
      <ModelPanes
        provider={provider}
        catalog={catalog}
        remote={[MODEL_ID]}
        fetching={false}
        fetchError={null}
        onModelsChange={onModelsChange}
        onFetch={vi.fn()}
      />
      <output data-testid="input-value">{JSON.stringify(provider.models[0].input)}</output>
    </>
  );
}

async function imageInputSelect(user: ReturnType<typeof userEvent.setup>) {
  const row = screen.getByRole("list", { name: "Model settings" }).querySelector(
    `[data-model-id="${MODEL_ID}"]`,
  );
  expect(row).not.toBeNull();
  const scoped = within(row as HTMLElement);
  await user.click(scoped.getByRole("button", { name: "Advanced" }));
  return scoped.getByRole("combobox", { name: "Image input" }) as HTMLSelectElement;
}

describe("ModelPanes image input override", () => {
  it("shows the inherited vision capability and round-trips explicit overrides", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const select = await imageInputSelect(user);
    expect(select).toHaveValue("inherit");
    expect(within(select).getByRole("option", { name: "Follow catalog · Text and images" })).toBeInTheDocument();
    expect(screen.getByTestId("input-value")).toHaveTextContent("null");

    await user.selectOptions(select, "text");
    expect(screen.getByTestId("input-value")).toHaveTextContent('["text"]');

    await user.selectOptions(select, "text-image");
    expect(screen.getByTestId("input-value")).toHaveTextContent('["text","image"]');

    await user.selectOptions(select, "inherit");
    expect(screen.getByTestId("input-value")).toHaveTextContent("null");
  });

  it("makes a published text-only catalog default explicit before overriding it", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        catalog={[catalogEntry({ input: ["text"], capabilities: ["text"] })]}
      />,
    );

    const select = await imageInputSelect(user);
    expect(within(select).getByRole("option", { name: "Follow catalog · Text only" })).toBeInTheDocument();
    await user.selectOptions(select, "text-image");
    expect(screen.getByTestId("input-value")).toHaveTextContent('["text","image"]');
  });

  it("does not invent an inherited capability when an older catalog entry has no input metadata", async () => {
    const user = userEvent.setup();
    render(<Harness catalog={[catalogEntry()]} />);

    const select = await imageInputSelect(user);
    expect(within(select).getByRole("option", { name: "Follow catalog" })).toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: /Follow catalog ·/ })).not.toBeInTheDocument();
  });

  it("preserves custom hand-written input modes until the user explicitly replaces them", async () => {
    const user = userEvent.setup();
    render(<Harness initialInput={["text", "pdf"]} />);

    const select = await imageInputSelect(user);
    expect(select).toHaveValue("custom");
    expect(within(select).getByRole("option", { name: "Custom (kept as-is)" })).toBeInTheDocument();
    expect(screen.getByTestId("input-value")).toHaveTextContent('["text","pdf"]');

    await user.selectOptions(select, "text-image");
    expect(screen.getByTestId("input-value")).toHaveTextContent('["text","image"]');
  });
});
