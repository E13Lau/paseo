import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderOverride } from "@getpaseo/protocol/provider-config";
import { MAX_EDITABLE_FILE_BYTES } from "../file-explorer/service.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { listResolvedInstructionFiles } from "./catalog.js";

interface CatalogHarness {
  root: string;
  claudeDir: string;
  glmDir: string;
  codexDir: string;
  daemon: TestPaseoDaemon;
  client: DaemonClient;
}

const harnesses: CatalogHarness[] = [];

afterEach(async () => {
  const closing = harnesses.splice(0);
  await Promise.all(
    closing.map(async (harness) => {
      await harness.client.close().catch(() => undefined);
      await harness.daemon.close().catch(() => undefined);
    }),
  );
});

function listedProviderIds(files: { providers: { id: string }[] }[]): string[] {
  return files.flatMap((file) => file.providers.map((provider) => provider.id));
}

async function startHarness(
  buildOverrides?: (dirs: {
    claudeDir: string;
    glmDir: string;
    codexDir: string;
  }) => Record<string, ProviderOverride>,
): Promise<CatalogHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-instruction-files-"));
  const claudeDir = path.join(root, "claude");
  const glmDir = path.join(root, "glm");
  const codexDir = path.join(root, "codex");
  await mkdir(claudeDir, { recursive: true });
  await mkdir(glmDir, { recursive: true });
  await mkdir(codexDir, { recursive: true });
  const extra = buildOverrides?.({ claudeDir, glmDir, codexDir }) ?? {};
  const { claude: claudeOverride, codex: codexOverride, ...rest } = extra;
  const daemon = await createTestPaseoDaemon({
    providerOverrides: {
      claude: {
        ...claudeOverride,
        env: {
          CLAUDE_CONFIG_DIR: claudeDir,
          ...claudeOverride?.env,
        },
      },
      codex: {
        ...codexOverride,
        env: {
          CODEX_HOME: codexDir,
          ...codexOverride?.env,
        },
      },
      ...rest,
    },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "instruction-files" } });
  const harness = { root, claudeDir, glmDir, codexDir, daemon, client };
  harnesses.push(harness);
  return harness;
}

describe("provider.instruction_file catalog", () => {
  it("advertises the feature and lists Claude and Codex files without bodies", async () => {
    const harness = await startHarness();
    expect(harness.client.getLastServerInfoMessage()?.features?.providerInstructionFiles).toBe(
      true,
    );

    const files = await harness.client.listInstructionFiles();
    expect(files.map((file) => file.filename).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
    const claude = files.find((file) => file.filename === "CLAUDE.md");
    const agents = files.find((file) => file.filename === "AGENTS.md");
    expect(claude).toMatchObject({
      missing: true,
      providers: [{ id: "claude", label: "Claude" }],
    });
    expect(claude?.displayPath).toContain("CLAUDE.md");
    expect(agents).toMatchObject({
      missing: true,
      providers: [{ id: "codex", label: "Codex" }],
    });
    expect(files.every((file) => !("text" in file))).toBe(true);
    const ids = listedProviderIds(files);
    expect(ids).not.toContain("opencode");
    expect(ids).not.toContain("pi");
    expect(ids).not.toContain("copilot");
  });

  it("keeps a disabled Claude row and dedupes a shared config dir", async () => {
    const harness = await startHarness(() => ({
      claude: { enabled: false },
      "claude-shared": {
        extends: "claude",
        label: "Shared Claude",
      },
    }));
    const files = await harness.client.listInstructionFiles();
    const claudeRows = files.filter((file) => file.filename === "CLAUDE.md");
    expect(claudeRows).toHaveLength(1);
    expect(claudeRows[0]?.missing).toBe(true);
    expect(claudeRows[0]?.providers.map((provider) => provider.id).sort()).toEqual([
      "claude",
      "claude-shared",
    ]);
  });

  it("distinguishes two CLAUDE.md files by path and omits ACP rows", async () => {
    const harness = await startHarness((dirs) => ({
      "claude-glm": {
        extends: "claude",
        label: "GLM",
        env: { CLAUDE_CONFIG_DIR: dirs.glmDir },
      },
      "acp-gemini": {
        extends: "acp",
        label: "Gemini",
        command: ["false"],
      },
    }));
    const files = await harness.client.listInstructionFiles();
    const claudeRows = files.filter((file) => file.filename === "CLAUDE.md");
    expect(claudeRows).toHaveLength(2);
    const paths = claudeRows.map((file) => file.displayPath).sort();
    expect(paths[0]).not.toBe(paths[1]);
    expect(listedProviderIds(files)).not.toContain("acp-gemini");
  });

  it("lists Codex override when present instead of AGENTS.md", async () => {
    const harness = await startHarness();
    await writeFile(path.join(harness.codexDir, "AGENTS.md"), "base agents\n", "utf8");
    const before = await harness.client.listInstructionFiles();
    expect(before.find((file) => file.filename === "AGENTS.md")?.missing).toBe(false);
    expect(before.some((file) => file.filename === "AGENTS.override.md")).toBe(false);

    await writeFile(path.join(harness.codexDir, "AGENTS.override.md"), "override agents\n", "utf8");
    const after = await harness.client.listInstructionFiles();
    expect(after.some((file) => file.filename === "AGENTS.md")).toBe(false);
    expect(after.find((file) => file.filename === "AGENTS.override.md")).toMatchObject({
      missing: false,
      providers: [{ id: "codex", label: "Codex" }],
    });
  });

  it("gets present and missing bodies and rejects oversize, non-text, and unknown ids", async () => {
    const harness = await startHarness();
    const listed = await harness.client.listInstructionFiles();
    const claude = listed.find((file) => file.filename === "CLAUDE.md")!;
    const missing = await harness.client.getInstructionFile(claude.id);
    expect(missing).toMatchObject({
      status: "ok",
      id: claude.id,
      text: "",
      missing: true,
      version: { status: "missing" },
    });

    await writeFile(
      path.join(harness.claudeDir, "CLAUDE.md"),
      "Use conventional commits.\n",
      "utf8",
    );
    const present = await harness.client.getInstructionFile(claude.id);
    expect(present).toMatchObject({
      status: "ok",
      text: "Use conventional commits.\n",
      missing: false,
    });
    if (present.status !== "ok" || present.version.status !== "present") {
      throw new Error("expected present instruction file");
    }
    expect(present.version.modifiedAt).toEqual(expect.any(String));
    expect(present.version.revision).toEqual(expect.any(String));

    const unknown = await harness.client.getInstructionFile("not-a-catalog-id");
    expect(unknown).toEqual({
      status: "error",
      requestId: expect.any(String),
      error: "Unknown instruction file",
    });

    await writeFile(path.join(harness.claudeDir, "CLAUDE.md"), Buffer.from([0, 1, 2, 3, 0]));
    const binary = await harness.client.getInstructionFile(claude.id);
    expect(binary).toMatchObject({ status: "error", error: "This file is not valid text" });

    await writeFile(
      path.join(harness.claudeDir, "CLAUDE.md"),
      Buffer.alloc(MAX_EDITABLE_FILE_BYTES + 1, 0x61),
    );
    const oversize = await harness.client.getInstructionFile(claude.id);
    expect(oversize).toMatchObject({ status: "error", error: "File is too large to edit" });
  });

  it("creates, writes empty text, conflicts on stale writes, and rejects unknown ids", async () => {
    const harness = await startHarness();
    await mkdir(path.join(harness.claudeDir, "skills", "keep-me"), { recursive: true });
    await writeFile(
      path.join(harness.claudeDir, "skills", "keep-me", "SKILL.md"),
      "# keep\n",
      "utf8",
    );
    const workspace = path.join(harness.root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "README.md"), "workspace\n", "utf8");
    const beforeConfig = await harness.client.getDaemonConfig();
    const listed = await harness.client.listInstructionFiles();
    const claude = listed.find((file) => file.filename === "CLAUDE.md")!;

    const created = await harness.client.writeInstructionFile({
      id: claude.id,
      text: "Prefer small diffs.\n",
    });
    expect(created).toMatchObject({ status: "written" });
    expect(await readFile(path.join(harness.claudeDir, "CLAUDE.md"), "utf8")).toBe(
      "Prefer small diffs.\n",
    );
    expect(
      (await harness.client.listInstructionFiles()).find((file) => file.id === claude.id),
    ).toMatchObject({ missing: false });

    const loaded = await harness.client.getInstructionFile(claude.id);
    if (loaded.status !== "ok" || loaded.version.status !== "present") {
      throw new Error("expected present file after create");
    }
    const emptied = await harness.client.writeInstructionFile({
      id: claude.id,
      text: "",
      expectedModifiedAt: loaded.version.modifiedAt,
      expectedRevision: loaded.version.revision,
    });
    expect(emptied).toMatchObject({ status: "written" });
    expect(await readFile(path.join(harness.claudeDir, "CLAUDE.md"), "utf8")).toBe("");

    await writeFile(path.join(harness.claudeDir, "CLAUDE.md"), "edited in CLI\n", "utf8");
    const conflict = await harness.client.writeInstructionFile({
      id: claude.id,
      text: "stale editor draft\n",
      expectedModifiedAt: loaded.version.modifiedAt,
      expectedRevision: loaded.version.revision,
    });
    expect(conflict).toMatchObject({
      status: "conflict",
      version: { status: "present" },
    });
    expect(await readFile(path.join(harness.claudeDir, "CLAUDE.md"), "utf8")).toBe(
      "edited in CLI\n",
    );
    if (conflict.status !== "conflict" || conflict.version.status !== "present") {
      throw new Error("expected present conflict version");
    }
    const overwritten = await harness.client.writeInstructionFile({
      id: claude.id,
      text: "forced from Paseo\n",
      expectedModifiedAt: conflict.version.modifiedAt,
      expectedRevision: conflict.version.revision,
    });
    expect(overwritten).toMatchObject({ status: "written" });
    expect(await readFile(path.join(harness.claudeDir, "CLAUDE.md"), "utf8")).toBe(
      "forced from Paseo\n",
    );

    expect(
      await harness.client.writeInstructionFile({ id: "not-a-catalog-id", text: "nope" }),
    ).toEqual({
      status: "error",
      error: "Unknown instruction file",
    });

    const afterConfig = await harness.client.getDaemonConfig();
    expect(afterConfig.config.appendSystemPrompt).toBe(beforeConfig.config.appendSystemPrompt);
    expect(
      await readFile(path.join(harness.claudeDir, "skills", "keep-me", "SKILL.md"), "utf8"),
    ).toBe("# keep\n");
    const directory = await harness.client.listDirectory(workspace, "");
    expect(directory.entries.map((entry) => entry.name)).toEqual(["README.md"]);
  });

  it("does not invent a Codex row when no Codex-family provider is supplied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-instruction-catalog-"));
    const claudeDir = path.join(root, "claude");
    await mkdir(claudeDir, { recursive: true });
    const files = await listResolvedInstructionFiles([
      {
        id: "claude",
        label: "Claude",
        family: "claude",
        env: { CLAUDE_CONFIG_DIR: claudeDir },
      },
    ]);
    expect(files.map((file) => file.filename)).toEqual(["CLAUDE.md"]);
  });
});
