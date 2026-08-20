import { expect, test as base } from "../support/fixtures";
import {
  expectClaudeFile,
  installInstructionFileWriteFailure,
  installInstructionFilesFeatureGate,
  openInstructionFileSheet,
  openInstructionFilesSettings,
  startInstructionFilesSandbox,
  writeClaudeFile,
  type InstructionFilesSandbox,
} from "../support/helpers/instruction-files";

const test = base.extend<{ files: InstructionFilesSandbox }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring for fixture dependency discovery.
  files: async ({}, provide) => {
    const sandbox = await startInstructionFilesSandbox();
    try {
      await provide(sandbox);
    } finally {
      await sandbox.close();
    }
  },
});

test.describe("Host instruction files", () => {
  test.describe.configure({ timeout: 120_000 });

  test("shows Save only when dirty and writes the file on save", async ({ page, files }) => {
    await openInstructionFilesSettings(page, files);
    await expect(page.getByTestId("host-instruction-files-card")).toBeVisible();
    await expect(page.getByRole("button", { name: "CLAUDE.md", exact: true })).toBeVisible();

    await openInstructionFileSheet(page, "CLAUDE.md");
    const save = page.getByTestId("host-instruction-files-save");
    await expect(save).toBeDisabled();
    await page.getByTestId("host-instruction-files-input").fill("Prefer small diffs.");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByTestId("host-instruction-files-sheet")).toHaveCount(0);
    await expectClaudeFile(files, "Prefer small diffs.");
    await expect(page.getByText("Missing", { exact: true })).toHaveCount(0);
  });

  test("keeps a save failure visible in the sheet", async ({ page, files }) => {
    await installInstructionFileWriteFailure(page, files.daemon.port);
    await openInstructionFilesSettings(page, files);
    await openInstructionFileSheet(page, "CLAUDE.md");
    await page.getByTestId("host-instruction-files-input").fill("will not save");
    await page.getByTestId("host-instruction-files-save").click();
    await expect(page.getByTestId("host-instruction-files-save-error")).toBeVisible();
    await expect(page.getByText("disk is read-only")).toBeVisible();
    await page.getByTestId("host-instruction-files-reset").click();
    await expect(page.getByTestId("host-instruction-files-input")).toHaveValue("");
    await expect(page.getByTestId("host-instruction-files-save-error")).toBeVisible();
    await expect(page.getByTestId("host-instruction-files-sheet")).toBeVisible();
  });

  test("offers Reload and Overwrite on a stale-write conflict", async ({ page, files }) => {
    await writeClaudeFile(files, "from disk\n");
    await openInstructionFilesSettings(page, files);
    await openInstructionFileSheet(page, "CLAUDE.md");
    await expect(page.getByTestId("host-instruction-files-input")).toHaveValue("from disk\n");
    await writeClaudeFile(files, "edited in CLI\n");
    await page.getByTestId("host-instruction-files-input").fill("draft from Paseo\n");
    await page.getByTestId("host-instruction-files-save").click();
    await expect(page.getByTestId("host-instruction-files-conflict")).toBeVisible();
    await expect(page.getByTestId("host-instruction-files-reload")).toBeVisible();
    await expect(page.getByTestId("host-instruction-files-overwrite")).toBeVisible();

    await page.getByTestId("host-instruction-files-reload").click();
    await expect(page.getByTestId("host-instruction-files-input")).toHaveValue("edited in CLI\n");
    await expect(page.getByTestId("host-instruction-files-save")).toBeDisabled();

    await page.getByTestId("host-instruction-files-input").fill("forced from Paseo\n");
    await writeClaudeFile(files, "newer CLI edit\n");
    await page.getByTestId("host-instruction-files-save").click();
    await expect(page.getByTestId("host-instruction-files-conflict")).toBeVisible();
    await page.getByTestId("host-instruction-files-overwrite").click();
    await expect(page.getByTestId("host-instruction-files-sheet")).toHaveCount(0);
    await expectClaudeFile(files, "forced from Paseo\n");
  });

  test("tells the user to update the Host when the feature is missing", async ({ page, files }) => {
    await installInstructionFilesFeatureGate(page, files.daemon.port, false);
    await openInstructionFilesSettings(page, files);
    await expect(page.getByTestId("host-instruction-files-unavailable")).toBeVisible();
    await expect(page.getByText("Update this host to edit Instruction files")).toBeVisible();
  });
});
