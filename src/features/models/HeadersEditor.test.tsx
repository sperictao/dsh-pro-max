import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { HeadersEditor } from "./HeadersEditor";

describe("HeadersEditor", () => {
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
  });
});
