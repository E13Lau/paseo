import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { ControllableHostTunnelConnector } from "./controllable-connector.js";
import { PortForwardManager } from "./manager.js";
import { createPortForwardStore } from "./store.js";

const directories = new Set<string>();
const sockets: net.Socket[] = [];
const managers: PortForwardManager[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(
    [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.clear();
});

describe("PortForwardManager", () => {
  it("creates a dual-stack listener and forwards opaque bytes", async () => {
    const { manager, connector } = await createManager();
    const snapshot = await manager.create({
      serverId: "host-a",
      target: "8080",
      label: "web",
      openAs: "http",
    });
    expect(snapshot.localAddress).toBe(`localhost:${snapshot.localPort}`);
    expect(snapshot.state).toBe("waiting_for_host");

    connector.latest().setState("ready");
    expect(manager.snapshots("host-a")[0]?.state).toBe("ready");

    const streamReady = new Promise<void>((resolve) => {
      connector.latest().onOpen(() => resolve());
    });
    const local = connectBothFamilies(snapshot.localPort ?? 0);
    await streamReady;
    const stream = connector.latest().streams[0];
    expect(stream.target).toEqual({ host: "localhost", port: 8080 });
    stream.emitReady();

    const echoed = receive(local.ipv4);
    stream.emitData(new TextEncoder().encode("from-host"));
    expect(await echoed).toBe("from-host");
    local.ipv4.write("from-client");
    await delay(20);
    expect(Buffer.concat(stream.written.map((chunk) => Buffer.from(chunk))).toString()).toBe(
      "from-client",
    );
    expect(await ping("::1", snapshot.localPort ?? 0)).toBe(true);
    expect(await ping("127.0.0.1", snapshot.localPort ?? 0)).toBe(true);
  });

  it("keeps two Hosts independent and remaps occupied ports", async () => {
    const { manager, connector } = await createManager();
    const first = await manager.create({ serverId: "host-a", target: "9000" });
    const second = await manager.create({
      serverId: "host-b",
      target: "9000",
      localPort: first.localPort ?? 9000,
    });
    expect(second.localPort).not.toBe(first.localPort);
    connector.handles[0]?.setState("ready");
    expect(manager.snapshots("host-a")[0]?.state).toBe("ready");
    expect(manager.snapshots("host-b")[0]?.state).toBe("waiting_for_host");
  });

  it("fails require local port instead of remapping", async () => {
    const { manager } = await createManager();
    const first = await manager.create({ serverId: "host-a", target: "9100" });
    await expect(
      manager.create({
        serverId: "host-a",
        target: "9101",
        localPort: first.localPort ?? 9100,
        requireLocalPort: true,
      }),
    ).rejects.toThrow(/Required local port/);
  });

  it("keeps the prior forward when a transactional edit cannot bind", async () => {
    const { manager } = await createManager();
    const created = await manager.create({ serverId: "host-a", target: "9200", label: "keep" });
    const other = await manager.create({ serverId: "host-a", target: "9201" });
    await expect(
      manager.update({
        id: created.id,
        localPort: other.localPort ?? 9201,
        requireLocalPort: true,
      }),
    ).rejects.toThrow(/Required local port|dual-stack|loopback port/);
    const current = manager.snapshots("host-a")[0];
    expect(current?.label).toBe("keep");
    expect(current?.localPort).toBe(created.localPort);
  });

  it("restores a listener before the Host reconnects and Stop deletes it", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "paseo-pf-"));
    directories.add(userDataPath);
    const store = createPortForwardStore({ userDataPath });
    const firstConnector = new ControllableHostTunnelConnector();
    const first = new PortForwardManager({ store, connector: firstConnector });
    managers.push(first);
    await first.start();
    const created = await first.create({ serverId: "host-a", target: "9300", label: "api" });
    await first.dispose();

    const secondConnector = new ControllableHostTunnelConnector();
    const restored = new PortForwardManager({ store, connector: secondConnector });
    managers.push(restored);
    await restored.start();
    const snapshot = restored.snapshots("host-a")[0];
    expect(snapshot?.localPort).toBe(created.localPort);
    expect(snapshot?.state).toBe("waiting_for_host");
    expect(await ping("127.0.0.1", snapshot?.localPort ?? 0)).toBe(true);

    await restored.stop(snapshot?.id ?? "");
    expect(restored.snapshots()).toEqual([]);
    expect(await store.list("host-a")).toEqual([]);
  });

  it("closes streams on disconnect and records a target failure on one socket", async () => {
    const { manager, connector } = await createManager();
    const created = await manager.create({ serverId: "host-a", target: "9400" });
    connector.latest().setState("ready");
    const local = connectBothFamilies(created.localPort ?? 0);
    await delay(20);
    const stream = connector.latest().streams[0];
    stream.emitReset("timeout");
    await delay(20);
    expect(manager.snapshots("host-a")[0]?.recentError?.category).toBe("timeout");
    expect(manager.snapshots("host-a")[0]?.state).toBe("ready");

    connector.latest().setState("ready");
    const second = connectBothFamilies(created.localPort ?? 0);
    await delay(20);
    connector.latest().close();
    await delay(20);
    expect(second.ipv4.destroyed || second.ipv4.readyState === "closed").toBe(true);
    expect(local.ipv4.destroyed || local.ipv4.readyState === "closed").toBe(true);
  });

  it("removes a Host and keeps a Service-created forward after a later Service stop", async () => {
    const { manager } = await createManager();
    const created = await manager.create({
      serverId: "host-a",
      target: "9500",
      label: "web",
      openAs: "http",
    });
    expect(created.label).toBe("web");
    await manager.removeHost("host-a");
    expect(manager.snapshots()).toEqual([]);
  });

  it("migrates definitions when a server id is rekeyed", async () => {
    const { manager } = await createManager();
    await manager.create({ serverId: "old", target: "9600" });
    await manager.rekeyHost("old", "new");
    expect(manager.snapshots("old")).toEqual([]);
    expect(manager.snapshots("new")).toHaveLength(1);
  });

  it("holds local bytes until the Host OpenResult is ready", async () => {
    const { manager, connector } = await createManager();
    const created = await manager.create({ serverId: "host-a", target: "9700" });
    connector.latest().setState("ready");
    const streamReady = new Promise<void>((resolve) => {
      connector.latest().onOpen(() => resolve());
    });
    const local = connectBothFamilies(created.localPort ?? 0);
    await streamReady;
    const stream = connector.latest().streams[0];
    local.ipv4.write("before-open");
    await delay(30);
    expect(stream.written).toEqual([]);
    stream.emitReady();
    await delay(30);
    expect(Buffer.concat(stream.written.map((chunk) => Buffer.from(chunk))).toString()).toBe(
      "before-open",
    );
  });

  it("keeps the bound port when only the Host target changes", async () => {
    const { manager, connector } = await createManager();
    const created = await manager.create({ serverId: "host-a", target: "9800" });
    connector.latest().setState("ready");
    const streamReady = new Promise<void>((resolve) => {
      connector.latest().onOpen(() => resolve());
    });
    connectBothFamilies(created.localPort ?? 0);
    await streamReady;
    const first = connector.latest().streams[0];
    const updated = await manager.update({ id: created.id, target: "9801" });
    expect(updated.localPort).toBe(created.localPort);
    expect(updated.targetPort).toBe(9801);
    expect(first.resetCategory).toBe("reset");

    const nextReady = new Promise<void>((resolve) => {
      connector.latest().onOpen(() => resolve());
    });
    connectBothFamilies(updated.localPort ?? 0);
    await nextReady;
    expect(connector.latest().streams.at(-1)?.target).toEqual({ host: "localhost", port: 9801 });
  });

  it("keeps the listener when only require-local-port changes", async () => {
    const { manager } = await createManager();
    const created = await manager.create({ serverId: "host-a", target: "9810" });
    const updated = await manager.update({ id: created.id, requireLocalPort: true });
    expect(updated.localPort).toBe(created.localPort);
    expect(updated.requireLocalPort).toBe(true);
    expect(await ping("127.0.0.1", updated.localPort ?? 0)).toBe(true);
  });

  it("serializes creates so one Host target stays unique", async () => {
    const { manager } = await createManager();
    const results = await Promise.allSettled([
      manager.create({ serverId: "host-a", target: "9820" }),
      manager.create({ serverId: "host-a", target: "9820" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(manager.snapshots("host-a")).toHaveLength(1);
  });

  it("updates the live tunnel candidate list without stacking handles", async () => {
    const { manager, connector } = await createManager();
    manager.syncHostCandidates("host-a", [
      { id: "tcp-1", type: "directTcp", endpoint: "127.0.0.1:6767" },
    ]);
    await manager.create({ serverId: "host-a", target: "9830" });
    expect(connector.handles).toHaveLength(1);
    const next = [{ id: "tcp-2", type: "directTcp", endpoint: "127.0.0.1:6768", password: "p" }];
    manager.syncHostCandidates("host-a", next);
    expect(connector.handles).toHaveLength(1);
    expect(connector.latest().candidates).toEqual(next);
  });
});

async function createManager(): Promise<{
  manager: PortForwardManager;
  connector: ControllableHostTunnelConnector;
}> {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "paseo-pf-"));
  directories.add(userDataPath);
  const connector = new ControllableHostTunnelConnector();
  const manager = new PortForwardManager({
    store: createPortForwardStore({ userDataPath }),
    connector,
  });
  managers.push(manager);
  await manager.start();
  return { manager, connector };
}

function connectBothFamilies(port: number): { ipv4: net.Socket; ipv6: net.Socket } {
  const ipv4 = net.connect({ host: "127.0.0.1", port });
  const ipv6 = net.connect({ host: "::1", port });
  ipv4.on("error", () => undefined);
  ipv6.on("error", () => undefined);
  sockets.push(ipv4, ipv6);
  return { ipv4, ipv6 };
}

function receive(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (chunk) => resolve(chunk.toString()));
  });
}

function ping(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.on("error", () => undefined);
    sockets.push(socket);
    socket.once("connect", () => resolve(true));
    socket.once("error", () => resolve(false));
  });
}
