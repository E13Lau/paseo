import net from "node:net";
import { describe, expect, it } from "vitest";
import { HostTunnelErrorCode } from "@getpaseo/protocol/binary-frames/index";
import { HostTcpConnectError, classifyHostTcpError, connectHostTcp } from "./host-tcp.js";

describe("host TCP connect", () => {
  it("classifies DNS, refuse, and timeout codes", () => {
    expect(classifyHostTcpError(Object.assign(new Error("dns"), { code: "ENOTFOUND" }))).toBe(
      HostTunnelErrorCode.Dns,
    );
    expect(
      classifyHostTcpError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })),
    ).toBe(HostTunnelErrorCode.Refused);
    expect(
      classifyHostTcpError(new HostTcpConnectError(HostTunnelErrorCode.Timeout, "timeout")),
    ).toBe(HostTunnelErrorCode.Timeout);
  });

  it("times out when the TCP handshake never completes", async () => {
    const started = Date.now();
    await expect(
      connectHostTcp({ host: "127.0.0.1", port: 9, timeoutMs: 150 }, () => new net.Socket()),
    ).rejects.toMatchObject({ errorCode: HostTunnelErrorCode.Timeout });
    expect(Date.now() - started).toBeGreaterThan(100);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
