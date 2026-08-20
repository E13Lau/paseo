import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readlink, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  InstructionFileListItem,
  InstructionFileVersion,
  InstructionFileWriteResult,
} from "@getpaseo/protocol/messages";
import { MAX_EDITABLE_FILE_BYTES } from "../file-explorer/service.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { listResolvedInstructionFiles, type ResolvedInstructionFile } from "./catalog.js";

export interface InstructionFileGetResult {
  status: "ok";
  id: string;
  text: string;
  missing: boolean;
  version: InstructionFileVersion;
}

export interface InstructionFileGetError {
  status: "error";
  error: string;
}

export type InstructionFileGetOutcome = InstructionFileGetResult | InstructionFileGetError;

export interface InstructionFileWriteInput {
  id: string;
  text: string;
  expectedModifiedAt?: string;
  expectedRevision?: string;
}

export class InstructionFileService {
  constructor(private readonly providerSnapshotManager: ProviderSnapshotManager) {}

  async list(): Promise<InstructionFileListItem[]> {
    const files = await this.resolveCatalog();
    return files.map((file) => ({
      id: file.id,
      filename: file.filename,
      displayPath: file.displayPath,
      missing: file.missing,
      providers: file.providers,
    }));
  }

  async get(id: string): Promise<InstructionFileGetOutcome> {
    const file = await this.findCatalogFile(id);
    if (!file) {
      return { status: "error", error: "Unknown instruction file" };
    }
    if (file.missing) {
      return {
        status: "ok",
        id: file.id,
        text: "",
        missing: true,
        version: { status: "missing" },
      };
    }
    return readInstructionFile(file);
  }

  async write(input: InstructionFileWriteInput): Promise<InstructionFileWriteResult> {
    const encoded = Buffer.from(input.text, "utf8");
    if (encoded.byteLength > MAX_EDITABLE_FILE_BYTES) {
      return { status: "error", error: "File is too large to edit" };
    }
    const file = await this.findCatalogFile(input.id);
    if (!file) {
      return { status: "error", error: "Unknown instruction file" };
    }
    return writeInstructionFile(file, encoded, input);
  }

  private async resolveCatalog(): Promise<ResolvedInstructionFile[]> {
    return listResolvedInstructionFiles(this.providerSnapshotManager.listInstructionFileSources());
  }

  private async findCatalogFile(id: string): Promise<ResolvedInstructionFile | null> {
    const files = await this.resolveCatalog();
    return files.find((file) => file.id === id) ?? null;
  }
}

async function readInstructionFile(
  file: ResolvedInstructionFile,
): Promise<InstructionFileGetOutcome> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(file.absolutePath, "r");
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) {
      return { status: "error", error: "Requested path is not a file" };
    }
    if (stats.size > BigInt(MAX_EDITABLE_FILE_BYTES)) {
      return { status: "error", error: "File is too large to edit" };
    }
    const contents = await handle.readFile();
    if (isLikelyBinary(contents) || !isValidUtf8(contents)) {
      return { status: "error", error: "This file is not valid text" };
    }
    return {
      status: "ok",
      id: file.id,
      text: contents.toString("utf8"),
      missing: false,
      version: presentVersion(stats),
    };
  } catch (error) {
    if (isMissingEntryError(error)) {
      return {
        status: "ok",
        id: file.id,
        text: "",
        missing: true,
        version: { status: "missing" },
      };
    }
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeInstructionFile(
  file: ResolvedInstructionFile,
  encoded: Buffer,
  input: InstructionFileWriteInput,
): Promise<InstructionFileWriteResult> {
  const expectedMissing = input.expectedModifiedAt == null && input.expectedRevision == null;
  let currentMode = 0o600;
  let writePath = file.absolutePath;
  try {
    writePath = await realpath(file.absolutePath);
    const stats = await stat(writePath, { bigint: true });
    if (!stats.isFile()) {
      return { status: "error", error: "Requested path is not a file" };
    }
    if (expectedMissing) {
      return { status: "conflict", version: presentVersion(stats) };
    }
    if (!matchesExpectedRevision(stats, input.expectedModifiedAt, input.expectedRevision)) {
      return { status: "conflict", version: presentVersion(stats) };
    }
    currentMode = Number(stats.mode);
  } catch (error) {
    if (!isMissingEntryError(error)) {
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
    if (!expectedMissing) {
      return { status: "conflict", version: { status: "missing" } };
    }
    writePath = await resolveMissingCreatePath(file.absolutePath);
  }

  await mkdir(path.dirname(writePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(writePath),
    `.${path.basename(writePath)}.paseo-${randomUUID()}.tmp`,
  );
  let temporaryHandle: FileHandle | null = null;
  try {
    temporaryHandle = await open(temporaryPath, "wx", currentMode);
    if (process.platform !== "win32") {
      await temporaryHandle.chmod(currentMode & 0o7777);
    }
    await temporaryHandle.writeFile(encoded);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    try {
      const latestStats = await stat(writePath, { bigint: true });
      if (expectedMissing) {
        return { status: "conflict", version: presentVersion(latestStats) };
      }
      if (!matchesExpectedRevision(latestStats, input.expectedModifiedAt, input.expectedRevision)) {
        return { status: "conflict", version: presentVersion(latestStats) };
      }
    } catch (error) {
      if (!isMissingEntryError(error)) {
        return { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
      if (!expectedMissing) {
        return { status: "conflict", version: { status: "missing" } };
      }
    }
    await rename(temporaryPath, writePath);
    const written = await stat(writePath, { bigint: true });
    return {
      status: "written",
      modifiedAt: written.mtime.toISOString(),
      size: Number(written.size),
      revision: fileRevision(written),
    };
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function presentVersion(
  stats: BigIntStats,
): Extract<InstructionFileVersion, { status: "present" }> {
  return {
    status: "present",
    modifiedAt: stats.mtime.toISOString(),
    revision: fileRevision(stats),
    size: Number(stats.size),
  };
}

function fileRevision(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`;
}

function matchesExpectedRevision(
  stats: BigIntStats,
  expectedModifiedAt?: string,
  expectedRevision?: string,
): boolean {
  return expectedRevision
    ? fileRevision(stats) === expectedRevision
    : stats.mtime.toISOString() === expectedModifiedAt;
}

function isMissingEntryError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function resolveMissingCreatePath(catalogPath: string): Promise<string> {
  try {
    const stats = await lstat(catalogPath);
    if (!stats.isSymbolicLink()) return catalogPath;
    return path.resolve(path.dirname(catalogPath), await readlink(catalogPath));
  } catch (error) {
    if (isMissingEntryError(error)) return catalogPath;
    throw error;
  }
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let suspicious = 0;
  for (let idx = 0; idx < buffer.length; idx += 1) {
    const byte = buffer[idx];
    if (byte === 0) return true;
    const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
    if (isControl || byte === 127) suspicious += 1;
  }
  return suspicious / buffer.length > 0.3;
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}
