import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { expandTilde } from "../../utils/path.js";
import type { InstructionFileProviderRef } from "@getpaseo/protocol/messages";

export type InstructionFileFamily = "claude" | "codex";

export interface InstructionFileProviderSource {
  id: string;
  label: string;
  family: InstructionFileFamily;
  env: Record<string, string> | undefined;
}

export interface ResolvedInstructionFile {
  id: string;
  absolutePath: string;
  filename: string;
  displayPath: string;
  missing: boolean;
  providers: InstructionFileProviderRef[];
}

export function instructionFileFamily(
  providerId: string,
  derivedFromProviderId: string | null,
): InstructionFileFamily | null {
  if (providerId === "claude" || derivedFromProviderId === "claude") return "claude";
  if (providerId === "codex" || derivedFromProviderId === "codex") return "codex";
  return null;
}

export function catalogIdForPath(absolutePath: string): string {
  return createHash("sha256").update(absolutePath).digest("hex").slice(0, 32);
}

export function resolveClaudeConfigDir(env: Record<string, string> | undefined): string {
  return resolveConfigDir(env?.["CLAUDE_CONFIG_DIR"], process.env["CLAUDE_CONFIG_DIR"], ".claude");
}

export function resolveCodexHome(env: Record<string, string> | undefined): string {
  return resolveConfigDir(env?.["CODEX_HOME"], process.env["CODEX_HOME"], ".codex");
}

export async function resolveInstructionFilePath(
  source: InstructionFileProviderSource,
): Promise<string> {
  if (source.family === "claude") {
    return path.join(resolveClaudeConfigDir(source.env), "CLAUDE.md");
  }
  const dir = resolveCodexHome(source.env);
  const overridePath = path.join(dir, "AGENTS.override.md");
  if (await pathExists(overridePath)) return overridePath;
  return path.join(dir, "AGENTS.md");
}

export async function listResolvedInstructionFiles(
  sources: readonly InstructionFileProviderSource[],
): Promise<ResolvedInstructionFile[]> {
  const byPath = new Map<string, ResolvedInstructionFile>();
  for (const source of sources) {
    const absolutePath = path.resolve(await resolveInstructionFilePath(source));
    const existing = byPath.get(absolutePath);
    const provider: InstructionFileProviderRef = { id: source.id, label: source.label };
    if (existing) {
      existing.providers.push(provider);
      continue;
    }
    byPath.set(absolutePath, {
      id: catalogIdForPath(absolutePath),
      absolutePath,
      filename: path.basename(absolutePath),
      displayPath: toDisplayPath(absolutePath),
      missing: !(await pathExists(absolutePath)),
      providers: [provider],
    });
  }
  const files = [...byPath.values()];
  for (const entry of files) {
    entry.providers.sort(compareProviderRefs);
  }
  files.sort(compareResolvedFiles);
  return files;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveConfigDir(
  providerValue: string | undefined,
  processValue: string | undefined,
  defaultDirName: string,
): string {
  const fromProvider = providerValue?.trim();
  if (fromProvider) return path.resolve(expandTilde(fromProvider));
  const fromProcess = processValue?.trim();
  if (fromProcess) return path.resolve(expandTilde(fromProcess));
  return path.join(homedir(), defaultDirName);
}

function toDisplayPath(absolutePath: string): string {
  const home = homedir();
  if (absolutePath === home) return "~";
  if (absolutePath.startsWith(`${home}${path.sep}`)) {
    return `~${absolutePath.slice(home.length)}`;
  }
  return absolutePath;
}

function compareProviderRefs(left: InstructionFileProviderRef, right: InstructionFileProviderRef) {
  return left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
}

function compareResolvedFiles(left: ResolvedInstructionFile, right: ResolvedInstructionFile) {
  return (
    left.filename.localeCompare(right.filename) || left.displayPath.localeCompare(right.displayPath)
  );
}
