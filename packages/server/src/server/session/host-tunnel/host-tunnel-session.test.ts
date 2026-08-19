import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { setTimeout as delay } from "node:timers/promises";
import {
  HOST_TUNNEL_LIMITS,
  HostTunnelErrorCode,
  HostTunnelOpcode,
  decodeHostTunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { HostTcpConnectError, type HostTcpSocket } from "./host-tcp.js";
import { HostTunnelSession } from "./host-tunnel-session.js";

class FakeSocket extends EventEmitter implements HostTcpSocket {
  written: Uint8Array[] = [];
  ended = false;
  destroyed = false;
  paused = false;
  writeBackpressure = false;

  write(data: Uint8Array): boolean {
    this.written.push(data);
    return !this.writeBackpressure;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }
}

function createSession(input: {
  supports?: boolean;
  connectImpl: (host: string, port: number) => Promise<FakeSocket>;
  networkDebug?: boolean;
}): {
  session: HostTunnelSession;
  frames: NonNullable<ReturnType<typeof decodeHostTunnelFrame>>[];
  logs: Array<{ msg: string; fields: Record<string, unknown> }>;
} {
  const frames: NonNullable<ReturnType<typeof decodeHostTunnelFrame>>[] = [];
  const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
  const logger = {
    info(fields: Record<string, unknown>, msg?: string) {
      logs.push({ msg: msg ?? "", fields });
    },
    warn(fields: Record<string, unknown>, msg?: string) {
      logs.push({ msg: msg ?? "", fields });
    },
  } as unknown as pino.Logger;
  const session = new HostTunnelSession({
    host: {
      emitBinary(frame) {
        const decoded = decodeHostTunnelFrame(frame);
        if (decoded) frames.push(decoded);
      },
      supportsHostTunnelStreams: () => input.supports !== false,
    },
    logger,
    connect: async ({ host, port }) => input.connectImpl(host, port),
    networkDebug: input.networkDebug,
  });
  return { session, frames, logs };
}

describe("HostTunnelSession", () => {
  it("relays opaque TCP bytes and preserves half-close", async () => {
    const socket = new FakeSocket();
    const { session, frames } = createSession({
      connectImpl: async () => socket,
    });

    session.handleFrame({
      opcode: HostTunnelOpcode.Open,
      streamId: 1,
      host: "svc.internal",
      port: 9000,
    });
    await waitFor(() => frames.length > 0);
    expect(frames[0]).toEqual({
      opcode: HostTunnelOpcode.OpenResult,
      streamId: 1,
      ok: true,
      errorCode: HostTunnelErrorCode.Ok,
    });

    session.handleFrame({
      opcode: HostTunnelOpcode.Data,
      streamId: 1,
      payload: new TextEncoder().encode("ping"),
    });
    expect(Buffer.concat(socket.written.map((chunk) => Buffer.from(chunk))).toString()).toBe(
      "ping",
    );
    expect(frames.some((frame) => frame.opcode === HostTunnelOpcode.WindowUpdate)).toBe(true);

    socket.emit("data", new TextEncoder().encode("pong"));
    expect(frames).toContainEqual({
      opcode: HostTunnelOpcode.Data,
      streamId: 1,
      payload: new TextEncoder().encode("pong"),
    });

    session.handleFrame({ opcode: HostTunnelOpcode.HalfClose, streamId: 1 });
    expect(socket.ended).toBe(true);
    socket.emit("end");
    expect(frames).toContainEqual({ opcode: HostTunnelOpcode.HalfClose, streamId: 1 });
  });

  it("times out a single open without tearing down the session", async () => {
    const { session, frames } = createSession({
      connectImpl: async (_host, _port) => {
        throw new HostTcpConnectError(HostTunnelErrorCode.Timeout, "timeout");
      },
    });
    session.handleFrame({
      opcode: HostTunnelOpcode.Open,
      streamId: 5,
      host: "slow.internal",
      port: 81,
    });
    await waitFor(() => frames.length > 0);
    expect(frames).toEqual([
      {
        opcode: HostTunnelOpcode.OpenResult,
        streamId: 5,
        ok: false,
        errorCode: HostTunnelErrorCode.Timeout,
      },
    ]);
  });

  it("maps target failures without deleting the session capability", async () => {
    const { session, frames } = createSession({
      connectImpl: async () => {
        throw new HostTcpConnectError(HostTunnelErrorCode.Refused, "refused");
      },
    });
    session.handleFrame({
      opcode: HostTunnelOpcode.Open,
      streamId: 4,
      host: "missing.local",
      port: 22,
    });
    await waitFor(() => frames.length > 0);
    expect(frames).toEqual([
      {
        opcode: HostTunnelOpcode.OpenResult,
        streamId: 4,
        ok: false,
        errorCode: HostTunnelErrorCode.Refused,
      },
    ]);
  });

  it("rejects new streams at the provisional limit", async () => {
    const sockets = new Map<number, FakeSocket>();
    const { session, frames } = createSession({
      connectImpl: async () => {
        const socket = new FakeSocket();
        sockets.set(sockets.size + 1, socket);
        return socket;
      },
    });

    for (let streamId = 1; streamId <= HOST_TUNNEL_LIMITS.MAX_STREAMS_PER_SESSION; streamId += 1) {
      session.handleFrame({
        opcode: HostTunnelOpcode.Open,
        streamId,
        host: "localhost",
        port: 80,
      });
    }
    await waitFor(
      () => countSuccessfulOpens(frames) === HOST_TUNNEL_LIMITS.MAX_STREAMS_PER_SESSION,
    );
    session.handleFrame({
      opcode: HostTunnelOpcode.Open,
      streamId: HOST_TUNNEL_LIMITS.MAX_STREAMS_PER_SESSION + 1,
      host: "localhost",
      port: 80,
    });
    await waitFor(() => hasOpenResult(frames, HOST_TUNNEL_LIMITS.MAX_STREAMS_PER_SESSION + 1));

    expect(
      frames.filter(
        (frame) =>
          frame.opcode === HostTunnelOpcode.OpenResult &&
          frame.streamId === HOST_TUNNEL_LIMITS.MAX_STREAMS_PER_SESSION + 1,
      ),
    ).toEqual([
      {
        opcode: HostTunnelOpcode.OpenResult,
        streamId: HOST_TUNNEL_LIMITS.MAX_STREAMS_PER_SESSION + 1,
        ok: false,
        errorCode: HostTunnelErrorCode.Limit,
      },
    ]);
  });

  it("ignores frames when the client lacks hostTunnelStreams", async () => {
    let connected = false;
    const { session, frames } = createSession({
      supports: false,
      connectImpl: async () => {
        connected = true;
        return new FakeSocket();
      },
    });
    session.handleFrame({
      opcode: HostTunnelOpcode.Open,
      streamId: 1,
      host: "localhost",
      port: 80,
    });
    await Promise.resolve();
    expect(connected).toBe(false);
    expect(frames).toEqual([]);
  });

  it("omits targets from normal logs and includes them only in network-debug", async () => {
    const quiet = createSession({
      connectImpl: async () => {
        throw new HostTcpConnectError(HostTunnelErrorCode.Dns, "dns");
      },
    });
    quiet.session.handleFrame({
      opcode: HostTunnelOpcode.Open,
      streamId: 8,
      host: "secret.internal",
      port: 443,
    });
    await waitFor(() => hasLogError(quiet.logs, "dns"));
    expect(findLogError(quiet.logs, "dns")?.fields.targetHost).toBeUndefined();

    const debug = createSession({
      networkDebug: true,
      connectImpl: async () => {
        throw new HostTcpConnectError(HostTunnelErrorCode.Dns, "dns");
      },
    });
    debug.session.handleFrame({
      opcode: HostTunnelOpcode.Open,
      streamId: 8,
      host: "secret.internal",
      port: 443,
    });
    await waitFor(() => hasLogTarget(debug.logs, "secret.internal"));
    expect(debug.logs[0]?.msg).toMatch(/private-network/);
    expect(debug.logs.some((entry) => entry.fields.targetHost === "secret.internal")).toBe(true);
  });
});

function countSuccessfulOpens(
  frames: NonNullable<ReturnType<typeof decodeHostTunnelFrame>>[],
): number {
  return frames.filter((frame) => frame.opcode === HostTunnelOpcode.OpenResult && frame.ok).length;
}

function hasOpenResult(
  frames: NonNullable<ReturnType<typeof decodeHostTunnelFrame>>[],
  streamId: number,
): boolean {
  return frames.some(
    (frame) => frame.opcode === HostTunnelOpcode.OpenResult && frame.streamId === streamId,
  );
}

function hasLogError(
  logs: Array<{ msg: string; fields: Record<string, unknown> }>,
  error: string,
): boolean {
  return logs.some((entry) => entry.fields.error === error);
}

function findLogError(
  logs: Array<{ msg: string; fields: Record<string, unknown> }>,
  error: string,
): { msg: string; fields: Record<string, unknown> } | undefined {
  return logs.find((entry) => entry.fields.error === error);
}

function hasLogTarget(
  logs: Array<{ msg: string; fields: Record<string, unknown> }>,
  targetHost: string,
): boolean {
  return logs.some((entry) => entry.fields.targetHost === targetHost);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(0);
  }
  throw new Error("Timed out waiting for host tunnel session update");
}
