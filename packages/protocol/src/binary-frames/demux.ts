import {
  decodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "./file-transfer.js";
import { decodeHostTunnelFrame, HostTunnelOpcode, type HostTunnelFrame } from "./host-tunnel.js";
import {
  decodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from "./terminal.js";

export type BinaryFrame =
  | { kind: "terminal"; frame: TerminalStreamFrame }
  | { kind: "file_transfer"; frame: FileTransferFrame }
  | { kind: "host_tunnel"; frame: HostTunnelFrame };

export function decodeBinaryFrame(bytes: Uint8Array): BinaryFrame | null {
  switch (bytes[0]) {
    case TerminalStreamOpcode.Output:
    case TerminalStreamOpcode.Input:
    case TerminalStreamOpcode.Resize:
    case TerminalStreamOpcode.Snapshot:
    case TerminalStreamOpcode.Restore: {
      const frame = decodeTerminalStreamFrame(bytes);
      return frame ? { kind: "terminal", frame } : null;
    }
    case FileTransferOpcode.FileBegin:
    case FileTransferOpcode.FileChunk:
    case FileTransferOpcode.FileEnd: {
      const frame = decodeFileTransferFrame(bytes);
      return frame ? { kind: "file_transfer", frame } : null;
    }
    case HostTunnelOpcode.Open:
    case HostTunnelOpcode.OpenResult:
    case HostTunnelOpcode.Data:
    case HostTunnelOpcode.HalfClose:
    case HostTunnelOpcode.Reset:
    case HostTunnelOpcode.WindowUpdate: {
      const frame = decodeHostTunnelFrame(bytes);
      return frame ? { kind: "host_tunnel", frame } : null;
    }
    default:
      return null;
  }
}
