import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry, ModelEntry, ProviderConfig } from "@/shared/types";
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

const provider = (models: ModelEntry[] = []): ProviderConfig => ({
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

const catalog: ModelCatalogEntry[] = [
  {
    id: "acme-chat-pro-0813",
    name: "Acme Pro",
    family: "openai",
    context: 131072,
    maxTokens: 16384,
    input: ["text"],
    reasoning: true,
    reasoningLevels: ["low", "medium", "high"],
    capabilities: ["text", "reasoning"],
  },
  {
    id: "acme-chat-flash",
    name: "Friendly Alias",
    family: "openai",
    context: 65536,
    maxTokens: 8192,
    input: ["text"],
    reasoning: false,
    reasoningLevels: [],
    capabilities: ["text"],
  },
  {
    id: "vision-max",
    name: "Search Alias Only",
    family: "openai",
    context: 32768,
    maxTokens: 4096,
    input: ["text", "image"],
    reasoning: false,
    reasoningLevels: [],
    capabilities: ["text", "vision"],
  },
];

const renderPanes = (
  remote: string[] = catalog.map((entry) => entry.id),
  onModelsChange = vi.fn(),
) => {
  render(
    <ModelPanes
      provider={provider()}
      catalog={catalog}
      remote={remote}
      fetching={false}
      fetchError={null}
      onModelsChange={onModelsChange}
      onFetch={() => {}}
    />,
  );
  return onModelsChange;
};

describe("ModelPanes Search model ID", () => {
  it("matches model IDs case-insensitively with surrounding whitespace ignored", async () => {
    const user = userEvent.setup();
    renderPanes();

    const search = screen.getByRole("searchbox", { name: "Search model ID…" });
    await user.type(search, " PRO-0813 ");

    const list = screen.getByRole("list", { name: "Models from this service" });
    expect(within(list).getByRole("checkbox", { name: "acme-chat-pro-0813" })).toBeInTheDocument();
    expect(within(list).queryByRole("checkbox", { name: "acme-chat-flash" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 models");
  });

  it("does not silently match display names when the control promises Model ID search", async () => {
    const user = userEvent.setup();
    renderPanes();

    await user.type(screen.getByRole("searchbox", { name: "Search model ID…" }), "Friendly Alias");

    const list = screen.getByRole("list", { name: "Models from this service" });
    expect(within(list).queryByRole("checkbox", { name: "acme-chat-flash" })).not.toBeInTheDocument();
    expect(within(list).getByText("No matching models")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("0 models");
    expect(screen.getByRole("checkbox", { name: "Select all · 0 models" })).toBeDisabled();
  });

  it("shows the filtered result count and keeps visible-only Select all available for matches", async () => {
    const user = userEvent.setup();
    const onModelsChange = renderPanes();

    await user.type(screen.getByRole("searchbox", { name: "Search model ID…" }), "acme-chat");

    expect(screen.getByRole("status")).toHaveTextContent("2 models");
    const selectAll = screen.getByRole("checkbox", { name: "Select all · 2 models" });
    expect(selectAll).toBeEnabled();
    await user.click(selectAll);

    expect(onModelsChange).toHaveBeenCalledOnce();
    expect(onModelsChange.mock.calls[0][0].map((entry: ModelEntry) => entry.id)).toEqual([
      "acme-chat-pro-0813",
      "acme-chat-flash",
    ]);
  });

  it("clears with Escape, restores the complete list, and resets a virtualized list to the top", async () => {
    const user = userEvent.setup();
    const remote = Array.from({ length: 80 }, (_, index) => `model-${String(index).padStart(3, "0")}`);
    renderPanes(remote);

    const list = screen.getByRole("list", { name: "Models from this service" });
    Object.defineProperty(list, "scrollTop", { value: 70 * 28, writable: true, configurable: true });
    fireEvent.scroll(list);
    expect(within(list).queryByRole("checkbox", { name: "model-000" })).not.toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "Search model ID…" });
    await user.type(search, "model-079");
    expect(list).toHaveAttribute("data-total-count", "1");
    expect(within(list).getByRole("checkbox", { name: "model-079" })).toBeInTheDocument();

    await user.type(search, "{Escape}");

    expect(search).toHaveValue("");
    expect(list).toHaveAttribute("data-total-count", "80");
    expect(within(list).getByRole("checkbox", { name: "model-000" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
