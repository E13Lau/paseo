import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PortForwardDefinition, PortForwardOpenAs } from "./types.js";

interface PersistedPortForwardDocument {
  version: 1;
  byServerId: Record<string, PortForwardDefinition[]>;
}

export interface PortForwardStore {
  list(serverId?: string): Promise<PortForwardDefinition[]>;
  save(definition: PortForwardDefinition): Promise<void>;
  remove(id: string): Promise<void>;
  removeHost(serverId: string): Promise<void>;
  rekeyHost(oldServerId: string, newServerId: string): Promise<void>;
}

const PORT_FORWARD_FILENAME = "port-forwards.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function coerceOpenAs(value: unknown): PortForwardOpenAs {
  if (value === "http" || value === "https" || value === "none") {
    return value;
  }
  return "none";
}

function coerceDefinition(input: unknown, serverId: string): PortForwardDefinition | null {
  if (!isRecord(input)) {
    return null;
  }
  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    return null;
  }
  if (typeof input.targetHost !== "string" || input.targetHost.trim().length === 0) {
    return null;
  }
  if (typeof input.targetPort !== "number" || !Number.isInteger(input.targetPort)) {
    return null;
  }
  if (input.targetPort < 1 || input.targetPort > 65535) {
    return null;
  }
  if (typeof input.preferredLocalPort !== "number" || !Number.isInteger(input.preferredLocalPort)) {
    return null;
  }
  if (input.preferredLocalPort < 1 || input.preferredLocalPort > 65535) {
    return null;
  }
  return {
    id: input.id.trim(),
    serverId,
    targetHost: input.targetHost.trim(),
    targetPort: input.targetPort,
    label: typeof input.label === "string" ? input.label : "",
    preferredLocalPort: input.preferredLocalPort,
    requireLocalPort: input.requireLocalPort === true,
    openAs: coerceOpenAs(input.openAs),
  };
}

function coerceDocument(input: unknown): PersistedPortForwardDocument {
  if (!isRecord(input) || !isRecord(input.byServerId)) {
    return { version: 1, byServerId: {} };
  }
  const byServerId: Record<string, PortForwardDefinition[]> = {};
  for (const [serverId, raw] of Object.entries(input.byServerId)) {
    if (!Array.isArray(raw) || serverId.trim().length === 0) {
      continue;
    }
    byServerId[serverId] = raw.flatMap((item) => {
      const definition = coerceDefinition(item, serverId);
      return definition ? [definition] : [];
    });
  }
  return { version: 1, byServerId };
}

export function createPortForwardStore({
  userDataPath,
}: {
  userDataPath: string;
}): PortForwardStore {
  const filePath = path.join(userDataPath, PORT_FORWARD_FILENAME);
  let cached: PersistedPortForwardDocument | null = null;
  let persistQueue: Promise<void> = Promise.resolve();

  async function persist(
    mutate: (document: PersistedPortForwardDocument) => PersistedPortForwardDocument,
  ): Promise<void> {
    const write = async () => {
      const current = await load();
      const document = mutate(current);
      await mkdir(userDataPath, { recursive: true });
      const tempFilePath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
      await writeFile(tempFilePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(tempFilePath, filePath);
      cached = document;
    };
    const queued = persistQueue.then(write, write);
    persistQueue = queued.catch(() => undefined);
    await queued;
  }

  async function load(): Promise<PersistedPortForwardDocument> {
    if (cached) {
      return cached;
    }
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      const document = { version: 1 as const, byServerId: {} };
      cached = document;
      return document;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError) {
        const document = { version: 1 as const, byServerId: {} };
        cached = document;
        return document;
      }
      throw error;
    }
    const document = coerceDocument(parsed);
    cached = document;
    return document;
  }

  return {
    async list(serverId) {
      const document = await load();
      if (serverId) {
        return [...(document.byServerId[serverId] ?? [])];
      }
      return Object.values(document.byServerId).flat();
    },

    async save(definition) {
      await persist((document) => {
        const existing = document.byServerId[definition.serverId] ?? [];
        const next = existing.filter((item) => item.id !== definition.id);
        next.push(definition);
        return {
          ...document,
          byServerId: { ...document.byServerId, [definition.serverId]: next },
        };
      });
    },

    async remove(id) {
      await persist((document) => {
        const byServerId = { ...document.byServerId };
        for (const [serverId, definitions] of Object.entries(byServerId)) {
          const next = definitions.filter((item) => item.id !== id);
          if (next.length === definitions.length) {
            continue;
          }
          if (next.length === 0) {
            delete byServerId[serverId];
          } else {
            byServerId[serverId] = next;
          }
        }
        return { ...document, byServerId };
      });
    },

    async removeHost(serverId) {
      await persist((document) => {
        if (!(serverId in document.byServerId)) {
          return document;
        }
        const byServerId = { ...document.byServerId };
        delete byServerId[serverId];
        return { ...document, byServerId };
      });
    },

    async rekeyHost(oldServerId, newServerId) {
      if (oldServerId === newServerId) {
        return;
      }
      await persist((document) => {
        const existing = document.byServerId[oldServerId];
        if (!existing) {
          return document;
        }
        const byServerId = { ...document.byServerId };
        delete byServerId[oldServerId];
        byServerId[newServerId] = existing.map((item) => {
          return Object.assign({}, item, { serverId: newServerId });
        });
        return { ...document, byServerId };
      });
    },
  };
}
