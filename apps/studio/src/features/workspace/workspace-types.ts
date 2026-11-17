import { z } from 'zod';

const nonEmptyStringSchema = z.string().min(1);
const messageMetadataSchema = z.object({
  messageId: nonEmptyStringSchema.optional(),
  sequence: z.number().int().positive().optional(),
  occurredAt: z.string().datetime().optional(),
  turnId: nonEmptyStringSchema.optional(),
});

const contentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
]);

const messageSchema = z.discriminatedUnion('role', [
  z
    .object({ role: z.literal('system'), content: z.array(contentPartSchema) })
    .extend(messageMetadataSchema.shape),
  z
    .object({ role: z.literal('user'), content: z.array(contentPartSchema) })
    .extend(messageMetadataSchema.shape),
  z
    .object({
      role: z.literal('assistant'),
      content: z.array(contentPartSchema),
      toolCalls: z
        .array(
          z.object({
            id: nonEmptyStringSchema,
            name: nonEmptyStringSchema,
            arguments: z.string(),
          }),
        )
        .optional(),
    })
    .extend(messageMetadataSchema.shape),
  z
    .object({
      role: z.literal('tool'),
      toolCallId: nonEmptyStringSchema,
      content: z.array(contentPartSchema),
    })
    .extend(messageMetadataSchema.shape),
]);

const sessionSummarySchema = z.object({
  id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  archivedAt: z.string().datetime().optional(),
  deletedAt: z.string().datetime().optional(),
  lastSequence: z.number().int().nonnegative(),
  lastMessage: messageSchema.optional(),
});

const projectSchemaBase = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  folderName: nonEmptyStringSchema,
  folderPath: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const projectListWarningSchema = z.object({
  code: z.literal('session-projection-invalid'),
  sessionId: nonEmptyStringSchema,
});

/** A Project summary returned by the Server workspace API. */
export const projectSchema = projectSchemaBase;

export const projectWithSessionsSchema = projectSchema.extend({
  sessions: z.array(sessionSummarySchema),
});

/** The response returned by `GET /projects`. */
export const projectListResponseSchema = z.object({
  projects: z.array(projectWithSessionsSchema),
  warnings: z.array(projectListWarningSchema),
});

/** Token usage as reported by the Server; absent counters were not reported. */
const tokenCountSchema = z.number().int().nonnegative();
export const turnUsageSchema = z.object({
  inputTokens: tokenCountSchema.optional(),
  outputTokens: tokenCountSchema.optional(),
  totalTokens: tokenCountSchema.optional(),
  cacheReadTokens: tokenCountSchema.optional(),
  cacheWriteTokens: tokenCountSchema.optional(),
  reasoningTokens: tokenCountSchema.optional(),
});

/** Per-Turn timing, attribution, and token usage summed over its model steps. */
export const turnSummarySchema = z.object({
  turnId: nonEmptyStringSchema,
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  provider: nonEmptyStringSchema.optional(),
  model: nonEmptyStringSchema.optional(),
  usage: turnUsageSchema.optional(),
  modelSteps: z
    .array(
      z.object({
        startedAt: z.string().datetime(),
        completedAt: z.string().datetime().optional(),
        usage: turnUsageSchema.optional(),
      }),
    )
    .default([]),
  toolCalls: z.number().int().nonnegative().default(0),
  failedToolCalls: z.number().int().nonnegative().default(0),
});

/** A complete Session returned by `GET /sessions/:sessionId`. */
export const sessionDetailSchema = sessionSummarySchema.extend({
  messages: z.array(messageSchema),
  turns: z.array(turnSummarySchema).default([]),
});

export type TurnUsage = z.infer<typeof turnUsageSchema>;
export type TurnSummary = z.infer<typeof turnSummarySchema>;

export type ContentPart = z.infer<typeof contentPartSchema>;
export type WorkspaceMessage = z.infer<typeof messageSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectWithSessions = z.infer<typeof projectWithSessionsSchema>;
export type ProjectListWarning = z.infer<typeof projectListWarningSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type SessionDetail = z.infer<typeof sessionDetailSchema>;

export interface CreateProjectInput {
  readonly name: string;
  readonly folderName: string;
  readonly folderPath?: string;
}

export interface WorkspaceApiErrorPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
