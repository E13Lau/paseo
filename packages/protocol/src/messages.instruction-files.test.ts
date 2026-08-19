import { describe, expect, it } from "vitest";
import {
  ProviderInstructionFileGetRequestSchema,
  ProviderInstructionFileGetResponseSchema,
  ProviderInstructionFileListRequestSchema,
  ProviderInstructionFileListResponseSchema,
  ProviderInstructionFileWriteRequestSchema,
  ProviderInstructionFileWriteResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages";

describe("provider instruction file protocol", () => {
  it("parses dotted catalog requests", () => {
    expect(
      ProviderInstructionFileListRequestSchema.parse({
        type: "provider.instruction_file.list.request",
        requestId: "list-1",
      }),
    ).toEqual({
      type: "provider.instruction_file.list.request",
      requestId: "list-1",
    });
    expect(
      ProviderInstructionFileGetRequestSchema.parse({
        type: "provider.instruction_file.get.request",
        requestId: "get-1",
        id: "uif_abc",
      }),
    ).toMatchObject({ id: "uif_abc", requestId: "get-1" });
    expect(
      ProviderInstructionFileWriteRequestSchema.parse({
        type: "provider.instruction_file.write.request",
        requestId: "write-1",
        id: "uif_abc",
        text: "Be concise.",
        expectedModifiedAt: "2026-08-19T00:00:00.000Z",
        expectedRevision: "1:2:3:4",
      }),
    ).toMatchObject({ text: "Be concise.", id: "uif_abc" });
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "provider.instruction_file.list.request",
        requestId: "list-2",
      }).success,
    ).toBe(true);
  });

  it("parses catalog responses without requiring a file body on list", () => {
    const listed = ProviderInstructionFileListResponseSchema.parse({
      type: "provider.instruction_file.list.response",
      payload: {
        requestId: "list-3",
        files: [
          {
            id: "uif_abc",
            filename: "CLAUDE.md",
            displayPath: "~/.claude/CLAUDE.md",
            missing: true,
            providers: [{ id: "claude", label: "Claude Code" }],
          },
        ],
      },
    });
    expect(listed.payload.files[0]).toEqual({
      id: "uif_abc",
      filename: "CLAUDE.md",
      displayPath: "~/.claude/CLAUDE.md",
      missing: true,
      providers: [{ id: "claude", label: "Claude Code" }],
    });
    expect("text" in listed.payload.files[0]!).toBe(false);

    expect(
      ProviderInstructionFileGetResponseSchema.parse({
        type: "provider.instruction_file.get.response",
        payload: {
          requestId: "get-2",
          status: "ok",
          id: "uif_abc",
          text: "Be concise.",
          missing: false,
          version: {
            status: "present",
            modifiedAt: "2026-08-19T00:00:00.000Z",
            revision: "1:2:3:4",
          },
        },
      }).payload,
    ).toMatchObject({ status: "ok", text: "Be concise." });

    expect(
      ProviderInstructionFileWriteResponseSchema.parse({
        type: "provider.instruction_file.write.response",
        payload: {
          requestId: "write-2",
          result: {
            status: "conflict",
            version: {
              status: "present",
              modifiedAt: "2026-08-19T00:00:01.000Z",
            },
          },
        },
      }).payload.result.status,
    ).toBe("conflict");
  });

  it("keeps the capability optional so an old app still parses server_info", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "old-daemon",
        features: {},
      }).features.providerInstructionFiles,
    ).toBeUndefined();
  });

  it("accepts extra instruction-file fields as unknown-safe protocol", () => {
    const listed = SessionOutboundMessageSchema.parse({
      type: "provider.instruction_file.list.response",
      payload: {
        requestId: "list-4",
        files: [
          {
            id: "uif_abc",
            filename: "CLAUDE.md",
            displayPath: "~/.claude/CLAUDE.md",
            missing: false,
            providers: [{ id: "claude", label: "Claude Code" }],
            extraFutureField: "ignored-by-old-app-shape",
          },
        ],
        extraEnvelopeField: true,
      },
    });
    expect(listed.type).toBe("provider.instruction_file.list.response");
  });
});
