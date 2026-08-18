import { access, appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

let ctx: DaemonTestContext | null = null;
let root: string | null = null;
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

afterEach(async () => {
  if (ctx) {
    await ctx.client.setConversationHistorySettings(false, []).catch(() => undefined);
    await ctx.cleanup();
    ctx = null;
  }
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
});

test("browses seeded Provider history through DaemonClient without creating an Agent", async () => {
  root = await mkdtemp(path.join(tmpdir(), "paseo-history-e2e-"));
  const projectDir = path.join(root, "repo");
  const historyDir = path.join(root, "claude", "projects", "repo");
  await Promise.all([
    mkdir(projectDir, { recursive: true }),
    mkdir(historyDir, { recursive: true }),
  ]);
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  const historyPath = path.join(historyDir, "conversation.jsonl");
  await writeFile(
    historyPath,
    `${[
      {
        type: "user",
        sessionId: "native-session",
        uuid: "user-1",
        cwd: projectDir,
        timestamp: "2026-08-18T01:00:00Z",
        message: { content: "Where is searchIndex built?" },
      },
      {
        type: "assistant",
        sessionId: "native-session",
        uuid: "assistant-1",
        cwd: projectDir,
        timestamp: "2026-08-18T01:01:00Z",
        message: { content: "The search_index is built by the Daemon." },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")}\n`,
  );

  ctx = await createDaemonTestContext();
  expect(ctx.client.getLastServerInfoMessage()?.features?.conversationHistory).toBe(true);
  const disabled = await ctx.client.getConversationHistorySettings();
  expect(disabled.enabled).toBe(false);
  const enabled = await ctx.client.setConversationHistorySettings(true, ["claude"]);
  expect(enabled.providers).toEqual(["claude"]);

  await vi.waitFor(
    async () => expect((await ctx!.client.getConversationHistoryStatus()).state).toBe("ready"),
    { timeout: 10_000 },
  );
  const search = await ctx.client.browseConversationHistory({ query: "search index" });
  expect(search.conversations).toMatchObject([
    { provider: "claude", title: "Where is searchIndex built?", stale: false },
  ]);
  expect(search.conversations[0]).not.toHaveProperty("sourcePath");
  const detail = await ctx.client.getConversationHistoryDetail(
    search.conversations[0]!.conversationId,
  );
  expect(detail.events.map((event) => event.text)).toEqual([
    "Where is searchIndex built?",
    "The search_index is built by the Daemon.",
  ]);

  await appendFile(
    historyPath,
    `${JSON.stringify({
      type: "assistant",
      sessionId: "native-session",
      uuid: "assistant-2",
      cwd: projectDir,
      timestamp: "2026-08-18T01:02:00Z",
      message: { content: "The observer refresh arrived." },
    })}\n`,
  );
  await vi.waitFor(
    async () => {
      const observed = await ctx!.client.browseConversationHistory({ query: "observer refresh" });
      expect(observed.conversations).toHaveLength(1);
    },
    { timeout: 10_000 },
  );

  const indexPath = enabled.indexPath;
  await ctx.client.setConversationHistorySettings(false, []);
  await expect(access(indexPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await ctx.client.fetchAgents()).entries).toEqual([]);
});
