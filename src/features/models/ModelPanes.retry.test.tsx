import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ModelEntry, ProviderConfig } from "@/shared/types";
import { ModelPanes } from "./ModelPanes";

const selected: ModelEntry = {
  id: "cached-chat",
  name: "Pinned Chat",
  contextWindow: 64000,
  maxTokens: null,
  input: null,
  reasoningEfforts: null,
  extra: null,
};

const provider: ProviderConfig = {
  route: "acme",
  displayName: "Acme",
  baseURL: "https://acme.example/v1",
  api: "openai-completions",
  apiKeyEnv: null,
  models: [selected],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
};

describe("ModelPanes fetch failure retry", () => {
  it("keeps existing rows visible, invokes Retry once, and recovers to fresh models", async () => {
    const user = userEvent.setup();
    const onFetch = vi.fn();
    const { rerender } = render(
      <ModelPanes
        provider={provider}
        catalog={[]}
        remote={["cached-chat", "cached-reasoner"]}
        fetching={false}
        fetchError="503 Service Unavailable"
        onModelsChange={() => {}}
        onFetch={onFetch}
      />,
    );

    const list = screen.getByRole("list", { name: "Models from this service" });
    expect(within(list).getByRole("checkbox", { name: "cached-chat" })).toBeChecked();
    expect(within(list).getByRole("checkbox", { name: "cached-reasoner" })).not.toBeChecked();

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("503 Service Unavailable");
    const retry = within(alert).getByRole("button", { name: "Retry" });
    await user.click(retry);
    expect(onFetch).toHaveBeenCalledTimes(1);

    rerender(
      <ModelPanes
        provider={provider}
        catalog={[]}
        remote={["cached-chat", "cached-reasoner"]}
        fetching
        fetchError={null}
        onModelsChange={() => {}}
        onFetch={onFetch}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Loading models…" })).toBeDisabled();
    expect(within(list).getByRole("checkbox", { name: "cached-chat" })).toBeChecked();

    rerender(
      <ModelPanes
        provider={provider}
        catalog={[]}
        remote={["fresh-chat", "fresh-reasoner", "cached-chat"]}
        fetching={false}
        fetchError={null}
        onModelsChange={() => {}}
        onFetch={onFetch}
      />,
    );
    expect(screen.getByRole("button", { name: "Fetch list" })).toBeEnabled();
    expect(within(list).getByRole("checkbox", { name: "fresh-chat" })).toBeInTheDocument();
    expect(within(list).getByRole("checkbox", { name: "fresh-reasoner" })).toBeInTheDocument();
    expect(within(list).getByRole("checkbox", { name: "cached-chat" })).toBeChecked();
  });
});
