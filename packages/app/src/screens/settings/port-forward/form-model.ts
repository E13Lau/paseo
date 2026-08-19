export type PortForwardOpenAs = "none" | "http" | "https";

export interface PortForwardFormSnapshot {
  target: string;
  label: string;
  localPort: string;
  requireLocalPort: boolean;
  openAs: PortForwardOpenAs;
  canSubmit: boolean;
  targetError: string | null;
  localPortError: string | null;
}

export interface PortForwardFormRecord {
  targetDisplay: string;
  label: string;
  preferredLocalPort: number;
  requireLocalPort: boolean;
  openAs: PortForwardOpenAs;
}

interface PortForwardFormInput {
  mode: "create" | "edit";
  record?: PortForwardFormRecord;
  capability: "supported" | "unsupported" | "unknown";
}

export interface PortForwardFormModel {
  getState(): PortForwardFormSnapshot;
  subscribe(listener: () => void): () => void;
  setTarget(value: string): void;
  setLabel(value: string): void;
  setLocalPort(value: string): void;
  setRequireLocalPort(value: boolean): void;
  setOpenAs(value: PortForwardOpenAs): void;
  close(): void;
}

export function openPortForwardForm(input: PortForwardFormInput): PortForwardFormModel {
  const listeners = new Set<() => void>();
  let closed = false;
  let target = input.record?.targetDisplay ?? "";
  let label = input.record?.label ?? "";
  let localPort = input.record ? String(input.record.preferredLocalPort) : "";
  let requireLocalPort = input.record?.requireLocalPort ?? false;
  let openAs = input.record?.openAs ?? "none";
  let snapshot = buildSnapshot();

  function buildSnapshot(): PortForwardFormSnapshot {
    const targetError = validateTarget(target);
    const localPortError = validateLocalPort(localPort);
    const canSubmit =
      !closed &&
      input.capability === "supported" &&
      targetError === null &&
      localPortError === null;
    return {
      target,
      label,
      localPort,
      requireLocalPort,
      openAs,
      canSubmit,
      targetError,
      localPortError,
    };
  }

  function publish(): void {
    snapshot = buildSnapshot();
    for (const listener of listeners) listener();
  }

  function getState(): PortForwardFormSnapshot {
    return snapshot;
  }

  return {
    getState,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setTarget(value) {
      target = value;
      publish();
    },
    setLabel(value) {
      label = value;
      publish();
    },
    setLocalPort(value) {
      localPort = value;
      publish();
    },
    setRequireLocalPort(value) {
      requireLocalPort = value;
      publish();
    },
    setOpenAs(value) {
      openAs = value;
      publish();
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}

function validateTarget(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return "required";
  }
  if (/^\d{1,5}$/.test(trimmed)) {
    return portInRange(Number(trimmed)) ? null : "port";
  }
  if (trimmed.startsWith("[")) {
    return /^\[[^\]]+\]:\d{1,5}$/.test(trimmed) && portInRange(Number(trimmed.split("]:")[1]))
      ? null
      : "format";
  }
  const match = trimmed.match(/^.+:(\d{1,5})$/);
  if (!match) {
    return "format";
  }
  return portInRange(Number(match[1])) ? null : "port";
}

function validateLocalPort(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^\d{1,5}$/.test(trimmed) || !portInRange(Number(trimmed))) {
    return "port";
  }
  return null;
}

function portInRange(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
