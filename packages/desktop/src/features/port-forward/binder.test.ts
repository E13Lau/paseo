import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { bindDualStackLoopback, bindDualStackLoopbackStrict } from "./binder.js";

const bindings: Array<{ close(): Promise<void> }> = [];
const occupiers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(bindings.splice(0).map((binding) => binding.close()));
  await Promise.all(
    occupiers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("dual-stack loopback binder", () => {
  it("binds 127.0.0.1 and ::1 on the same port and never a LAN interface", async () => {
    const binding = await bindDualStackLoopback(0);
    bindings.push(binding);
    expect(binding.addresses).toEqual({ ipv4: "127.0.0.1", ipv6: "::1" });
    expect(binding.port).toBeGreaterThan(0);

    const ipv4 = await ping("127.0.0.1", binding.port);
    const ipv6 = await ping("::1", binding.port);
    expect(ipv4).toBe(true);
    expect(ipv6).toBe(true);
  });

  it("selects a replacement port when the preferred port is occupied", async () => {
    const first = await bindDualStackLoopback(0);
    bindings.push(first);
    const remapped = await bindDualStackLoopback(first.port);
    bindings.push(remapped);
    expect(remapped.port).not.toBe(first.port);
    expect(remapped.addresses).toEqual({ ipv4: "127.0.0.1", ipv6: "::1" });
  });

  it("fails clearly when the required local port is occupied", async () => {
    const first = await bindDualStackLoopback(0);
    bindings.push(first);
    await expect(bindDualStackLoopbackStrict(first.port)).rejects.toThrow(
      /dual-stack loopback port/,
    );
  });
});

function ping(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
