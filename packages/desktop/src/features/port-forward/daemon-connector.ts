import { randomUUID } from "node:crypto";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
} from "@getpaseo/protocol/daemon-endpoints";
import {
  HOST_TUNNEL_LIMITS,
  HostTunnelFlow,
  HostTunnelOpcode,
  encodeHostTunnelFrame,
  type HostTunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  HostConnectionCandidate,
  HostTunnelConnector,
  HostTunnelHandle,
  HostTunnelStream,
} from "./types.js";

interface OpenClientStream extends HostTunnelStream {
  enqueueFromTunnel(data: Uint8Array): void;
  markHalfClosed(): void;
  markReset(category: string): void;
  markReady(): void;
}

export class DaemonHostTunnelConnector implements HostTunnelConnector {
  constructor(
    private readonly input: {
      clientId: string;
      appVersion?: string;
      now?: () => number;
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
    });
  }
}

class DaemonHostTunnelHandle implements HostTunnelHandle {
  state: HostTunnelHandle["state"] = "connecting";
  private readonly serverId: string;
  private readonly candidates: HostConnectionCandidate[];
  private readonly onStateChange: (state: HostTunnelHandle["state"]) => void;
  private readonly clientId: string;
  private readonly appVersion?: string;
  private readonly flow = new HostTunnelFlow();
  private readonly streams = new Map<number, OpenClientStream>();
  private nextStreamId = 1;
  private client: DaemonClient | null = null;
  private unsubscribeFrames: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private closed = false;
  private attempt = 0;

  constructor(input: {
    serverId: string;
    candidates: HostConnectionCandidate[];
    onStateChange: (state: HostTunnelHandle["state"]) => void;
    clientId: string;
    appVersion?: string;
  }) {
    this.serverId = input.serverId;
    this.candidates = input.candidates;
    this.onStateChange = input.onStateChange;
    this.clientId = input.clientId;
    this.appVersion = input.appVersion;
    void this.connectLoop();
  }

  openStream(target: { host: string; port: number }): HostTunnelStream {
    const streamId = this.nextStreamId;
    this.nextStreamId += 1;
    const opened = this.flow.openStream(streamId);
    const stream = createClientStream(streamId, this.flow, (frame) => this.send(frame));
    this.streams.set(streamId, stream);
    if (!opened.ok) {
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

  close(): void {
    this.closed = true;
    this.unsubscribeFrames?.();
    this.unsubscribeStatus?.();
    void this.client?.close();
    this.client = null;
    for (const stream of this.streams.values()) {
      stream.markReset("reset");
    }
    this.streams.clear();
    this.setState("disconnected");
  }

  private async connectLoop(): Promise<void> {
    while (!this.closed) {
      if (this.candidates.length === 0) {
        this.setState("disconnected");
        await wait(500);
        continue;
      }
      const candidate = this.candidates[this.attempt % this.candidates.length];
      this.attempt += 1;
      this.setState("connecting");
      try {
        const client = this.createClient(candidate);
        this.client = client;
        this.unsubscribeFrames = client.subscribeHostTunnelFrames((frame) => {
          this.handleFrame(frame);
        });
        this.unsubscribeStatus = client.subscribeConnectionStatus((status) => {
          if (status.status === "disconnected" || status.status === "disposed") {
            this.handleDisconnect();
          }
        });
        await client.connect();
        if (this.closed) {
          return;
        }
        const features = client.getLastServerInfoMessage()?.features;
        if (features?.portForward !== true) {
          this.setState("update_host_required");
          await wait(2_000);
          this.teardownClient();
          continue;
        }
        this.setState("ready");
        return;
      } catch {
        this.teardownClient();
        this.setState("disconnected");
        await wait(500);
      }
    }
  }

  private handleDisconnect(): void {
    for (const stream of this.streams.values()) {
      stream.markReset("reset");
    }
    this.streams.clear();
    this.setState("disconnected");
    if (!this.closed) {
      void this.connectLoop();
    }
  }

  private handleFrame(frame: HostTunnelFrame): void {
    const stream = this.streams.get(frame.streamId);
    if (frame.opcode === HostTunnelOpcode.OpenResult) {
      if (!frame.ok) {
        stream?.markReset(frame.errorCode === 1 ? "timeout" : "refused");
        this.streams.delete(frame.streamId);
        this.flow.closeStream(frame.streamId);
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
      this.streams.delete(frame.streamId);
      this.flow.closeStream(frame.streamId);
      return;
    }
    if (frame.opcode === HostTunnelOpcode.WindowUpdate) {
      this.flow.applySendWindowUpdate(frame.streamId, frame.credit);
      stream.onWindowAvailable(() => undefined);
    }
  }

  private send(frame: Parameters<typeof encodeHostTunnelFrame>[0]): void {
    this.client?.sendHostTunnelFrame(encodeHostTunnelFrame(frame));
  }

  private teardownClient(): void {
    this.unsubscribeFrames?.();
    this.unsubscribeStatus?.();
    this.unsubscribeFrames = null;
    this.unsubscribeStatus = null;
    void this.client?.close();
    this.client = null;
  }

  private setState(state: HostTunnelHandle["state"]): void {
    this.state = state;
    this.onStateChange(state);
  }

  private createClient(candidate: HostConnectionCandidate): DaemonClient {
    const base = {
      clientId: `${this.clientId}:host-tunnel:${this.serverId}:${randomUUID()}`,
      clientType: "browser" as const,
      appVersion: this.appVersion,
      capabilities: { [CLIENT_CAPS.hostTunnelStreams]: true },
      suppressSendErrors: true,
    };
    if (candidate.type === "directSocket" || candidate.type === "directPipe") {
      return new DaemonClient({
        ...base,
        url: `ws+unix://${candidate.path}:/ws`,
      });
    }
    if (candidate.type === "directTcp") {
      return new DaemonClient({
        ...base,
        url: buildDaemonWebSocketUrl(candidate.endpoint ?? "127.0.0.1:6767", {
          useTls: candidate.useTls ?? false,
        }),
        ...(candidate.password ? { password: candidate.password } : {}),
      });
    }
    return new DaemonClient({
      ...base,
      url: buildRelayWebSocketUrl({
        endpoint: candidate.relayEndpoint ?? "",
        useTls: candidate.useTls ?? true,
        serverId: this.serverId,
        role: "client",
      }),
      e2ee: candidate.daemonPublicKeyB64
        ? { enabled: true, daemonPublicKeyB64: candidate.daemonPublicKeyB64 }
        : undefined,
    });
  }
}

function createClientStream(
  streamId: number,
  flow: HostTunnelFlow,
  send: (frame: Parameters<typeof encodeHostTunnelFrame>[0]) => void,
): OpenClientStream {
  const dataListeners = new Set<(data: Uint8Array) => void>();
  const halfCloseListeners = new Set<() => void>();
  const resetListeners = new Set<(category: string) => void>();
  const windowListeners = new Set<() => void>();

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
    },
    reset() {
      send({ opcode: HostTunnelOpcode.Reset, streamId });
      flow.closeStream(streamId);
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
      for (const listener of dataListeners) listener(data);
      send({
        opcode: HostTunnelOpcode.WindowUpdate,
        streamId,
        credit: Math.min(data.byteLength, HOST_TUNNEL_LIMITS.MAX_STREAM_WINDOW_BYTES),
      });
    },
    markHalfClosed() {
      for (const listener of halfCloseListeners) listener();
    },
    markReset(category) {
      for (const listener of resetListeners) listener(category);
    },
    markReady() {
      for (const listener of windowListeners) listener();
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
