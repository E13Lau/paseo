/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";

void testI18n;

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6, lg: 8, full: 999 },
    opacity: { 50: 0.5 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { normal: "400" },
    fontFamily: { mono: "mono" },
    colors: {
      accent: "#08f",
      accentForeground: "#fff",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      foregroundExtraMuted: "#666",
      border: "#333",
      borderAccent: "#555",
      destructive: "#f00",
      destructiveForeground: "#fff",
      palette: { red: { 300: "#f66" }, amber: { 500: "#f80" } },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({
      uniProps,
      ...rest
    }: {
      uniProps?: (theme: unknown) => Record<string, unknown>;
    } & Record<string, unknown>) => {
      const themed = uniProps ? uniProps(theme) : {};
      return React.createElement(Component, { ...rest, ...themed });
    },
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = () => React.createElement("span", { "data-icon": name });
    Icon.displayName = name;
    return Icon;
  };
  return {
    AlertTriangle: icon("AlertTriangle"),
    Download: icon("Download"),
  };
});

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "file-panel-download-tooltip" }, children),
}));

import { FilePanelBar } from "./bar";

beforeEach(() => {
  vi.stubGlobal("React", React);
  void testI18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

function noopDownload() {}
function noopModeChange(_mode: "preview" | "source") {}

function renderBar(overrides: Partial<React.ComponentProps<typeof FilePanelBar>> = {}) {
  return render(<FilePanelBar size={12} lineCount={2} onDownload={noopDownload} {...overrides} />);
}

describe("FilePanelBar download action", () => {
  it("places Download immediately before Preview/Source for a renderable file", () => {
    renderBar({
      mode: "preview",
      onModeChange: noopModeChange,
    });

    const download = screen.getByRole("button", { name: "Download" });
    const previewSource = screen.getByTestId("file-preview-mode");
    expect(download.compareDocumentPosition(previewSource) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(download.getAttribute("data-testid")).toBe("file-panel-download");
  });

  it("keeps Download when Preview/Source is absent", () => {
    renderBar();

    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    expect(screen.queryByTestId("file-preview-mode")).toBeNull();
  });

  it("delegates activation to the provided download boundary", () => {
    const onDownload = vi.fn();
    renderBar({ onDownload });

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("preserves Download and Preview/Source while metadata yields space", () => {
    renderBar({
      mode: "preview",
      onModeChange: noopModeChange,
    });

    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    expect(screen.getByTestId("file-preview-mode")).toBeTruthy();
    expect(screen.getByTestId("file-panel-bar-metadata").getAttribute("style")).toContain(
      "min-width: 0",
    );
    expect(screen.getByTestId("file-panel-bar-actions").getAttribute("style")).toContain(
      "flex-shrink: 0",
    );
  });

  it("exposes the localized tooltip on desktop", () => {
    renderBar();

    expect(screen.getByTestId("file-panel-download-tooltip").textContent).toBe("Download");
  });

  it("keeps Download independent of dirty editor status", () => {
    renderBar({
      editorStatus: "dirty",
      mode: "source",
      onModeChange: noopModeChange,
    });

    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    expect(screen.getByLabelText("Unsaved changes")).toBeTruthy();
  });
});
