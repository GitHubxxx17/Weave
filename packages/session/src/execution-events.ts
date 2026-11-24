import {
  contentPartSchema,
  executionContextsSchema,
  fileReferencesSchema,
  skillRefsSchema,
  turnRequestMetadataSchema,
} from '@weave/protocol';
import { z } from 'zod';
import type { SessionEvent } from './events.js';
import { capturedFileContextSchema } from './file-context.js';
import { capturedWorkspaceContextSchema, workspaceContextMatches } from './workspace-context.js';

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
    files: fileReferencesSchema.optional(),
    contexts: executionContextsSchema.optional(),
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
    dispatch: z.literal('queued').optional(),
    runInput: agentExecutionInputSchema.optional(),
    fileContext: capturedFileContextSchema.optional(),
    workspaceContext: capturedWorkspaceContextSchema.optional(),
  })
  .strict()
  .refine(({ input, fileContext, workspaceContext, dispatch, runInput }) => {
    if (input.files === undefined && input.contexts === undefined)
      return (
        fileContext === undefined &&
        workspaceContext === undefined &&
        runInput?.files === undefined &&
        runInput?.contexts === undefined
      );
    if (dispatch !== 'queued' || runInput === undefined) return false;
    const filesMatch =
      input.files === undefined
        ? fileContext === undefined
        : fileContext !== undefined &&
          input.files.length === fileContext.files.length &&
          input.files.every((file, index) => file.path === fileContext.files[index]?.path);
    const contextsMatch =
      input.contexts === undefined
        ? workspaceContext === undefined
        : workspaceContext !== undefined &&
          workspaceContextMatches(input.contexts, workspaceContext);
    return filesMatch && contextsMatch;
  }, 'File references and contexts require a matching captured batch and queued effective input')
  .refine(({ dispatch, input, runInput }) => {
    if (dispatch !== 'queued') return true;
    if (runInput === undefined || runInput.useProviderDefaults !== false) return false;
    const invariant = (value: AgentExecutionInput): string => {
      const {
        temperature: _temperature,
        maxTokens: _maxTokens,
        useProviderDefaults: _defaults,
        ...rest
      } = value;
      void _temperature;
      void _maxTokens;
      void _defaults;
      return JSON.stringify(rest);
    };
    return (
      invariant(input) === invariant(runInput) &&
      (input.temperature === undefined || input.temperature === runInput.temperature) &&
      (input.maxTokens === undefined || input.maxTokens === runInput.maxTokens) &&
      (input.useProviderDefaults !== false ||
        (input.temperature === runInput.temperature && input.maxTokens === runInput.maxTokens))
    );
  }, 'Queued executions require an immutable effective sampling snapshot');

export const executionClaimedPayloadSchema = z.object({ executionId: identifierSchema }).strict();
export const executionQueueRequestSchema = z
  .object({
    requestId: identifierSchema,
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expectedRevision: z.number().int().nonnegative().safe(),
  })
  .strict();
export const executionQueueReorderedPayloadSchema = executionQueueRequestSchema
  .extend({
    executionIds: z
      .array(identifierSchema)
      .max(10)
      .readonly()
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();

export const executionFinishedPayloadSchema = z
  .object({
    executionId: identifierSchema,
    status: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
    reason: z.string().optional(),
    queueRequest: executionQueueRequestSchema.optional(),
  })
  .strict();

export type SessionExecution = z.infer<typeof executionAcceptedPayloadSchema> & {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly status: 'queued' | 'accepted' | z.infer<typeof executionFinishedPayloadSchema>['status'];
  readonly durableThroughSequence?: number;
  readonly reason?: string;
};

export type SessionExecutionMetadata = Omit<
  SessionExecution,
  'input' | 'runInput' | 'fileContext' | 'workspaceContext'
> & {
  readonly preview: string;
  readonly provider: string;
  readonly model: string;
  readonly imageCount: number;
  readonly skillCount: number;
  readonly fileCount: number;
};
export interface SessionExecutionQueue {
  readonly revision: number;
  readonly active: SessionExecutionMetadata | null;
  readonly queued: readonly SessionExecutionMetadata[];
  readonly executions: readonly SessionExecutionMetadata[];
  readonly controls: readonly (z.infer<typeof executionQueueRequestSchema> & {
    readonly sequence: number;
  })[];
}

function projectExecutions(events: readonly SessionEvent[]) {
  const executions = new Map<string, SessionExecution>();
  const requestIds = new Set<string>();
  const controlIds = new Set<string>();
  const controls: (z.infer<typeof executionQueueRequestSchema> & { sequence: number })[] = [];
  let queued: string[] = [];
  let active: string | undefined;
  let revision = 0;
  const control = (
    request: z.infer<typeof executionQueueRequestSchema>,
    sequence: number,
  ): void => {
    if (controlIds.has(request.requestId) || request.expectedRevision !== revision)
      throw new Error('Invalid execution queue control');
    controlIds.add(request.requestId);
    controls.push({ ...request, sequence });
  };
  for (const event of events) {
    if (event.type === 'execution.accepted') {
      const payload = event.payload;
      if (executions.has(payload.executionId) || requestIds.has(payload.requestId))
        throw new Error('Duplicate execution acceptance');
      requestIds.add(payload.requestId);
      if (payload.dispatch === 'queued') queued.push(payload.executionId);
      else {
        if (active !== undefined) throw new Error('Multiple claimed executions');
        active = payload.executionId;
      }
      executions.set(payload.executionId, {
        ...payload,
        sessionId: event.sessionId,
        createdAt: event.occurredAt,
        status: payload.dispatch === 'queued' ? 'queued' : 'accepted',
      });
      revision = event.sequence;
    } else if (event.type === 'execution.claimed') {
      const accepted = executions.get(event.payload.executionId);
      if (
        active !== undefined ||
        accepted?.status !== 'queued' ||
        queued[0] !== accepted.executionId
      )
        throw new Error('Invalid execution claim');
      queued.shift();
      active = accepted.executionId;
      executions.set(accepted.executionId, { ...accepted, status: 'accepted' });
      revision = event.sequence;
    } else if (event.type === 'execution.queue-reordered') {
      const ids = event.payload.executionIds;
      if (
        ids.length !== queued.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !queued.includes(id))
      )
        throw new Error('Invalid execution queue permutation');
      control(event.payload, event.sequence);
      queued = [...ids];
      revision = event.sequence;
    } else if (event.type === 'execution.finished') {
      const accepted = executions.get(event.payload.executionId);
      if (
        accepted === undefined ||
        (accepted.status !== 'accepted' && accepted.status !== 'queued')
      )
        throw new Error('Invalid execution completion');
      if (accepted.status === 'queued' && event.payload.status === 'completed')
        throw new Error('Unclaimed execution cannot complete');
      if (event.payload.queueRequest !== undefined) {
        if (
          accepted.status !== 'queued' ||
          event.payload.status !== 'cancelled' ||
          event.payload.reason !== 'queue-cancelled'
        )
          throw new Error('Invalid queued cancellation');
        control(event.payload.queueRequest, event.sequence);
      }
      if (active === accepted.executionId) active = undefined;
      queued = queued.filter((id) => id !== accepted.executionId);
      executions.set(accepted.executionId, {
        ...accepted,
        status: event.payload.status,
        durableThroughSequence: event.sequence,
        ...(event.payload.reason === undefined ? {} : { reason: event.payload.reason }),
      });
      revision = event.sequence;
    }
  }
  return { executions: [...executions.values()], queued, active, revision, controls };
}

/** Execution control facts do not project accepted user input into conversation history. */
export function projectAgentExecutions(
  events: readonly SessionEvent[],
): readonly SessionExecution[] {
  return structuredClone(projectExecutions(events).executions);
}

/** Metadata-only queue projection; never retains accepted content or image bytes. */
export function projectAgentExecutionQueue(events: readonly SessionEvent[]): SessionExecutionQueue {
  const projection = projectExecutions(events);
  const bounded = (value: string): string => {
    let result = '';
    let count = 0;
    for (const point of value) {
      if (count++ === 240) break;
      result += point;
    }
    return result;
  };
  const executions: SessionExecutionMetadata[] = projection.executions.map((execution) => {
    const { input } = execution;
    let preview = '';
    let imageCount = 0;
    for (const part of input.userMessage.content) {
      if (part.type === 'image') imageCount++;
      else if (part.type === 'text' && Array.from(preview).length < 240)
        preview = bounded(preview + (preview === '' ? '' : '\n') + part.text);
    }
    return {
      executionId: execution.executionId,
      requestId: execution.requestId,
      requestDigest: execution.requestDigest,
      turnId: execution.turnId,
      userMessageId: execution.userMessageId,
      sessionId: execution.sessionId,
      createdAt: execution.createdAt,
      status: execution.status,
      ...(execution.dispatch === undefined ? {} : { dispatch: execution.dispatch }),
      ...(execution.durableThroughSequence === undefined
        ? {}
        : { durableThroughSequence: execution.durableThroughSequence }),
      ...(execution.reason === undefined ? {} : { reason: execution.reason }),
      preview,
      provider: bounded(input.provider),
      model: bounded(input.model),
      imageCount,
      skillCount: input.skills?.length ?? 0,
      fileCount: input.files?.length ?? 0,
    };
  });
  return {
    revision: projection.revision,
    active: executions.find((item) => item.executionId === projection.active) ?? null,
    queued: projection.queued.map((id) => executions.find((item) => item.executionId === id)!),
    executions,
    controls: projection.controls,
  };
}
