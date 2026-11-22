import { agentExecutionInputSchema, type SessionEventStore } from '@weave/session';
import { z } from 'zod';
import { agentRuntimeEventSchema, type AgentRunner } from './agent-types.js';

export { agentExecutionInputSchema } from '@weave/session';
export type { AgentExecutionInput } from '@weave/session';

export const agentExecutionStatusSchema = z.enum([
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
export const agentExecutionSnapshotSchema = agentExecutionSummarySchema
  .extend({
    input: agentExecutionInputSchema,
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
  recover(sessionIds: readonly string[]): Promise<void>;
  withSessionIdle<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  closeSync(): void;
  drain(): Promise<void>;
}

export interface AgentExecutionServiceOptions {
  readonly runner: AgentRunner;
  readonly sessionStore: SessionEventStore;
  readonly admit: (sessionId: string) => Promise<void>;
}

export type AgentExecutionErrorCode =
  | 'execution-not-found'
  | 'execution-busy'
  | 'execution-request-conflict'
  | 'execution-closed'
  | 'execution-output-limit'
  | 'execution-persistence-error'
  | 'execution-invalid-input';
export class AgentExecutionError extends Error {
  readonly code: AgentExecutionErrorCode;
  constructor(code: AgentExecutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentExecutionError';
    this.code = code;
  }
}
