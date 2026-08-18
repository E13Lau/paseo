import { describe, expect, test } from "vitest";
import { ServerInfoStatusPayloadSchema, SessionInboundMessageSchema } from "../messages.js";
import {
  ConversationHistoryBrowseRequestSchema,
  ConversationHistoryConversationSchema,
  ConversationHistoryGetDetailResponseSchema,
} from "./rpc-schemas.js";

describe("Conversation history protocol", () => {
  test("keeps the capability optional for old Daemons", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "host-1" }).features,
    ).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "host-1",
        features: { conversationHistory: true },
      }).features?.conversationHistory,
    ).toBe(true);
  });

  test("validates client-only namespaced requests and public opaque identities", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "conversation_history.browse.request",
        requestId: "request-1",
        query: '"exact phrase"',
        providers: ["claude", "codex"],
        limit: 50,
      }),
    ).toEqual({
      type: "conversation_history.browse.request",
      requestId: "request-1",
      query: '"exact phrase"',
      providers: ["claude", "codex"],
      limit: 50,
    });
    expect(
      ConversationHistoryConversationSchema.parse({
        conversationId: "opaque-id",
        provider: "codex",
        title: "Conversation",
        projectId: null,
        projectName: null,
        lastActivityAt: "2026-08-18T00:00:00.000Z",
        stale: false,
        hasTools: false,
      }),
    ).not.toHaveProperty("sourcePath");
  });

  test("enforces public page limits", () => {
    expect(
      ConversationHistoryBrowseRequestSchema.safeParse({
        type: "conversation_history.browse.request",
        requestId: "request-1",
        limit: 51,
      }).success,
    ).toBe(false);
    expect(
      ConversationHistoryGetDetailResponseSchema.safeParse({
        type: "conversation_history.get_detail.response",
        payload: {
          requestId: "request-1",
          conversation: {
            conversationId: "opaque-id",
            provider: "codex",
            title: "Conversation",
            projectId: null,
            projectName: null,
            lastActivityAt: "2026-08-18T00:00:00.000Z",
            stale: false,
            hasTools: false,
          },
          events: Array.from({ length: 101 }, (_, index) => ({
            eventId: String(index),
            role: "user",
            timestamp: null,
            text: "message",
          })),
          nextCursor: null,
        },
      }).success,
    ).toBe(false);
  });
});
