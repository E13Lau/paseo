import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { ConversationHistoryAdapter } from "./adapters.js";
import { ConversationHistoryService } from "./service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("indexes, searches, paginates, and purges provider-derived conversations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-history-service-"));
  roots.push(root);
  let config: MutableDaemonConfig = {
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  };
  let fingerprint = "1";
  let failRead = false;
  let sourcePresent = true;
  const adapter: ConversationHistoryAdapter = {
    provider: "codex",
    sourceDescription: "test",
    sourceRoots: () => [],
    async discover() {
      return sourcePresent
        ? [{ nativeId: "native-1", path: "/source/one.jsonl", fingerprint }]
        : [];
    },
    async read(source) {
      if (failRead) throw new Error("fixture parse failure");
      return {
        nativeId: source.nativeId,
        sourcePath: source.path,
        fingerprint: source.fingerprint,
        cwd: "/repo",
        title: "Build config",
        lastActivityAt: "2026-08-18T02:00:00.000Z",
        parentNativeId: null,
        events: [
          {
            eventId: "u1",
            role: "user",
            timestamp: "2026-08-18T01:00:00.000Z",
            text: "查找配置 buildConfig",
          },
          {
            eventId: "a1",
            role: "assistant",
            timestamp: "2026-08-18T02:00:00.000Z",
            text: "Located build_config in src/config.ts",
          },
        ],
      };
    },
  };
  const configStore = {
    get: () => config,
    patch: (value: Partial<MutableDaemonConfig>) => {
      config = { ...config, ...value } as MutableDaemonConfig;
      return config;
    },
  };
  const projectRegistry = {
    list: async () => [
      {
        projectId: "project-1",
        rootPath: "/repo",
        displayName: "Repo",
        customName: null,
        archivedAt: null,
      },
    ],
  };
  const logger = { child: () => logger, info: vi.fn(), warn: vi.fn() };
  const service = new ConversationHistoryService(
    root,
    configStore as never,
    projectRegistry as never,
    logger,
    [adapter],
  );

  await expect(
    service.browse({ type: "conversation_history.browse.request", requestId: "disabled" }),
  ).rejects.toThrow("disabled");
  await service.setSettings(true, ["codex"]);
  await vi.waitFor(async () => expect((await service.getStatus()).state).toBe("ready"));

  const result = await service.browse({
    type: "conversation_history.browse.request",
    requestId: "r1",
    query: "查找配置",
    limit: 1,
  });
  expect(result.conversations).toMatchObject([
    { provider: "codex", projectId: "project-1", snippets: [{ eventId: "u1" }] },
  ]);
  const identifierResult = await service.browse({
    type: "conversation_history.browse.request",
    requestId: "r2",
    query: "build config",
  });
  expect(identifierResult.conversations).toHaveLength(1);
  const phraseResult = await service.browse({
    type: "conversation_history.browse.request",
    requestId: "phrase",
    query: '"build config"',
  });
  expect(phraseResult.conversations).toHaveLength(1);
  const roleMismatch = await service.browse({
    type: "conversation_history.browse.request",
    requestId: "role-mismatch",
    query: "Located",
    role: "user",
  });
  expect(roleMismatch.conversations).toEqual([]);

  const firstDetailPage = await service.detail(
    result.conversations[0]!.conversationId,
    undefined,
    1,
  );
  expect(firstDetailPage.nextCursor).not.toBeNull();
  const anchoredDetailPage = await service.detail(
    result.conversations[0]!.conversationId,
    undefined,
    1,
    "a1",
  );
  expect(anchoredDetailPage.events[0]?.eventId).toBe("a1");

  fingerprint = "2";
  failRead = true;
  expect(await service.rescan()).toBe(true);
  await vi.waitFor(async () => expect((await service.getStatus()).state).toBe("stale"));
  const staleResult = await service.browse({
    type: "conversation_history.browse.request",
    requestId: "stale",
  });
  expect(staleResult.conversations[0]).toMatchObject({ stale: true, title: "Build config" });

  failRead = false;
  expect(await service.rescan()).toBe(true);
  await vi.waitFor(async () => expect((await service.getStatus()).state).toBe("ready"));
  await expect(
    service.detail(
      result.conversations[0]!.conversationId,
      firstDetailPage.nextCursor ?? undefined,
      1,
    ),
  ).rejects.toMatchObject({ code: "cursor_expired" });
  await service.setSettings(true, []);
  expect(
    (await service.browse({ type: "conversation_history.browse.request", requestId: "r3" }))
      .conversations,
  ).toEqual([]);

  await service.setSettings(true, ["codex"]);
  await vi.waitFor(async () =>
    expect(
      (await service.browse({ type: "conversation_history.browse.request", requestId: "readded" }))
        .conversations,
    ).toHaveLength(1),
  );
  await vi.waitFor(async () => expect((await service.getStatus()).state).toBe("ready"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  sourcePresent = false;
  expect(await service.rescan()).toBe(true);
  await vi.waitFor(async () =>
    expect(
      (await service.browse({ type: "conversation_history.browse.request", requestId: "deleted" }))
        .conversations,
    ).toEqual([]),
  );
});
