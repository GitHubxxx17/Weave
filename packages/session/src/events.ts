import { messageSchema } from '@weave/protocol';
import { z } from 'zod';

const nonEmptyStringSchema = z.string().min(1);
const positiveSequenceSchema = z.number().int().positive().safe();
const completedStatusSchema = z.enum(['completed', 'failed', 'cancelled']);

const sessionCreatedPayloadSchema = z
  .object({
    title: z.string().optional(),
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
  })
  .passthrough();

const stepCompletedPayloadSchema = z
  .object({
    turnId: nonEmptyStringSchema,
    stepId: nonEmptyStringSchema,
    status: completedStatusSchema,
  })
  .passthrough();

/**
 * The durable facts supported by the first Session Event Store slice.
 */
export const sessionEventPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.created'),
    payload: sessionCreatedPayloadSchema,
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
]);

/**
 * An event accepted from a caller before the Store assigns persistence fields.
 *
 * `eventId`, `sequence`, and `occurredAt` are intentionally absent because
 * callers must not control durable identity or ordering.
 */
export type NewSessionEvent = z.infer<typeof sessionEventPayloadSchema>;

/**
 * The event type discriminator used by the durable Session log.
 */
export type SessionEventType = NewSessionEvent['type'];

/**
 * Runtime schema for caller-provided events.
 */
export const newSessionEventSchema = sessionEventPayloadSchema;

const persistedEventSchemas = [
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
] as const;

/**
 * Runtime schema for events after a Store has assigned persistence fields.
 */
export const sessionEventSchema = z.discriminatedUnion('type', persistedEventSchemas);

/**
 * The persisted event envelope with a type-safe payload discriminator.
 */
export type SessionEvent = z.infer<typeof sessionEventSchema>;
