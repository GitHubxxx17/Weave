import {
  executionAcceptedPayloadSchema,
  executionClaimedPayloadSchema,
  executionQueueReorderedPayloadSchema,
  executionFinishedPayloadSchema,
} from './execution-events.js';
import { taskFactSchemas } from './agent-task-events.js';
import {
  fileWriteIntentPayloadSchema,
  fileWritePayloadSchema,
  fileUndoStartedPayloadSchema,
  fileUndoFilePayloadSchema,
  fileUndoCompletedPayloadSchema,
} from './file-undo-events.js';
import {
  skillContentPayloadSchema,
  skillCatalogAppliedPayloadSchema,
  skillRequestedPayloadSchema,
  skillFailedPayloadSchema,
  skillAppliedPayloadSchema,
} from './skill-events.js';
import {
  contextBreakdownSchema,
  messageSchema,
  planSchema,
  toolCallSchema,
  turnRequestMetadataSchema,
} from '@weave/protocol';
import { z } from 'zod';

const nonEmptyStringSchema = z.string().min(1);
const positiveSequenceSchema = z.number().int().positive().safe();
const completedStatusSchema = z.enum(['completed', 'failed', 'cancelled']);
const tokenCountSchema = z.number().int().nonnegative().safe();

/** Token usage persisted on a model step; unknown provider fields are dropped. */
const stepUsageSchema = z.object({
  inputTokens: tokenCountSchema.optional(),
  outputTokens: tokenCountSchema.optional(),
  totalTokens: tokenCountSchema.optional(),
  cacheReadTokens: tokenCountSchema.optional(),
  cacheWriteTokens: tokenCountSchema.optional(),
  reasoningTokens: tokenCountSchema.optional(),
});

const sessionCreatedPayloadSchema = z
  .object({
    title: z.string().optional(),
  })
  .passthrough();

const sessionRenamedPayloadSchema = z
  .object({
    title: nonEmptyStringSchema,
  })
  .passthrough();

const sessionLifecyclePayloadSchema = z
  .object({
    reason: z.string().optional(),
  })
  .passthrough();

const messageCreatedPayloadSchema = z
  .object({
    messageId: nonEmptyStringSchema,
    message: messageSchema,
  })
  .passthrough();

const turnStartedPayloadSchema = z
  .object({
    turnId: nonEmptyStringSchema,
    executionId: nonEmptyStringSchema.optional(),
    userMessageId: nonEmptyStringSchema.optional(),
    request: turnRequestMetadataSchema.optional(),
  })
  .passthrough();

const turnCompletedPayloadSchema = z
  .object({
    turnId: nonEmptyStringSchema,
    status: completedStatusSchema,
    reason: z.string().optional(),
  })
  .passthrough();

const stepStartedPayloadSchema = z
  .object({
    turnId: nonEmptyStringSchema,
    stepId: nonEmptyStringSchema,
    kind: nonEmptyStringSchema,
    /** Provider id of a model step, recorded so usage can be attributed later. */
    provider: nonEmptyStringSchema.optional(),
    /** Model id of a model step. */
    model: nonEmptyStringSchema.optional(),
  })
  .passthrough();

const stepCompletedPayloadSchema = z
  .object({
    turnId: nonEmptyStringSchema,
    stepId: nonEmptyStringSchema,
    status: completedStatusSchema,
    /** Provider-reported token usage of a model step, when the provider sent it. */
    usage: stepUsageSchema.optional(),
    /** Deterministic send-window composition of a model step, when computed. */
    context: contextBreakdownSchema.optional(),
    /** Current task plan, set on the tool step of an `update_plan` call. */
    plan: planSchema.optional(),
  })
  .passthrough();

const toolCallCreatedPayloadSchema = z
  .object({
    turnId: nonEmptyStringSchema,
    stepId: nonEmptyStringSchema,
    toolCall: toolCallSchema,
  })
  .passthrough();

const toolResultCreatedPayloadSchema = z
  .object({
    turnId: nonEmptyStringSchema,
    stepId: nonEmptyStringSchema,
    toolCallId: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    content: z.string(),
    truncated: z.boolean(),
    status: z.enum(['completed', 'failed']),
    errorCode: nonEmptyStringSchema.optional(),
  })
  .passthrough();

const fileSnapshotPayloadSchema = z
  .object({
    path: nonEmptyStringSchema,
    existedBefore: z.boolean(),
    previousContent: z.string(),
    snapshotId: nonEmptyStringSchema.optional(),
    turnId: nonEmptyStringSchema.optional(),
    toolCallId: nonEmptyStringSchema.optional(),
    rootIdentity: nonEmptyStringSchema.optional(),
    beforeDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .passthrough();

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 hex digest');
const byteCountSchema = z.number().int().nonnegative().safe();

/**
 * One plugin-contributed system-prompt section as it was applied: which section
 * and plugin, the SHA-256 of its text, and the size of that text in UTF-8 bytes.
 * The text itself is in a `prompt.section-content` event under the same hash.
 */
const appliedPromptSectionSchema = z
  .object({
    id: nonEmptyStringSchema,
    pluginId: nonEmptyStringSchema,
    sha256: sha256Schema,
    bytes: byteCountSchema,
  })
  .passthrough();

const promptSectionsAppliedPayloadSchema = z
  .object({
    /** The turn the set took effect for; it stays in effect until the next such event. */
    turnId: nonEmptyStringSchema,
    /** The sections in the order they were rendered; empty when none apply any more. */
    sections: z.array(appliedPromptSectionSchema),
  })
  .passthrough();

const promptSectionContentPayloadSchema = z
  .object({
    sha256: sha256Schema,
    text: nonEmptyStringSchema,
  })
  .passthrough();

/**
 * The durable facts supported by the first Session Event Store slice.
 */
export const sessionEventPayloadSchema = z.discriminatedUnion('type', [
  ...taskFactSchemas,
  z.object({ type: z.literal('execution.accepted'), payload: executionAcceptedPayloadSchema }),
  z.object({ type: z.literal('execution.finished'), payload: executionFinishedPayloadSchema }),
  z.object({ type: z.literal('execution.claimed'), payload: executionClaimedPayloadSchema }),
  z.object({
    type: z.literal('execution.queue-reordered'),
    payload: executionQueueReorderedPayloadSchema,
  }),
  z.object({
    type: z.literal('workspace.file-write-intent'),
    payload: fileWriteIntentPayloadSchema,
  }),
  z.object({ type: z.literal('workspace.file-write'), payload: fileWritePayloadSchema }),
  z.object({ type: z.literal('workspace.undo-started'), payload: fileUndoStartedPayloadSchema }),
  z.object({ type: z.literal('workspace.undo-file'), payload: fileUndoFilePayloadSchema }),
  z.object({
    type: z.literal('workspace.undo-completed'),
    payload: fileUndoCompletedPayloadSchema,
  }),
  z.object({ type: z.literal('skill.content'), payload: skillContentPayloadSchema }),
  z.object({ type: z.literal('skill.catalog-applied'), payload: skillCatalogAppliedPayloadSchema }),
  z.object({ type: z.literal('skill.requested'), payload: skillRequestedPayloadSchema }),
  z.object({ type: z.literal('skill.failed'), payload: skillFailedPayloadSchema }),
  z.object({ type: z.literal('skill.applied'), payload: skillAppliedPayloadSchema }),
  z.object({
    type: z.literal('session.created'),
    payload: sessionCreatedPayloadSchema,
  }),
  z.object({
    type: z.literal('session.renamed'),
    payload: sessionRenamedPayloadSchema,
  }),
  z.object({
    type: z.literal('session.archived'),
    payload: sessionLifecyclePayloadSchema,
  }),
  z.object({
    type: z.literal('session.restored'),
    payload: sessionLifecyclePayloadSchema,
  }),
  z.object({
    type: z.literal('session.deleted'),
    payload: sessionLifecyclePayloadSchema,
  }),
  z.object({
    type: z.literal('message.created'),
    payload: messageCreatedPayloadSchema,
  }),
  z.object({
    type: z.literal('turn.started'),
    payload: turnStartedPayloadSchema,
  }),
  z.object({
    type: z.literal('turn.completed'),
    payload: turnCompletedPayloadSchema,
  }),
  z.object({
    type: z.literal('step.started'),
    payload: stepStartedPayloadSchema,
  }),
  z.object({
    type: z.literal('step.completed'),
    payload: stepCompletedPayloadSchema,
  }),
  z.object({
    type: z.literal('tool-call.created'),
    payload: toolCallCreatedPayloadSchema,
  }),
  z.object({
    type: z.literal('tool-result.created'),
    payload: toolResultCreatedPayloadSchema,
  }),
  z.object({
    type: z.literal('workspace.file-snapshot'),
    payload: fileSnapshotPayloadSchema,
  }),
  z.object({
    type: z.literal('prompt.section-content'),
    payload: promptSectionContentPayloadSchema,
  }),
  z.object({
    type: z.literal('prompt.sections-applied'),
    payload: promptSectionsAppliedPayloadSchema,
  }),
]);

/**
 * Where a plugin's own events live in the log: `<pluginId>/<name>`. The slash
 * is what keeps them apart from the core events, whose types never contain one.
 */
export const pluginEventTypePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The type of a plugin event, `<pluginId>/<name>`. */
export type PluginEventType = `${string}/${string}`;

/** Whether `type` has the shape of a plugin event type. */
export function isPluginEventType(type: string): type is PluginEventType {
  return pluginEventTypePattern.test(type);
}

const pluginEventTypeSchema = z.custom<PluginEventType>(
  (value) => typeof value === 'string' && pluginEventTypePattern.test(value),
  { message: 'Plugin event type must look like <pluginId>/<name>' },
);

/**
 * A plugin's event as the log holds it. The Store only checks the envelope:
 * who owns the type and what its payload must look like is the plugin's
 * contract, checked by the host that registered it when the event is appended.
 * Reading never depends on that registration, so a Session still opens after a
 * plugin is removed and its old events simply stay in the log.
 */
const pluginNewEventSchema = z.object({
  type: pluginEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
});

/**
 * An event accepted from a caller before the Store assigns persistence fields.
 *
 * `eventId`, `sequence`, and `occurredAt` are intentionally absent because
 * callers must not control durable identity or ordering.
 */
export type NewSessionEvent = z.infer<typeof newSessionEventSchema>;

/**
 * The event type discriminator used by the durable Session log.
 */
export type SessionEventType = NewSessionEvent['type'];

/**
 * Runtime schema for caller-provided events: a core fact, or a plugin's event.
 */
export const newSessionEventSchema = z.union([sessionEventPayloadSchema, pluginNewEventSchema]);

const taskFactEnvelope = {
  eventId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  sequence: positiveSequenceSchema,
  occurredAt: z.iso.datetime(),
};
const [
  taskAcceptedSchema,
  taskOriginSchema,
  taskDispatchedSchema,
  taskCancelRequestedSchema,
  taskSettledSchema,
  tasksStopRequestedSchema,
] = taskFactSchemas;
const persistedEventSchemas = [
  taskAcceptedSchema.extend(taskFactEnvelope),
  taskOriginSchema.extend(taskFactEnvelope),
  taskDispatchedSchema.extend(taskFactEnvelope),
  taskCancelRequestedSchema.extend(taskFactEnvelope),
  taskSettledSchema.extend(taskFactEnvelope),
  tasksStopRequestedSchema.extend(taskFactEnvelope),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('execution.claimed'),
    payload: executionClaimedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('execution.queue-reordered'),
    payload: executionQueueReorderedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('execution.accepted'),
    payload: executionAcceptedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('execution.finished'),
    payload: executionFinishedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('workspace.file-write-intent'),
    payload: fileWriteIntentPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('workspace.file-write'),
    payload: fileWritePayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('workspace.undo-started'),
    payload: fileUndoStartedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('workspace.undo-file'),
    payload: fileUndoFilePayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('workspace.undo-completed'),
    payload: fileUndoCompletedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('skill.content'),
    payload: skillContentPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('skill.catalog-applied'),
    payload: skillCatalogAppliedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('skill.requested'),
    payload: skillRequestedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('skill.failed'),
    payload: skillFailedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('skill.applied'),
    payload: skillAppliedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('session.created'),
    payload: sessionCreatedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('session.renamed'),
    payload: sessionRenamedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('session.archived'),
    payload: sessionLifecyclePayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('session.restored'),
    payload: sessionLifecyclePayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('session.deleted'),
    payload: sessionLifecyclePayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('message.created'),
    payload: messageCreatedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('turn.started'),
    payload: turnStartedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('turn.completed'),
    payload: turnCompletedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('step.started'),
    payload: stepStartedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('step.completed'),
    payload: stepCompletedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('tool-call.created'),
    payload: toolCallCreatedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('tool-result.created'),
    payload: toolResultCreatedPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('workspace.file-snapshot'),
    payload: fileSnapshotPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('prompt.section-content'),
    payload: promptSectionContentPayloadSchema,
  }),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: z.literal('prompt.sections-applied'),
    payload: promptSectionsAppliedPayloadSchema,
  }),
] as const;

/**
 * Runtime schema for events after a Store has assigned persistence fields.
 */
export const sessionEventSchema = z.union([
  z.discriminatedUnion('type', persistedEventSchemas),
  z.object({
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    sequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    type: pluginEventTypeSchema,
    payload: z.record(z.string(), z.unknown()),
  }),
]);

/**
 * The persisted event envelope with a type-safe payload discriminator.
 */
export type SessionEvent = z.infer<typeof sessionEventSchema>;
