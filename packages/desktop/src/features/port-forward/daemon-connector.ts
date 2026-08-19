import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";
import {
  HostTunnelFlow,
  HostTunnelOpcode,
  encodeHostTunnelFrame,
  hostTunnelErrorCategory,
  type HostTunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  DaemonClient,
  type DaemonClientConfig,
  type WebSocketLike,
} from "@getpaseo/client/internal/daemon-client";
import type {
  HostConnectionCandidate,
  HostTunnelConnector,
  HostTunnelHandle,
  HostTunnelStream,
} from "./types.js";

type OutboundFrame = Parameters<typeof encodeHostTunnelFrame>[0];

export interface PortForwardDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void> | void;
  subscribeHostTunnelFrames(handler: (frame: HostTunnelFrame) => void): () => void;
  subscribeConnectionStatus(handler: (status: { status: string }) => void): () => void;
  getLastServerInfoMessage(): { features?: { portForward?: boolean } } | null | undefined;
  sendHostTunnelFrame(frame: Uint8Array): void;
}

export type PortForwardDaemonClientFactory = (input: {
  candidate: HostConnectionCandidate;
  serverId: string;
  clientId: string;
  appVersion?: string;
}) => PortForwardDaemonClient;

interface OpenClientStream extends HostTunnelStream {
  enqueueFromTunnel(data: Uint8Array): void;
  markHalfClosed(): void;
  markReset(category: string): void;
  markReady(): void;
  notifyWindowAvailable(): void;
}

export class DaemonHostTunnelConnector implements HostTunnelConnector {
  constructor(
    private readonly input: {
      clientId: string;
      appVersion?: string;
      now?: () => number;
      createClient?: PortForwardDaemonClientFactory;
    },
  ) {}

  connect(params: {
    serverId: string;
    candidates: HostConnectionCandidate[];
    onStateChange: (state: HostTunnelHandle["state"]) => void;
  }): HostTunnelHandle {
    return new DaemonHostTunnelHandle({
      serverId: params.serverId,
      candidates: params.candidates,
      onStateChange: params.onStateChange,
      clientId: this.input.clientId,
      appVersion: this.input.appVersion,
      createClient: this.input.createClient ?? createPortForwardDaemonClient,
    });
  }
}

export class HostTunnelClientMux {
  readonly flow = new HostTunnelFlow();
  readonly streams = new Map<number, OpenClientStream>();
  private nextStreamId = 1;

  constructor(private readonly send: (frame: OutboundFrame) => void) {}

  get streamCount(): number {
    return this.streams.size;
  }

  openStream(target: { host: string; port: number }): HostTunnelStream {
    const streamId = this.nextStreamId;
    this.nextStreamId += 1;
    const opened = this.flow.openStream(streamId);
    const stream = createClientStream(
      streamId,
      this.flow,
      (frame) => this.send(frame),
      () => {
        this.streams.delete(streamId);
      },
    );
    this.streams.set(streamId, stream);
    if (!opened.ok) {
      this.streams.delete(streamId);
      queueMicrotask(() => stream.markReset("limit"));
      return stream;
    }
    this.send({
      opcode: HostTunnelOpcode.Open,
      streamId,
      host: target.host,
      port: target.port,
    });
    return stream;
  }

  handleFrame(frame: HostTunnelFrame): void {
    const stream = this.streams.get(frame.streamId);
    if (frame.opcode === HostTunnelOpcode.OpenResult) {
      if (!frame.ok) {
        stream?.markReset(hostTunnelErrorCategory(frame.errorCode));
        this.release(frame.streamId);
      } else {
        stream?.markReady();
      }
      return;
    }
    if (!stream) {
      return;
    }
    if (frame.opcode === HostTunnelOpcode.Data) {
      stream.enqueueFromTunnel(frame.payload);
      return;
    }
    if (frame.opcode === HostTunnelOpcode.HalfClose) {
      stream.markHalfClosed();
      return;
    }
    if (frame.opcode === HostTunnelOpcode.Reset) {
      stream.markReset("reset");
      this.release(frame.streamId);
      return;
    }
    if (frame.opcode === HostTunnelOpcode.WindowUpdate) {
      this.flow.applySendWindowUpdate(frame.streamId, frame.credit);
      this.flushOutbound();
      stream.notifyWindowAvailable();
    }
  }

  resetAll(): void {
    const open = Array.from(this.streams.entries());
    this.streams.clear();
    for (const [streamId, stream] of open) {
      stream.markReset("reset");
      this.flow.closeStream(streamId);
    }
  }

  private flushOutbound(): void {
    for (const frame of this.flow.takeOutboundData()) {
      this.send({
        opcode: HostTunnelOpcode.Data,
        streamId: frame.streamId,
        payload: frame.payload,
      });
    }
  }

  private release(streamId: number): void {
    this.streams.delete(streamId);
    this.flow.closeStream(streamId);
  }
}

class DaemonHostTunnelHandle implements HostTunnelHandle {
  state: HostTunnelHandle["state"] = "connecting";
  private readonly serverId: string;
  private candidates: HostConnectionCandidate[];
  private readonly onStateChange: (state: HostTunnelHandle["state"]) => void;
  private readonly clientId: string;
  private readonly appVersion?: string;
  private readonly createClient: PortForwardDaemonClientFactory;
  private readonly mux: HostTunnelClientMux;
  private client: PortForwardDaemonClient | null = null;
  private unsubscribeFrames: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private closed = false;
  private attempt = 0;
  private connectLoopRunning = false;
  private handlingDisconnect = false;

  constructor(input: {
    serverId: string;
    candidates: HostConnectionCandidate[];
    onStateChange: (state: HostTunnelHandle["state"]) => void;
    clientId: string;
    appVersion?: string;
    createClient: PortForwardDaemonClientFactory;
  }) {
    this.serverId = input.serverId;
    this.candidates = input.candidates;
    this.onStateChange = input.onStateChange;
    this.clientId = input.clientId;
    this.appVersion = input.appVersion;
    this.createClient = input.createClient;
    this.mux = new HostTunnelClientMux((frame) => this.send(frame));
    void this.connectLoop();
  }

  openStream(target: { host: string; port: number }): HostTunnelStream {
    return this.mux.openStream(target);
  }

  setCandidates(candidates: HostConnectionCandidate[]): void {
    this.candidates = candidates;
  }

  close(): void {
    this.closed = true;
    this.mux.resetAll();
    this.teardownClient();
    this.setState("disconnected");
  }

  private async connectLoop(): Promise<void> {
    if (this.connectLoopRunning || this.closed) {
      return;
    }
    this.connectLoopRunning = true;
    try {
      while (!this.closed) {
        if (this.candidates.length === 0) {
          this.setState("disconnected");
          await wait(500);
          continue;
        }
        const candidate = this.candidates[this.attempt % this.candidates.length];
        this.attempt += 1;
        this.setState("connecting");
        const client = this.createClient({
          candidate,
          serverId: this.serverId,
          clientId: this.clientId,
          appVersion: this.appVersion,
        });
        this.client = client;
        this.unsubscribeFrames = client.subscribeHostTunnelFrames((frame) => {
          this.mux.handleFrame(frame);
        });
        this.unsubscribeStatus = client.subscribeConnectionStatus((status) => {
          if (status.status === "disconnected" || status.status === "disposed") {
            this.handleDisconnect();
          }
        });
        try {
          await client.connect();
          if (this.closed) {
            return;
          }
          if (this.client !== client) {
            continue;
          }
          const features = client.getLastServerInfoMessage()?.features;
          if (features?.portForward !== true) {
            this.setState("update_host_required");
            await wait(2_000);
            this.mux.resetAll();
            this.teardownClient();
            continue;
          }
          this.setState("ready");
          return;
        } catch {
          this.mux.resetAll();
          this.teardownClient();
          this.setState("disconnected");
          await wait(500);
        }
      }
    } finally {
      this.connectLoopRunning = false;
    }
  }

  private handleDisconnect(): void {
    if (this.closed || this.handlingDisconnect) {
      return;
    }
    this.handlingDisconnect = true;
    try {
      this.mux.resetAll();
      this.teardownClient();
      this.setState("disconnected");
    } finally {
      this.handlingDisconnect = false;
    }
    if (!this.closed && !this.connectLoopRunning) {
      void this.connectLoop();
    }
  }

  private send(frame: OutboundFrame): void {
    this.client?.sendHostTunnelFrame(encodeHostTunnelFrame(frame));
  }

  private teardownClient(): void {
    this.unsubscribeFrames?.();
    this.unsubscribeStatus?.();
    this.unsubscribeFrames = null;
    this.unsubscribeStatus = null;
    const client = this.client;
    this.client = null;
    if (client) {
      void client.close();
    }
  }

  private setState(state: HostTunnelHandle["state"]): void {
    this.state = state;
    this.onStateChange(state);
  }
}

export function buildHostTunnelDaemonClientConfig(input: {
  clientId: string;
  appVersion?: string;
  serverId: string;
  candidate: HostConnectionCandidate;
}): DaemonClientConfig {
  const sessionClientId = `${input.clientId}:host-tunnel:${input.serverId}:${randomUUID()}`;
  const base = {
    clientId: sessionClientId,
    clientType: "browser" as const,
    appVersion: input.appVersion,
    capabilities: { [CLIENT_CAPS.hostTunnelStreams]: true },
    suppressSendErrors: true,
    webSocketFactory: createNodeWebSocketFactory(),
    reconnect: { enabled: false as const },
  };
  if (input.candidate.type === "directSocket" || input.candidate.type === "directPipe") {
    return {
      ...base,
      url: `ws+unix://${input.candidate.path}:/ws`,
    };
  }
  if (input.candidate.type === "directTcp") {
    return {
      ...base,
      url: buildDaemonWebSocketUrl(input.candidate.endpoint ?? "127.0.0.1:6767", {
        useTls: input.candidate.useTls ?? false,
      }),
      ...(input.candidate.password ? { password: input.candidate.password } : {}),
    };
  }
  const relayEndpoint = input.candidate.relayEndpoint ?? "";
  const useTls = input.candidate.useTls ?? shouldUseTlsForDefaultHostedRelay(relayEndpoint);
  return {
    ...base,
    url: buildRelayWebSocketUrl({
      endpoint: relayEndpoint,
      useTls,
      serverId: input.serverId,
      role: "client",
    }),
    e2ee: input.candidate.daemonPublicKeyB64
      ? { enabled: true, daemonPublicKeyB64: input.candidate.daemonPublicKeyB64 }
      : undefined,
  };
}

export function createNodeWebSocketFactory(): (
  url: string,
  options?: { headers?: Record<string, string>; protocols?: string[] },
) => WebSocketLike {
  return (url, options) =>
    new WebSocket(url, options?.protocols, {
      headers: options?.headers,
    }) as unknown as WebSocketLike;
}

function createPortForwardDaemonClient(input: {
  candidate: HostConnectionCandidate;
  serverId: string;
  clientId: string;
  appVersion?: string;
}): PortForwardDaemonClient {
  return new DaemonClient(buildHostTunnelDaemonClientConfig(input));
}

function createClientStream(
  streamId: number,
  flow: HostTunnelFlow,
  send: (frame: OutboundFrame) => void,
  onReleased: () => void,
): OpenClientStream {
  const dataListeners = new Set<(data: Uint8Array) => void>();
  const halfCloseListeners = new Set<() => void>();
  const resetListeners = new Set<(category: string) => void>();
  const windowListeners = new Set<() => void>();
  let localHalfClosed = false;
  let remoteHalfClosed = false;
  let released = false;

  function releaseIfDone(): void {
    if (released || !localHalfClosed || !remoteHalfClosed) {
      return;
    }
    released = true;
    flow.closeStream(streamId);
    onReleased();
  }

  return {
    streamId,
    write(data) {
      const result = flow.enqueueOutbound(streamId, data);
      for (const frame of flow.takeOutboundData()) {
        send({
          opcode: HostTunnelOpcode.Data,
          streamId: frame.streamId,
          payload: frame.payload,
        });
      }
      return !result.paused;
    },
    halfClose() {
      send({ opcode: HostTunnelOpcode.HalfClose, streamId });
      localHalfClosed = true;
      releaseIfDone();
    },
    reset() {
      send({ opcode: HostTunnelOpcode.Reset, streamId });
      released = true;
      flow.closeStream(streamId);
      onReleased();
    },
    acknowledgeInbound() {
      const credit = flow.consumeInbound(streamId);
      if (credit <= 0) {
        return;
      }
      send({
        opcode: HostTunnelOpcode.WindowUpdate,
        streamId,
        credit,
      });
    },
    onData(cb) {
      dataListeners.add(cb);
    },
    onHalfClose(cb) {
      halfCloseListeners.add(cb);
    },
    onReset(cb) {
      resetListeners.add(cb);
    },
    onWindowAvailable(cb) {
      windowListeners.add(cb);
    },
    enqueueFromTunnel(data) {
      flow.recordInbound(streamId, data.byteLength);
      for (const listener of dataListeners) listener(data);
    },
    markHalfClosed() {
      remoteHalfClosed = true;
      for (const listener of halfCloseListeners) listener();
      releaseIfDone();
    },
    markReset(category) {
      for (const listener of resetListeners) listener(category);
    },
    markReady() {
      for (const listener of windowListeners) listener();
    },
    notifyWindowAvailable() {
      for (const listener of windowListeners) listener();
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
