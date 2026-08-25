import { render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cmd from "@/shared/commands";
import { useAppStore } from "@/shared/store";
import type { DshLatestInfo } from "@/shared/types";
import { DshVersionSection } from "./DshVersionSection";

const latest: DshLatestInfo = {
  tags: [
    {
      tag: "latest",
      version: "0.2.0",
      isInstalled: false,
      aboveSupported: false,
      incompatible: false,
    },
  ],
  installedVersion: null,
  supportedVersion: "0.1.0-rc.6",
  error: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({
    dshLatest: null,
    dshLatestBusy: false,
    dshInstallingVersion: null,
    dshTimeline: [],
    toasts: [],
    config: null,
  });
  vi.spyOn(cmd, "dshCheckLatest").mockResolvedValue(latest);
});

describe("DshVersionSection cross-page state", () => {
  it("keeps an in-flight version install after unmount and remount", async () => {
    useAppStore.setState({
      dshLatest: latest,
      dshInstallingVersion: "0.2.0",
    });

    const first = render(createElement(DshVersionSection));
    expect(screen.getByRole("button", { name: "Installing…" })).toBeInTheDocument();
    expect(screen.getByText("0.2.0")).toBeInTheDocument();

    first.unmount();
    const second = render(createElement(DshVersionSection));
    expect(screen.getByRole("button", { name: "Installing…" })).toBeInTheDocument();
    expect(screen.getByText("0.2.0")).toBeInTheDocument();
    second.unmount();
  });

  it("still loads latest on a normal first mount", async () => {
    const check = vi.spyOn(cmd, "dshCheckLatest");
    const first = render(createElement(DshVersionSection));
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    first.unmount();
  });
});
