import net from "node:net";

export interface DualStackBinding {
  port: number;
  addresses: { ipv4: string; ipv6: string };
  close(): Promise<void>;
  onConnection(cb: (socket: net.Socket) => void): void;
}

export class PortBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortBindError";
  }
}

export async function bindDualStackLoopback(preferredPort: number): Promise<DualStackBinding> {
  const requested = preferredPort > 0 ? preferredPort : 0;
  try {
    return await bindPair(requested);
  } catch (error) {
    if (requested === 0) {
      throw error;
    }
    return bindPair(0);
  }
}

export async function bindDualStackLoopbackStrict(port: number): Promise<DualStackBinding> {
  if (port < 1 || port > 65535) {
    throw new PortBindError("Local port must be between 1 and 65535");
  }
  return bindPair(port);
}

async function bindPair(port: number): Promise<DualStackBinding> {
  const ipv4 = net.createServer();
  const ipv6 = net.createServer();
  try {
    await listen(ipv4, "127.0.0.1", port);
    const ipv4Address = readAddress(ipv4, "127.0.0.1");
    await listen(ipv6, "::1", ipv4Address.port, true);
    const ipv6Address = readAddress(ipv6, "::1");
    if (ipv4Address.port !== ipv6Address.port) {
      throw new PortBindError("Dual-stack local port mismatch");
    }
    assertLoopback(ipv4Address.host);
    assertLoopback(ipv6Address.host);
    return {
      port: ipv4Address.port,
      addresses: { ipv4: ipv4Address.host, ipv6: ipv6Address.host },
      async close() {
        await Promise.all([closeServer(ipv4), closeServer(ipv6)]);
      },
      onConnection(cb) {
        ipv4.on("connection", cb);
        ipv6.on("connection", cb);
      },
    };
  } catch (error) {
    await Promise.all([closeServer(ipv4), closeServer(ipv6)]);
    throw error instanceof PortBindError
      ? error
      : new PortBindError("Unable to bind a dual-stack loopback port");
  }
}

function listen(server: net.Server, host: string, port: number, ipv6Only = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host, ipv6Only, exclusive: true });
  });
}

function readAddress(server: net.Server, fallbackHost: string): { host: string; port: number } {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new PortBindError("Unable to read loopback listener address");
  }
  return { host: address.address || fallbackHost, port: address.port };
}

function assertLoopback(host: string): void {
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new PortBindError("Port Forward refused a non-loopback bind");
  }
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      server.close();
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
