import { getDesktopHost, type DesktopPortForwardSnapshot } from "@/desktop/host";
import { listenToDesktopEvent } from "@/desktop/electron/events";

export type PortForwardSnapshot = DesktopPortForwardSnapshot;

export function getPortForwardBridge() {
  return getDesktopHost()?.portForward ?? null;
}

export async function listPortForwards(serverId: string): Promise<PortForwardSnapshot[]> {
  return (await getPortForwardBridge()?.list?.(serverId)) ?? [];
}

export async function createPortForward(input: {
  serverId: string;
  target: string;
  label?: string;
  localPort?: number;
  requireLocalPort?: boolean;
  openAs?: "none" | "http" | "https";
}): Promise<PortForwardSnapshot> {
  const bridge = getPortForwardBridge();
  if (!bridge?.create) {
    throw new Error("Port Forward is only available in Electron.");
  }
  return bridge.create(input);
}

export async function updatePortForward(input: {
  id: string;
  target?: string;
  label?: string;
  localPort?: number;
  requireLocalPort?: boolean;
  openAs?: "none" | "http" | "https";
}): Promise<PortForwardSnapshot> {
  const bridge = getPortForwardBridge();
  if (!bridge?.update) {
    throw new Error("Port Forward is only available in Electron.");
  }
  return bridge.update(input);
}

export async function stopPortForward(id: string): Promise<void> {
  await getPortForwardBridge()?.stop?.(id);
}

export async function retryPortForward(id: string): Promise<void> {
  await getPortForwardBridge()?.retry?.(id);
}

export async function openPortForward(url: string): Promise<void> {
  await getPortForwardBridge()?.open?.({ url });
}

export async function syncPortForwardCandidates(
  serverId: string,
  candidates: readonly object[],
): Promise<void> {
  await getPortForwardBridge()?.syncCandidates?.({
    serverId,
    candidates: candidates as Array<Record<string, unknown>>,
  });
}

export async function removePortForwardHost(serverId: string): Promise<void> {
  await getPortForwardBridge()?.removeHost?.(serverId);
}

export async function rekeyPortForwardHost(
  oldServerId: string,
  newServerId: string,
): Promise<void> {
  await getPortForwardBridge()?.rekeyHost?.({ oldServerId, newServerId });
}

export function subscribePortForwards(
  handler: (snapshots: PortForwardSnapshot[]) => void,
): Promise<() => void> {
  return listenToDesktopEvent<PortForwardSnapshot[]>("port-forward", handler);
}
