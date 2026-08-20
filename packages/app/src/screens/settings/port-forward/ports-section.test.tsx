/**
 * @vitest-environment jsdom
 */
/* eslint-disable react-perf/jsx-no-new-function-as-prop */
import { i18n as testI18n } from "@/i18n/i18next";
import React from "react";
import { act, fireEvent } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

void testI18n;

const { listMock, createMock, stopMock, subscribeMock } = vi.hoisted(() => ({
  listMock: vi.fn(async () => []),
  createMock: vi.fn(async (input: { target: string; label?: string }) => ({
    id: "pf-1",
    serverId: "host-a",
    targetHost: "localhost",
    targetPort: 8080,
    targetDisplay: "localhost:8080",
    label: input.label ?? "",
    preferredLocalPort: 8080,
    localPort: 8080,
    localAddress: "localhost:8080",
    requireLocalPort: false,
    openAs: "http",
    state: "ready",
    recentError: null,
  })),
  stopMock: vi.fn(async () => ({ ok: true })),
  subscribeMock: vi.fn(async () => () => {}),
}));

vi.mock("@/desktop/port-forward/facade", () => ({
  listPortForwards: listMock,
  createPortForward: createMock,
  updatePortForward: vi.fn(),
  stopPortForward: stopMock,
  retryPortForward: vi.fn(),
  openPortForward: vi.fn(),
  subscribePortForwards: subscribeMock,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        "host-a": { serverInfo: { features: { portForward: true } } },
      },
    }),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ copied: vi.fn(), show: vi.fn(), error: vi.fn() }),
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(async () => true),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    testID,
    disabled,
  }: {
    children: React.ReactNode;
    onPress?: () => void;
    testID?: string;
    disabled?: boolean;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));

function MockFormTextInput({
  value,
  onChangeText,
  testID,
}: {
  value: string;
  onChangeText: (value: string) => void;
  testID?: string;
}) {
  return <input data-testid={testID} value={value} onChange={onChangeFromText(onChangeText)} />;
}

function onChangeFromText(onChangeText: (value: string) => void) {
  return function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    onChangeText(event.target.value);
  };
}

function MockSwitch({
  value,
  onValueChange,
  testID,
}: {
  value: boolean;
  onValueChange: (value: boolean) => void;
  testID?: string;
}) {
  return (
    <input
      type="checkbox"
      data-testid={testID}
      checked={value}
      onChange={onChangeFromChecked(onValueChange)}
    />
  );
}

function onChangeFromChecked(onValueChange: (value: boolean) => void) {
  return function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    onValueChange(event.target.checked);
  };
}

vi.mock("@/components/ui/form-field", () => ({
  Field: ({ children, label }: { children: React.ReactNode; label: string }) => (
    <label>
      {label}
      {children}
    </label>
  ),
  FormTextInput: MockFormTextInput,
}));

vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: () => <div />,
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: MockSwitch,
}));

vi.mock("@/screens/settings/settings-group", () => ({
  SettingsGroup: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
}));

vi.mock("@/screens/settings/settings-section", () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/styles/settings", () => ({
  settingsStyles: {
    card: {},
    row: {},
    rowBorder: {},
    rowContent: {},
    rowTitle: {},
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? factory({
            colors: { foreground: "#fff", foregroundMuted: "#aaa", destructive: "#f00" },
            fontSize: { sm: 12 },
            fontWeight: { normal: "400" },
            spacing: { 2: 8, 3: 12 },
          })
        : factory,
  },
}));

import { PortsSection } from "./ports-section.electron";

describe("Ports section", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("creates a Port Forward through the Electron IPC facade", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<PortsSection serverId="host-a" />);
    });
    await act(async () => {
      fireEvent.click(
        container.querySelector('[data-testid="host-ports-add"]') as HTMLButtonElement,
      );
    });
    await act(async () => {
      fireEvent.change(
        container.querySelector('[data-testid="host-ports-target"]') as HTMLInputElement,
        {
          target: { value: "8080" },
        },
      );
    });
    await act(async () => {
      fireEvent.click(
        container.querySelector('[data-testid="host-ports-submit"]') as HTMLButtonElement,
      );
    });
    expect(createMock).toHaveBeenCalledWith({
      serverId: "host-a",
      target: "8080",
      label: "",
      requireLocalPort: false,
      openAs: "none",
    });
    expect(container.querySelector('[data-testid="host-ports-loopback-hint"]')).not.toBeNull();
    root.unmount();
  });

  it("disables save while a create is in flight", async () => {
    createMock.mockImplementation(() => new Promise(() => {}));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<PortsSection serverId="host-a" />);
    });
    await act(async () => {
      fireEvent.click(
        container.querySelector('[data-testid="host-ports-add"]') as HTMLButtonElement,
      );
    });
    await act(async () => {
      fireEvent.change(
        container.querySelector('[data-testid="host-ports-target"]') as HTMLInputElement,
        {
          target: { value: "8080" },
        },
      );
    });
    await act(async () => {
      fireEvent.click(
        container.querySelector('[data-testid="host-ports-submit"]') as HTMLButtonElement,
      );
    });
    await act(async () => {
      fireEvent.click(
        container.querySelector('[data-testid="host-ports-submit"]') as HTMLButtonElement,
      );
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(
      (container.querySelector('[data-testid="host-ports-submit"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    root.unmount();
  });
});
