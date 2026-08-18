import { z } from "zod";

export const ConversationHistoryProviderIdSchema = z.enum(["claude", "codex", "pi", "omp"]);
export const ConversationHistoryRoleSchema = z.enum([
  "user",
  "assistant",
  "tool",
  "reasoning_summary",
  "attachment",
]);

export const ConversationHistoryProviderStatusSchema = z.object({
  provider: ConversationHistoryProviderIdSchema,
  supported: z.boolean(),
  sourceDescription: z.string().optional(),
  enabled: z.boolean(),
  state: z.enum(["disabled", "scanning", "ready", "stale", "failed"]),
  scannedConversations: z.number().int().nonnegative(),
  totalConversations: z.number().int().nonnegative().optional(),
  staleCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  lastSuccessfulSyncAt: z.string().nullable(),
  errorCategory: z.string().nullable().optional(),
});

export const ConversationHistorySettingsSchema = z.object({
  enabled: z.boolean(),
  providers: z.array(ConversationHistoryProviderIdSchema),
  indexPath: z.string(),
  providersStatus: z.array(ConversationHistoryProviderStatusSchema),
  unavailableReason: z.string().nullable(),
});

export const ConversationHistorySnippetSchema = z.object({
  eventId: z.string(),
  role: ConversationHistoryRoleSchema,
  timestamp: z.string().nullable(),
  text: z.string(),
});

export const ConversationHistoryConversationSchema = z.object({
  conversationId: z.string(),
  provider: ConversationHistoryProviderIdSchema,
  title: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  lastActivityAt: z.string(),
  stale: z.boolean(),
  hasTools: z.boolean(),
  parentConversationId: z.string().nullable().optional(),
  snippets: z.array(ConversationHistorySnippetSchema).max(3).optional(),
});

export const ConversationHistoryEventSchema = z.object({
  eventId: z.string(),
  role: ConversationHistoryRoleSchema,
  timestamp: z.string().nullable(),
  text: z.string().optional(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  toolStatus: z.string().optional(),
  toolInput: z.string().optional(),
  toolResult: z.string().optional(),
  originalSize: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  attachmentName: z.string().optional(),
  attachmentMime: z.string().optional(),
});

const RequestIdSchema = z.string().min(1);

export const ConversationHistoryGetSettingsRequestSchema = z.object({
  type: z.literal("conversation_history.get_settings.request"),
  requestId: RequestIdSchema,
});
export const ConversationHistoryGetSettingsResponseSchema = z.object({
  type: z.literal("conversation_history.get_settings.response"),
  payload: ConversationHistorySettingsSchema.extend({ requestId: RequestIdSchema }),
});
export const ConversationHistorySetSettingsRequestSchema = z.object({
  type: z.literal("conversation_history.set_settings.request"),
  requestId: RequestIdSchema,
  enabled: z.boolean(),
  providers: z.array(ConversationHistoryProviderIdSchema),
});
export const ConversationHistorySetSettingsResponseSchema = z.object({
  type: z.literal("conversation_history.set_settings.response"),
  payload: ConversationHistorySettingsSchema.extend({ requestId: RequestIdSchema }),
});
export const ConversationHistoryGetStatusRequestSchema = z.object({
  type: z.literal("conversation_history.get_status.request"),
  requestId: RequestIdSchema,
});
export const ConversationHistoryGetStatusResponseSchema = z.object({
  type: z.literal("conversation_history.get_status.response"),
  payload: z.object({
    requestId: RequestIdSchema,
    state: z.enum(["disabled", "scanning", "ready", "empty", "stale", "failed", "unavailable"]),
    conversationCount: z.number().int().nonnegative(),
    providers: z.array(ConversationHistoryProviderStatusSchema),
    unavailableReason: z.string().nullable(),
  }),
});
export const ConversationHistoryBrowseRequestSchema = z.object({
  type: z.literal("conversation_history.browse.request"),
  requestId: RequestIdSchema,
  query: z.string().max(500).optional(),
  providers: z.array(ConversationHistoryProviderIdSchema).optional(),
  projectId: z.string().nullable().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  role: z.enum(["user", "assistant"]).optional(),
  hasTools: z.boolean().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export const ConversationHistoryBrowseResponseSchema = z.object({
  type: z.literal("conversation_history.browse.response"),
  payload: z.object({
    requestId: RequestIdSchema,
    conversations: z.array(ConversationHistoryConversationSchema).max(50),
    nextCursor: z.string().nullable(),
  }),
});
export const ConversationHistoryGetDetailRequestSchema = z.object({
  type: z.literal("conversation_history.get_detail.request"),
  requestId: RequestIdSchema,
  conversationId: z.string().min(1),
  eventId: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const ConversationHistoryGetDetailResponseSchema = z.object({
  type: z.literal("conversation_history.get_detail.response"),
  payload: z.object({
    requestId: RequestIdSchema,
    conversation: ConversationHistoryConversationSchema,
    events: z.array(ConversationHistoryEventSchema).max(100),
    nextCursor: z.string().nullable(),
  }),
});
export const ConversationHistoryRescanRequestSchema = z.object({
  type: z.literal("conversation_history.rescan.request"),
  requestId: RequestIdSchema,
});
export const ConversationHistoryRescanResponseSchema = z.object({
  type: z.literal("conversation_history.rescan.response"),
  payload: z.object({ requestId: RequestIdSchema, accepted: z.boolean() }),
});
export const ConversationHistoryClearRequestSchema = z.object({
  type: z.literal("conversation_history.clear.request"),
  requestId: RequestIdSchema,
});
export const ConversationHistoryClearResponseSchema = z.object({
  type: z.literal("conversation_history.clear.response"),
  payload: z.object({ requestId: RequestIdSchema, cleared: z.boolean() }),
});

export const ConversationHistoryInboundSchemas = [
  ConversationHistoryGetSettingsRequestSchema,
  ConversationHistorySetSettingsRequestSchema,
  ConversationHistoryGetStatusRequestSchema,
  ConversationHistoryBrowseRequestSchema,
  ConversationHistoryGetDetailRequestSchema,
  ConversationHistoryRescanRequestSchema,
  ConversationHistoryClearRequestSchema,
] as const;
export const ConversationHistoryOutboundSchemas = [
  ConversationHistoryGetSettingsResponseSchema,
  ConversationHistorySetSettingsResponseSchema,
  ConversationHistoryGetStatusResponseSchema,
  ConversationHistoryBrowseResponseSchema,
  ConversationHistoryGetDetailResponseSchema,
  ConversationHistoryRescanResponseSchema,
  ConversationHistoryClearResponseSchema,
] as const;

export type ConversationHistoryProviderId = z.infer<typeof ConversationHistoryProviderIdSchema>;
export type ConversationHistorySettings = z.infer<typeof ConversationHistorySettingsSchema>;
export type ConversationHistoryConversation = z.infer<typeof ConversationHistoryConversationSchema>;
export type ConversationHistoryEvent = z.infer<typeof ConversationHistoryEventSchema>;
export type ConversationHistoryBrowseRequest = z.infer<
  typeof ConversationHistoryBrowseRequestSchema
>;
