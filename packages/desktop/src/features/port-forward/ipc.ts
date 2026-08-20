import { app, BrowserWindow, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { DaemonHostTunnelConnector } from "./daemon-connector.js";
import { PortForwardManager } from "./manager.js";
import { createPortForwardStore } from "./store.js";
import { parsePortForwardOpenUrl } from "./open-url.js";
import type {
  HostConnectionCandidate,
  PortForwardCreateInput,
  PortForwardOpenAs,
  PortForwardUpdateInput,
} from "./types.js";

const EVENT = "paseo:event:port-forward";

export async function startPortForwardMain(): Promise<PortForwardManager> {
  const manager = new PortForwardManager({
    store: createPortForwardStore({ userDataPath: app.getPath("userData") }),
    connector: new DaemonHostTunnelConnector({
      clientId: `electron-port-forward-${randomUUID()}`,
      appVersion: app.getVersion(),
    }),
  });
  registerPortForwardIpc(manager);
  await manager.start();
  return manager;
}

export function registerPortForwardIpc(manager: PortForwardManager): void {
  manager.subscribe((snapshots) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(EVENT, snapshots);
    }
  });

  ipcMain.handle("paseo:port-forward:list", (_event, serverId?: unknown) => {
    return manager.snapshots(typeof serverId === "string" ? serverId : undefined);
  });
  ipcMain.handle("paseo:port-forward:create", async (_event, raw: unknown) => {
    return manager.create(parseCreate(raw));
  });
  ipcMain.handle("paseo:port-forward:update", async (_event, raw: unknown) => {
    return manager.update(parseUpdate(raw));
  });
  ipcMain.handle("paseo:port-forward:stop", async (_event, id: unknown) => {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error("Port Forward id is required");
    }
    await manager.stop(id);
    return { ok: true };
  });
  ipcMain.handle("paseo:port-forward:retry", async (_event, id: unknown) => {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error("Port Forward id is required");
    }
    return manager.retry(id);
  });
  ipcMain.handle("paseo:port-forward:sync-candidates", (_event, raw: unknown) => {
    const parsed = parseCandidates(raw);
    manager.syncHostCandidates(parsed.serverId, parsed.candidates);
    return { ok: true };
  });
  ipcMain.handle("paseo:port-forward:remove-host", async (_event, serverId: unknown) => {
    if (typeof serverId !== "string" || serverId.trim().length === 0) {
      throw new Error("serverId is required");
    }
    await manager.removeHost(serverId);
    return { ok: true };
  });
  ipcMain.handle("paseo:port-forward:rekey-host", async (_event, raw: unknown) => {
    const parsed = parseRekey(raw);
    await manager.rekeyHost(parsed.oldServerId, parsed.newServerId);
    return { ok: true };
  });
  ipcMain.handle("paseo:port-forward:open", async (_event, raw: unknown) => {
    const url = parsePortForwardOpenUrl(raw);
    await shell.openExternal(url);
    return { ok: true };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCreate(raw: unknown): PortForwardCreateInput {
  if (!isRecord(raw) || typeof raw.serverId !== "string" || typeof raw.target !== "string") {
    throw new Error("Port Forward create requires serverId and target");
  }
  return {
    serverId: raw.serverId,
    target: raw.target,
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    ...(typeof raw.localPort === "number" ? { localPort: raw.localPort } : {}),
    ...(typeof raw.requireLocalPort === "boolean"
      ? { requireLocalPort: raw.requireLocalPort }
      : {}),
    ...(isOpenAs(raw.openAs) ? { openAs: raw.openAs } : {}),
  };
}

function parseUpdate(raw: unknown): PortForwardUpdateInput {
  if (!isRecord(raw) || typeof raw.id !== "string") {
    throw new Error("Port Forward update requires id");
  }
  return {
    id: raw.id,
    ...(typeof raw.target === "string" ? { target: raw.target } : {}),
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    ...(typeof raw.localPort === "number" ? { localPort: raw.localPort } : {}),
    ...(typeof raw.requireLocalPort === "boolean"
      ? { requireLocalPort: raw.requireLocalPort }
      : {}),
    ...(isOpenAs(raw.openAs) ? { openAs: raw.openAs } : {}),
  };
}

function parseCandidates(raw: unknown): {
  serverId: string;
  candidates: HostConnectionCandidate[];
} {
  if (!isRecord(raw) || typeof raw.serverId !== "string" || !Array.isArray(raw.candidates)) {
    throw new Error("Host candidates require serverId and candidates");
  }
  return {
    serverId: raw.serverId,
    candidates: raw.candidates.filter(isCandidate),
  };
}

function parseRekey(raw: unknown): { oldServerId: string; newServerId: string } {
  if (
    !isRecord(raw) ||
    typeof raw.oldServerId !== "string" ||
    typeof raw.newServerId !== "string"
  ) {
    throw new Error("Host rekey requires oldServerId and newServerId");
  }
  return { oldServerId: raw.oldServerId, newServerId: raw.newServerId };
}

function isOpenAs(value: unknown): value is PortForwardOpenAs {
  return value === "none" || value === "http" || value === "https";
}

function isCandidate(value: unknown): value is HostConnectionCandidate {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") {
    return false;
  }
  return (
    value.type === "directTcp" ||
    value.type === "directSocket" ||
    value.type === "directPipe" ||
    value.type === "relay"
  );
}
