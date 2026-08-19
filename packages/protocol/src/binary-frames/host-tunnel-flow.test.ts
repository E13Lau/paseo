import { describe, expect, it } from "vitest";

import { HostTunnelFlow } from "./host-tunnel-flow.js";
import { HOST_TUNNEL_LIMITS } from "./host-tunnel-limits.js";

describe("host tunnel flow control", () => {
  it("rejects new streams at the provisional session stream limit", () => {
    const flow = new HostTunnelFlow({
      ...HOST_TUNNEL_LIMITS,
      MAX_STREAMS_PER_SESSION: 2,
    });

    expect(flow.openStream(1)).toEqual({ ok: true });
    expect(flow.openStream(2)).toEqual({ ok: true });
    expect(flow.openStream(3)).toEqual({ ok: false, reason: "limit" });
    expect(flow.snapshot().streamCount).toBe(2);

    flow.closeStream(1);
    expect(flow.openStream(3)).toEqual({ ok: true });
  });

  it("pauses only the affected reader when the session queue is full", () => {
    const flow = new HostTunnelFlow({
      ...HOST_TUNNEL_LIMITS,
      MAX_SESSION_QUEUED_BYTES: 8,
      MAX_DATA_FRAME_BYTES: 4,
      INITIAL_STREAM_WINDOW_BYTES: 8,
    });
    expect(flow.openStream(1)).toEqual({ ok: true });
    expect(flow.openStream(2)).toEqual({ ok: true });

    expect(flow.enqueueOutbound(1, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toEqual({
      accepted: 8,
      paused: true,
    });
    expect(flow.enqueueOutbound(2, new Uint8Array([10, 11]))).toEqual({
      accepted: 0,
      paused: true,
    });
    expect(flow.openStream(3)).toEqual({ ok: false, reason: "limit" });
    expect(flow.snapshot()).toEqual({
      streamCount: 2,
      sessionQueuedBytes: 8,
      streams: [
        { streamId: 1, sendWindow: 8, queuedBytes: 8, paused: true },
        { streamId: 2, sendWindow: 8, queuedBytes: 0, paused: true },
      ],
    });
  });

  it("schedules data fairly and respects per-stream send windows", () => {
    const flow = new HostTunnelFlow({
      ...HOST_TUNNEL_LIMITS,
      MAX_DATA_FRAME_BYTES: 2,
      INITIAL_STREAM_WINDOW_BYTES: 4,
    });
    flow.openStream(1);
    flow.openStream(2);
    flow.enqueueOutbound(1, new Uint8Array([1, 1, 1, 1]));
    flow.enqueueOutbound(2, new Uint8Array([2, 2, 2, 2]));

    expect(flow.takeOutboundData(4)).toEqual([
      { streamId: 1, payload: new Uint8Array([1, 1]) },
      { streamId: 2, payload: new Uint8Array([2, 2]) },
      { streamId: 1, payload: new Uint8Array([1, 1]) },
      { streamId: 2, payload: new Uint8Array([2, 2]) },
    ]);
    expect(flow.takeOutboundData()).toEqual([]);

    flow.applySendWindowUpdate(1, 2);
    flow.enqueueOutbound(1, new Uint8Array([3, 3]));
    expect(flow.takeOutboundData(1)).toEqual([{ streamId: 1, payload: new Uint8Array([3, 3]) }]);
  });

  it("returns inbound credit through WindowUpdate accounting", () => {
    const flow = new HostTunnelFlow();
    flow.openStream(9);
    expect(flow.recordInbound(9, 100)).toBe(100);
    expect(flow.recordInbound(9, 50)).toBe(150);
    expect(flow.consumeInbound(9)).toBe(150);
    expect(flow.consumeInbound(9)).toBe(0);
  });
});
