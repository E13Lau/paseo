import { describe, expect, it } from "vitest";

import {
  FileTransferOpcode,
  TerminalStreamOpcode,
  decodeFileTransferFrame,
  decodeTerminalStreamFrame,
} from "./index.js";
import { HOST_TUNNEL_LIMITS } from "./host-tunnel-limits.js";
import {
  HostTunnelErrorCode,
  HostTunnelOpcode,
  decodeHostTunnelFrame,
  encodeHostTunnelFrame,
  hostTunnelErrorCategory,
} from "./host-tunnel.js";

describe("host tunnel binary frames", () => {
  it("uses opcodes outside the terminal and file-transfer ranges", () => {
    const opcodes = Object.values(HostTunnelOpcode);
    for (const opcode of opcodes) {
      expect(Object.values(TerminalStreamOpcode)).not.toContain(opcode);
      expect(Object.values(FileTransferOpcode)).not.toContain(opcode);
    }
  });

  it("encodes Open as opcode, stream id, port, and utf8 host without JSON", () => {
    const encoded = encodeHostTunnelFrame({
      opcode: HostTunnelOpcode.Open,
      streamId: 7,
      host: "localhost",
      port: 8080,
    });
    const host = new TextEncoder().encode("localhost");

    expect(decodeTerminalStreamFrame(encoded)).toBeNull();
    expect(decodeFileTransferFrame(encoded)).toBeNull();
    expect(encoded[0]).toBe(HostTunnelOpcode.Open);
    expect(new DataView(encoded.buffer, encoded.byteOffset).getUint32(1)).toBe(7);
    expect(new DataView(encoded.buffer, encoded.byteOffset).getUint16(5)).toBe(8080);
    expect(new DataView(encoded.buffer, encoded.byteOffset).getUint16(7)).toBe(host.byteLength);
    expect(encoded.subarray(9)).toEqual(host);
    expect(new TextDecoder().decode(encoded.subarray(9))).toBe("localhost");
    expect(new TextDecoder().decode(encoded).includes('"host"')).toBe(false);

    expect(decodeHostTunnelFrame(encoded)).toEqual({
      opcode: HostTunnelOpcode.Open,
      streamId: 7,
      host: "localhost",
      port: 8080,
    });
  });

  it("encodes IPv6 Open hosts as raw utf8", () => {
    const encoded = encodeHostTunnelFrame({
      opcode: HostTunnelOpcode.Open,
      streamId: 1,
      host: "2001:db8::1",
      port: 443,
    });
    expect(decodeHostTunnelFrame(encoded)).toEqual({
      opcode: HostTunnelOpcode.Open,
      streamId: 1,
      host: "2001:db8::1",
      port: 443,
    });
  });

  it("encodes OpenResult, Data, HalfClose, Reset, and WindowUpdate", () => {
    const payload = new TextEncoder().encode("hello");
    expect(
      decodeHostTunnelFrame(
        encodeHostTunnelFrame({
          opcode: HostTunnelOpcode.OpenResult,
          streamId: 3,
          ok: true,
        }),
      ),
    ).toEqual({
      opcode: HostTunnelOpcode.OpenResult,
      streamId: 3,
      ok: true,
      errorCode: HostTunnelErrorCode.Ok,
    });
    expect(
      decodeHostTunnelFrame(
        encodeHostTunnelFrame({
          opcode: HostTunnelOpcode.OpenResult,
          streamId: 3,
          ok: false,
          errorCode: HostTunnelErrorCode.Timeout,
        }),
      ),
    ).toEqual({
      opcode: HostTunnelOpcode.OpenResult,
      streamId: 3,
      ok: false,
      errorCode: HostTunnelErrorCode.Timeout,
    });
    expect(
      decodeHostTunnelFrame(
        encodeHostTunnelFrame({
          opcode: HostTunnelOpcode.Data,
          streamId: 3,
          payload,
        }),
      ),
    ).toEqual({
      opcode: HostTunnelOpcode.Data,
      streamId: 3,
      payload,
    });
    expect(
      decodeHostTunnelFrame(
        encodeHostTunnelFrame({
          opcode: HostTunnelOpcode.HalfClose,
          streamId: 3,
        }),
      ),
    ).toEqual({
      opcode: HostTunnelOpcode.HalfClose,
      streamId: 3,
    });
    expect(
      decodeHostTunnelFrame(
        encodeHostTunnelFrame({
          opcode: HostTunnelOpcode.Reset,
          streamId: 3,
          errorCode: HostTunnelErrorCode.Refused,
        }),
      ),
    ).toEqual({
      opcode: HostTunnelOpcode.Reset,
      streamId: 3,
      errorCode: HostTunnelErrorCode.Refused,
    });
    expect(
      decodeHostTunnelFrame(
        encodeHostTunnelFrame({
          opcode: HostTunnelOpcode.WindowUpdate,
          streamId: 3,
          credit: 4096,
        }),
      ),
    ).toEqual({
      opcode: HostTunnelOpcode.WindowUpdate,
      streamId: 3,
      credit: 4096,
    });
  });

  it("rejects oversized Data frames and unknown opcodes", () => {
    const oversized = new Uint8Array(HOST_TUNNEL_LIMITS.MAX_DATA_FRAME_BYTES + 1);
    expect(() =>
      encodeHostTunnelFrame({
        opcode: HostTunnelOpcode.Data,
        streamId: 1,
        payload: oversized,
      }),
    ).toThrow(/HOST_TUNNEL_MAX_DATA_FRAME_BYTES/);

    const encoded = encodeHostTunnelFrame({
      opcode: HostTunnelOpcode.Data,
      streamId: 1,
      payload: new Uint8Array(4),
    });
    encoded[0] = 0xff;
    expect(decodeHostTunnelFrame(encoded)).toBeNull();
  });

  it("maps error codes to log categories without targets", () => {
    expect(hostTunnelErrorCategory(HostTunnelErrorCode.Dns)).toBe("dns");
    expect(hostTunnelErrorCategory(HostTunnelErrorCode.Timeout)).toBe("timeout");
    expect(hostTunnelErrorCategory(HostTunnelErrorCode.Limit)).toBe("limit");
  });
});
