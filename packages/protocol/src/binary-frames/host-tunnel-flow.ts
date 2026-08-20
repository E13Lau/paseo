import { HOST_TUNNEL_LIMITS, type HostTunnelLimits } from "./host-tunnel-limits.js";

export interface HostTunnelStreamCredit {
  streamId: number;
  sendWindow: number;
  queuedBytes: number;
  paused: boolean;
}

export interface HostTunnelFlowSnapshot {
  streamCount: number;
  sessionQueuedBytes: number;
  streams: HostTunnelStreamCredit[];
}

interface StreamWindow {
  sendWindow: number;
  queued: Uint8Array[];
  queuedBytes: number;
  inboundUnacked: number;
}

export class HostTunnelFlow {
  private readonly limits: HostTunnelLimits;
  private readonly streams = new Map<number, StreamWindow>();
  private fairCursor = 0;

  constructor(limits: HostTunnelLimits = HOST_TUNNEL_LIMITS) {
    this.limits = limits;
  }

  get sessionQueuedBytes(): number {
    let total = 0;
    for (const stream of this.streams.values()) {
      total += stream.queuedBytes;
    }
    return total;
  }

  get streamCount(): number {
    return this.streams.size;
  }

  canAcceptStream(): boolean {
    return (
      this.streams.size < this.limits.MAX_STREAMS_PER_SESSION &&
      this.sessionQueuedBytes < this.limits.MAX_SESSION_QUEUED_BYTES
    );
  }

  openStream(streamId: number): { ok: true } | { ok: false; reason: "limit" | "duplicate" } {
    if (this.streams.has(streamId)) {
      return { ok: false, reason: "duplicate" };
    }
    if (!this.canAcceptStream()) {
      return { ok: false, reason: "limit" };
    }
    this.streams.set(streamId, {
      sendWindow: this.limits.INITIAL_STREAM_WINDOW_BYTES,
      queued: [],
      queuedBytes: 0,
      inboundUnacked: 0,
    });
    return { ok: true };
  }

  closeStream(streamId: number): void {
    this.streams.delete(streamId);
  }

  enqueueOutbound(streamId: number, data: Uint8Array): { accepted: number; paused: boolean } {
    const stream = this.streams.get(streamId);
    if (!stream || data.byteLength === 0) {
      return { accepted: 0, paused: false };
    }

    const sessionRoom = this.limits.MAX_SESSION_QUEUED_BYTES - this.sessionQueuedBytes;
    const accepted = Math.min(data.byteLength, Math.max(0, sessionRoom));
    if (accepted > 0) {
      stream.queued.push(data.subarray(0, accepted));
      stream.queuedBytes += accepted;
    }
    return {
      accepted,
      paused: accepted < data.byteLength,
    };
  }

  takeOutboundData(maxFrames = Number.POSITIVE_INFINITY): Array<{
    streamId: number;
    payload: Uint8Array;
  }> {
    const frames: Array<{ streamId: number; payload: Uint8Array }> = [];
    const eligible = [...this.streams.entries()].filter(
      ([, stream]) => stream.queuedBytes > 0 && stream.sendWindow > 0,
    );
    if (eligible.length === 0) {
      return frames;
    }

    let index = this.fairCursor % eligible.length;
    let idlePasses = 0;
    while (frames.length < maxFrames && idlePasses < eligible.length) {
      const [streamId, stream] = eligible[index];
      const budget = Math.min(
        this.limits.MAX_DATA_FRAME_BYTES,
        stream.sendWindow,
        stream.queuedBytes,
      );
      if (budget <= 0) {
        idlePasses += 1;
        index = (index + 1) % eligible.length;
        continue;
      }
      const payload = takeQueuedBytes(stream, budget);
      stream.sendWindow -= payload.byteLength;
      frames.push({ streamId, payload });
      idlePasses = 0;
      index = (index + 1) % eligible.length;
    }
    this.fairCursor = index;
    return frames;
  }

  applySendWindowUpdate(streamId: number, credit: number): void {
    const stream = this.streams.get(streamId);
    if (!stream || credit <= 0) {
      return;
    }
    stream.sendWindow = Math.min(stream.sendWindow + credit, this.limits.MAX_STREAM_WINDOW_BYTES);
  }

  recordInbound(streamId: number, byteLength: number): number {
    const stream = this.streams.get(streamId);
    if (!stream || byteLength <= 0) {
      return 0;
    }
    stream.inboundUnacked += byteLength;
    return stream.inboundUnacked;
  }

  consumeInbound(streamId: number): number {
    const stream = this.streams.get(streamId);
    if (!stream || stream.inboundUnacked <= 0) {
      return 0;
    }
    const credit = stream.inboundUnacked;
    stream.inboundUnacked = 0;
    return credit;
  }

  isReaderPaused(streamId: number): boolean {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return false;
    }
    return (
      stream.queuedBytes >= this.limits.MAX_SESSION_QUEUED_BYTES ||
      this.sessionQueuedBytes >= this.limits.MAX_SESSION_QUEUED_BYTES
    );
  }

  snapshot(): HostTunnelFlowSnapshot {
    return {
      streamCount: this.streams.size,
      sessionQueuedBytes: this.sessionQueuedBytes,
      streams: [...this.streams.entries()].map(([streamId, stream]) => ({
        streamId,
        sendWindow: stream.sendWindow,
        queuedBytes: stream.queuedBytes,
        paused: this.isReaderPaused(streamId),
      })),
    };
  }
}

function takeQueuedBytes(stream: StreamWindow, count: number): Uint8Array {
  const out = new Uint8Array(count);
  let offset = 0;
  while (offset < count && stream.queued.length > 0) {
    const next = stream.queued[0];
    const take = Math.min(next.byteLength, count - offset);
    out.set(next.subarray(0, take), offset);
    offset += take;
    if (take === next.byteLength) {
      stream.queued.shift();
    } else {
      stream.queued[0] = next.subarray(take);
    }
  }
  stream.queuedBytes -= count;
  return out;
}
