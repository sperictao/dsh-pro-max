import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import type { ImportGroup } from "@/shared/types";
import { ImportDialog } from "./ImportDialog";

const groups: ImportGroup[] = [
  {
    source: "claude-code",
    entries: [
      {
        key: "claude-code:anthropic",
        route: "anthropic",
        name: "Anthropic",
        baseURL: "https://api.anthropic.com",
        api: "anthropic-messages",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        credential: "env",
        models: ["claude-sonnet-4-5"],
      },
    ],
  },
  {
    source: "codex",
    entries: [
      {
        key: "codex:openai",
        route: "openai",
        name: "OpenAI",
        baseURL: "https://api.openai.com/v1",
        api: "openai-responses",
        apiKeyEnv: null,
        credential: "literal",
        models: ["gpt-5.6"],
      },
    ],
  },
  { source: "pi", entries: [] },
  {
    source: "cc-switch",
    entries: [
      {
        key: "cc-switch:local",
        route: "local-proxy",
        name: "Local Proxy",
        baseURL: "http://127.0.0.1:8317/v1",
        api: "openai-completions",
        apiKeyEnv: null,
        credential: "none",
        models: ["local-model"],
      },
    ],
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(cmd, "modelConfigImportScan").mockResolvedValue(structuredClone(groups));
  vi.spyOn(cmd, "modelConfigImportRun").mockResolvedValue({ imported: 2, skipped: 0, failed: 0, literal: 0 });
});

describe("ImportDialog", () => {
  it("preselects only entries that do not depend on literal secrets and hides empty sources", async () => {
    render(createElement(ImportDialog, { onClose: vi.fn(), onImported: vi.fn() }));
    const dialog = await screen.findByRole("dialog", { name: "Import provider configuration" });

    await waitFor(() =>
      expect(within(dialog).getByRole("checkbox", { name: "claude-code:anthropic" })).toBeChecked(),
    );
    expect(within(dialog).getByRole("checkbox", { name: "cc-switch:local" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "codex:openai" })).not.toBeChecked();
    expect(within(dialog).queryByText("Pi")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Import selected (2)" })).toBeEnabled();
    expect(within(dialog).queryByText(/selected entries carry literal keys/)).not.toBeInTheDocument();
  });

  it("still lets the user explicitly include a literal-key entry and surfaces the consequence", async () => {
    const user = userEvent.setup();
    render(createElement(ImportDialog, { onClose: vi.fn(), onImported: vi.fn() }));
    const dialog = await screen.findByRole("dialog", { name: "Import provider configuration" });
    const literal = await within(dialog).findByRole("checkbox", { name: "codex:openai" });

    await user.click(literal);

    expect(within(dialog).getByText("1 selected entries carry literal keys; they import without credentials.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Import selected (3)" })).toBeEnabled();
  });

  it("reports the filtered provider count instead of the unfiltered total", async () => {
    const user = userEvent.setup();
    render(createElement(ImportDialog, { onClose: vi.fn(), onImported: vi.fn() }));
    const dialog = await screen.findByRole("dialog", { name: "Import provider configuration" });
    await within(dialog).findByText("Providers found: 3");

    await user.type(within(dialog).getByRole("textbox", { name: "Search providers…" }), "deepseek");

    expect(within(dialog).getByText("Providers found: 0")).toBeInTheDocument();
    expect(within(dialog).getByText("Nothing found")).toBeInTheDocument();
  });
});
