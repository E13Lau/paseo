import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPortForwardStore } from "./store.js";
import type { PortForwardDefinition } from "./types.js";

function definition(overrides: Partial<PortForwardDefinition> = {}): PortForwardDefinition {
  return {
    id: "pf-1",
    serverId: "host-a",
    targetHost: "localhost",
    targetPort: 8080,
    label: "web",
    preferredLocalPort: 8080,
    requireLocalPort: false,
    openAs: "http",
    ...overrides,
  };
}

describe("port-forward store", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.clear();
  });

  it("persists definitions atomically by serverId", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "paseo-port-forward-"));
    directories.add(userDataPath);
    const store = createPortForwardStore({ userDataPath });
    await store.save(definition());

    const persisted = JSON.parse(
      await readFile(path.join(userDataPath, "port-forwards.json"), "utf8"),
    ) as { byServerId: Record<string, PortForwardDefinition[]> };
    expect(await readdir(userDataPath)).toEqual(["port-forwards.json"]);
    expect(persisted.byServerId["host-a"]).toEqual([definition()]);
    expect(await store.list("host-a")).toEqual([definition()]);
  });

  it("handles concurrent first writes without leftover temp files", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "paseo-port-forward-"));
    directories.add(userDataPath);
    const store = createPortForwardStore({ userDataPath });
    await Promise.all([
      store.save(definition({ id: "pf-1", targetPort: 8080, preferredLocalPort: 8080 })),
      store.save(definition({ id: "pf-2", targetPort: 9090, preferredLocalPort: 9090 })),
    ]);
    expect(await readdir(userDataPath)).toEqual(["port-forwards.json"]);
    expect(await store.list("host-a")).toHaveLength(2);
  });

  it("removes a Host and migrates a server-id rekey", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "paseo-port-forward-"));
    directories.add(userDataPath);
    const store = createPortForwardStore({ userDataPath });
    await store.save(definition());
    await store.rekeyHost("host-a", "host-b");
    expect(await store.list("host-a")).toEqual([]);
    expect(await store.list("host-b")).toEqual([definition({ serverId: "host-b" })]);
    await store.removeHost("host-b");
    expect(await store.list()).toEqual([]);
  });

  it("ignores a corrupted file instead of crashing restore", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "paseo-port-forward-"));
    directories.add(userDataPath);
    await writeFile(path.join(userDataPath, "port-forwards.json"), "{ not json");
    const store = createPortForwardStore({ userDataPath });
    expect(await store.list()).toEqual([]);
  });
});
