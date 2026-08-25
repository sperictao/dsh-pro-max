import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/shared/store";
import { AboutSection } from "./AboutSection";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useAppStore.setState({
    updaterHealth: null,
    updaterHealthError: null,
    updateInfo: null,
    updateBusyKind: null,
    updateLastCheckAt: null,
    updateCheckError: null,
    downloadProgress: null,
    toasts: [],
  });
});

describe("AboutSection cross-page state", () => {
  it("keeps self-update progress after unmount and remount", () => {
    useAppStore.setState({
      updateInfo: {
        currentVersion: "0.3.12",
        availableVersion: "0.3.13",
        hasUpdate: true,
        releaseNotes: "notes",
        message: null,
      },
      updateBusyKind: "install",
      downloadProgress: {
        stage: "downloading",
        version: "0.3.13",
        downloadedBytes: 1024,
        totalBytes: 2048,
        percent: 50,
        attempt: 1,
        maxAttempts: 3,
      },
    });

    const first = render(createElement(AboutSection));
    expect(screen.getByRole("button", { name: "Updating..." })).toBeInTheDocument();
    expect(screen.getByText("Downloading v0.3.13: 50%")).toBeInTheDocument();

    first.unmount();
    const second = render(createElement(AboutSection));
    expect(screen.getByRole("button", { name: "Updating..." })).toBeInTheDocument();
    expect(screen.getByText("Downloading v0.3.13: 50%")).toBeInTheDocument();
    second.unmount();
  });
});
