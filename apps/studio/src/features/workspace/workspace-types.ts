import { z } from 'zod';

const nonEmptyStringSchema = z.string().min(1);

const contentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
]);

const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.array(contentPartSchema) }),
  z.object({ role: z.literal('user'), content: z.array(contentPartSchema) }),
  z.object({
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
  }),
  z.object({
    role: z.literal('tool'),
    toolCallId: nonEmptyStringSchema,
    content: z.array(contentPartSchema),
  }),
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

/** A complete Session returned by `GET /sessions/:sessionId`. */
export const sessionDetailSchema = sessionSummarySchema.extend({
  messages: z.array(messageSchema),
});

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
