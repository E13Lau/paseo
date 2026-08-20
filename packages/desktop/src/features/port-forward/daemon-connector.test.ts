import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import {
  HOST_TUNNEL_LIMITS,
  HostTunnelErrorCode,
  HostTunnelOpcode,
  type HostTunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  DaemonHostTunnelConnector,
  HostTunnelClientMux,
  buildHostTunnelDaemonClientConfig,
  type PortForwardDaemonClient,
} from "./daemon-connector.js";

describe("HostTunnelClientMux", () => {
  it("flushes queued outbound data on WindowUpdate and notifies listeners", () => {
    const sent: Array<{ opcode: number; streamId?: number; payload?: Uint8Array }> = [];
    const mux = new HostTunnelClientMux((frame) => sent.push(frame));
    const stream = mux.openStream({ host: "localhost", port: 80 });
    let windowSignals = 0;
    stream.onWindowAvailable(() => {
      windowSignals += 1;
    });
    mux.handleFrame({
      opcode: HostTunnelOpcode.OpenResult,
      streamId: stream.streamId,
      ok: true,
      errorCode: HostTunnelErrorCode.Ok,
    });
    expect(windowSignals).toBe(1);

    stream.write(new Uint8Array(80 * 1024));
    const firstSent = sent
      .filter((frame) => frame.opcode === HostTunnelOpcode.Data)
      .reduce((total, frame) => total + (frame.payload?.byteLength ?? 0), 0);
    expect(firstSent).toBe(HOST_TUNNEL_LIMITS.INITIAL_STREAM_WINDOW_BYTES);

    mux.handleFrame({
      opcode: HostTunnelOpcode.WindowUpdate,
      streamId: stream.streamId,
      credit: 16 * 1024,
    });
    const afterCredit = sent
      .filter((frame) => frame.opcode === HostTunnelOpcode.Data)
      .reduce((total, frame) => total + (frame.payload?.byteLength ?? 0), 0);
    expect(afterCredit).toBe(HOST_TUNNEL_LIMITS.INITIAL_STREAM_WINDOW_BYTES + 16 * 1024);
    expect(windowSignals).toBe(2);
  });

  it("maps failed OpenResult through hostTunnelErrorCategory", () => {
    const mux = new HostTunnelClientMux(() => undefined);
    const stream = mux.openStream({ host: "localhost", port: 80 });
    let category: string | null = null;
    stream.onReset((value) => {
      category = value;
    });
    mux.handleFrame({
      opcode: HostTunnelOpcode.OpenResult,
      streamId: stream.streamId,
      ok: false,
      errorCode: HostTunnelErrorCode.Dns,
    });
    expect(category).toBe("dns");
  });

  it("releases a stream after both sides half-close so the session can open more", async () => {
    const mux = new HostTunnelClientMux(() => undefined);
    for (let index = 0; index < HOST_TUNNEL_LIMITS.MAX_STREAMS_PER_SESSION; index += 1) {
      const stream = mux.openStream({ host: "localhost", port: 80 });
      mux.handleFrame({
        opcode: HostTunnelOpcode.OpenResult,
        streamId: stream.streamId,
        ok: true,
        errorCode: HostTunnelErrorCode.Ok,
      });
      stream.halfClose();
      mux.handleFrame({
        opcode: HostTunnelOpcode.HalfClose,
        streamId: stream.streamId,
      });
    }
    expect(mux.streamCount).toBe(0);
    let limited = false;
    const extra = mux.openStream({ host: "localhost", port: 80 });
    extra.onReset((category) => {
      if (category === "limit") limited = true;
    });
    await delay(0);
    expect(limited).toBe(false);
    expect(mux.streamCount).toBe(1);
  });

  it("credits inbound bytes only after acknowledgeInbound", () => {
    const sent: Array<{ opcode: number; credit?: number }> = [];
    const mux = new HostTunnelClientMux((frame) => sent.push(frame));
    const stream = mux.openStream({ host: "localhost", port: 80 });
    mux.handleFrame({
      opcode: HostTunnelOpcode.OpenResult,
      streamId: stream.streamId,
      ok: true,
      errorCode: HostTunnelErrorCode.Ok,
    });
    mux.handleFrame({
      opcode: HostTunnelOpcode.Data,
      streamId: stream.streamId,
      payload: new Uint8Array(12),
    });
    expect(sent.filter((frame) => frame.opcode === HostTunnelOpcode.WindowUpdate)).toEqual([]);
    stream.acknowledgeInbound();
    const credit = sent.find((frame) => frame.opcode === HostTunnelOpcode.WindowUpdate);
    expect(credit?.credit).toBe(12);
  });
});

describe("buildHostTunnelDaemonClientConfig", () => {
  it("uses a Node ws factory, disables reconnect, and speaks ws+unix", () => {
    const config = buildHostTunnelDaemonClientConfig({
      clientId: "electron",
      serverId: "host-a",
      candidate: { id: "sock", type: "directSocket", path: "/tmp/paseo.sock" },
    });
    expect(config.url).toBe("ws+unix:///tmp/paseo.sock:/ws");
    expect(config.reconnect).toEqual({ enabled: false });
    expect(typeof config.webSocketFactory).toBe("function");
  });

  it("defaults relay TLS from shouldUseTlsForDefaultHostedRelay", () => {
    const insecure = buildHostTunnelDaemonClientConfig({
      clientId: "electron",
      serverId: "host-a",
      candidate: {
        id: "relay",
        type: "relay",
        relayEndpoint: "relay.example.com:8080",
      },
    });
    expect(insecure.url.startsWith("ws://")).toBe(true);
    const secure = buildHostTunnelDaemonClientConfig({
      clientId: "electron",
      serverId: "host-a",
      candidate: {
        id: "relay",
        type: "relay",
        relayEndpoint: "relay.example.com:443",
      },
    });
    expect(secure.url.startsWith("wss://")).toBe(true);
  });
});

describe("DaemonHostTunnelConnector reconnect", () => {
  it("does not stack connect loops when connect fails and emits disconnected", async () => {
    const clients: MockDaemonClient[] = [];
    const connector = new DaemonHostTunnelConnector({
      clientId: "electron",
      createClient: () => {
        const client = new MockDaemonClient(async () => {
          client.emitStatus("disconnected");
          throw new Error("connect failed");
        });
        clients.push(client);
        return client;
      },
    });
    const handle = connector.connect({
      serverId: "host-a",
      candidates: [{ id: "tcp", type: "directTcp", endpoint: "127.0.0.1:1" }],
      onStateChange: () => undefined,
    });
    await delay(80);
    expect(clients).toHaveLength(1);
    handle.close();
  });
});

class MockDaemonClient implements PortForwardDaemonClient {
  private readonly statusListeners = new Set<(status: { status: string }) => void>();
  private readonly connectImpl: () => Promise<void>;

  constructor(connectImpl: () => Promise<void>) {
    this.connectImpl = connectImpl;
  }

  connect(): Promise<void> {
    return this.connectImpl();
  }

  close(): void {
    this.emitStatus("disconnected");
  }

  subscribeHostTunnelFrames(_handler: (frame: HostTunnelFrame) => void): () => void {
    return () => undefined;
  }

  subscribeConnectionStatus(handler: (status: { status: string }) => void): () => void {
    this.statusListeners.add(handler);
    return () => {
      this.statusListeners.delete(handler);
    };
  }

  getLastServerInfoMessage(): { features?: { portForward?: boolean } } {
    return { features: { portForward: true } };
  }

  sendHostTunnelFrame(_frame: Uint8Array): void {}

  emitStatus(status: string): void {
    for (const listener of this.statusListeners) listener({ status });
  }
}
