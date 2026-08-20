import net from "node:net";
import { HOST_TUNNEL_LIMITS, HostTunnelErrorCode } from "@getpaseo/protocol/binary-frames/index";

export interface HostTcpSocket {
  write(data: Uint8Array): boolean;
  end(): void;
  destroy(): void;
  pause(): void;
  resume(): void;
  on(event: "data", cb: (data: Uint8Array) => void): void;
  on(event: "end", cb: () => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "drain", cb: () => void): void;
}

export interface HostTcpConnectInput {
  host: string;
  port: number;
  timeoutMs: number;
}

export type HostTcpConnect = (input: HostTcpConnectInput) => Promise<HostTcpSocket>;

export class HostTcpConnectError extends Error {
  readonly errorCode: HostTunnelErrorCode;

  constructor(errorCode: HostTunnelErrorCode, message: string) {
    super(message);
    this.name = "HostTcpConnectError";
    this.errorCode = errorCode;
  }
}

export function classifyHostTcpError(error: unknown): HostTunnelErrorCode {
  if (error instanceof HostTcpConnectError) {
    return error.errorCode;
  }
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") {
    return HostTunnelErrorCode.Dns;
  }
  if (code === "ECONNREFUSED") {
    return HostTunnelErrorCode.Refused;
  }
  if (code === "ETIMEDOUT" || code === "ETIME") {
    return HostTunnelErrorCode.Timeout;
  }
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH") {
    return HostTunnelErrorCode.Unreachable;
  }
  return HostTunnelErrorCode.Internal;
}

export function connectHostTcp(
  input: HostTcpConnectInput,
  open: typeof net.connect = net.connect,
): Promise<HostTcpSocket> {
  const timeoutMs =
    input.timeoutMs > 0 ? input.timeoutMs : HOST_TUNNEL_LIMITS.TARGET_CONNECT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = open({ host: input.host, port: input.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new HostTcpConnectError(HostTunnelErrorCode.Timeout, "Host target connect timed out"));
    }, timeoutMs);
    timer.unref?.();

    const fail = (error: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      if (error instanceof HostTcpConnectError) {
        reject(error);
        return;
      }
      reject(new HostTcpConnectError(classifyHostTcpError(error), "Host target connect failed"));
    };

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(wrapNodeSocket(socket));
    });
    socket.once("error", fail);
  });
}

function wrapNodeSocket(socket: net.Socket): HostTcpSocket {
  return {
    write(data) {
      return socket.write(data);
    },
    end() {
      socket.end();
    },
    destroy() {
      socket.destroy();
    },
    pause() {
      socket.pause();
    },
    resume() {
      socket.resume();
    },
    on(event, cb) {
      if (event === "data") {
        socket.on("data", (chunk: Buffer) => {
          (cb as (data: Uint8Array) => void)(
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          );
        });
        return;
      }
      socket.on(event, cb as () => void);
    },
  };
}
