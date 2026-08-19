import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { PortBindError, bindDualStackLoopback, bindDualStackLoopbackStrict } from "./binder.js";
import { formatPortForwardTarget, parsePortForwardTarget } from "./target.js";
import type { PortForwardStore } from "./store.js";
import type {
  HostConnectionCandidate,
  HostTunnelConnector,
  HostTunnelHandle,
  HostTunnelStream,
  PortForwardCreateInput,
  PortForwardDefinition,
  PortForwardOpenAs,
  PortForwardSnapshot,
  PortForwardState,
  PortForwardUpdateInput,
} from "./types.js";

interface LiveForward {
  definition: PortForwardDefinition;
  state: PortForwardState;
  localPort: number | null;
  binding: Awaited<ReturnType<typeof bindDualStackLoopback>> | null;
  recentError: { category: string; at: string } | null;
  sockets: Set<LiveSocket>;
}

interface LiveSocket {
  local: Socket;
  remote: HostTunnelStream | null;
  localEnded: boolean;
  remoteEnded: boolean;
}

interface HostRuntime {
  candidates: HostConnectionCandidate[];
  tunnel: HostTunnelHandle | null;
}

export class PortForwardManager {
  private readonly store: PortForwardStore;
  private readonly connector: HostTunnelConnector;
  private readonly now: () => number;
  private readonly forwards = new Map<string, LiveForward>();
  private readonly hosts = new Map<string, HostRuntime>();
  private readonly listeners = new Set<(snapshots: PortForwardSnapshot[]) => void>();
  private started = false;

  constructor(input: {
    store: PortForwardStore;
    connector: HostTunnelConnector;
    now?: () => number;
  }) {
    this.store = input.store;
    this.connector = input.connector;
    this.now = input.now ?? Date.now;
  }

  subscribe(listener: (snapshots: PortForwardSnapshot[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshots());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshots(serverId?: string): PortForwardSnapshot[] {
    return [...this.forwards.values()]
      .filter((forward) => !serverId || forward.definition.serverId === serverId)
      .map((forward) => toSnapshot(forward));
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    for (const definition of await this.store.list()) {
      await this.restoreDefinition(definition);
    }
    this.emit();
  }

  syncHostCandidates(serverId: string, candidates: HostConnectionCandidate[]): void {
    const host = this.hosts.get(serverId) ?? { candidates: [], tunnel: null };
    host.candidates = candidates;
    this.hosts.set(serverId, host);
    this.reconcileHostTunnel(serverId);
    this.emit();
  }

  async create(input: PortForwardCreateInput): Promise<PortForwardSnapshot> {
    const target = parsePortForwardTarget(input.target);
    const duplicate = [...this.forwards.values()].find(
      (forward) =>
        forward.definition.serverId === input.serverId &&
        forward.definition.targetHost === target.host &&
        forward.definition.targetPort === target.port,
    );
    if (duplicate) {
      throw new Error("A Port Forward already exists for this Host target");
    }
    const preferredLocalPort = input.localPort ?? target.port;
    const definition: PortForwardDefinition = {
      id: randomUUID(),
      serverId: input.serverId,
      targetHost: target.host,
      targetPort: target.port,
      label: input.label?.trim() ?? "",
      preferredLocalPort,
      requireLocalPort: input.requireLocalPort === true,
      openAs: input.openAs ?? "none",
    };
    let live: LiveForward;
    try {
      live = await this.bindDefinition(definition);
    } catch (error) {
      if (definition.requireLocalPort) {
        throw new Error("Required local port is unavailable", { cause: error });
      }
      throw error;
    }
    this.forwards.set(live.definition.id, live);
    await this.store.save(live.definition);
    this.reconcileHostTunnel(input.serverId);
    this.emit();
    return toSnapshot(live);
  }

  async update(input: PortForwardUpdateInput): Promise<PortForwardSnapshot> {
    const live = this.requireForward(input.id);
    const nextTarget = input.target
      ? parsePortForwardTarget(input.target)
      : {
          host: live.definition.targetHost,
          port: live.definition.targetPort,
        };
    const nextRequire = input.requireLocalPort ?? live.definition.requireLocalPort;
    const nextLocalPort = input.localPort ?? live.definition.preferredLocalPort;
    const transportChanged =
      nextTarget.host !== live.definition.targetHost ||
      nextTarget.port !== live.definition.targetPort ||
      nextLocalPort !== live.definition.preferredLocalPort;

    if (!transportChanged) {
      live.definition = {
        ...live.definition,
        label: input.label ?? live.definition.label,
        openAs: input.openAs ?? live.definition.openAs,
        requireLocalPort: nextRequire,
      };
      await this.store.save(live.definition);
      this.emit();
      return toSnapshot(live);
    }

    const replacement: PortForwardDefinition = {
      ...live.definition,
      targetHost: nextTarget.host,
      targetPort: nextTarget.port,
      label: input.label ?? live.definition.label,
      preferredLocalPort: nextLocalPort,
      requireLocalPort: nextRequire,
      openAs: input.openAs ?? live.definition.openAs,
    };
    const nextLive = await this.bindDefinition(replacement);
    await this.closeLive(live, false);
    this.forwards.set(nextLive.definition.id, nextLive);
    await this.store.save(nextLive.definition);
    this.reconcileHostTunnel(nextLive.definition.serverId);
    this.emit();
    return toSnapshot(nextLive);
  }

  async stop(id: string): Promise<void> {
    const live = this.requireForward(id);
    await this.closeLive(live, true);
    await this.store.remove(id);
    this.reconcileHostTunnel(live.definition.serverId);
    this.emit();
  }

  async removeHost(serverId: string): Promise<void> {
    const hosted: LiveForward[] = [];
    for (const live of this.forwards.values()) {
      if (live.definition.serverId === serverId) {
        hosted.push(live);
      }
    }
    for (const live of hosted) {
      await this.closeLive(live, true);
    }
    this.hosts.get(serverId)?.tunnel?.close();
    this.hosts.delete(serverId);
    await this.store.removeHost(serverId);
    this.emit();
  }

  async rekeyHost(oldServerId: string, newServerId: string): Promise<void> {
    for (const live of this.forwards.values()) {
      if (live.definition.serverId === oldServerId) {
        live.definition = { ...live.definition, serverId: newServerId };
      }
    }
    const host = this.hosts.get(oldServerId);
    if (host) {
      this.hosts.delete(oldServerId);
      this.hosts.set(newServerId, host);
    }
    await this.store.rekeyHost(oldServerId, newServerId);
    this.reconcileHostTunnel(newServerId);
    this.emit();
  }

  async dispose(): Promise<void> {
    const liveForwards: LiveForward[] = [];
    for (const live of this.forwards.values()) {
      liveForwards.push(live);
    }
    for (const live of liveForwards) {
      await this.closeLive(live, false);
    }
    for (const host of this.hosts.values()) {
      host.tunnel?.close();
    }
    this.hosts.clear();
  }

  async retry(id: string): Promise<PortForwardSnapshot> {
    const live = this.requireForward(id);
    if (live.binding) {
      live.state = this.hostState(live.definition.serverId);
      this.emit();
      return toSnapshot(live);
    }
    const next = await this.installDefinition(live.definition, live.definition.id);
    this.emit();
    return toSnapshot(next);
  }

  private async restoreDefinition(definition: PortForwardDefinition): Promise<void> {
    try {
      await this.installDefinition(definition, definition.id);
    } catch {
      this.forwards.set(definition.id, {
        definition,
        state: "port_unavailable",
        localPort: null,
        binding: null,
        recentError: { category: "port_unavailable", at: new Date(this.now()).toISOString() },
        sockets: new Set(),
      });
    }
  }

  private async installDefinition(
    definition: PortForwardDefinition,
    existingId?: string,
  ): Promise<LiveForward> {
    try {
      const live = await this.bindDefinition(definition);
      this.forwards.set(live.definition.id, live);
      return live;
    } catch (error) {
      if (existingId && this.forwards.has(existingId)) {
        throw error;
      }
      const failed: LiveForward = {
        definition,
        state: error instanceof PortBindError ? "port_unavailable" : "error",
        localPort: null,
        binding: null,
        recentError: {
          category: error instanceof PortBindError ? "port_unavailable" : "error",
          at: new Date(this.now()).toISOString(),
        },
        sockets: new Set(),
      };
      this.forwards.set(definition.id, failed);
      if (definition.requireLocalPort) {
        throw new Error("Required local port is unavailable", { cause: error });
      }
      return failed;
    }
  }

  private async bindDefinition(definition: PortForwardDefinition): Promise<LiveForward> {
    const live: LiveForward = {
      definition,
      state: "starting",
      localPort: null,
      binding: null,
      recentError: null,
      sockets: new Set(),
    };
    const binding = definition.requireLocalPort
      ? await bindDualStackLoopbackStrict(definition.preferredLocalPort)
      : await bindDualStackLoopback(definition.preferredLocalPort);
    live.binding = binding;
    live.localPort = binding.port;
    live.definition = {
      ...definition,
      preferredLocalPort: binding.port,
    };
    live.state = this.hostState(definition.serverId);
    binding.onConnection((socket) => {
      this.acceptConnection(live, socket);
    });
    return live;
  }

  private acceptConnection(live: LiveForward, socket: Socket): void {
    socket.setNoDelay(true);
    const tracked: LiveSocket = {
      local: socket,
      remote: null,
      localEnded: false,
      remoteEnded: false,
    };
    live.sockets.add(tracked);

    const host = this.hosts.get(live.definition.serverId);
    if (!host?.tunnel || host.tunnel.state !== "ready") {
      live.recentError = {
        category:
          live.state === "update_host_required" ? "update_host_required" : "waiting_for_host",
        at: new Date(this.now()).toISOString(),
      };
      socket.resetAndDestroy();
      live.sockets.delete(tracked);
      this.emit();
      return;
    }

    const remote = host.tunnel.openStream({
      host: live.definition.targetHost,
      port: live.definition.targetPort,
    });
    tracked.remote = remote;
    pipeLocalToRemote(tracked, () => this.emit());
    remote.onData((data) => {
      if (!socket.write(data)) {
        socket.pause();
        socket.once("drain", () => socket.resume());
      }
    });
    remote.onHalfClose(() => {
      tracked.remoteEnded = true;
      socket.end();
      this.maybeReleaseSocket(live, tracked);
    });
    remote.onReset((category) => {
      live.recentError = { category, at: new Date(this.now()).toISOString() };
      socket.resetAndDestroy();
      live.sockets.delete(tracked);
      this.emit();
    });
    remote.onWindowAvailable(() => socket.resume());
  }

  private maybeReleaseSocket(live: LiveForward, tracked: LiveSocket): void {
    if (tracked.localEnded && tracked.remoteEnded) {
      live.sockets.delete(tracked);
    }
  }

  private async closeLive(live: LiveForward, remove: boolean): Promise<void> {
    for (const tracked of live.sockets) {
      tracked.remote?.reset();
      tracked.local.resetAndDestroy();
    }
    live.sockets.clear();
    await live.binding?.close();
    live.binding = null;
    if (remove) {
      this.forwards.delete(live.definition.id);
    }
  }

  private reconcileHostTunnel(serverId: string): void {
    const hasForwards = [...this.forwards.values()].some(
      (forward) => forward.definition.serverId === serverId,
    );
    const host = this.hosts.get(serverId) ?? { candidates: [], tunnel: null };
    this.hosts.set(serverId, host);
    if (!hasForwards) {
      host.tunnel?.close();
      host.tunnel = null;
      return;
    }
    if (host.tunnel) {
      this.applyHostState(serverId, host.tunnel.state);
      return;
    }
    host.tunnel = this.connector.connect({
      serverId,
      candidates: host.candidates,
      onStateChange: (state) => {
        this.applyHostState(serverId, state);
        this.emit();
      },
    });
    this.applyHostState(serverId, host.tunnel.state);
  }

  private applyHostState(serverId: string, tunnelState: HostTunnelHandle["state"]): void {
    for (const live of this.forwards.values()) {
      if (live.definition.serverId !== serverId || !live.binding) {
        continue;
      }
      live.state = tunnelStateToForwardState(tunnelState);
      if (tunnelState === "disconnected") {
        for (const tracked of live.sockets) {
          tracked.remote?.reset();
          tracked.local.resetAndDestroy();
        }
        live.sockets.clear();
      }
    }
  }

  private hostState(serverId: string): PortForwardState {
    const tunnel = this.hosts.get(serverId)?.tunnel;
    return tunnel ? tunnelStateToForwardState(tunnel.state) : "waiting_for_host";
  }

  private requireForward(id: string): LiveForward {
    const live = this.forwards.get(id);
    if (!live) {
      throw new Error("Port Forward not found");
    }
    return live;
  }

  private emit(): void {
    const snapshots = this.snapshots();
    for (const listener of this.listeners) {
      listener(snapshots);
    }
  }
}

function tunnelStateToForwardState(state: HostTunnelHandle["state"]): PortForwardState {
  if (state === "ready") return "ready";
  if (state === "update_host_required") return "update_host_required";
  return "waiting_for_host";
}

function toSnapshot(live: LiveForward): PortForwardSnapshot {
  return {
    id: live.definition.id,
    serverId: live.definition.serverId,
    targetHost: live.definition.targetHost,
    targetPort: live.definition.targetPort,
    targetDisplay: formatPortForwardTarget({
      host: live.definition.targetHost,
      port: live.definition.targetPort,
    }),
    label: live.definition.label,
    preferredLocalPort: live.definition.preferredLocalPort,
    localPort: live.localPort,
    localAddress: live.localPort ? `localhost:${live.localPort}` : null,
    requireLocalPort: live.definition.requireLocalPort,
    openAs: live.definition.openAs,
    state: live.state,
    recentError: live.recentError,
  };
}

function pipeLocalToRemote(tracked: LiveSocket, onChange: () => void): void {
  const remote = tracked.remote;
  if (!remote) {
    return;
  }
  tracked.local.on("data", (chunk: Buffer) => {
    const accepted = remote.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if (!accepted) {
      tracked.local.pause();
    }
  });
  tracked.local.on("end", () => {
    tracked.localEnded = true;
    remote.halfClose();
    onChange();
  });
  tracked.local.on("error", () => {
    remote.reset();
  });
  tracked.local.on("close", () => {
    if (!tracked.localEnded) {
      remote.reset();
    }
  });
}

export type { PortForwardOpenAs };
