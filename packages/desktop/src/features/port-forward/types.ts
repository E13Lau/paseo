export type PortForwardOpenAs = "none" | "http" | "https";

export type PortForwardState =
  | "starting"
  | "waiting_for_host"
  | "update_host_required"
  | "ready"
  | "port_unavailable"
  | "error";

export interface PortForwardDefinition {
  id: string;
  serverId: string;
  targetHost: string;
  targetPort: number;
  label: string;
  preferredLocalPort: number;
  requireLocalPort: boolean;
  openAs: PortForwardOpenAs;
}

export interface PortForwardRecentError {
  category: string;
  at: string;
}

export interface PortForwardSnapshot {
  id: string;
  serverId: string;
  targetHost: string;
  targetPort: number;
  targetDisplay: string;
  label: string;
  preferredLocalPort: number;
  localPort: number | null;
  localAddress: string | null;
  requireLocalPort: boolean;
  openAs: PortForwardOpenAs;
  state: PortForwardState;
  recentError: PortForwardRecentError | null;
}

export interface PortForwardCreateInput {
  serverId: string;
  target: string;
  label?: string;
  localPort?: number;
  requireLocalPort?: boolean;
  openAs?: PortForwardOpenAs;
}

export interface PortForwardUpdateInput {
  id: string;
  target?: string;
  label?: string;
  localPort?: number;
  requireLocalPort?: boolean;
  openAs?: PortForwardOpenAs;
}

export interface HostConnectionCandidate {
  id: string;
  type: "directTcp" | "directSocket" | "directPipe" | "relay";
  endpoint?: string;
  path?: string;
  useTls?: boolean;
  password?: string;
  relayEndpoint?: string;
  daemonPublicKeyB64?: string;
}

export interface HostTunnelStream {
  readonly streamId: number;
  write(data: Uint8Array): boolean;
  halfClose(): void;
  reset(): void;
  onData(cb: (data: Uint8Array) => void): void;
  onHalfClose(cb: () => void): void;
  onReset(cb: (category: string) => void): void;
  onWindowAvailable(cb: () => void): void;
}

export interface HostTunnelHandle {
  readonly state: "connecting" | "ready" | "update_host_required" | "disconnected";
  openStream(target: { host: string; port: number }): HostTunnelStream;
  close(): void;
}

export interface HostTunnelConnector {
  connect(input: {
    serverId: string;
    candidates: HostConnectionCandidate[];
    onStateChange: (state: HostTunnelHandle["state"]) => void;
  }): HostTunnelHandle;
}
