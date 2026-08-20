import type pino from "pino";
import {
  HOST_TUNNEL_LIMITS,
  HostTunnelErrorCode,
  HostTunnelFlow,
  HostTunnelOpcode,
  encodeHostTunnelFrame,
  hostTunnelErrorCategory,
  type HostTunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  classifyHostTcpError,
  connectHostTcp,
  type HostTcpConnect,
  type HostTcpSocket,
} from "./host-tcp.js";

export interface HostTunnelSessionHost {
  emitBinary(frame: Uint8Array): void;
  supportsHostTunnelStreams(): boolean;
}

export interface HostTunnelSessionOptions {
  host: HostTunnelSessionHost;
  logger: pino.Logger;
  connect?: HostTcpConnect;
  now?: () => number;
  networkDebug?: boolean;
}

interface OpenStream {
  streamId: number;
  socket: HostTcpSocket;
  openedAt: number;
  bytesIn: number;
  bytesOut: number;
  localWriteClosed: boolean;
  remoteReadClosed: boolean;
  waitingForDrain: boolean;
  pendingWindowUpdate: number;
}

export class HostTunnelSession {
  private readonly host: HostTunnelSessionHost;
  private readonly logger: pino.Logger;
  private readonly connect: HostTcpConnect;
  private readonly now: () => number;
  private readonly networkDebug: boolean;
  private readonly flow = new HostTunnelFlow();
  private readonly streams = new Map<number, OpenStream>();
  private readonly opening = new Set<number>();
  private closed = false;

  constructor(options: HostTunnelSessionOptions) {
    this.host = options.host;
    this.logger = options.logger;
    this.connect = options.connect ?? connectHostTcp;
    this.now = options.now ?? Date.now;
    this.networkDebug = options.networkDebug === true;
    if (this.networkDebug) {
      this.logger.warn(
        { feature: "host_tunnel" },
        "Network-debug logging enabled; logs may include private-network or browsing data",
      );
    }
  }

  handleFrame(frame: HostTunnelFrame): void {
    if (this.closed || !this.host.supportsHostTunnelStreams()) {
      return;
    }
    if (frame.opcode === HostTunnelOpcode.Open) {
      void this.handleOpen(frame.streamId, frame.host, frame.port);
      return;
    }
    if (frame.opcode === HostTunnelOpcode.Data) {
      this.handleData(frame.streamId, frame.payload);
      return;
    }
    if (frame.opcode === HostTunnelOpcode.HalfClose) {
      this.handleHalfClose(frame.streamId);
      return;
    }
    if (frame.opcode === HostTunnelOpcode.Reset) {
      this.resetStream(frame.streamId, frame.errorCode, false);
      return;
    }
    if (frame.opcode === HostTunnelOpcode.WindowUpdate) {
      this.flow.applySendWindowUpdate(frame.streamId, frame.credit);
      this.flushOutbound();
      const stream = this.streams.get(frame.streamId);
      if (stream && !this.flow.isReaderPaused(frame.streamId)) {
        stream.socket.resume();
      }
    }
  }

  dispose(): void {
    this.closed = true;
    for (const streamId of this.streams.keys()) {
      this.resetStream(streamId, HostTunnelErrorCode.Reset, false);
    }
    this.opening.clear();
  }

  private async handleOpen(streamId: number, host: string, port: number): Promise<void> {
    if (this.streams.has(streamId) || this.opening.has(streamId)) {
      this.sendReset(streamId, HostTunnelErrorCode.Internal);
      return;
    }
    const accepted = this.flow.openStream(streamId);
    if (!accepted.ok) {
      this.sendOpenResult(streamId, false, HostTunnelErrorCode.Limit);
      this.logLifecycle(streamId, "open_rejected", { error: "limit" });
      return;
    }
    this.opening.add(streamId);
    const startedAt = this.now();
    try {
      const socket = await this.connect({
        host,
        port,
        timeoutMs: HOST_TUNNEL_LIMITS.TARGET_CONNECT_TIMEOUT_MS,
      });
      if (this.closed || !this.opening.has(streamId)) {
        socket.destroy();
        this.flow.closeStream(streamId);
        return;
      }
      this.opening.delete(streamId);
      const stream: OpenStream = {
        streamId,
        socket,
        openedAt: startedAt,
        bytesIn: 0,
        bytesOut: 0,
        localWriteClosed: false,
        remoteReadClosed: false,
        waitingForDrain: false,
        pendingWindowUpdate: 0,
      };
      this.streams.set(streamId, stream);
      this.bindSocket(stream);
      this.sendOpenResult(streamId, true, HostTunnelErrorCode.Ok);
      this.logLifecycle(streamId, "open", {
        durationMs: this.now() - startedAt,
        ...(this.networkDebug ? { targetHost: host, targetPort: port } : {}),
      });
    } catch (error) {
      this.opening.delete(streamId);
      this.flow.closeStream(streamId);
      const errorCode = classifyHostTcpError(error);
      this.sendOpenResult(streamId, false, errorCode);
      this.logLifecycle(streamId, "open_failed", {
        error: hostTunnelErrorCategory(errorCode),
        durationMs: this.now() - startedAt,
        ...(this.networkDebug ? { targetHost: host, targetPort: port } : {}),
      });
    }
  }

  private bindSocket(stream: OpenStream): void {
    stream.socket.on("data", (data) => {
      stream.bytesOut += data.byteLength;
      const enqueued = this.flow.enqueueOutbound(stream.streamId, data);
      if (enqueued.paused) {
        stream.socket.pause();
      }
      this.flushOutbound();
    });
    stream.socket.on("end", () => {
      stream.remoteReadClosed = true;
      this.sendFrame({
        opcode: HostTunnelOpcode.HalfClose,
        streamId: stream.streamId,
      });
      this.maybeClose(stream);
    });
    stream.socket.on("error", (error) => {
      this.resetStream(stream.streamId, classifyHostTcpError(error), true);
    });
    stream.socket.on("close", () => {
      if (this.streams.has(stream.streamId)) {
        this.resetStream(stream.streamId, HostTunnelErrorCode.Reset, true);
      }
    });
    stream.socket.on("drain", () => {
      stream.waitingForDrain = false;
      this.flushInboundWindow(stream);
    });
  }

  private handleData(streamId: number, payload: Uint8Array): void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.localWriteClosed) {
      return;
    }
    stream.bytesIn += payload.byteLength;
    const wrote = stream.socket.write(payload);
    this.flow.recordInbound(streamId, payload.byteLength);
    if (!wrote) {
      stream.waitingForDrain = true;
      stream.pendingWindowUpdate += payload.byteLength;
      return;
    }
    this.flushInboundWindow(stream);
  }

  private handleHalfClose(streamId: number): void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.localWriteClosed) {
      return;
    }
    stream.localWriteClosed = true;
    stream.socket.end();
    this.maybeClose(stream);
  }

  private resetStream(
    streamId: number,
    errorCode: HostTunnelErrorCode,
    notifyClient: boolean,
  ): void {
    const stream = this.streams.get(streamId);
    this.opening.delete(streamId);
    this.flow.closeStream(streamId);
    if (!stream) {
      if (notifyClient) {
        this.sendReset(streamId, errorCode);
      }
      return;
    }
    this.streams.delete(streamId);
    stream.socket.destroy();
    if (notifyClient) {
      this.sendReset(streamId, errorCode);
    }
    this.logLifecycle(streamId, "close", {
      error: hostTunnelErrorCategory(errorCode),
      bytesIn: stream.bytesIn,
      bytesOut: stream.bytesOut,
      durationMs: this.now() - stream.openedAt,
    });
  }

  private maybeClose(stream: OpenStream): void {
    if (stream.localWriteClosed && stream.remoteReadClosed) {
      this.streams.delete(stream.streamId);
      this.flow.closeStream(stream.streamId);
      this.logLifecycle(stream.streamId, "close", {
        error: "ok",
        bytesIn: stream.bytesIn,
        bytesOut: stream.bytesOut,
        durationMs: this.now() - stream.openedAt,
      });
    }
  }

  private flushOutbound(): void {
    for (const frame of this.flow.takeOutboundData()) {
      this.sendFrame({
        opcode: HostTunnelOpcode.Data,
        streamId: frame.streamId,
        payload: frame.payload,
      });
    }
  }

  private flushInboundWindow(stream: OpenStream): void {
    if (stream.waitingForDrain) {
      return;
    }
    const credit = this.flow.consumeInbound(stream.streamId);
    if (credit <= 0) {
      return;
    }
    this.sendFrame({
      opcode: HostTunnelOpcode.WindowUpdate,
      streamId: stream.streamId,
      credit,
    });
  }

  private sendOpenResult(streamId: number, ok: boolean, errorCode: HostTunnelErrorCode): void {
    this.sendFrame({
      opcode: HostTunnelOpcode.OpenResult,
      streamId,
      ok,
      errorCode,
    });
  }

  private sendReset(streamId: number, errorCode: HostTunnelErrorCode): void {
    this.sendFrame({
      opcode: HostTunnelOpcode.Reset,
      streamId,
      errorCode,
    });
  }

  private sendFrame(frame: Parameters<typeof encodeHostTunnelFrame>[0]): void {
    if (!this.host.supportsHostTunnelStreams()) {
      return;
    }
    this.host.emitBinary(encodeHostTunnelFrame(frame));
  }

  private logLifecycle(
    streamId: number,
    event: "open" | "open_failed" | "open_rejected" | "close",
    fields: Record<string, unknown>,
  ): void {
    this.logger.info(
      {
        feature: "host_tunnel",
        streamId,
        event,
        ...fields,
      },
      "Host tunnel stream",
    );
  }
}
