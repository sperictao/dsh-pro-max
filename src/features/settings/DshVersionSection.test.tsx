import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  installedCompatible: false,
  installedAboveSupported: false,
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

describe("DshVersionSection compatibility facts", () => {
  it("marks the installed version and the matching tag as the verified stack", async () => {
    const verified: DshLatestInfo = {
      tags: [
        {
          tag: "latest",
          version: "0.1.0-rc.6",
          isInstalled: true,
          aboveSupported: false,
          incompatible: false,
        },
      ],
      installedVersion: "0.1.0-rc.6",
      installedCompatible: true,
      installedAboveSupported: false,
      supportedVersion: "0.1.0-rc.6",
      error: null,
    };
    vi.spyOn(cmd, "dshCheckLatest").mockResolvedValue(verified);

    render(createElement(DshVersionSection));
    // 已装行 + 命中验证栈版本的 tag 行各一枚
    expect(await screen.findAllByText("Verified stack")).toHaveLength(2);
    expect(screen.getByText("installed")).toBeInTheDocument();
  });

  it("shows the check failure with an inline retry that re-runs the check", async () => {
    const failed: DshLatestInfo = {
      tags: [],
      installedVersion: "0.1.0-rc.6",
      installedCompatible: true,
      installedAboveSupported: false,
      supportedVersion: "0.1.0-rc.6",
      error: "npm query timed out (15s)",
    };
    const check = vi.spyOn(cmd, "dshCheckLatest").mockResolvedValue(failed);
    const user = userEvent.setup();

    render(createElement(DshVersionSection));
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Check failed: npm query timed out/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
  });
});
