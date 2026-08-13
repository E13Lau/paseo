import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import {
  attachImageFromMenu,
  composerLocator,
  expectAttachmentPill,
  expectComposerDraft,
  expectComposerEditable,
  expectComposerVisible,
} from "../support/helpers/composer";
import { expectAgentIdle, expectAgentReadyToInterrupt } from "../support/helpers/agent-stream";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { openSettingsSection } from "../support/helpers/settings";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import type { Dialog } from "@playwright/test";

const IMAGE = {
  name: "saved-prompt-context.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
};

async function openSavedPrompts(page: Page): Promise<void> {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "saved-prompts");
  await expect(page.getByTestId("saved-prompts-list")).toBeVisible();
}

async function openCreateForm(page: Page): Promise<void> {
  const add = page
    .getByTestId("saved-prompts-add")
    .or(page.getByRole("button", { name: "New saved prompt", exact: true }));
  await add.first().click();
  await expect(page.getByTestId("saved-prompt-form-sheet")).toBeVisible();
}

async function fillSavedPromptForm(
  page: Page,
  input: { name: string; body: string },
): Promise<void> {
  await page.getByTestId("saved-prompt-name-input").fill(input.name);
  await page.getByTestId("saved-prompt-body-input").fill(input.body);
}

async function saveForm(page: Page): Promise<void> {
  await page.getByTestId("saved-prompt-save").click();
  await expect(page.getByTestId("saved-prompt-form-sheet")).toHaveCount(0);
}

function savedPromptRows(page: Page) {
  return page.locator('[data-testid^="saved-prompt-row-"]');
}

async function expectPromptOrder(page: Page, names: string[]): Promise<void> {
  await expect(savedPromptRows(page)).toHaveCount(names.length);
  for (const [index, name] of names.entries()) {
    await expect(savedPromptRows(page).nth(index)).toContainText(name);
  }
}

async function setComposerSelection(page: Page, start: number, end = start): Promise<void> {
  await composerLocator(page).evaluate(
    (element, selection) => {
      const input = element as HTMLTextAreaElement;
      input.focus();
      input.setSelectionRange(selection.start, selection.end);
    },
    { start, end },
  );
}

async function acceptTemporaryRemoval(dialog: Dialog): Promise<void> {
  expect(dialog.message()).toContain("Temporary");
  await dialog.accept();
}

async function getComposerSelectionStart(page: Page): Promise<number | null> {
  return composerLocator(page).evaluate(
    (element) => (element as HTMLTextAreaElement).selectionStart,
  );
}

async function getComposerSelection(page: Page): Promise<{ start: number; end: number }> {
  return composerLocator(page).evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    return { start: input.selectionStart, end: input.selectionEnd };
  });
}

async function expectPromptRowBeforeAttachment(page: Page): Promise<void> {
  const promptRow = page.getByTestId("saved-prompts-composer-row");
  const attachment = page.getByTestId("composer-image-attachment-pill").first();
  const attachmentHandle = await attachment.elementHandle();
  expect(
    await promptRow.evaluate(
      (row, tray) =>
        Boolean(row.compareDocumentPosition(tray as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
      attachmentHandle,
    ),
  ).toBe(true);
}

async function setSendBehavior(page: Page, behavior: "Interrupt" | "Queue"): Promise<void> {
  await page.goto(buildSettingsSectionRoute("general"));
  await page.getByRole("button", { name: behavior, exact: true }).click();
  await expect
    .poll(async () => {
      const raw = await page.evaluate(() => localStorage.getItem("@paseo:app-settings"));
      if (!raw) {
        return null;
      }
      return (JSON.parse(raw) as { sendBehavior?: string }).sendBehavior ?? null;
    })
    .toBe(behavior.toLowerCase());
}

test.describe("Saved prompts", () => {
  test("manages prompts and uses them from an existing agent Composer", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const gate = await installDaemonWebSocketGate(page);
    const agents: MockAgentWorkspace[] = [];
    try {
      await openSavedPrompts(page);
      await expect(page.getByTestId("saved-prompts-empty")).toBeVisible();

      await test.step("create, validate, edit, reorder, and remove", async () => {
        await openCreateForm(page);
        await fillSavedPromptForm(page, { name: "Review", body: "   " });
        await expect(page.getByText("Prompt must contain text", { exact: true })).toBeVisible();
        await expect(page.getByTestId("saved-prompt-save")).toBeDisabled();
        await page.getByTestId("saved-prompt-body-input").fill(" first\nsecond ");
        await saveForm(page);

        await openCreateForm(page);
        await fillSavedPromptForm(page, { name: "  Review  ", body: "duplicate" });
        await expect(page.getByText("Name must be unique", { exact: true })).toBeVisible();
        await page.getByTestId("saved-prompt-name-input").fill("Temporary");
        await saveForm(page);

        await openCreateForm(page);
        await fillSavedPromptForm(page, { name: "Action", body: "  /clear  " });
        await saveForm(page);
        await expectPromptOrder(page, ["Review", "Temporary", "Action"]);

        await page.getByRole("button", { name: "Move Action up", exact: true }).click();
        await page.getByRole("button", { name: "Move Action up", exact: true }).click();
        await expectPromptOrder(page, ["Action", "Review", "Temporary"]);

        await page.getByRole("button", { name: "Edit Review", exact: true }).click();
        await expect(page.getByTestId("saved-prompt-name-input")).toHaveValue("Review");
        await expect(page.getByTestId("saved-prompt-body-input")).toHaveValue(" first\nsecond ");
        await fillSavedPromptForm(page, { name: "Review notes", body: " revised\nbody " });
        await saveForm(page);

        await page.getByRole("button", { name: "Edit Review notes", exact: true }).click();
        await expect(page.getByTestId("saved-prompt-name-input")).toHaveValue("Review notes");
        await expect(page.getByTestId("saved-prompt-body-input")).toHaveValue(" revised\nbody ");
        await page.getByTestId("saved-prompt-cancel").click();
        await expect(page.getByTestId("saved-prompt-form-sheet")).toHaveCount(0);

        page.once("dialog", acceptTemporaryRemoval);
        await page.getByRole("button", { name: "Remove Temporary", exact: true }).click();
        await expectPromptOrder(page, ["Action", "Review notes"]);
      });

      await test.step("the ordered list survives reload", async () => {
        await page.reload();
        await expect(page.getByTestId("saved-prompts-list")).toBeVisible();
        await expectPromptOrder(page, ["Action", "Review notes"]);
      });

      const agent = await seedMockAgentWorkspace({
        repoPrefix: `saved-prompts-${testInfo.workerIndex}-`,
        title: "Saved prompts journey",
      });
      agents.push(agent);

      await test.step("insertion replaces the selection and restores focus", async () => {
        await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
        await expectComposerVisible(page);
        await expectAgentIdle(page);
        await expect(page.getByTestId("saved-prompts-composer-row")).toBeVisible();

        const composer = composerLocator(page);
        await composer.fill("before SELECT after");
        await setComposerSelection(page, 7, 13);
        expect(await getComposerSelection(page)).toEqual({ start: 7, end: 13 });
        await page.getByRole("button", { name: "Review notes", exact: true }).click();
        await expectComposerDraft(page, "before  revised\nbody  after");
        await expect(composer).toBeFocused();
        await expect.poll(getComposerSelectionStart.bind(null, page)).toBe(21);

        await page.getByRole("button", { name: "Review notes", exact: true }).click();
        await expectComposerDraft(page, "before  revised\nbody  revised\nbody  after");
      });

      await test.step("automatic sending is independent and only disables the selected action", async () => {
        await page.goto(buildSettingsSectionRoute("saved-prompts"));
        await page.getByTestId("saved-prompts-automatic-sending").click();
        await expect(page.getByTestId("saved-prompts-automatic-sending")).toBeChecked();

        await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
        await expectComposerVisible(page);
        await expectAgentIdle(page);
        await composerLocator(page).fill("unfinished draft");
        await attachImageFromMenu(page, IMAGE);
        await expectAttachmentPill(page, "composer-image-attachment-pill");

        await expectPromptRowBeforeAttachment(page);

        await setComposerSelection(page, 3, 8);
        await expect(composerLocator(page)).toBeFocused();
        gate.holdNextClientRequest("send_agent_message_request");
        const action = page.getByRole("button", { name: "Action", exact: true });
        await action.click();
        await gate.waitForHeldClientRequest();
        await expect(action).toBeDisabled();
        await expect(page.getByRole("button", { name: "Review notes", exact: true })).toBeEnabled();
        await expectComposerEditable(page);
        await expect(composerLocator(page)).toBeFocused();
        expect(await getComposerSelection(page)).toEqual({ start: 3, end: 8 });
        gate.releaseHeldClientRequest();
        await expect(page.getByTestId("user-message").filter({ hasText: "/clear" })).toBeVisible();
        await expectComposerDraft(page, "unfinished draft");
        await expectAttachmentPill(page, "composer-image-attachment-pill");
      });

      await test.step("automatic-send failure preserves unrelated composer state", async () => {
        const rejectedAgent = await seedMockAgentWorkspace({
          repoPrefix: `saved-prompts-rejected-${testInfo.workerIndex}-`,
          title: "Saved prompt rejection",
          featureValues: { mockPromptRejections: 1 },
        });
        agents.push(rejectedAgent);
        await openAgentRoute(page, rejectedAgent);
        await expectComposerVisible(page);
        await expectAgentIdle(page);
        await composerLocator(page).fill("keep this draft");
        await attachImageFromMenu(page, IMAGE);
        await setComposerSelection(page, 2, 6);
        const sentBefore = await page.getByTestId("user-message").count();

        await page.getByRole("button", { name: "Review notes", exact: true }).click();

        await expect(
          page.getByText("Requested mock prompt rejection", { exact: true }),
        ).toBeVisible();
        await expect(page.getByTestId("user-message")).toHaveCount(sentBefore);
        await expectComposerDraft(page, "keep this draft");
        await expectAttachmentPill(page, "composer-image-attachment-pill");
        await expect(composerLocator(page)).toBeFocused();
        expect(await getComposerSelection(page)).toEqual({ start: 2, end: 6 });
      });

      await test.step("active-agent queue and interrupt preserve unrelated composer state", async () => {
        const runningAgent = await seedMockAgentWorkspace({
          repoPrefix: `saved-prompts-running-${testInfo.workerIndex}-`,
          title: "Saved prompt running behavior",
          model: "thirty-minute-stream",
        });
        agents.push(runningAgent);
        await setSendBehavior(page, "Queue");
        await openAgentRoute(page, runningAgent);
        await expectComposerVisible(page);
        await runningAgent.client.sendAgentMessage(
          runningAgent.agentId,
          "Keep running while saved prompts are tested.",
        );
        await expectAgentReadyToInterrupt(page);
        await composerLocator(page).fill("active unfinished draft");
        await attachImageFromMenu(page, IMAGE);

        await page.getByRole("button", { name: "Review notes", exact: true }).click();

        await expect(page.getByText("revised\nbody", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Send queued message now" })).toBeVisible();
        await expectComposerDraft(page, "active unfinished draft");
        await expectAttachmentPill(page, "composer-image-attachment-pill");

        await setSendBehavior(page, "Interrupt");
        await openAgentRoute(page, runningAgent);
        await expect(
          page.getByRole("button", { name: "Send and interrupt", exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Action", exact: true }).click();

        await expect(page.getByTestId("user-message").filter({ hasText: "/clear" })).toBeVisible();
        await expectComposerDraft(page, "active unfinished draft");
        await expectAttachmentPill(page, "composer-image-attachment-pill");
      });

      await test.step("automatic-send actions disable when the session is unavailable", async () => {
        await gate.drop();
        await expect(page.getByRole("button", { name: "Action", exact: true })).toBeDisabled();
        await expect(
          page.getByRole("button", { name: "Review notes", exact: true }),
        ).toBeDisabled();
        await expectComposerDraft(page, "active unfinished draft");
        await expectAttachmentPill(page, "composer-image-attachment-pill");
      });
    } finally {
      gate.restore();
      for (const agent of agents) {
        await agent.cleanup();
      }
    }
  });
});
