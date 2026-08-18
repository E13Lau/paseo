import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { createConversationHistoryAdapters } from "./adapters.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-history-adapter-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Conversation history provider adapters", () => {
  test("normalizes Claude and ignores an incomplete trailing record", async () => {
    const root = await tempRoot();
    const projects = path.join(root, "projects", "project-a");
    await mkdir(projects, { recursive: true });
    await writeFile(
      path.join(projects, "session.jsonl"),
      [
        JSON.stringify({
          type: "user",
          sessionId: "claude-1",
          uuid: "u1",
          cwd: "/repo",
          timestamp: "2026-08-18T01:00:00Z",
          message: { content: "Find the buildConfig value" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "claude-1",
          uuid: "a1",
          timestamp: "2026-08-18T01:01:00Z",
          message: {
            content: [
              { type: "text", text: "It is in build_config.ts" },
              { type: "tool_use", id: "tool-1", name: "Read", input: "x".repeat(70_000) },
              { type: "file", filename: "design.pdf", mimeType: "application/pdf" },
            ],
          },
        }),
        '{"type":"assistant","message":',
      ].join("\n"),
    );
    const adapter = createConversationHistoryAdapters({ CLAUDE_CONFIG_DIR: root }).find(
      (item) => item.provider === "claude",
    )!;
    const sources = await adapter.discover();
    expect(sources).toHaveLength(1);
    const conversation = await adapter.read(sources[0]!);
    expect(conversation).toMatchObject({
      nativeId: "claude-1",
      cwd: "/repo",
      title: "Find the buildConfig value",
    });
    expect(conversation.events.map((event) => event.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "attachment",
    ]);
    expect(conversation.events[2]).toMatchObject({
      toolCallId: "tool-1",
      truncated: true,
      originalSize: 70_000,
    });
    expect(Buffer.byteLength(conversation.events[2]!.toolInput ?? "")).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(conversation.events[3]).toMatchObject({
      attachmentName: "design.pdf",
      attachmentMime: "application/pdf",
    });
  });

  test("keeps Claude subagents separate and links them to their parent conversation", async () => {
    const root = await tempRoot();
    const subagents = path.join(root, "projects", "project-a", "parent-1", "subagents");
    await mkdir(subagents, { recursive: true });
    await writeFile(
      path.join(subagents, "agent-child-1.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        isSidechain: true,
        agentId: "child-1",
        uuid: "child-message",
        timestamp: "2026-08-18T01:01:00Z",
        message: { content: "Child result" },
      })}\n`,
    );
    const adapter = createConversationHistoryAdapters({ CLAUDE_CONFIG_DIR: root }).find(
      (item) => item.provider === "claude",
    )!;
    const conversation = await adapter.read((await adapter.discover())[0]!);
    expect(conversation).toMatchObject({ nativeId: "child-1", parentNativeId: "parent-1" });
  });

  test.each([
    {
      provider: "codex" as const,
      envKey: "CODEX_HOME",
      nested: "sessions/2026/08/18",
      lines: [
        { type: "session_meta", payload: { id: "codex-1", cwd: "/repo" } },
        {
          type: "event_msg",
          timestamp: "2026-08-18T02:00:00Z",
          payload: { type: "user_message", message: "修复搜索" },
        },
        {
          type: "event_msg",
          timestamp: "2026-08-18T02:01:00Z",
          payload: { type: "agent_message", message: "已经修复" },
        },
      ],
    },
    {
      provider: "pi" as const,
      envKey: "PI_CODING_AGENT_SESSION_DIR",
      nested: "sessions/project",
      lines: [
        { type: "session", id: "pi-1", cwd: "/repo" },
        {
          type: "message",
          id: "p1",
          timestamp: "2026-08-18T03:00:00Z",
          message: { role: "user", content: "Pi question" },
        },
        {
          type: "message",
          id: "p2",
          timestamp: "2026-08-18T03:01:00Z",
          message: { role: "assistant", content: [{ type: "text", text: "Pi answer" }] },
        },
      ],
    },
    {
      provider: "omp" as const,
      envKey: "OMP_SESSION_DIR",
      nested: "sessions/project",
      lines: [
        { type: "session", id: "omp-1", cwd: "/repo" },
        {
          type: "message",
          id: "o1",
          timestamp: "2026-08-18T04:00:00Z",
          message: { role: "user", content: "OMP question" },
        },
        {
          type: "message",
          id: "o2",
          timestamp: "2026-08-18T04:01:00Z",
          message: { role: "assistant", content: [{ type: "text", text: "OMP answer" }] },
        },
      ],
    },
  ])("normalizes $provider persisted sessions", async ({ provider, envKey, nested, lines }) => {
    const root = await tempRoot();
    const sessions = path.join(root, nested);
    await mkdir(sessions, { recursive: true });
    await writeFile(
      path.join(sessions, "session.jsonl"),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    const configuredRoot = provider === "codex" ? root : path.join(root, "sessions");
    const adapter = createConversationHistoryAdapters({ [envKey]: configuredRoot }).find(
      (item) => item.provider === provider,
    )!;
    const conversation = await adapter.read((await adapter.discover())[0]!);
    expect(conversation.nativeId).toBe(`${provider}-1`);
    expect(conversation.events.map((event) => event.role)).toEqual(["user", "assistant"]);
  });
});
