import { z } from 'zod';

const encoder = new TextEncoder();
export const taskIdentifierSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[!-~]+$/);
export const taskIdSchema = z.uuid();
export const taskDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const taskSequenceSchema = z.number().int().positive().safe();
export const taskPreviewMaxBytes = 4096;

const taskCursorSchema = z
  .string()
  .min(1)
  .max(600)
  .regex(/^[!-~]+$/);
const targetIdsSchema = z
  .array(taskIdSchema)
  .min(1)
  .max(4)
  .readonly()
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate task targets');

function validTaskText(value: string, allowsWhitespaceControls: boolean): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (allowsWhitespaceControls && (codePoint === 9 || codePoint === 10 || codePoint === 13))
      continue;
    if (
      codePoint < 32 ||
      (codePoint >= 127 && codePoint <= 159) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    )
      return false;
  }
  return true;
}

export const taskTitleSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => Array.from(value).length <= 120 && encoder.encode(value).length <= 480)
  .refine((value) => validTaskText(value, false), 'Unsupported task title character');
export const taskPromptSchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => encoder.encode(value).length <= 16_384)
  .refine((value) => validTaskText(value, true), 'Unsupported task prompt character');
export const taskAccessSchema = z.enum(['read-only', 'workspace']);
export const agentTaskSpawnInputSchema = z.strictObject({
  title: taskTitleSchema,
  prompt: taskPromptSchema,
  access: taskAccessSchema.default('read-only'),
});
export const agentTaskStatusInputSchema = z.union([
  z.strictObject({ taskIds: targetIdsSchema }),
  z.strictObject({
    limit: z.number().int().min(1).max(16).default(16),
    cursor: taskCursorSchema.optional(),
  }),
]);
export const agentTaskWaitInputSchema = z.strictObject({
  taskIds: targetIdsSchema,
  timeoutMs: z.number().int().min(0).max(60_000).default(30_000),
  after: taskCursorSchema.optional(),
});
export const agentTaskCancelInputSchema = z.strictObject({ taskIds: targetIdsSchema });

export type TaskAccess = z.infer<typeof taskAccessSchema>;
export type AgentTaskSpawnInput = z.infer<typeof agentTaskSpawnInputSchema>;
export type AgentTaskStatusInput = z.infer<typeof agentTaskStatusInputSchema>;
export type AgentTaskWaitInput = z.infer<typeof agentTaskWaitInputSchema>;
export type AgentTaskCancelInput = z.infer<typeof agentTaskCancelInputSchema>;

export const taskStopReasonSchema = z.enum([
  'task-cancelled',
  'parent-stop',
  'task-deadline',
  'workspace-changed',
  'generation-revoked',
  'ownership-lost',
  'shutdown',
]);
export const taskPreparationReasonSchema = z.enum([
  'preparation-failed',
  'preparation-interrupted',
  'generation-unavailable',
  ...taskStopReasonSchema.options,
]);
export const taskExecutionReasonSchema = z.enum([
  'agent-step-limit',
  'child-failed',
  'child-interrupted',
  'generation-unavailable',
  ...taskStopReasonSchema.options,
]);
export const taskReasonSchema = z.enum([
  'preparation-failed',
  'preparation-interrupted',
  ...taskExecutionReasonSchema.options,
]);
export const taskResultKindSchema = z.enum(['final-answer', 'partial', 'none']);
export const taskExecutionStatusSchema = z.enum([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export type TaskStopReason = z.infer<typeof taskStopReasonSchema>;
export type TaskPreparationReason = z.infer<typeof taskPreparationReasonSchema>;
export type TaskExecutionReason = z.infer<typeof taskExecutionReasonSchema>;
export type TaskReason = z.infer<typeof taskReasonSchema>;
export type TaskResultKind = z.infer<typeof taskResultKindSchema>;
export type TaskExecutionStatus = z.infer<typeof taskExecutionStatusSchema>;

export function taskPreparationStatus(
  reason: TaskPreparationReason,
): 'failed' | 'cancelled' | 'interrupted' {
  if (reason === 'preparation-failed' || reason === 'generation-unavailable') return 'failed';
  if (reason === 'preparation-interrupted') return 'interrupted';
  return 'cancelled';
}

const preparationEvidenceSchema = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.literal('accepted'), parentAcceptedSequence: taskSequenceSchema }),
  z.strictObject({
    stage: z.enum(['child-created', 'project-attached']),
    parentAcceptedSequence: taskSequenceSchema,
    childOriginSequence: taskSequenceSchema,
  }),
]);

const preparationSettlementSchema = z
  .strictObject({
    phase: z.literal('preparation'),
    status: z.enum(['failed', 'cancelled', 'interrupted']),
    reason: taskPreparationReasonSchema,
    evidence: preparationEvidenceSchema,
    resultKind: z.literal('none'),
  })
  .refine(
    ({ status, reason }) => status === taskPreparationStatus(reason),
    'Preparation status contradicts its reason',
  );

const executionSettlementSchema = z
  .strictObject({
    phase: z.literal('execution'),
    status: taskExecutionStatusSchema,
    reason: taskExecutionReasonSchema.optional(),
    executionStatus: taskExecutionStatusSchema,
    childExecutionId: taskIdSchema,
    childTerminalSequence: taskSequenceSchema,
    resultKind: taskResultKindSchema,
    messageId: taskIdentifierSchema.optional(),
    preview: z
      .string()
      .max(taskPreviewMaxBytes)
      .refine((preview) => encoder.encode(preview).length <= taskPreviewMaxBytes),
    previewTruncated: z.boolean(),
  })
  .refine(({ status, reason, executionStatus }) => {
    if (reason === 'agent-step-limit')
      return status === 'failed' && executionStatus === 'completed';
    if (status !== executionStatus) return false;
    switch (status) {
      case 'completed':
        return reason === undefined;
      case 'failed':
        return reason === 'child-failed' || reason === 'generation-unavailable';
      case 'cancelled':
        return taskStopReasonSchema.safeParse(reason).success;
      case 'interrupted':
        return reason === 'child-interrupted';
    }
  }, 'Execution status contradicts its reason or child status')
  .refine(({ resultKind, status, messageId, preview, previewTruncated }) => {
    if (resultKind === 'none')
      return messageId === undefined && preview === '' && !previewTruncated;
    return (
      messageId !== undefined &&
      preview.length > 0 &&
      (resultKind === 'final-answer' ? status === 'completed' : status !== 'completed')
    );
  }, 'Execution result contradicts its status, pointer or preview');

export const taskSettlementSchema = z.discriminatedUnion('phase', [
  preparationSettlementSchema,
  executionSettlementSchema,
]);
export type TaskSettlement = z.infer<typeof taskSettlementSchema>;
