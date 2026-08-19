import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { DaemonClient as InternalDaemonClient } from "@getpaseo/client/internal/daemon-client";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { gotoAppShell, openSettings } from "./app";
import { connectDaemonClient } from "./daemon-client-loader";
import { startIsolatedHostDaemon, type IsolatedHostDaemon } from "./isolated-host-daemon";
import { wsRoutePatternForPort } from "./daemon-port";
import {
  addDirectHostFromSettings,
  goBackInSettings,
  openCompactSettings,
  openHostSection,
  selectSettingsHost,
} from "./settings";

type InstructionFilesClient = Pick<
  InternalDaemonClient,
  "close" | "connect" | "listInstructionFiles" | "getInstructionFile" | "writeInstructionFile"
>;

export interface InstructionFilesSandbox {
  client: InstructionFilesClient;
  daemon: IsolatedHostDaemon;
  home: string;
  claudeFile: string;
  close(): Promise<void>;
}

export async function startInstructionFilesSandbox(): Promise<InstructionFilesSandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-instruction-files-e2e-"));
  const home = path.join(root, "home");
  const claudeDir = path.join(home, ".claude");
  const claudeFile = path.join(claudeDir, "CLAUDE.md");
  await mkdir(claudeDir, { recursive: true });
  await mkdir(path.join(home, ".codex"), { recursive: true });
  const daemon = await startIsolatedHostDaemon(`instruction-files-${randomUUID()}`, {
    environment: {
      HOME: home,
      NODE_ENV: "development",
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: path.join(home, ".codex"),
    },
  });
  const client = await connectDaemonClient<InstructionFilesClient>({
    clientIdPrefix: "app-e2e-instruction-files",
    port: daemon.port,
  });

  return {
    client,
    daemon,
    home,
    claudeFile,
    close: async () => {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export async function openInstructionFilesSettings(
  page: Page,
  sandbox: InstructionFilesSandbox,
  options: { compact?: boolean } = {},
): Promise<void> {
  await gotoAppShell(page);
  if (options.compact) {
    await openCompactSettings(page, buildOpenProjectRoute());
  } else {
    await openSettings(page);
  }
  await addDirectHostFromSettings(page, {
    host: "127.0.0.1",
    port: sandbox.daemon.port,
  });
  if (options.compact) await goBackInSettings(page);
  await selectSettingsHost(page, sandbox.daemon.serverId);
  await openHostSection(page, sandbox.daemon.serverId, "agents");
  await expect(page.getByTestId("host-instruction-files-section")).toBeVisible();
}

export async function openInstructionFileSheet(page: Page, filename: string): Promise<void> {
  await page.getByRole("button", { name: filename, exact: true }).click();
  await expect(page.getByTestId("host-instruction-files-sheet")).toBeVisible();
  await expect(page.getByTestId("host-instruction-files-input")).toBeVisible();
}

export async function installInstructionFilesFeatureGate(
  page: Page,
  port: number,
  advertise: boolean,
): Promise<void> {
  await page.routeWebSocket(wsRoutePatternForPort(String(port)), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      server.send(message);
    });
    server.onMessage((message) => {
      const rewritten = rewriteInstructionFilesFeature(message, advertise);
      ws.send(rewritten ?? message);
    });
  });
}

export async function installInstructionFileWriteFailure(page: Page, port: number): Promise<void> {
  await page.routeWebSocket(wsRoutePatternForPort(String(port)), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      if (sessionMessage?.type === "provider.instruction_file.write.request") {
        const requestId = sessionMessage.requestId;
        if (typeof requestId !== "string") {
          throw new Error("provider.instruction_file.write.request missing requestId");
        }
        ws.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "provider.instruction_file.write.response",
              payload: {
                requestId,
                result: { status: "error", error: "disk is read-only" },
              },
            },
          }),
        );
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      ws.send(message);
    });
  });
}

export async function expectClaudeFile(
  sandbox: InstructionFilesSandbox,
  content: string,
): Promise<void> {
  await expect.poll(() => readFile(sandbox.claudeFile, "utf8")).toBe(content);
}

export async function writeClaudeFile(
  sandbox: InstructionFilesSandbox,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(sandbox.claudeFile), { recursive: true });
  await writeFile(sandbox.claudeFile, content, "utf8");
}

function getSessionMessage(message: string | Buffer): Record<string, unknown> | null {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(raw) as {
      type?: unknown;
      message?: unknown;
    };
    if (envelope.type !== "session" || !envelope.message || typeof envelope.message !== "object") {
      return null;
    }
    return envelope.message as Record<string, unknown>;
  } catch {
    return null;
  }
}

function rewriteInstructionFilesFeature(
  message: string | Buffer,
  advertise: boolean,
): string | null {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(raw) as {
      type?: unknown;
      message?: {
        type?: unknown;
        payload?: Record<string, unknown>;
      };
    };
    const payload = envelope.message?.payload;
    if (
      envelope.type !== "session" ||
      envelope.message?.type !== "status" ||
      payload?.status !== "server_info"
    ) {
      return null;
    }
    return JSON.stringify({
      ...envelope,
      message: {
        ...envelope.message,
        payload: {
          ...payload,
          features: {
            ...(typeof payload.features === "object" && payload.features !== null
              ? payload.features
              : {}),
            providerInstructionFiles: advertise,
          },
        },
      },
    });
  } catch {
    return null;
  }
}
