import { describe, expect, it } from "vitest";

import {
  decodeBinaryFrame,
  encodeFileTransferFrame,
  encodeHostTunnelFrame,
  encodeTerminalStreamFrame,
  FileTransferOpcode,
  HostTunnelOpcode,
  TerminalStreamOpcode,
} from "./index.js";

describe("binary frame demux", () => {
  it("routes terminal frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          slot: 7,
          payload: "ls",
        }),
      ),
    ).toEqual({
      kind: "terminal",
      frame: {
        opcode: TerminalStreamOpcode.Input,
        slot: 7,
        payload: new TextEncoder().encode("ls"),
      },
    });
  });

  it("routes file-transfer frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileChunk,
          requestId: "req-upload",
          payload: new TextEncoder().encode("hello"),
        }),
      ),
    ).toEqual({
      kind: "file_transfer",
      frame: {
        opcode: FileTransferOpcode.FileChunk,
        requestId: "req-upload",
        payload: new TextEncoder().encode("hello"),
      },
    });
  });

  it("routes host-tunnel frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeHostTunnelFrame({
          opcode: HostTunnelOpcode.Open,
          streamId: 11,
          host: "127.0.0.1",
          port: 8080,
        }),
      ),
    ).toEqual({
      kind: "host_tunnel",
      frame: {
        opcode: HostTunnelOpcode.Open,
        streamId: 11,
        host: "127.0.0.1",
        port: 8080,
      },
    });
  });

  it("rejects unknown binary opcodes", () => {
    expect(decodeBinaryFrame(new Uint8Array([0xff, 0]))).toBeNull();
  });
});
