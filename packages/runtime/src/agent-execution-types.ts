import {
  agentExecutionInputSchema,
  type AgentExecutionInput,
  type SessionEventStore,
  type CapturedFileContext,
} from '@weave/session';
import { fileAttachmentSummarySchema, type FileReference } from '@weave/protocol';
import { z } from 'zod';
import { agentRuntimeEventSchema, type AgentRunner } from './agent-types.js';

export { agentExecutionInputSchema } from '@weave/session';
export type { AgentExecutionInput } from '@weave/session';

export const agentExecutionStatusSchema = z.enum([
  'queued',
  'accepted',
  'running',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'persistence-error',
]);
export type AgentExecutionStatus = z.infer<typeof agentExecutionStatusSchema>;
export const agentExecutionCursorSchema = z
  .string()
  .max(600)
  .regex(/^[^:]+:[^:]+:(?:0|[1-9][0-9]*)$/)
  .refine(
    (cursor) => Number.isSafeInteger(Number(cursor.split(':')[2])),
    'Invalid cursor sequence',
  );

export const agentExecutionLaunchSchema = z
  .object({
    requestId: z.string().min(1).max(240),
    input: agentExecutionInputSchema,
  })
  .strict();
export type AgentExecutionLaunch = z.infer<typeof agentExecutionLaunchSchema>;

const executionErrorSchema = z.object({ code: z.string().min(1), message: z.string() }).strict();
export const agentExecutionSummarySchema = z
  .object({
    executionId: z.string().min(1),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    userMessageId: z.string().min(1),
    createdAt: z.iso.datetime(),
    status: agentExecutionStatusSchema,
    cursor: agentExecutionCursorSchema,
    durableThroughSequence: z.number().int().positive().safe().optional(),
    error: executionErrorSchema.optional(),
  })
  .strict();
export type AgentExecutionSummary = z.infer<typeof agentExecutionSummarySchema>;
export const agentExecutionEffectiveSettingsSchema = z
  .object({
    useProviderDefaults: z.literal(false),
    temperature: z.number().finite().nonnegative().optional(),
    maxTokens: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type AgentExecutionEffectiveSettings = z.infer<typeof agentExecutionEffectiveSettingsSchema>;
export const agentExecutionSnapshotSchema = agentExecutionSummarySchema
  .extend({
    input: agentExecutionInputSchema,
    effectiveSettings: agentExecutionEffectiveSettingsSchema.optional(),
    fileAttachments: z.array(fileAttachmentSummarySchema).min(1).max(8).readonly().optional(),
    events: z.array(agentRuntimeEventSchema).readonly(),
  })
  .strict();
export type AgentExecutionSnapshot = z.infer<typeof agentExecutionSnapshotSchema>;
export const agentExecutionFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: agentExecutionSnapshotSchema }).strict(),
  z
    .object({
      type: z.literal('event'),
      cursor: agentExecutionCursorSchema,
      event: agentRuntimeEventSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('status'),
      cursor: agentExecutionCursorSchema,
      status: agentExecutionStatusSchema,
      durableThroughSequence: z.number().int().positive().safe().optional(),
      error: executionErrorSchema.optional(),
    })
    .strict(),
]);
export type AgentExecutionFrame = z.infer<typeof agentExecutionFrameSchema>;

const queueIdentifierSchema = z.string().min(1).max(240);
const queueRevisionSchema = z.number().int().nonnegative().safe();
const boundedLabelSchema = z.string().refine((value) => Array.from(value).length <= 240);
export const agentExecutionQueueEntrySchema = agentExecutionSummarySchema
  .extend({
    preview: boundedLabelSchema,
    provider: boundedLabelSchema,
    model: boundedLabelSchema,
    imageCount: z.number().int().nonnegative().safe(),
    skillCount: z.number().int().nonnegative().max(32),
    fileCount: z.number().int().nonnegative().max(8),
  })
  .strict();
export type AgentExecutionQueueEntry = z.infer<typeof agentExecutionQueueEntrySchema>;
export const agentExecutionQueueCursorSchema = z
  .string()
  .max(2500)
  .regex(/^[^:]+:[^:]+:(?:0|[1-9][0-9]*)$/)
  .refine(
    (cursor) => Number.isSafeInteger(Number(cursor.split(':')[2])),
    'Invalid queue cursor sequence',
  );
export const agentExecutionQueueSnapshotSchema = z
  .object({
    sessionId: queueIdentifierSchema,
    revision: queueRevisionSchema,
    cursor: agentExecutionQueueCursorSchema,
    active: agentExecutionSummarySchema.nullable(),
    queued: z.array(agentExecutionQueueEntrySchema).max(10).readonly(),
    scheduler: z.enum(['ready', 'closing', 'blocked']),
    limits: z.object({ sessionQueued: z.literal(10), globalQueued: z.literal(100) }).strict(),
    error: executionErrorSchema.optional(),
  })
  .strict();
export type AgentExecutionQueueSnapshot = z.infer<typeof agentExecutionQueueSnapshotSchema>;
export const agentExecutionQueueReorderSchema = z
  .object({
    requestId: queueIdentifierSchema,
    expectedRevision: queueRevisionSchema,
    executionIds: z
      .array(queueIdentifierSchema)
      .max(10)
      .readonly()
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export type AgentExecutionQueueReorder = z.infer<typeof agentExecutionQueueReorderSchema>;
export const agentExecutionQueuedCancelSchema = z
  .object({
    requestId: queueIdentifierSchema,
    expectedRevision: queueRevisionSchema,
  })
  .strict();
export type AgentExecutionQueuedCancel = z.infer<typeof agentExecutionQueuedCancelSchema>;
export interface AgentExecutionQueueSubscription {
  readonly initial: readonly AgentExecutionQueueSnapshot[];
  readonly events: AsyncIterable<AgentExecutionQueueSnapshot>;
  close(): void;
}

export interface AgentExecutionSubscription {
  readonly initial: readonly AgentExecutionFrame[];
  readonly events: AsyncIterable<AgentExecutionFrame>;
  close(): void;
}

export interface AgentExecutionService {
  launch(sessionId: string, request: AgentExecutionLaunch): Promise<AgentExecutionSnapshot>;
  list(sessionId: string): Promise<readonly AgentExecutionSummary[]>;
  get(sessionId: string, executionId: string): Promise<AgentExecutionSnapshot>;
  subscribe(
    sessionId: string,
    executionId: string,
    after?: string,
  ): Promise<AgentExecutionSubscription>;
  cancel(sessionId: string, executionId: string): Promise<AgentExecutionSnapshot>;
  queue(sessionId: string): Promise<AgentExecutionQueueSnapshot>;
  subscribeQueue(sessionId: string): Promise<AgentExecutionQueueSubscription>;
  reorderQueue(
    sessionId: string,
    request: AgentExecutionQueueReorder,
  ): Promise<AgentExecutionQueueSnapshot>;
  cancelQueued(
    sessionId: string,
    executionId: string,
    request: AgentExecutionQueuedCancel,
  ): Promise<AgentExecutionQueueSnapshot>;
  recover(sessionIds: readonly string[]): Promise<void>;
  withSessionIdle<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  closeSync(): void;
  drain(): Promise<void>;
}

export interface AgentExecutionServiceOptions {
  readonly runner: AgentRunner;
  readonly sessionStore: SessionEventStore;
  readonly admit: (sessionId: string) => Promise<void>;
  readonly resolveInput?: (
    sessionId: string,
    input: AgentExecutionInput,
  ) => Promise<AgentExecutionInput>;
  readonly captureFiles?: CaptureFiles;
}

export interface CaptureFilesOptions {
  readonly signal: AbortSignal;
}
/** Core host authority: external requests provide refs only, never this bundle. */
export type CaptureFiles = (
  sessionId: string,
  files: readonly FileReference[],
  options: CaptureFilesOptions,
) => Promise<CapturedFileContext>;

export type AgentExecutionErrorCode =
  | 'execution-not-found'
  | 'execution-busy'
  | 'execution-queue-full'
  | 'execution-queue-conflict'
  | 'execution-not-active'
  | 'execution-not-queued'
  | 'execution-request-conflict'
  | 'execution-closed'
  | 'execution-output-limit'
  | 'execution-admission-uncertain'
  | 'execution-persistence-error'
  | 'execution-file-too-large'
  | 'execution-file-unavailable'
  | 'execution-file-invalid-utf8'
  | 'execution-file-changed'
  | 'execution-file-capture-timeout'
  | 'execution-file-capture-failed'
  | 'execution-invalid-input';
export class AgentExecutionError extends Error {
  readonly code: AgentExecutionErrorCode;
  constructor(code: AgentExecutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentExecutionError';
    this.code = code;
  }
}
