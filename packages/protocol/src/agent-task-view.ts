import { z } from 'zod';
import {
  taskAccessSchema,
  taskIdentifierSchema,
  taskIdSchema,
  taskReasonSchema,
  taskResultKindSchema,
  taskSequenceSchema,
  taskStopReasonSchema,
} from './agent-task.js';

export const agentTaskViewStatusSchema = z.enum([
  'preparing',
  'queued',
  'running',
  'cancelling',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export const agentTaskResultPointerSchema = z.strictObject({
  sessionId: taskIdSchema,
  executionId: taskIdSchema,
  turnId: taskIdSchema,
  messageId: taskIdentifierSchema,
  terminalSequence: taskSequenceSchema,
});
export const agentTaskViewSchema = z
  .strictObject({
    taskId: taskIdSchema,
    rootSessionId: taskIdentifierSchema,
    parentSessionId: taskIdentifierSchema,
    parentTurnId: taskIdentifierSchema,
    childSessionId: taskIdSchema,
    childExecutionId: taskIdSchema,
    childTurnId: taskIdSchema,
    title: z
      .string()
      .max(240)
      .refine(
        (value) => Array.from(value).length <= 120 && new TextEncoder().encode(value).length <= 480,
      ),
    access: taskAccessSchema,
    acceptedAt: z.iso.datetime(),
    settledAt: z.iso.datetime().optional(),
    status: agentTaskViewStatusSchema,
    resultKind: taskResultKindSchema,
    reason: taskReasonSchema.optional(),
    preview: z
      .string()
      .max(4096)
      .refine((value) => new TextEncoder().encode(value).length <= 4096),
    previewTruncated: z.boolean(),
    pendingApprovalIds: z.array(taskIdentifierSchema).max(4).readonly(),
    pendingApprovalCount: z.number().int().nonnegative().safe(),
    result: agentTaskResultPointerSchema.optional(),
  })
  .refine(
    (view) =>
      view.rootSessionId === view.parentSessionId &&
      view.pendingApprovalIds.length <= view.pendingApprovalCount &&
      new Set(view.pendingApprovalIds).size === view.pendingApprovalIds.length &&
      (view.result === undefined ||
        (view.result.sessionId === view.childSessionId &&
          view.result.executionId === view.childExecutionId &&
          view.result.turnId === view.childTurnId)),
  )
  .refine((view) => {
    const noResult =
      view.resultKind === 'none' &&
      view.result === undefined &&
      view.preview === '' &&
      !view.previewTruncated;
    const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(view.status);
    if (!terminal) return noResult && view.reason === undefined && view.settledAt === undefined;
    if (view.pendingApprovalCount !== 0) return false;
    if (view.status === 'completed' && view.reason !== undefined) return false;
    if (
      view.status === 'failed' &&
      ![
        'preparation-failed',
        'generation-unavailable',
        'child-failed',
        'agent-step-limit',
      ].includes(view.reason ?? '')
    )
      return false;
    if (view.status === 'cancelled' && !taskStopReasonSchema.safeParse(view.reason).success)
      return false;
    if (
      view.status === 'interrupted' &&
      view.reason !== 'child-interrupted' &&
      view.reason !== 'preparation-interrupted'
    )
      return false;
    if (
      view.resultKind === 'none' ||
      view.reason === 'preparation-failed' ||
      view.reason === 'preparation-interrupted'
    )
      return noResult;
    return (
      view.result !== undefined &&
      (view.preview !== '' || view.previewTruncated) &&
      (view.resultKind === 'final-answer'
        ? view.status === 'completed'
        : view.status !== 'completed')
    );
  }, 'Task view result contradicts its status or reason');
export type AgentTaskViewStatus = z.infer<typeof agentTaskViewStatusSchema>;
export type AgentTaskResultPointer = z.infer<typeof agentTaskResultPointerSchema>;
export type AgentTaskView = z.infer<typeof agentTaskViewSchema>;
