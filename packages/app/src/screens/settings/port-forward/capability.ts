export type PortForwardCapability = "supported" | "unsupported" | "unknown";

const lastKnown = new Map<string, PortForwardCapability>();

export function rememberPortForwardCapability(
  serverId: string,
  capability: PortForwardCapability,
): void {
  if (capability === "unknown") {
    return;
  }
  lastKnown.set(serverId, capability);
}

export function resolvePortForwardCapability(input: {
  serverId: string;
  isConnected: boolean;
  feature: boolean | undefined;
  hasRestoredForward: boolean;
}): PortForwardCapability {
  if (input.feature === true) {
    rememberPortForwardCapability(input.serverId, "supported");
    return "supported";
  }
  if (input.isConnected) {
    rememberPortForwardCapability(input.serverId, "unsupported");
    return "unsupported";
  }
  if (input.hasRestoredForward) {
    rememberPortForwardCapability(input.serverId, "supported");
    return "supported";
  }
  return lastKnown.get(input.serverId) ?? "unknown";
}
