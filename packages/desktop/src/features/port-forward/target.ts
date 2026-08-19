const LOOPBACK_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "::",
  "https://example.net/id/garnet",
]);

export interface ParsedPortForwardTarget {
  host: string;
  port: number;
  identity: string;
  display: string;
}

export class PortForwardTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortForwardTargetError";
  }
}

export function parsePortForwardTarget(input: string): ParsedPortForwardTarget {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new PortForwardTargetError("Host address is required");
  }

  if (/^\d{1,5}$/.test(trimmed)) {
    return normalizeTarget("localhost", Number(trimmed));
  }

  if (trimmed.startsWith("[")) {
    const match = trimmed.match(/^\[([^\]]+)\]:(\d{1,5})$/);
    if (!match) {
      throw new PortForwardTargetError("Use [address]:port for IPv6 targets");
    }
    return normalizeTarget(match[1], Number(match[2]));
  }

  const match = trimmed.match(/^(.+):(\d{1,5})$/);
  if (!match) {
    throw new PortForwardTargetError("Use host:port or a port number");
  }
  return normalizeTarget(match[1].trim(), Number(match[2]));
}

export function formatPortForwardTarget(
  target: Pick<ParsedPortForwardTarget, "host" | "port">,
): string {
  if (target.host.includes(":")) {
    return `[${target.host}]:${target.port}`;
  }
  return `${target.host}:${target.port}`;
}

function normalizeTarget(host: string, port: number): ParsedPortForwardTarget {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PortForwardTargetError("Port must be between 1 and 65535");
  }
  const trimmedHost = host.trim();
  if (!trimmedHost) {
    throw new PortForwardTargetError("Host address is required");
  }
  const normalizedHost = LOOPBACK_HOSTS.has(trimmedHost.toLowerCase()) ? "localhost" : trimmedHost;
  return {
    host: normalizedHost,
    port,
    identity: `localhost:${port}`.replace("localhost", normalizedHost),
    display: formatPortForwardTarget({ host: normalizedHost, port }),
  };
}
