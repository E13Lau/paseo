import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { openSettings } from "../support/helpers/app";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  addDirectHostFromSettings,
  clickSettingsBackToWorkspace,
} from "../support/helpers/settings";

function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe("Conversation history", () => {
  test.describe.configure({ timeout: 180_000 });

  test("enables a selected Provider, searches, opens a match, and copies evidence", async ({
    page,
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-history-browser-"));
    const claudeRoot = path.join(root, "claude");
    const historyDir = path.join(claudeRoot, "projects", "project-a");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      path.join(historyDir, "session.jsonl"),
      `${[
        {
          type: "user",
          sessionId: "browser-history-session",
          uuid: "history-user",
          cwd: path.join(root, "repo"),
          timestamp: "2026-08-18T01:00:00Z",
          message: { content: "Where is the lexicalSearch index?" },
        },
        {
          type: "assistant",
          sessionId: "browser-history-session",
          uuid: "history-assistant",
          timestamp: "2026-08-18T01:01:00Z",
          message: { content: "The lexical_search index lives under PASEO_HOME." },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    const daemon = await startIsolatedHostDaemon("conversation-history-browser", {
      environment: { ...process.env, CLAUDE_CONFIG_DIR: claudeRoot },
    });

    try {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto("/");
      await openSettings(page);
      await addDirectHostFromSettings(page, { host: "127.0.0.1", port: daemon.port });
      await clickSettingsBackToWorkspace(page);
      await page.getByTestId("sidebar-hosts-trigger").click();
      await page.getByTestId(`sidebar-host-row-${daemon.serverId}`).click();

      await expect(page.getByTestId("history-disabled-state")).toBeVisible();
      await page.getByText("Claude", { exact: true }).click();
      await page.getByTestId("history-enable-scan").click();
      await expect(page.getByText("Where is the lexicalSearch index?")).toBeVisible({
        timeout: 30_000,
      });

      await page.getByTestId("history-search-input").fill('"lexical search"');
      await expect(
        page.getByText("The lexical_search index lives under PASEO_HOME."),
      ).toBeVisible();
      await page.getByLabel("Copy snippet").last().click();
      await expect
        .poll(() => readClipboard(page))
        .toBe("The lexical_search index lives under PASEO_HOME.");
      await page.getByText("The lexical_search index lives under PASEO_HOME.").click();
      await expect(page.getByText("Back to results")).toBeVisible();
      await expect(
        page.getByText("The lexical_search index lives under PASEO_HOME."),
      ).toBeVisible();
    } finally {
      await daemon.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
