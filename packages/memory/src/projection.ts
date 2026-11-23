import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  memoryAccessSchema,
  memoryContentSchema,
  memoryCurrentSchema,
  memoryDigestSchema,
  memoryIdSchema,
  memoryOperationSchema,
  memoryProvenanceSchema,
  memoryReceiptSchema,
  memoryRefSchema,
  memoryScopeSchema,
  memorySubjectSchema,
  type MemoryContent,
} from '@weave/protocol';
import type { MemoryEvent, MemoryRequestKey } from './types.js';
import { persistence } from './errors.js';

export const memoryRequestKeySchema = z.strictObject({
  scope: memoryScopeSchema,
  requestId: memoryIdSchema,
  callerKey: z.string().min(1).max(2048),
  digest: memoryDigestSchema,
});
export const memoryEventSchema = z.strictObject({
  version: z.literal(1),
  eventId: memoryIdSchema,
  sequence: z.number().int().positive().safe(),
  kind: z.enum(['created', 'revised', 'reviewed', 'deleted', 'access-changed']),
  occurredAt: z.iso.datetime(),
  subject: memorySubjectSchema,
  key: memoryRequestKeySchema,
  operation: memoryOperationSchema,
  provenance: memoryProvenanceSchema,
  previousRef: memoryRefSchema.optional(),
  current: memoryCurrentSchema.optional(),
  reason: z.string().max(1024).optional(),
  access: memoryAccessSchema.optional(),
  receipt: memoryReceiptSchema,
});
export function scopeKey(scope: MemoryRequestKey['scope']): string {
  return scope.kind === 'user' ? 'user' : `project:${scope.projectId}`;
}
export function memoryContentDigest(input: MemoryContent): string {
  const value = memoryContentSchema.parse(input);
  return createHash('sha256')
    .update(JSON.stringify({ title: value.title, content: value.content, tags: value.tags }))
    .digest('hex');
}
export function agentInvocation(
  event: Pick<MemoryEvent, 'provenance' | 'operation'>,
): string | undefined {
  const p = event.provenance;
  const operation =
    event.operation === 'create' || event.operation === 'revise'
      ? 'memory.save'
      : event.operation === 'remove'
        ? 'memory.delete'
        : event.operation;
  return p.actor === 'agent'
    ? JSON.stringify([p.sessionId, p.executionId, p.turnId, p.toolCallId, operation])
    : undefined;
}
export function parseMemoryEvent(value: unknown): MemoryEvent {
  try {
    const event = memoryEventSchema.parse(value);
    if (
      event.receipt.sequence !== event.sequence ||
      event.receipt.requestId !== event.key.requestId ||
      event.receipt.operation !== event.operation ||
      JSON.stringify(event.receipt.subject) !== JSON.stringify(event.subject) ||
      scopeKey(event.key.scope) !== scopeKey(event.subject.scope)
    )
      throw persistence();
    if (event.kind === 'access-changed') {
      if (
        event.subject.kind !== 'scope-access' ||
        event.operation !== 'setAccess' ||
        !event.access ||
        event.current ||
        event.previousRef ||
        event.subject.settingRevision !== event.access.settingRevision ||
        scopeKey(event.access.scope) !== scopeKey(event.subject.scope) ||
        JSON.stringify(event.receipt.result) !== JSON.stringify(event.access) ||
        event.provenance.actor !== 'local-user'
      )
        throw persistence();
    } else {
      if (event.subject.kind !== 'record' || event.access) throw persistence();
      const expectedOperation = {
        created: 'create',
        revised: 'revise',
        reviewed: 'review',
        deleted: 'remove',
      }[event.kind];
      if (
        event.operation !== expectedOperation ||
        (event.kind === 'created') !== (event.previousRef === undefined)
      )
        throw persistence();
      if (event.kind === 'deleted') {
        if (
          event.current ||
          !('deleted' in event.receipt.result) ||
          event.receipt.result.memoryId !== event.subject.memoryId ||
          event.receipt.result.revision !== event.subject.revision
        )
          throw persistence();
      } else {
        const current = event.current;
        if (
          !current ||
          memoryContentDigest({
            title: current.title,
            content: current.content,
            tags: current.tags,
          }) !== current.ref.sha256 ||
          current.ref.memoryId !== event.subject.memoryId ||
          current.ref.revision !== event.subject.revision ||
          scopeKey(current.ref.scope) !== scopeKey(event.subject.scope) ||
          current.updatedAt !== event.occurredAt ||
          JSON.stringify(event.receipt.result) !== JSON.stringify(current.ref) ||
          JSON.stringify(current.provenance) !== JSON.stringify(event.provenance)
        )
          throw persistence();
        if (
          event.kind === 'reviewed'
            ? event.provenance.actor !== 'local-user' || current.review !== 'user-reviewed'
            : current.review !==
              (event.provenance.actor === 'agent' ? 'agent-authored' : 'user-reviewed')
        )
          throw persistence();
      }
    }
    return {
      ...event,
      ...(event.previousRef === undefined ? {} : { previousRef: event.previousRef }),
      ...(event.current === undefined ? {} : { current: event.current }),
      ...(event.access === undefined ? {} : { access: event.access }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    };
  } catch (error) {
    throw persistence(error);
  }
}
