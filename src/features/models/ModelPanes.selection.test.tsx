import { fireEvent, render, screen, within } from "@testing-library/react";
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

const renderPanes = (
  models: ModelEntry[],
  onModelsChange: (models: ModelEntry[]) => void,
  remote: string[] = ["alpha-model", "beta-model"],
) =>
  render(
    <ModelPanes
      provider={provider(models)}
      catalog={[]}
      remote={remote}
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

  it("dedupes case variants and treats the configured spelling as the same selected model", async () => {
    const user = userEvent.setup();
    const onModelsChange = vi.fn();
    renderPanes(
      [model("ALPHA-MODEL", "Pinned override")],
      onModelsChange,
      ["alpha-model", "ALPHA-MODEL", "beta-model"],
    );

    const list = screen.getByRole("list", { name: "Models from this service" });
    const alpha = within(list).getByRole("checkbox", { name: /alpha-model/i });
    expect(within(list).getAllByRole("checkbox")).toHaveLength(2);
    expect(alpha).toBeChecked();

    await user.click(alpha);

    expect(onModelsChange).toHaveBeenCalledOnce();
    expect(onModelsChange.mock.calls[0][0]).toEqual([]);
  });

  it("select all does not duplicate an already-selected case variant", async () => {
    const user = userEvent.setup();
    const onModelsChange = vi.fn();
    renderPanes([model("ALPHA-MODEL", "Pinned override")], onModelsChange);

    await user.click(screen.getByRole("checkbox", { name: "Select all" }));

    expect(onModelsChange).toHaveBeenCalledOnce();
    expect(onModelsChange.mock.calls[0][0]).toEqual([
      model("ALPHA-MODEL", "Pinned override"),
      model("beta-model"),
    ]);
  });

  it("rejects a custom model ID that differs only by case", async () => {
    const user = userEvent.setup();
    const onModelsChange = vi.fn();
    renderPanes([model("Alpha-Model")], onModelsChange);

    await user.type(screen.getByLabelText("Custom model ID"), "alpha-model");
    await user.click(screen.getByRole("button", { name: "Add custom model" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Model already added");
    expect(onModelsChange).not.toHaveBeenCalled();
  });

  it("virtualizes large candidate DOM without truncating select-all scope", async () => {
    const user = userEvent.setup();
    const onModelsChange = vi.fn();
    const remote = Array.from({ length: 75 }, (_, index) => `model-${String(index).padStart(3, "0")}`);
    renderPanes([], onModelsChange, remote);

    const list = screen.getByRole("list", { name: "Models from this service" });
    expect(list).toHaveAttribute("data-total-count", "75");
    expect(Number(list.getAttribute("data-rendered-count"))).toBeLessThan(75);
    expect(within(list).getAllByRole("checkbox").length).toBeLessThan(75);
    expect(within(list).queryByRole("checkbox", { name: "model-074" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select all" }));

    expect(onModelsChange).toHaveBeenCalledOnce();
    expect(onModelsChange.mock.calls[0][0]).toHaveLength(75);
    expect(onModelsChange.mock.calls[0][0][74].id).toBe("model-074");
  });

  it("renders deep candidate rows when the virtual list scrolls", () => {
    const onModelsChange = vi.fn();
    const remote = Array.from({ length: 120 }, (_, index) => `model-${String(index).padStart(3, "0")}`);
    renderPanes([], onModelsChange, remote);

    const list = screen.getByRole("list", { name: "Models from this service" });
    expect(within(list).queryByRole("checkbox", { name: "model-119" })).not.toBeInTheDocument();

    Object.defineProperty(list, "scrollTop", { value: 110 * 28, writable: true, configurable: true });
    fireEvent.scroll(list);

    const last = within(list).getByRole("checkbox", { name: "model-119" });
    expect(last).toBeInTheDocument();
    expect(last.closest("li")).toHaveAttribute("aria-posinset", "120");
    expect(last.closest("li")).toHaveAttribute("aria-setsize", "120");
  });
});
