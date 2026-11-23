import { createHash } from 'node:crypto';
import {
  taskAccessSchema,
  taskDigestSchema,
  taskIdentifierSchema,
  taskIdSchema,
  taskPromptSchema,
  taskSequenceSchema,
  taskSettlementSchema,
  taskStopReasonSchema,
  taskTitleSchema,
  turnRequestMetadataSchema,
} from '@weave/protocol';
import { z } from 'zod';

const lineage = {
  version: z.literal(1),
  taskId: taskIdSchema,
  rootSessionId: taskIdentifierSchema,
  parentSessionId: taskIdentifierSchema,
  childSessionId: taskIdSchema,
  childExecutionId: taskIdSchema,
  childTurnId: taskIdSchema,
  childUserMessageId: taskIdSchema,
};

function validLineage(value: {
  rootSessionId: string;
  parentSessionId: string;
  taskId: string;
  childSessionId: string;
  childExecutionId: string;
  childTurnId: string;
  childUserMessageId: string;
}): boolean {
  return (
    value.parentSessionId === value.rootSessionId &&
    new Set([
      value.parentSessionId,
      value.taskId,
      value.childSessionId,
      value.childExecutionId,
      value.childTurnId,
      value.childUserMessageId,
    ]).size === 6
  );
}

const taskProjectSchema = z
  .strictObject({
    projectId: taskIdentifierSchema,
    folderRevision: z.number().int().nonnegative().safe(),
    folderPath: z.string().min(1).max(16_384).optional(),
    rootDigest: taskDigestSchema.optional(),
  })
  .refine(
    ({ folderPath, rootDigest }) => (folderPath === undefined) === (rootDigest === undefined),
  );
const taskToolIdentitySchema = z.strictObject({
  ownerId: taskIdentifierSchema,
  name: taskIdentifierSchema,
  definitionDigest: taskDigestSchema,
});

export const agentTaskAcceptedPayloadSchema = z
  .strictObject({
    ...lineage,
    parentExecutionId: taskIdentifierSchema,
    parentTurnId: taskIdentifierSchema,
    parentToolCallId: taskIdentifierSchema,
    depth: z.literal(1),
    requestId: taskIdentifierSchema,
    requestDigest: taskDigestSchema,
    title: taskTitleSchema,
    prompt: taskPromptSchema,
    access: taskAccessSchema,
    settings: turnRequestMetadataSchema.extend({
      provider: taskIdentifierSchema,
      model: taskIdentifierSchema,
      reasoningEffort: taskIdentifierSchema.optional(),
      useProviderDefaults: z.literal(false),
    }),
    tools: z
      .array(taskToolIdentitySchema)
      .readonly()
      .refine((tools) => new Set(tools.map(({ name }) => name)).size === tools.length),
    project: taskProjectSchema,
  })
  .refine(
    (value) => validLineage(value) && value.requestId === `agent-task:${value.taskId}`,
    'Invalid task acceptance lineage',
  );

export const agentTaskOriginPayloadSchema = z
  .strictObject({
    ...lineage,
    parentAcceptedSequence: taskSequenceSchema,
    parentAcceptedDigest: taskDigestSchema,
    admissionClass: z.literal('agent-task-once'),
  })
  .refine(validLineage, 'Invalid task origin lineage');

const parentFact = { version: z.literal(1), taskId: taskIdSchema };
export const agentTaskDispatchedPayloadSchema = z.strictObject({
  ...parentFact,
  childExecutionAcceptedSequence: taskSequenceSchema.min(3),
  childExecutionAcceptedDigest: taskDigestSchema,
});
export const agentTaskCancelRequestedPayloadSchema = z.strictObject({
  ...parentFact,
  operationId: taskIdentifierSchema,
  reason: taskStopReasonSchema,
});
export const agentTaskSettledPayloadSchema = z.strictObject({
  ...parentFact,
  settlement: taskSettlementSchema,
});
export const agentTasksStopRequestedPayloadSchema = z.strictObject({
  version: z.literal(1),
  operationId: taskIdentifierSchema,
  taskIds: z
    .array(taskIdSchema)
    .max(4)
    .readonly()
    .refine((ids) => new Set(ids).size === ids.length),
});

export const taskFactSchemas = [
  z.strictObject({
    type: z.literal('agent.task.accepted'),
    payload: agentTaskAcceptedPayloadSchema,
  }),
  z.strictObject({ type: z.literal('agent.task.origin'), payload: agentTaskOriginPayloadSchema }),
  z.strictObject({
    type: z.literal('agent.task.dispatched'),
    payload: agentTaskDispatchedPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('agent.task.cancel-requested'),
    payload: agentTaskCancelRequestedPayloadSchema,
  }),
  z.strictObject({ type: z.literal('agent.task.settled'), payload: agentTaskSettledPayloadSchema }),
  z.strictObject({
    type: z.literal('agent.tasks.stop-requested'),
    payload: agentTasksStopRequestedPayloadSchema,
  }),
] as const;

export type AgentTaskAccepted = z.infer<typeof agentTaskAcceptedPayloadSchema>;
export type AgentTaskOrigin = z.infer<typeof agentTaskOriginPayloadSchema>;
export type AgentTaskDispatched = z.infer<typeof agentTaskDispatchedPayloadSchema>;
export type AgentTaskCancelRequested = z.infer<typeof agentTaskCancelRequestedPayloadSchema>;
export type AgentTaskSettled = z.infer<typeof agentTaskSettledPayloadSchema>;
export type AgentTasksStopRequested = z.infer<typeof agentTasksStopRequestedPayloadSchema>;
export type AgentTaskProject = z.infer<typeof taskProjectSchema>;
export type AgentTaskToolIdentity = z.infer<typeof taskToolIdentitySchema>;

/** Canonical digest of a validated JSON fact, excluding the Store envelope. */
export function agentTaskFactDigest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const object = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [key, object[key]]),
      );
    }
    return item;
  });
  return createHash('sha256').update(canonical).digest('hex');
}
