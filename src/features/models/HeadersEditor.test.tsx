import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { HeadersEditor } from "./HeadersEditor";

describe("HeadersEditor", () => {
  it("keeps a blank Add header row visible until the user completes it", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(createElement(HeadersEditor, { headers: null, onChange }));

    await user.click(screen.getByRole("button", { name: "Add header" }));

    const name = screen.getByLabelText("Header name");
    const value = screen.getByLabelText("Header value");
    expect(name).toHaveValue("");
    expect(value).toHaveValue("");
    expect(onChange).not.toHaveBeenCalled();

    await user.type(name, "X-Client-Name");
    await user.type(value, "dsh-pro-max-audit");

    expect(onChange).toHaveBeenLastCalledWith({ "X-Client-Name": "dsh-pro-max-audit" });
  });

  it("filters credential headers from JSON import while keeping ordinary provider headers", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(createElement(HeadersEditor, { headers: null, onChange }));

    await user.click(screen.getByRole("button", { name: "Import JSON" }));
    fireEvent.change(screen.getByLabelText("Headers JSON"), {
      target: {
        value: JSON.stringify({
          "X-Title": "my-app",
          Authorization: "Bearer literal-secret",
          "x-api-key": "literal-secret",
        }),
      },
    });
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onChange).toHaveBeenLastCalledWith({ "X-Title": "my-app" });
    expect(screen.getByRole("alert")).toHaveTextContent("Authorization, x-api-key");
  });

  it("rejects a mixed JSON object atomically instead of silently skipping non-string values", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(createElement(HeadersEditor, { headers: null, onChange }));

    const importButton = screen.getByRole("button", { name: "Import JSON" });
    await user.click(importButton);
    expect(importButton).toHaveAttribute("aria-expanded", "true");
    fireEvent.change(screen.getByLabelText("Headers JSON"), {
      target: { value: JSON.stringify({ "X-Title": "my-app", Retries: 3 }) },
    });
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Use a JSON object with header names and string values.",
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(importButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByDisplayValue("my-app")).not.toBeInTheDocument();
  });

  it("treats case-only duplicate header names as one persisted HTTP header", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(createElement(HeadersEditor, { headers: { "X-Title": "original" }, onChange }));

    await user.click(screen.getByRole("button", { name: "Add header" }));
    const names = screen.getAllByLabelText("Header name");
    const values = screen.getAllByLabelText("Header value");
    await user.type(names[1], "x-title");
    await user.type(values[1], "replacement");

    expect(onChange).toHaveBeenLastCalledWith({ "x-title": "replacement" });
  });

  it("upserts preset and JSON headers case-insensitively instead of creating duplicate rows", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(createElement(HeadersEditor, { headers: { "x-client-name": "legacy" }, onChange }));

    await user.selectOptions(screen.getByRole("combobox", { name: "Common headers" }), "X-Client-Name");
    expect(screen.getAllByLabelText("Header name")).toHaveLength(1);
    expect(screen.getByLabelText("Header name")).toHaveValue("X-Client-Name");
    expect(screen.getByLabelText("Header value")).toHaveValue("dsh-pro-max");
    expect(onChange).toHaveBeenLastCalledWith({ "X-Client-Name": "dsh-pro-max" });

    await user.click(screen.getByRole("button", { name: "Import JSON" }));
    fireEvent.change(screen.getByLabelText("Headers JSON"), {
      target: { value: JSON.stringify({ "x-client-name": "json-value" }) },
    });
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getAllByLabelText("Header name")).toHaveLength(1);
    expect(screen.getByLabelText("Header name")).toHaveValue("x-client-name");
    expect(screen.getByLabelText("Header value")).toHaveValue("json-value");
    expect(onChange).toHaveBeenLastCalledWith({ "x-client-name": "json-value" });
  });
});
