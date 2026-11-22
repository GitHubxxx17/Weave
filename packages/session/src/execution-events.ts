import { contentPartSchema, skillRefsSchema, turnRequestMetadataSchema } from '@weave/protocol';
import { z } from 'zod';
import type { SessionEvent } from './events.js';

const identifierSchema = z.string().min(1).max(240);
const strictContentSchema = z.discriminatedUnion('type', [
  contentPartSchema.options[0].strict(),
  contentPartSchema.options[1].strict(),
  contentPartSchema.options[2].strict(),
]);

function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return typeof value === 'object' && Object.values(value).every(isJson);
}

/** Closed JSON input captured at durable execution acceptance, before defaults. */
export const agentExecutionInputSchema = turnRequestMetadataSchema
  .extend({
    userMessage: z
      .object({ role: z.literal('user'), content: z.array(strictContentSchema).readonly() })
      .strict(),
    skills: skillRefsSchema.optional(),
  })
  .strict()
  .refine(isJson, 'Execution input must contain only JSON values');
export type AgentExecutionInput = z.infer<typeof agentExecutionInputSchema>;

export const executionAcceptedPayloadSchema = z
  .object({
    executionId: identifierSchema,
    requestId: identifierSchema,
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    turnId: identifierSchema,
    userMessageId: identifierSchema,
    input: agentExecutionInputSchema,
  })
  .strict();

export const executionFinishedPayloadSchema = z
  .object({
    executionId: identifierSchema,
    status: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
    reason: z.string().optional(),
  })
  .strict();

export type SessionExecution = z.infer<typeof executionAcceptedPayloadSchema> & {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly status: 'accepted' | z.infer<typeof executionFinishedPayloadSchema>['status'];
  readonly durableThroughSequence?: number;
  readonly reason?: string;
};

/** Execution control facts do not project accepted user input into conversation history. */
export function projectAgentExecutions(
  events: readonly SessionEvent[],
): readonly SessionExecution[] {
  const executions = new Map<string, SessionExecution>();
  const requestIds = new Set<string>();
  for (const event of events) {
    if (event.type === 'execution.accepted') {
      if (executions.has(event.payload.executionId) || requestIds.has(event.payload.requestId)) {
        throw new Error('Duplicate execution acceptance');
      }
      requestIds.add(event.payload.requestId);
      executions.set(event.payload.executionId, {
        ...structuredClone(event.payload),
        sessionId: event.sessionId,
        createdAt: event.occurredAt,
        status: 'accepted',
      });
    } else if (event.type === 'execution.finished') {
      const accepted = executions.get(event.payload.executionId);
      if (accepted === undefined || accepted.status !== 'accepted')
        throw new Error('Invalid execution completion');
      executions.set(event.payload.executionId, {
        ...accepted,
        status: event.payload.status,
        durableThroughSequence: event.sequence,
        ...(event.payload.reason === undefined ? {} : { reason: event.payload.reason }),
      });
    }
  }
  return [...executions.values()];
}
