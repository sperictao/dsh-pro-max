import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry, ModelEntry, ProviderConfig } from "@/shared/types";
import { ModelPanes } from "./ModelPanes";
import { inputView } from "./shared";

const model = (input: string[] | null): ModelEntry => ({
  id: "doc-model",
  name: null,
  contextWindow: null,
  maxTokens: null,
  input,
  reasoningEfforts: null,
  extra: null,
});

const provider = (input: string[] | null): ProviderConfig => ({
  route: "acme",
  displayName: "Acme",
  baseURL: "https://acme.example/v1",
  api: "openai-completions",
  apiKeyEnv: null,
  models: [model(input)],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
});

const catalog: ModelCatalogEntry[] = [
  {
    id: "doc-model",
    name: "Document Model",
    family: "openai",
    context: 128000,
    input: ["text", "image", "pdf"],
    capabilities: ["text", "vision", "pdf"],
  },
];

describe("ModelPanes document capability projection", () => {
  it("only treats losslessly representable llm-pi-ai modalities as native input views", () => {
    expect(inputView(model(null))).toBe("inherit");
    expect(inputView(model([]))).toBe("inherit");
    expect(inputView(model(["text"]))).toBe("text");
    expect(inputView(model(["text", "image"]))).toBe("text-image");
    expect(inputView(model(["image", "text"]))).toBe("text-image");
    expect(inputView(model(["image"]))).toBe("custom");
    expect(inputView(model(["text", "image", "pdf"]))).toBe("custom");
    expect(inputView(model(["pdf"]))).toBe("custom");
  });

  it("shows published PDF capability as read-only metadata and preserves a custom input list", async () => {
    const user = userEvent.setup();
    const onModelsChange = vi.fn();
    render(
      <ModelPanes
        provider={provider(["text", "image", "pdf"])}
        catalog={catalog}
        remote={null}
        fetching={false}
        fetchError={null}
        onModelsChange={onModelsChange}
        onFetch={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByTestId("published-input-capabilities")).toHaveTextContent("Vision");
    expect(screen.getByTestId("published-input-capabilities")).toHaveTextContent("PDF");
    expect(screen.getByText(/PDF is catalog metadata only/)).toBeInTheDocument();
    expect(screen.getByLabelText("Image input")).toHaveValue("custom");

    fireEvent.change(screen.getByLabelText("Alias"), { target: { value: "Document Alias" } });
    expect(onModelsChange).toHaveBeenCalledOnce();
    expect(onModelsChange.mock.calls[0][0][0]).toMatchObject({
      name: "Document Alias",
      input: ["text", "image", "pdf"],
    });
  });

  it("writes only DSH-native text/image modalities when the user explicitly changes image input", async () => {
    const user = userEvent.setup();
    const onModelsChange = vi.fn();
    render(
      <ModelPanes
        provider={provider(null)}
        catalog={catalog}
        remote={null}
        fetching={false}
        fetchError={null}
        onModelsChange={onModelsChange}
        onFetch={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.selectOptions(screen.getByLabelText("Image input"), "text-image");
    expect(onModelsChange).toHaveBeenCalledOnce();
    expect(onModelsChange.mock.calls[0][0][0].input).toEqual(["text", "image"]);
  });
});
