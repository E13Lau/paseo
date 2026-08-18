import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

const performanceTest = process.env.PASEO_HISTORY_PERFORMANCE === "1" ? test : test.skip;
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
let context: DaemonTestContext | null = null;
let root: string | null = null;

afterEach(async () => {
  if (context) {
    await context.client.setConversationHistorySettings(false, []).catch(() => undefined);
    await context.cleanup();
    context = null;
  }
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
});

function percentile95(samples: number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

async function duration(run: () => Promise<unknown>): Promise<number> {
  const startedAt = performance.now();
  await run();
  return performance.now() - startedAt;
}

performanceTest(
  "keeps indexed search, browse, and detail within the million-event baseline",
  async () => {
    root = await mkdtemp(path.join(tmpdir(), "paseo-history-performance-"));
    const historyDir = path.join(root, "claude", "projects", "performance");
    await mkdir(historyDir, { recursive: true });
    for (let conversation = 0; conversation < 1_000; conversation += 1) {
      const lines: string[] = [];
      for (let event = 0; event < 1_000; event += 1) {
        lines.push(
          JSON.stringify({
            type: event % 2 === 0 ? "user" : "assistant",
            sessionId: `conversation-${conversation}`,
            uuid: `event-${event}`,
            timestamp: new Date(1_700_000_000_000 + conversation * 1_000 + event).toISOString(),
            message: {
              content:
                event === 500
                  ? `exactHistoryNeedle conversation ${conversation}`
                  : `ordinary event ${event}`,
            },
          }),
        );
      }
      await writeFile(path.join(historyDir, `${conversation}.jsonl`), `${lines.join("\n")}\n`);
    }

    process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
    context = await createDaemonTestContext();
    await context.client.setConversationHistorySettings(true, ["claude"]);
    await vi.waitFor(
      async () => {
        const status = await context!.client.getConversationHistoryStatus();
        expect(status).toMatchObject({ state: "ready", conversationCount: 1_000 });
      },
      { timeout: 30 * 60_000, interval: 1_000 },
    );

    const first = await context.client.browseConversationHistory({ limit: 1 });
    const conversationId = first.conversations[0]!.conversationId;
    await context.client.browseConversationHistory({ query: "exactHistoryNeedle" });
    const searchSamples: number[] = [];
    const readSamples: number[] = [];
    for (let sample = 0; sample < 20; sample += 1) {
      searchSamples.push(
        await duration(() =>
          context!.client.browseConversationHistory({ query: "exactHistoryNeedle" }),
        ),
      );
      readSamples.push(
        await duration(async () => {
          await context!.client.browseConversationHistory();
          await context!.client.getConversationHistoryDetail(conversationId);
        }),
      );
    }
    expect(percentile95(searchSamples)).toBeLessThan(500);
    expect(percentile95(readSamples)).toBeLessThan(300);
  },
  35 * 60_000,
);
