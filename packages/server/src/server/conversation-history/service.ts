import { createRequire } from "node:module";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type {
  ConversationHistoryBrowseRequest,
  ConversationHistoryConversation,
  ConversationHistoryEvent,
  ConversationHistoryProviderId,
  ConversationHistorySettings,
} from "@getpaseo/protocol/conversation-history/rpc-schemas";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import {
  createFileObserver,
  type FileObserver,
  type FileObserverSubscription,
} from "../file-observer/index.js";
import {
  conversationId,
  createConversationHistoryAdapters,
  type ConversationHistoryAdapter,
  type NormalizedHistoryConversation,
} from "./adapters.js";

interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
}
interface Database {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): Statement;
}
interface SqliteModule {
  DatabaseSync: new (file: string) => Database;
}
interface LoggerLike {
  child(fields: Record<string, unknown>): LoggerLike;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

interface ProviderRuntimeStatus {
  state: "disabled" | "scanning" | "ready" | "stale" | "failed";
  scannedConversations: number;
  totalConversations?: number;
  staleCount: number;
  failureCount: number;
  lastSuccessfulSyncAt: string | null;
  errorCategory: string | null;
}

interface ConversationRow {
  conversation_id: string;
  provider: ConversationHistoryProviderId;
  title: string;
  cwd: string | null;
  last_activity_at: string;
  stale: number;
  has_tools: number;
  parent_conversation_id: string | null;
}

export class ConversationHistoryError extends Error {
  constructor(
    readonly code: "cursor_expired" | "not_found" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

const PROVIDERS = ["claude", "codex", "pi", "omp"] as const;
const SCHEMA_VERSION = 1;
const RECONCILE_MS = 60_000;
const require = createRequire(import.meta.url);
const services = new Map<string, ConversationHistoryService>();

function runtimeStatus(): ProviderRuntimeStatus {
  return {
    state: "disabled",
    scannedConversations: 0,
    staleCount: 0,
    failureCount: 0,
    lastSuccessfulSyncAt: null,
    errorCategory: null,
  };
}

function sqlite(): SqliteModule | null {
  try {
    return require("node:sqlite") as SqliteModule;
  } catch {
    return null;
  }
}

function encodeCursor(generation: number, offset: number): string {
  return Buffer.from(JSON.stringify({ generation, offset })).toString("base64url");
}

function decodeCursor(cursor: string | undefined, generation: number): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid");
    const value = parsed as { generation?: unknown; offset?: unknown };
    if (
      value.generation !== generation ||
      !Number.isInteger(value.offset) ||
      Number(value.offset) < 0
    ) {
      throw new Error("expired");
    }
    return Number(value.offset);
  } catch {
    throw new ConversationHistoryError("cursor_expired", "History changed; reload the first page");
  }
}

function normalizeBaseText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replace(/[_.\\/:-]+/gu, " ")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeSearchText(value: string): string {
  const splitIdentifiers = normalizeBaseText(value);
  const cjkRuns =
    splitIdentifiers.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
    ) ?? [];
  const grams = cjkRuns.flatMap((run) => {
    const chars = Array.from(run);
    const result: string[] = [];
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= chars.length; index += 1) {
        result.push(chars.slice(index, index + size).join(""));
      }
    }
    return result;
  });
  return `${splitIdentifiers} ${grams.join(" ")}`.replace(/\s+/gu, " ").trim();
}

function ftsQuery(query: string): string {
  const rawTerms = query.match(/"([^"]+)"|[^\s"]+/gu) ?? [];
  return rawTerms
    .flatMap((rawTerm) => {
      const quoted = rawTerm.startsWith('"') && rawTerm.endsWith('"');
      const value = quoted ? rawTerm.slice(1, -1) : rawTerm;
      const normalized = quoted ? normalizeBaseText(value) : normalizeSearchText(value);
      if (!normalized) return [];
      if (quoted) return [`"${normalized.replaceAll('"', '""')}"`];
      return normalized
        .split(" ")
        .filter(Boolean)
        .map((term) => `"${term.replaceAll('"', '""')}"`);
    })
    .join(" AND ");
}

function searchNeedles(query: string): string[] {
  return (
    query
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/"([^"]+)"|[^\s]+/gu)
      ?.map((term) => term.replace(/^"|"$/gu, "")) ?? []
  );
}

function eventFromRow(row: Record<string, unknown>): ConversationHistoryEvent {
  const event: ConversationHistoryEvent = {
    eventId: String(row.event_id),
    role: row.role as ConversationHistoryEvent["role"],
    timestamp: typeof row.timestamp === "string" ? row.timestamp : null,
  };
  if (typeof row.text === "string") event.text = row.text;
  if (typeof row.tool_name === "string") event.toolName = row.tool_name;
  if (typeof row.tool_call_id === "string") event.toolCallId = row.tool_call_id;
  if (typeof row.tool_status === "string") event.toolStatus = row.tool_status;
  if (typeof row.tool_input === "string") event.toolInput = row.tool_input;
  if (typeof row.tool_result === "string") event.toolResult = row.tool_result;
  if (typeof row.original_size === "number") event.originalSize = row.original_size;
  if (row.truncated === 1) event.truncated = true;
  if (typeof row.attachment_name === "string") event.attachmentName = row.attachment_name;
  if (typeof row.attachment_mime === "string") event.attachmentMime = row.attachment_mime;
  return event;
}

function providerEnvironment(
  configStore: DaemonConfigStore,
  provider: ConversationHistoryProviderId,
): NodeJS.ProcessEnv {
  const configured = configStore.get().providers[provider];
  if (!configured || typeof configured !== "object") return process.env;
  const environment = Reflect.get(configured, "env");
  const overrides: Record<string, string> = {};
  if (environment && typeof environment === "object" && !Array.isArray(environment)) {
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value === "string") overrides[key] = value;
    }
  }
  const params = Reflect.get(configured, "params");
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const sessionDir = Reflect.get(params, "sessionDir");
    if (typeof sessionDir === "string" && sessionDir.trim()) {
      if (provider === "pi") overrides.PI_CODING_AGENT_SESSION_DIR = sessionDir;
      if (provider === "omp") overrides.OMP_SESSION_DIR = sessionDir;
    }
  }
  return { ...process.env, ...overrides };
}

export class ConversationHistoryService {
  private readonly databasePath: string;
  private readonly adapters: Map<ConversationHistoryProviderId, ConversationHistoryAdapter>;
  private readonly status = new Map<ConversationHistoryProviderId, ProviderRuntimeStatus>();
  private db: Database | null = null;
  private unavailableReason: string | null = null;
  private scanPromise: Promise<void> | null = null;
  private scanRevision = 0;
  private generation = 0;
  private rebuildAttempted = false;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private fileObserver: FileObserver | null = null;
  private observations: FileObserverSubscription[] = [];
  private observationDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly paseoHome: string,
    private readonly configStore: DaemonConfigStore,
    private readonly projectRegistry: ProjectRegistry,
    private readonly logger: LoggerLike,
    adapters?: ConversationHistoryAdapter[],
  ) {
    this.databasePath = path.join(paseoHome, "conversation-history.sqlite");
    const resolvedAdapters =
      adapters ??
      createConversationHistoryAdapters((provider) => providerEnvironment(configStore, provider));
    this.adapters = new Map(resolvedAdapters.map((adapter) => [adapter.provider, adapter]));
    for (const provider of PROVIDERS) this.status.set(provider, runtimeStatus());
    if (this.config().enabled)
      queueMicrotask(() => {
        void this.startObserving();
        void this.rescan();
      });
    this.reconcileTimer = setInterval(() => {
      if (this.config().enabled) void this.rescan();
    }, RECONCILE_MS);
    this.reconcileTimer.unref();
  }

  private config(): { enabled: boolean; providers: ConversationHistoryProviderId[] } {
    const value = this.configStore.get().conversationHistory;
    return { enabled: value?.enabled === true, providers: value?.providers ?? [] };
  }

  private async open(): Promise<Database | null> {
    if (this.db) return this.db;
    const module = sqlite();
    if (!module) {
      this.unavailableReason = "This Host runtime does not provide SQLite and FTS5";
      return null;
    }
    await mkdir(this.paseoHome, { recursive: true });
    let opened: Database | null = null;
    try {
      const db = new module.DatabaseSync(this.databasePath);
      opened = db;
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
      const version = Number(
        (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)
          ?.user_version ?? 0,
      );
      if (version !== 0 && version !== SCHEMA_VERSION) {
        db.close();
        await this.deleteDatabaseFiles();
        return this.open();
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          conversation_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          native_id TEXT NOT NULL,
          source_path TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          cwd TEXT,
          title TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          parent_conversation_id TEXT,
          stale INTEGER NOT NULL DEFAULT 0,
          has_tools INTEGER NOT NULL DEFAULT 0,
          UNIQUE(provider, native_id)
        );
        CREATE TABLE IF NOT EXISTS events (
          conversation_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          event_id TEXT NOT NULL,
          role TEXT NOT NULL,
          timestamp TEXT,
          text TEXT,
          tool_name TEXT,
          tool_call_id TEXT,
          tool_status TEXT,
          tool_input TEXT,
          tool_result TEXT,
          original_size INTEGER,
          truncated INTEGER,
          attachment_name TEXT,
          attachment_mime TEXT,
          PRIMARY KEY(conversation_id, ordinal),
          FOREIGN KEY(conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS conversations_activity_idx
          ON conversations(last_activity_at DESC, conversation_id);
        CREATE INDEX IF NOT EXISTS conversations_provider_activity_idx
          ON conversations(provider, last_activity_at DESC, conversation_id);
        CREATE INDEX IF NOT EXISTS events_conversation_role_idx
          ON events(conversation_id, role, ordinal);
        CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
          conversation_id UNINDEXED, event_id UNINDEXED, role UNINDEXED, timestamp UNINDEXED,
          text, normalized, tokenize='unicode61 remove_diacritics 2'
        );
        PRAGMA user_version=${SCHEMA_VERSION};
      `);
      this.db = db;
      this.rebuildAttempted = false;
      this.unavailableReason = null;
      return db;
    } catch {
      opened?.close();
      if (!this.rebuildAttempted) {
        this.rebuildAttempted = true;
        await this.deleteDatabaseFiles();
        return this.open();
      }
      this.unavailableReason = "The local Conversation history index could not be opened";
      this.logger.warn({ errorCategory: "sqlite_open_failed" }, "Conversation history unavailable");
      return null;
    }
  }

  private async deleteDatabaseFiles(): Promise<void> {
    await Promise.all([
      rm(this.databasePath, { force: true }),
      rm(`${this.databasePath}-wal`, { force: true }),
      rm(`${this.databasePath}-shm`, { force: true }),
    ]);
  }

  private async startObserving(): Promise<void> {
    await this.stopObserving();
    if (!this.config().enabled) return;
    const observer = createFileObserver();
    this.fileObserver = observer;
    const selected = new Set(this.config().providers);
    for (const adapter of this.adapters.values()) {
      if (!selected.has(adapter.provider)) continue;
      for (const root of adapter.sourceRoots()) {
        try {
          this.observations.push(
            await observer.subscribe(root, (error, events) => {
              if (error || events.length === 0) return;
              if (this.observationDebounce) clearTimeout(this.observationDebounce);
              this.observationDebounce = setTimeout(() => void this.rescan(), 500);
            }),
          );
        } catch {
          // Missing Provider roots are valid. Periodic reconciliation will pick
          // them up after the Provider creates its first persisted session.
        }
      }
    }
  }

  private async stopObserving(): Promise<void> {
    if (this.observationDebounce) clearTimeout(this.observationDebounce);
    this.observationDebounce = null;
    const subscriptions = this.observations.splice(0);
    await Promise.allSettled(subscriptions.map((subscription) => subscription.unsubscribe()));
    await this.fileObserver?.close();
    this.fileObserver = null;
  }

  private bumpGeneration(): void {
    this.generation += 1;
  }

  async settings(): Promise<ConversationHistorySettings> {
    if (this.config().enabled) await this.open();
    const config = this.config();
    return {
      enabled: config.enabled,
      providers: config.providers,
      indexPath: this.databasePath,
      providersStatus: PROVIDERS.map((provider) => ({
        provider,
        supported: this.adapters.has(provider),
        sourceDescription: this.adapters.get(provider)?.sourceDescription,
        enabled: config.enabled && config.providers.includes(provider),
        ...this.status.get(provider)!,
      })),
      unavailableReason: this.unavailableReason,
    };
  }

  async setSettings(
    enabled: boolean,
    providers: ConversationHistoryProviderId[],
  ): Promise<ConversationHistorySettings> {
    const selected = [...new Set(providers)].filter((provider) => this.adapters.has(provider));
    const previous = this.config();
    this.configStore.patch({ conversationHistory: { enabled, providers: selected } });
    await this.cancelActiveScan();
    for (const provider of PROVIDERS) {
      if (!enabled || !selected.includes(provider)) this.status.set(provider, runtimeStatus());
    }
    if (!enabled) {
      await this.stopObserving();
      await this.clear(true);
    } else {
      const db = await this.open();
      if (db) {
        const disabled = previous.providers.filter((provider) => !selected.includes(provider));
        for (const provider of disabled) this.deleteProvider(db, provider);
        void this.startObserving();
        void this.rescan();
      }
    }
    return this.settings();
  }

  async getStatus(): Promise<{
    state: "disabled" | "scanning" | "ready" | "empty" | "stale" | "failed" | "unavailable";
    conversationCount: number;
    providers: ConversationHistorySettings["providersStatus"];
    unavailableReason: string | null;
  }> {
    const settings = await this.settings();
    if (!settings.enabled)
      return {
        state: "disabled",
        conversationCount: 0,
        providers: settings.providersStatus,
        unavailableReason: null,
      };
    if (settings.unavailableReason)
      return {
        state: "unavailable",
        conversationCount: 0,
        providers: settings.providersStatus,
        unavailableReason: settings.unavailableReason,
      };
    const count = Number(
      (this.db!.prepare("SELECT COUNT(*) AS count FROM conversations").get() as { count: number })
        .count,
    );
    const states = new Set(
      settings.providersStatus
        .filter((provider) => provider.enabled)
        .map((provider) => provider.state),
    );
    let state: "scanning" | "stale" | "failed" | "empty" | "ready" = "ready";
    if (states.has("scanning")) state = "scanning";
    else if (states.has("stale")) state = "stale";
    else if (states.has("failed")) state = "failed";
    else if (count === 0) state = "empty";
    return {
      state,
      conversationCount: count,
      providers: settings.providersStatus,
      unavailableReason: null,
    };
  }

  async rescan(): Promise<boolean> {
    if (!this.config().enabled || this.scanPromise) return false;
    const revision = this.scanRevision;
    this.scanPromise = this.scan(revision).finally(() => {
      this.scanPromise = null;
    });
    void this.scanPromise;
    return true;
  }

  // Provider failure isolation and checkpoint cancellation live at this orchestration seam.
  // oxlint-disable-next-line complexity
  private async scan(revision: number): Promise<void> {
    const db = await this.open();
    if (!db || revision !== this.scanRevision) return;
    for (const provider of this.config().providers) {
      if (revision !== this.scanRevision) return;
      const adapter = this.adapters.get(provider);
      if (!adapter) continue;
      const current = this.status.get(provider)!;
      this.status.set(provider, {
        ...current,
        state: "scanning",
        scannedConversations: 0,
        errorCategory: null,
      });
      let sources;
      try {
        sources = await adapter.discover();
        if (revision !== this.scanRevision) return;
        this.status.set(provider, {
          ...this.status.get(provider)!,
          totalConversations: sources.length,
        });
      } catch {
        this.status.set(provider, {
          ...current,
          state: "failed",
          failureCount: current.failureCount + 1,
          errorCategory: "discovery_failed",
        });
        continue;
      }
      const seen = new Set<string>();
      let failures = 0;
      let stale = 0;
      for (const source of sources) {
        seen.add(source.path);
        const existing = db
          .prepare("SELECT fingerprint FROM conversations WHERE provider = ? AND source_path = ?")
          .get(provider, source.path) as { fingerprint?: string } | undefined;
        if (existing?.fingerprint === source.fingerprint) {
          this.status.get(provider)!.scannedConversations += 1;
          continue;
        }
        try {
          const conversation = await adapter.read(source);
          if (revision !== this.scanRevision) return;
          this.replaceConversation(db, provider, conversation);
        } catch {
          failures += 1;
          const changed = db
            .prepare("UPDATE conversations SET stale = 1 WHERE provider = ? AND source_path = ?")
            .run(provider, source.path).changes;
          if (Number(changed) > 0) stale += 1;
        }
        this.status.get(provider)!.scannedConversations += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (revision !== this.scanRevision) return;
      }
      const existingPaths = db
        .prepare("SELECT source_path FROM conversations WHERE provider = ?")
        .all(provider) as Array<{ source_path: string }>;
      for (const row of existingPaths)
        if (!seen.has(row.source_path)) this.deleteSource(db, provider, row.source_path);
      const completedAt = new Date().toISOString();
      const previous = this.status.get(provider)!;
      let providerState: "ready" | "stale" | "failed" = "ready";
      if (failures > 0) providerState = stale > 0 ? "stale" : "failed";
      this.status.set(provider, {
        ...previous,
        state: providerState,
        totalConversations: sources.length,
        staleCount: stale,
        failureCount: previous.failureCount + failures,
        lastSuccessfulSyncAt:
          failures < sources.length ? completedAt : previous.lastSuccessfulSyncAt,
        errorCategory: failures > 0 ? "parse_failed" : null,
      });
      this.logger.info(
        { provider, conversationCount: sources.length, failureCount: failures },
        "Conversation history provider scan completed",
      );
    }
  }

  private replaceConversation(
    db: Database,
    provider: ConversationHistoryProviderId,
    item: NormalizedHistoryConversation,
  ): void {
    const id = conversationId(provider, item.nativeId);
    const parentId = item.parentNativeId ? conversationId(provider, item.parentNativeId) : null;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM events_fts WHERE conversation_id = ?").run(id);
      db.prepare("DELETE FROM events WHERE conversation_id = ?").run(id);
      db.prepare(`INSERT INTO conversations (conversation_id, provider, native_id, source_path, fingerprint, cwd, title, last_activity_at, parent_conversation_id, stale, has_tools)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET source_path=excluded.source_path, fingerprint=excluded.fingerprint, cwd=excluded.cwd, title=excluded.title, last_activity_at=excluded.last_activity_at, parent_conversation_id=excluded.parent_conversation_id, stale=0, has_tools=excluded.has_tools`).run(
        id,
        provider,
        item.nativeId,
        item.sourcePath,
        item.fingerprint,
        item.cwd,
        item.title,
        item.lastActivityAt,
        parentId,
        item.events.some((event) => event.role === "tool") ? 1 : 0,
      );
      const insertEvent = db.prepare(
        "INSERT INTO events (conversation_id, ordinal, event_id, role, timestamp, text, tool_name, tool_call_id, tool_status, tool_input, tool_result, original_size, truncated, attachment_name, attachment_mime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertFts = db.prepare(
        "INSERT INTO events_fts (conversation_id, event_id, role, timestamp, text, normalized) VALUES (?, ?, ?, ?, ?, ?)",
      );
      item.events.forEach((event, ordinal) => {
        insertEvent.run(
          id,
          ordinal,
          event.eventId,
          event.role,
          event.timestamp,
          event.text ?? null,
          event.toolName ?? null,
          event.toolCallId ?? null,
          event.toolStatus ?? null,
          event.toolInput ?? null,
          event.toolResult ?? null,
          event.originalSize ?? null,
          event.truncated ? 1 : 0,
          event.attachmentName ?? null,
          event.attachmentMime ?? null,
        );
        if ((event.role === "user" || event.role === "assistant") && event.text)
          insertFts.run(
            id,
            event.eventId,
            event.role,
            event.timestamp,
            event.text,
            normalizeSearchText(event.text),
          );
      });
      db.exec("COMMIT");
      this.bumpGeneration();
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private deleteSource(
    db: Database,
    provider: ConversationHistoryProviderId,
    sourcePath: string,
  ): void {
    const rows = db
      .prepare("SELECT conversation_id FROM conversations WHERE provider = ? AND source_path = ?")
      .all(provider, sourcePath) as Array<{ conversation_id: string }>;
    for (const row of rows)
      db.prepare("DELETE FROM events_fts WHERE conversation_id = ?").run(row.conversation_id);
    db.prepare(
      "DELETE FROM events WHERE conversation_id IN (SELECT conversation_id FROM conversations WHERE provider = ? AND source_path = ?)",
    ).run(provider, sourcePath);
    db.prepare("DELETE FROM conversations WHERE provider = ? AND source_path = ?").run(
      provider,
      sourcePath,
    );
    if (rows.length > 0) this.bumpGeneration();
  }

  private deleteProvider(db: Database, provider: ConversationHistoryProviderId): void {
    const rows = db
      .prepare("SELECT conversation_id FROM conversations WHERE provider = ?")
      .all(provider) as Array<{ conversation_id: string }>;
    for (const row of rows)
      db.prepare("DELETE FROM events_fts WHERE conversation_id = ?").run(row.conversation_id);
    db.prepare(
      "DELETE FROM events WHERE conversation_id IN (SELECT conversation_id FROM conversations WHERE provider = ?)",
    ).run(provider);
    db.prepare("DELETE FROM conversations WHERE provider = ?").run(provider);
    if (rows.length > 0) this.bumpGeneration();
  }

  async clear(closing = false): Promise<boolean> {
    await this.cancelActiveScan();
    this.db?.close();
    this.db = null;
    await this.deleteDatabaseFiles();
    this.bumpGeneration();
    if (!closing && this.config().enabled) await this.open();
    return true;
  }

  private async cancelActiveScan(): Promise<void> {
    this.scanRevision += 1;
    const activeScan = this.scanPromise;
    if (activeScan) await activeScan.catch(() => undefined);
  }

  // The public filter contract is deliberately assembled in one query builder.
  // oxlint-disable-next-line complexity
  async browse(
    request: ConversationHistoryBrowseRequest,
  ): Promise<{ conversations: ConversationHistoryConversation[]; nextCursor: string | null }> {
    if (!this.config().enabled)
      throw new ConversationHistoryError("unavailable", "Conversation history is disabled");
    const db = await this.open();
    if (!db)
      throw new ConversationHistoryError(
        "unavailable",
        this.unavailableReason ?? "History unavailable",
      );
    const offset = decodeCursor(request.cursor, this.generation);
    const limit = request.limit ?? 50;
    const projects = await this.projectRegistry.list();
    const where: string[] = [];
    const params: unknown[] = [];
    if (request.providers?.length) {
      where.push(`c.provider IN (${request.providers.map(() => "?").join(",")})`);
      params.push(...request.providers);
    }
    if (request.from) {
      where.push("c.last_activity_at >= ?");
      params.push(request.from);
    }
    if (request.to) {
      where.push("c.last_activity_at <= ?");
      params.push(request.to);
    }
    if (request.hasTools !== undefined) {
      where.push("c.has_tools = ?");
      params.push(request.hasTools ? 1 : 0);
    }
    if (request.role) {
      where.push(
        "EXISTS (SELECT 1 FROM events er WHERE er.conversation_id = c.conversation_id AND er.role = ?)",
      );
      params.push(request.role);
    }
    if (request.projectId !== undefined) {
      const activeProjects = projects.filter((project) => project.archivedAt === null);
      const appendProjectMatchCount = (): string => {
        const matches = activeProjects.map((project) => {
          const root = path.resolve(project.rootPath);
          params.push(root, `${root}${path.sep}%`);
          return "CASE WHEN c.cwd = ? OR c.cwd LIKE ? THEN 1 ELSE 0 END";
        });
        return matches.length > 0 ? matches.join(" + ") : "0";
      };
      if (request.projectId === null) {
        where.push(`(c.cwd IS NULL OR (${appendProjectMatchCount()}) != 1)`);
      } else {
        const project = activeProjects.find((item) => item.projectId === request.projectId);
        if (!project) return { conversations: [], nextCursor: null };
        const root = path.resolve(project.rootPath);
        where.push("(c.cwd = ? OR c.cwd LIKE ?)");
        params.push(root, `${root}${path.sep}%`);
        where.push(`(${appendProjectMatchCount()}) = 1`);
      }
    }
    let join = "";
    let order = "c.last_activity_at DESC, c.conversation_id ASC";
    const searchParams: unknown[] = [];
    const searchExpression = request.query?.trim() ? ftsQuery(request.query) : "";
    if (searchExpression) {
      const roleClause = request.role ? " AND role = ?" : "";
      join = `JOIN (WITH ranked AS MATERIALIZED (SELECT conversation_id, bm25(events_fts) AS rank FROM events_fts WHERE events_fts MATCH ?${roleClause}) SELECT conversation_id, MIN(rank) AS rank FROM ranked GROUP BY conversation_id) search ON search.conversation_id = c.conversation_id`;
      searchParams.push(searchExpression);
      if (request.role) searchParams.push(request.role);
      order = "search.rank ASC, c.last_activity_at DESC, c.conversation_id ASC";
    }
    const rows = db
      .prepare(
        `SELECT c.* FROM conversations c ${join} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...searchParams, ...params, limit + 1, offset) as ConversationRow[];
    let result = rows.slice(0, limit).map((row) => this.toPublicConversation(row, projects));
    if (searchExpression && request.query) {
      const query = request.query;
      result = result.map((item) => ({
        ...item,
        snippets: this.snippets(db, item.conversationId, query, request.role),
      }));
    }
    return {
      conversations: result,
      nextCursor: rows.length > limit ? encodeCursor(this.generation, offset + limit) : null,
    };
  }

  private toPublicConversation(
    row: ConversationRow,
    projects: Awaited<ReturnType<ProjectRegistry["list"]>>,
  ): ConversationHistoryConversation {
    const resolvedCwd = row.cwd ? path.resolve(row.cwd) : null;
    const matches = resolvedCwd
      ? projects.filter((project) => {
          if (project.archivedAt !== null) return false;
          const root = path.resolve(project.rootPath);
          return resolvedCwd === root || resolvedCwd.startsWith(`${root}${path.sep}`);
        })
      : [];
    const project = matches.length === 1 ? matches[0]! : null;
    return {
      conversationId: row.conversation_id,
      provider: row.provider,
      title: row.title,
      projectId: project?.projectId ?? null,
      projectName: project ? (project.customName ?? project.displayName) : null,
      lastActivityAt: row.last_activity_at,
      stale: row.stale === 1,
      hasTools: row.has_tools === 1,
      parentConversationId: row.parent_conversation_id,
    };
  }

  private snippets(
    db: Database,
    id: string,
    query: string,
    role?: "user" | "assistant",
  ): NonNullable<ConversationHistoryConversation["snippets"]> {
    const needles = searchNeedles(query);
    const roleClause = role ? " AND role = ?" : "";
    const rows = db
      .prepare(
        `SELECT event_id, role, timestamp, text FROM events WHERE conversation_id = ? AND role IN ('user','assistant')${roleClause} ORDER BY ordinal`,
      )
      .all(...(role ? [id, role] : [id])) as Array<{
      event_id: string;
      role: "user" | "assistant";
      timestamp: string | null;
      text: string | null;
    }>;
    return rows
      .filter(
        (row) =>
          row.text &&
          needles.every((needle) =>
            normalizeSearchText(row.text!).includes(normalizeBaseText(needle)),
          ),
      )
      .slice(0, 3)
      .map((row) => ({
        eventId: row.event_id,
        role: row.role,
        timestamp: row.timestamp,
        text: row.text!.length > 320 ? `${row.text!.slice(0, 320)}…` : row.text!,
      }));
  }

  async detail(
    conversationIdValue: string,
    cursor?: string,
    requestedLimit?: number,
    eventId?: string,
  ): Promise<{
    conversation: ConversationHistoryConversation;
    events: ConversationHistoryEvent[];
    nextCursor: string | null;
  }> {
    if (!this.config().enabled)
      throw new ConversationHistoryError("unavailable", "Conversation history is disabled");
    const db = await this.open();
    if (!db)
      throw new ConversationHistoryError(
        "unavailable",
        this.unavailableReason ?? "History unavailable",
      );
    const limit = requestedLimit ?? 100;
    const row = db
      .prepare("SELECT * FROM conversations WHERE conversation_id = ?")
      .get(conversationIdValue) as ConversationRow | undefined;
    if (!row) throw new ConversationHistoryError("not_found", "History conversation not found");
    let offset = decodeCursor(cursor, this.generation);
    if (!cursor && eventId) {
      const anchor = db
        .prepare("SELECT ordinal FROM events WHERE conversation_id = ? AND event_id = ?")
        .get(conversationIdValue, eventId) as { ordinal?: number } | undefined;
      if (typeof anchor?.ordinal === "number") offset = anchor.ordinal;
    }
    const eventRows = db
      .prepare("SELECT * FROM events WHERE conversation_id = ? ORDER BY ordinal LIMIT ? OFFSET ?")
      .all(conversationIdValue, limit + 1, offset) as Array<Record<string, unknown>>;
    const events = eventRows.slice(0, limit).map(eventFromRow);
    return {
      conversation: this.toPublicConversation(row, await this.projectRegistry.list()),
      events,
      nextCursor: eventRows.length > limit ? encodeCursor(this.generation, offset + limit) : null,
    };
  }
}

export function getConversationHistoryService(input: {
  paseoHome: string;
  configStore: DaemonConfigStore;
  projectRegistry: ProjectRegistry;
  logger: LoggerLike;
}): ConversationHistoryService {
  const key = path.resolve(input.paseoHome);
  const existing = services.get(key);
  if (existing) return existing;
  const service = new ConversationHistoryService(
    input.paseoHome,
    input.configStore,
    input.projectRegistry,
    input.logger.child({ module: "conversation-history" }),
  );
  services.set(key, service);
  return service;
}
