import { createHash } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  ConversationHistoryEvent,
  ConversationHistoryProviderId,
} from "@getpaseo/protocol/conversation-history/rpc-schemas";

export interface HistorySource {
  nativeId: string;
  path: string;
  fingerprint: string;
}

export interface NormalizedHistoryConversation {
  nativeId: string;
  sourcePath: string;
  fingerprint: string;
  cwd: string | null;
  title: string;
  lastActivityAt: string;
  parentNativeId: string | null;
  events: ConversationHistoryEvent[];
}

export interface ConversationHistoryAdapter {
  readonly provider: ConversationHistoryProviderId;
  readonly sourceDescription: string;
  sourceRoots(): string[];
  discover(): Promise<HistorySource[]>;
  read(source: HistorySource): Promise<NormalizedHistoryConversation>;
}

type JsonRecord = Record<string, unknown>;
const MAX_TOOL_BYTES = 64 * 1024;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function messageRole(value: unknown): "user" | "assistant" | null {
  if (value === "user" || value === "user_message") return "user";
  if (value === "assistant" || value === "agent_message") return "assistant";
  return null;
}

function sourceRoot(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return path.resolve(value);
}

function clipTool(
  value: unknown,
): Pick<ConversationHistoryEvent, "toolResult" | "originalSize" | "truncated"> {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = Buffer.byteLength(text);
  if (bytes <= MAX_TOOL_BYTES) return { toolResult: text, originalSize: bytes, truncated: false };
  const marker = "\n… truncated …\n";
  const half = Math.floor((MAX_TOOL_BYTES - Buffer.byteLength(marker) - 8) / 2);
  return {
    toolResult: `${Buffer.from(text).subarray(0, half).toString()}${marker}${Buffer.from(text).subarray(-half).toString()}`,
    originalSize: bytes,
    truncated: true,
  };
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const item = record(part);
    if (!item) return [];
    const type = string(item.type);
    if (type === "text" || type === "input_text" || type === "output_text") {
      return string(item.text) ?? [];
    }
    return [];
  });
}

// Provider content blocks intentionally share one normalization boundary.
// oxlint-disable-next-line complexity
function contentEvents(
  content: unknown,
  base: { eventId: string; timestamp: string | null; role: "user" | "assistant" },
): ConversationHistoryEvent[] {
  const events: ConversationHistoryEvent[] = [];
  const texts = textParts(content);
  if (texts.length > 0) events.push({ ...base, text: texts.join("\n\n") });
  if (!Array.isArray(content)) return events;
  for (let index = 0; index < content.length; index += 1) {
    const part = record(content[index]);
    if (!part) continue;
    const type = string(part.type);
    if (type === "tool_use" || type === "toolCall") {
      const clipped = clipTool(part.input ?? part.arguments ?? "");
      events.push({
        eventId: `${base.eventId}:tool:${index}`,
        role: "tool",
        timestamp: base.timestamp,
        toolName: string(part.name) ?? "tool",
        toolCallId: string(part.id) ?? undefined,
        toolStatus: "requested",
        toolInput: clipped.toolResult,
        originalSize: clipped.originalSize,
        truncated: clipped.truncated,
      });
    } else if (type === "tool_result" || type === "toolResult") {
      events.push({
        eventId: `${base.eventId}:result:${index}`,
        role: "tool",
        timestamp: base.timestamp,
        toolName: string(part.name) ?? "tool",
        toolCallId: string(part.tool_use_id) ?? undefined,
        toolStatus: part.is_error === true ? "failed" : "completed",
        ...clipTool(part.content ?? part.result ?? ""),
      });
    } else if (type === "image" || type === "document" || type === "file") {
      const name = string(part.name) ?? string(part.filename);
      const mime = string(part.mimeType) ?? string(part.media_type);
      const attachmentText = string(part.text);
      events.push({
        eventId: `${base.eventId}:attachment:${index}`,
        role: "attachment",
        timestamp: base.timestamp,
        ...(attachmentText ? { text: attachmentText } : {}),
        ...(name ? { attachmentName: name } : {}),
        ...(mime ? { attachmentMime: mime } : {}),
      });
    }
  }
  return events;
}

async function walkJsonl(root: string): Promise<string[]> {
  const directories = [root];
  const files: string[] = [];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
    }
  }
  return files;
}

async function discoverRoot(root: string): Promise<HistorySource[]> {
  const files = await walkJsonl(root);
  const sources: HistorySource[] = [];
  for (const file of files) {
    const info = await stat(file);
    sources.push({
      nativeId: file,
      path: file,
      fingerprint: `${info.size}:${Math.floor(info.mtimeMs)}`,
    });
  }
  return sources;
}

async function* completeLines(file: string): AsyncGenerator<JsonRecord> {
  const stream = createReadStream(file, { encoding: "utf8" });
  let pending = "";
  for await (const chunk of stream) {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) continue;
      const item = record(JSON.parse(line) as unknown);
      if (item) yield item;
    }
  }
  // A Provider may be streaming the final record. It becomes visible only
  // after the terminating newline arrives on a later observation.
}

function opaqueId(provider: ConversationHistoryProviderId, nativeId: string): string {
  return createHash("sha256").update(`${provider}\0${nativeId}`).digest("base64url").slice(0, 32);
}

function fallbackTitle(events: readonly ConversationHistoryEvent[]): string {
  const text = events.find((event) => event.role === "user" && event.text)?.text?.trim();
  return text ? text.replace(/\s+/gu, " ").slice(0, 120) : "Untitled conversation";
}

function finalConversation(input: {
  provider: ConversationHistoryProviderId;
  source: HistorySource;
  nativeId: string | null;
  cwd: string | null;
  title: string | null;
  parentNativeId?: string | null;
  events: ConversationHistoryEvent[];
}): NormalizedHistoryConversation {
  const nativeId = input.nativeId ?? input.source.nativeId;
  const activity = input.events
    .flatMap((event) => (event.timestamp ? [event.timestamp] : []))
    .at(-1);
  return {
    nativeId,
    sourcePath: input.source.path,
    fingerprint: input.source.fingerprint,
    cwd: input.cwd,
    title: input.title ?? fallbackTitle(input.events),
    lastActivityAt: activity ?? new Date(0).toISOString(),
    parentNativeId: input.parentNativeId ?? null,
    events: input.events,
  };
}

async function parseClaude(
  lines: AsyncIterable<JsonRecord>,
  source: HistorySource,
): Promise<NormalizedHistoryConversation> {
  let nativeId: string | null = null;
  let cwd: string | null = null;
  let parentNativeId: string | null = null;
  const events: ConversationHistoryEvent[] = [];
  const sourceParts = path.normalize(source.path).split(path.sep);
  const subagentsIndex = sourceParts.lastIndexOf("subagents");
  const isSubagentSource = subagentsIndex > 0;
  if (subagentsIndex > 0) parentNativeId = sourceParts[subagentsIndex - 1] ?? null;
  let index = 0;
  for await (const line of lines) {
    const lineIndex = index;
    index += 1;
    if (!isSubagentSource && line.isSidechain === true) continue;
    nativeId = isSubagentSource
      ? (string(line.agentId) ?? nativeId)
      : (string(line.sessionId) ?? nativeId);
    cwd = string(line.cwd) ?? cwd;
    parentNativeId = string(line.parentSessionId) ?? parentNativeId;
    const role = messageRole(line.type);
    const message = record(line.message);
    if (!role || !message) continue;
    events.push(
      ...contentEvents(message.content, {
        eventId: string(line.uuid) ?? `${lineIndex}`,
        role,
        timestamp: timestamp(line.timestamp),
      }),
    );
  }
  return finalConversation({
    provider: "claude",
    source,
    nativeId:
      nativeId ??
      (isSubagentSource
        ? path.basename(source.path, path.extname(source.path)).replace(/^agent-/u, "")
        : null),
    cwd,
    parentNativeId,
    title: null,
    events,
  });
}

// Codex persists several public event shapes in the same JSONL stream.
// oxlint-disable-next-line complexity
async function parseCodex(
  lines: AsyncIterable<JsonRecord>,
  source: HistorySource,
): Promise<NormalizedHistoryConversation> {
  let nativeId: string | null = null;
  let cwd: string | null = null;
  const eventMessages: ConversationHistoryEvent[] = [];
  const responseEvents: ConversationHistoryEvent[] = [];
  let index = 0;
  for await (const line of lines) {
    const lineIndex = index;
    index += 1;
    const payload = record(line.payload);
    if (!payload) continue;
    if (line.type === "session_meta") {
      nativeId = string(payload.id) ?? nativeId;
      cwd = string(payload.cwd) ?? cwd;
      continue;
    }
    const at = timestamp(line.timestamp ?? payload.timestamp);
    if (line.type === "event_msg") {
      const kind = string(payload.type);
      const role = messageRole(kind);
      const text = string(payload.message);
      if (role && text) eventMessages.push({ eventId: `${lineIndex}`, role, timestamp: at, text });
      continue;
    }
    if (line.type !== "response_item") continue;
    const kind = string(payload.type);
    if (kind === "message") {
      const role = messageRole(payload.role);
      if (role)
        responseEvents.push(
          ...contentEvents(payload.content, { eventId: `${lineIndex}`, role, timestamp: at }),
        );
    } else if (kind === "function_call" || kind === "custom_tool_call") {
      const clipped = clipTool(payload.arguments ?? payload.input ?? "");
      responseEvents.push({
        eventId: `${lineIndex}`,
        role: "tool",
        timestamp: at,
        toolName: string(payload.name) ?? "tool",
        toolCallId: string(payload.call_id) ?? undefined,
        toolStatus: "requested",
        toolInput: clipped.toolResult,
        originalSize: clipped.originalSize,
        truncated: clipped.truncated,
      });
    } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      responseEvents.push({
        eventId: `${lineIndex}`,
        role: "tool",
        timestamp: at,
        toolName: "tool",
        toolCallId: string(payload.call_id) ?? undefined,
        toolStatus: "completed",
        ...clipTool(payload.output ?? ""),
      });
    } else if (kind === "reasoning") {
      const summary = textParts(payload.summary);
      if (summary.length > 0)
        responseEvents.push({
          eventId: `${lineIndex}`,
          role: "reasoning_summary",
          timestamp: at,
          text: summary.join("\n\n"),
        });
    }
  }
  const events = responseEvents.some((event) => event.role === "user" || event.role === "assistant")
    ? responseEvents
    : eventMessages;
  return finalConversation({ provider: "codex", source, nativeId, cwd, title: null, events });
}

async function parsePiFamily(
  provider: "pi" | "omp",
  lines: AsyncIterable<JsonRecord>,
  source: HistorySource,
): Promise<NormalizedHistoryConversation> {
  let nativeId: string | null = null;
  let cwd: string | null = null;
  let title: string | null = null;
  const events: ConversationHistoryEvent[] = [];
  let index = 0;
  for await (const line of lines) {
    const lineIndex = index;
    index += 1;
    if (line.type === "session") {
      nativeId = string(line.id) ?? string(line.sessionId) ?? nativeId;
      cwd = string(line.cwd) ?? cwd;
    }
    if (line.type === "session_info") title = string(line.name) ?? title;
    if (line.type !== "message") continue;
    const message = record(line.message);
    if (!message) continue;
    const role = messageRole(message.role);
    if (role)
      events.push(
        ...contentEvents(message.content, {
          eventId: string(line.id) ?? `${lineIndex}`,
          role,
          timestamp: timestamp(line.timestamp),
        }),
      );
    if (message.role === "toolResult")
      events.push({
        eventId: string(line.id) ?? `${lineIndex}`,
        role: "tool",
        timestamp: timestamp(line.timestamp),
        toolName: string(message.toolName) ?? "tool",
        toolCallId: string(message.toolCallId) ?? undefined,
        toolStatus: message.isError === true ? "failed" : "completed",
        ...clipTool(message.content ?? ""),
      });
  }
  return finalConversation({ provider, source, nativeId, cwd, title, events });
}

function adapter(
  provider: ConversationHistoryProviderId,
  sourceDescription: string,
  root: () => string,
  parse: (
    lines: AsyncIterable<JsonRecord>,
    source: HistorySource,
  ) => Promise<NormalizedHistoryConversation>,
): ConversationHistoryAdapter {
  return {
    provider,
    sourceDescription,
    sourceRoots: () => [root()],
    discover: () => discoverRoot(root()),
    async read(source) {
      const result = await parse(completeLines(source.path), source);
      if (result.events.length === 0) throw new Error("no_complete_messages");
      return result;
    },
  };
}

export function createConversationHistoryAdapters(
  envSource:
    | NodeJS.ProcessEnv
    | ((provider: ConversationHistoryProviderId) => NodeJS.ProcessEnv) = process.env,
): ConversationHistoryAdapter[] {
  const env = (provider: ConversationHistoryProviderId) =>
    typeof envSource === "function" ? envSource(provider) : envSource;
  const home = (provider: ConversationHistoryProviderId) => env(provider).HOME ?? homedir();
  return [
    adapter(
      "claude",
      "Claude projects history",
      () =>
        path.join(
          sourceRoot(
            env("claude").CLAUDE_CONFIG_DIR ?? path.join(home("claude"), ".claude"),
            home("claude"),
          ),
          "projects",
        ),
      parseClaude,
    ),
    adapter(
      "codex",
      "Codex sessions history",
      () =>
        path.join(
          sourceRoot(env("codex").CODEX_HOME ?? path.join(home("codex"), ".codex"), home("codex")),
          "sessions",
        ),
      parseCodex,
    ),
    adapter(
      "pi",
      "Pi agent sessions",
      () =>
        sourceRoot(
          env("pi").PI_CODING_AGENT_SESSION_DIR ??
            path.join(
              env("pi").PI_CODING_AGENT_DIR ?? path.join(home("pi"), ".pi", "agent"),
              "sessions",
            ),
          home("pi"),
        ),
      (lines, source) => parsePiFamily("pi", lines, source),
    ),
    adapter(
      "omp",
      "OMP agent sessions",
      () =>
        sourceRoot(
          env("omp").OMP_SESSION_DIR ??
            path.join(
              env("omp").OMP_AGENT_DIR ?? path.join(home("omp"), ".omp", "agent"),
              "sessions",
            ),
          home("omp"),
        ),
      (lines, source) => parsePiFamily("omp", lines, source),
    ),
  ];
}

export function conversationId(provider: ConversationHistoryProviderId, nativeId: string): string {
  return opaqueId(provider, nativeId);
}
