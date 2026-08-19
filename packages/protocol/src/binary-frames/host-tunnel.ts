import { asUint8Array } from "./terminal.js";
import { HOST_TUNNEL_LIMITS } from "./host-tunnel-limits.js";

export const HostTunnelOpcode = {
  Open: 0x20,
  OpenResult: 0x21,
  Data: 0x22,
  HalfClose: 0x23,
  Reset: 0x24,
  WindowUpdate: 0x25,
} as const;

export type HostTunnelOpcode = (typeof HostTunnelOpcode)[keyof typeof HostTunnelOpcode];

export const HostTunnelErrorCode = {
  Ok: 0,
  Timeout: 1,
  Dns: 2,
  Refused: 3,
  Unreachable: 4,
  Limit: 5,
  Reset: 6,
  Internal: 7,
} as const;

export type HostTunnelErrorCode = (typeof HostTunnelErrorCode)[keyof typeof HostTunnelErrorCode];

export const HOST_TUNNEL_ERROR_CATEGORIES = {
  [HostTunnelErrorCode.Ok]: "ok",
  [HostTunnelErrorCode.Timeout]: "timeout",
  [HostTunnelErrorCode.Dns]: "dns",
  [HostTunnelErrorCode.Refused]: "refused",
  [HostTunnelErrorCode.Unreachable]: "unreachable",
  [HostTunnelErrorCode.Limit]: "limit",
  [HostTunnelErrorCode.Reset]: "reset",
  [HostTunnelErrorCode.Internal]: "internal",
} as const;

export type HostTunnelErrorCategory = (typeof HOST_TUNNEL_ERROR_CATEGORIES)[HostTunnelErrorCode];

export interface HostTunnelOpenFrame {
  opcode: typeof HostTunnelOpcode.Open;
  streamId: number;
  host: string;
  port: number;
}

export interface HostTunnelOpenResultFrame {
  opcode: typeof HostTunnelOpcode.OpenResult;
  streamId: number;
  ok: boolean;
  errorCode: HostTunnelErrorCode;
}

export interface HostTunnelDataFrame {
  opcode: typeof HostTunnelOpcode.Data;
  streamId: number;
  payload: Uint8Array;
}

export interface HostTunnelHalfCloseFrame {
  opcode: typeof HostTunnelOpcode.HalfClose;
  streamId: number;
}

export interface HostTunnelResetFrame {
  opcode: typeof HostTunnelOpcode.Reset;
  streamId: number;
  errorCode: HostTunnelErrorCode;
}

export interface HostTunnelWindowUpdateFrame {
  opcode: typeof HostTunnelOpcode.WindowUpdate;
  streamId: number;
  credit: number;
}

export type HostTunnelFrame =
  | HostTunnelOpenFrame
  | HostTunnelOpenResultFrame
  | HostTunnelDataFrame
  | HostTunnelHalfCloseFrame
  | HostTunnelResetFrame
  | HostTunnelWindowUpdateFrame;

export type HostTunnelFrameInput =
  | {
      opcode: typeof HostTunnelOpcode.Open;
      streamId: number;
      host: string;
      port: number;
    }
  | {
      opcode: typeof HostTunnelOpcode.OpenResult;
      streamId: number;
      ok: boolean;
      errorCode?: HostTunnelErrorCode;
    }
  | {
      opcode: typeof HostTunnelOpcode.Data;
      streamId: number;
      payload?: Uint8Array | ArrayBuffer | string;
    }
  | {
      opcode: typeof HostTunnelOpcode.HalfClose;
      streamId: number;
    }
  | {
      opcode: typeof HostTunnelOpcode.Reset;
      streamId: number;
      errorCode?: HostTunnelErrorCode;
    }
  | {
      opcode: typeof HostTunnelOpcode.WindowUpdate;
      streamId: number;
      credit: number;
    };

const HEADER_BYTES = 5;

function isHostTunnelOpcode(value: number): value is HostTunnelOpcode {
  return (
    value === HostTunnelOpcode.Open ||
    value === HostTunnelOpcode.OpenResult ||
    value === HostTunnelOpcode.Data ||
    value === HostTunnelOpcode.HalfClose ||
    value === HostTunnelOpcode.Reset ||
    value === HostTunnelOpcode.WindowUpdate
  );
}

function isHostTunnelErrorCode(value: number): value is HostTunnelErrorCode {
  return (
    value === HostTunnelErrorCode.Ok ||
    value === HostTunnelErrorCode.Timeout ||
    value === HostTunnelErrorCode.Dns ||
    value === HostTunnelErrorCode.Refused ||
    value === HostTunnelErrorCode.Unreachable ||
    value === HostTunnelErrorCode.Limit ||
    value === HostTunnelErrorCode.Reset ||
    value === HostTunnelErrorCode.Internal
  );
}

function assertStreamId(streamId: number): void {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new RangeError("Host tunnel streamId must fit in a uint32");
  }
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("Host tunnel port must be between 1 and 65535");
  }
}

function writeHeader(bytes: Uint8Array, opcode: HostTunnelOpcode, streamId: number): DataView {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes[0] = opcode;
  view.setUint32(1, streamId);
  return view;
}

function readHeader(bytes: Uint8Array): { opcode: HostTunnelOpcode; streamId: number } | null {
  if (bytes.byteLength < HEADER_BYTES) {
    return null;
  }
  const opcode = bytes[0];
  if (!isHostTunnelOpcode(opcode)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { opcode, streamId: view.getUint32(1) };
}

export function encodeHostTunnelFrame(input: HostTunnelFrameInput): Uint8Array {
  assertStreamId(input.streamId);

  if (input.opcode === HostTunnelOpcode.Open) {
    assertPort(input.port);
    const host = new TextEncoder().encode(input.host);
    if (host.byteLength === 0) {
      throw new RangeError("Host tunnel Open host is required");
    }
    if (host.byteLength > 0xffff) {
      throw new RangeError("Host tunnel Open host is too long");
    }
    const bytes = new Uint8Array(HEADER_BYTES + 4 + host.byteLength);
    const view = writeHeader(bytes, input.opcode, input.streamId);
    view.setUint16(HEADER_BYTES, input.port);
    view.setUint16(HEADER_BYTES + 2, host.byteLength);
    bytes.set(host, HEADER_BYTES + 4);
    return bytes;
  }

  if (input.opcode === HostTunnelOpcode.OpenResult) {
    const bytes = new Uint8Array(HEADER_BYTES + 2);
    writeHeader(bytes, input.opcode, input.streamId);
    bytes[HEADER_BYTES] = input.ok ? 0 : 1;
    bytes[HEADER_BYTES + 1] = input.ok
      ? HostTunnelErrorCode.Ok
      : (input.errorCode ?? HostTunnelErrorCode.Internal);
    return bytes;
  }

  if (input.opcode === HostTunnelOpcode.Data) {
    const payload = asUint8Array(input.payload ?? new Uint8Array()) ?? new Uint8Array();
    if (payload.byteLength > HOST_TUNNEL_LIMITS.MAX_DATA_FRAME_BYTES) {
      throw new RangeError("Host tunnel Data payload exceeds HOST_TUNNEL_MAX_DATA_FRAME_BYTES");
    }
    const bytes = new Uint8Array(HEADER_BYTES + payload.byteLength);
    writeHeader(bytes, input.opcode, input.streamId);
    bytes.set(payload, HEADER_BYTES);
    return bytes;
  }

  if (input.opcode === HostTunnelOpcode.HalfClose) {
    const bytes = new Uint8Array(HEADER_BYTES);
    writeHeader(bytes, input.opcode, input.streamId);
    return bytes;
  }

  if (input.opcode === HostTunnelOpcode.Reset) {
    const bytes = new Uint8Array(HEADER_BYTES + 1);
    writeHeader(bytes, input.opcode, input.streamId);
    bytes[HEADER_BYTES] = input.errorCode ?? HostTunnelErrorCode.Reset;
    return bytes;
  }

  const credit = input.credit;
  if (!Number.isInteger(credit) || credit < 0 || credit > 0xffffffff) {
    throw new RangeError("Host tunnel WindowUpdate credit must fit in a uint32");
  }
  const bytes = new Uint8Array(HEADER_BYTES + 4);
  const view = writeHeader(bytes, input.opcode, input.streamId);
  view.setUint32(HEADER_BYTES, credit);
  return bytes;
}

export function decodeHostTunnelFrame(bytes: Uint8Array): HostTunnelFrame | null {
  const header = readHeader(bytes);
  if (!header) {
    return null;
  }
  const { opcode, streamId } = header;
  const body = bytes.subarray(HEADER_BYTES);

  if (opcode === HostTunnelOpcode.Open) {
    if (body.byteLength < 4) {
      return null;
    }
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const port = view.getUint16(0);
    const hostLength = view.getUint16(2);
    if (hostLength === 0 || hostLength !== body.byteLength - 4) {
      return null;
    }
    if (port < 1) {
      return null;
    }
    const host = new TextDecoder().decode(body.subarray(4));
    if (host.length === 0) {
      return null;
    }
    return { opcode, streamId, host, port };
  }

  if (opcode === HostTunnelOpcode.OpenResult) {
    if (body.byteLength !== 2) {
      return null;
    }
    const errorCode = body[1];
    if (!isHostTunnelErrorCode(errorCode)) {
      return null;
    }
    const ok = body[0] === 0;
    return { opcode, streamId, ok, errorCode: ok ? HostTunnelErrorCode.Ok : errorCode };
  }

  if (opcode === HostTunnelOpcode.Data) {
    if (body.byteLength > HOST_TUNNEL_LIMITS.MAX_DATA_FRAME_BYTES) {
      return null;
    }
    return { opcode, streamId, payload: body };
  }

  if (opcode === HostTunnelOpcode.HalfClose) {
    if (body.byteLength !== 0) {
      return null;
    }
    return { opcode, streamId };
  }

  if (opcode === HostTunnelOpcode.Reset) {
    if (body.byteLength !== 1) {
      return null;
    }
    const errorCode = body[0];
    if (!isHostTunnelErrorCode(errorCode)) {
      return null;
    }
    return { opcode, streamId, errorCode };
  }

  if (body.byteLength !== 4) {
    return null;
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return { opcode, streamId, credit: view.getUint32(0) };
}

export function hostTunnelErrorCategory(code: HostTunnelErrorCode): HostTunnelErrorCategory {
  return HOST_TUNNEL_ERROR_CATEGORIES[code];
}
