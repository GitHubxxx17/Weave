import { createHash, randomUUID } from 'node:crypto';
import {
  agentTaskFactDigest,
  projectAgentExecutions,
  projectAgentExecutionQueue,
  type SessionExecutionMetadata,
  type SessionExecutionQueue,
  type SessionEvent,
  projectSession,
  type NewSessionEvent,
  type SessionExecution,
  type SessionTurn,
  capturedFileContextSchema,
  executionAcceptedPayloadSchema,
  fileAttachmentSummaries,
  type CapturedFileContext,
} from '@weave/session';
import { taskStopReasonSchema, type TaskStopReason } from '@weave/protocol';
import {
  agentRuntimeEventSchema,
  type AgentRunner,
  type AgentRuntimeEvent,
} from './agent-types.js';
import {
  boundTaskLaunchSchema,
  readTaskLaunchAuthority,
  readTaskRunnerLease,
  registerBoundTaskExecutionPort,
  taskBindingConflict,
  type AdaptTaskRunnerLeaseOptions,
  type BoundTaskExecutionPort,
  type TaskLaunchAuthority,
  type TaskRunnerLease,
} from './agent-task-execution.js';
import type { TaskExecutionCleanup } from './agent-task-types.js';
import {
  AgentExecutionError,
  agentExecutionCursorSchema,
  agentExecutionLaunchSchema,
  agentExecutionInputSchema,
  agentExecutionQueueReorderSchema,
  agentExecutionQueuedCancelSchema,
  type AgentExecutionQueueSnapshot,
  type AgentExecutionSummary,
  type AgentExecutionFrame,
  type AgentExecutionService,
  type AgentExecutionServiceOptions,
  type AgentExecutionSnapshot,
  type AgentExecutionStatus,
} from './agent-execution-types.js';

const snapshotMaxBytes = 8 * 1024 * 1024;
const snapshotMaxEvents = 4096;
const ringMaxBytes = 1024 * 1024;
const ringMaxFrames = 256;
const subscriberMaxFrames = 64;
const encoder = new TextEncoder();
const bytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;
const terminalStatuses = new Set<AgentExecutionStatus>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

function changeSignal() {
  let notify!: () => void;
  const promise = new Promise<void>((resolve) => {
    notify = resolve;
  });
  return { promise, notify };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

interface Subscriber {
  push(frame: AgentExecutionFrame): void;
  finish(): void;
  close(): void;
}
interface LiveExecution {
  readonly accepted: SessionExecution;
  readonly task?: BoundExecution;
  readonly runner: AgentRunner;
  readonly controller: AbortController;
  readonly subscribers: Set<Subscriber>;
  readonly ring: {
    readonly sequence: number;
    readonly frame: AgentExecutionFrame;
    readonly bytes: number;
  }[];
  events: AgentRuntimeEvent[];
  status: AgentExecutionStatus;
  sequence: number;
  ringBytes: number;
  outputBytes: number;
  error?: { code: string; message: string };
  durableThroughSequence?: number;
  outputLimited: boolean;
  promise: Promise<void>;
}

interface BoundExecution {
  readonly token: TaskLaunchAuthority;
  readonly authority: ReturnType<typeof readTaskLaunchAuthority>;
  lease?: { readonly token: TaskRunnerLease; readonly options: AdaptTaskRunnerLeaseOptions };
  reservation: 'none' | 'unconfirmed' | 'confirmed';
  stopReason?: TaskStopReason;
  unstartedFinishReason?: TaskStopReason | 'generation-unavailable';
  pendingLaunches: number;
  running?: LiveExecution;
  finish?: () => Promise<void>;
  durable?: SessionExecution | null;
  cleanup?: TaskExecutionCleanup;
  released: boolean;
  startsClosed: boolean;
  issue?: AgentExecutionError;
  change: ReturnType<typeof changeSignal>;
}

interface QueueSubscriber {
  push(snapshot: AgentExecutionQueueSnapshot): void;
  close(): void;
}
interface QueueState {
  revision: number;
  active: SessionExecutionMetadata | null;
  queued: readonly SessionExecutionMetadata[];
  readonly subscribers: Set<QueueSubscriber>;
  error?: { code: string; message: string };
  unresolvedAdmission?: { requestId: string; requestDigest: string; executionId: string };
}
class AppendFailure extends Error {
  constructor(
    readonly uncertain: boolean,
    cause: unknown,
  ) {
    super('Execution persistence failed', { cause });
  }
}

/** Owns execution production independently from every detachable observer. */
export function createAgentExecutionService(
  options: AgentExecutionServiceOptions,
): AgentExecutionService {
  const epoch = randomUUID();
  const live = new Map<string, LiveExecution>();
  const queues = new Map<string, QueueState>();
  const pendingCounts = new Map<string, number>();
  const bound = new WeakMap<TaskLaunchAuthority, BoundExecution>();
  const reservedTasks = new Map<string, BoundExecution>();
  let tail = Promise.resolve();
  let queueSequence = 0;
  let closed = false;
  const captureController = new AbortController();
  const cursor = (executionId: string, sequence: number): string =>
    `${epoch}:${executionId}:${sequence}`;
  // One short mutation gate also makes global pending reservations atomic.
  const gate = async <T>(_sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      cleanup(_sessionId);
      release();
    }
  };
  const requireId = (value: string): void => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 240)
      throw new AgentExecutionError('execution-invalid-input', 'Execution identifier is invalid');
  };
  const records = async (sessionId: string) =>
    projectAgentExecutions(await options.sessionStore.read(sessionId));
  const refuseOrdinaryTaskLaunch = (events: readonly SessionEvent[]): void => {
    if (events.some((event) => event.type === 'agent.task.origin'))
      throw new AgentExecutionError(
        'execution-task-session-read-only',
        'Task Sessions only run their original bound execution',
      );
  };
  const digest = (value: unknown): string =>
    createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
  const summary = (
    accepted: SessionExecutionMetadata | SessionExecution,
    state = live.get(accepted.executionId),
  ): AgentExecutionSummary => ({
    executionId: accepted.executionId,
    requestId: accepted.requestId,
    sessionId: accepted.sessionId,
    turnId: accepted.turnId,
    userMessageId: accepted.userMessageId,
    createdAt: accepted.createdAt,
    status: state?.status ?? accepted.status,
    cursor: cursor(accepted.executionId, state?.sequence ?? 0),
    ...((state?.durableThroughSequence ?? accepted.durableThroughSequence) === undefined
      ? {}
      : {
          durableThroughSequence: state?.durableThroughSequence ?? accepted.durableThroughSequence,
        }),
    ...(state?.error === undefined
      ? accepted.reason === undefined
        ? {}
        : { error: { code: accepted.reason, message: accepted.reason } }
      : { error: state.error }),
  });
  const view = (sessionId: string, state: QueueState): AgentExecutionQueueSnapshot =>
    structuredClone({
      sessionId,
      revision: state.revision,
      cursor: cursor(encodeURIComponent(sessionId), queueSequence),
      active: state.active === null ? null : summary(state.active),
      queued: state.queued.map((item) => ({
        ...summary(item),
        preview: item.preview,
        provider: item.provider,
        model: item.model,
        imageCount: item.imageCount,
        skillCount: item.skillCount,
        fileCount: item.fileCount,
      })),
      scheduler: state.error !== undefined ? 'blocked' : closed ? 'closing' : 'ready',
      limits: { sessionQueued: 10, globalQueued: 100 },
      ...(state.error === undefined ? {} : { error: state.error }),
    });
  const cleanup = (sessionId: string): void => {
    const state = queues.get(sessionId);
    if (
      state !== undefined &&
      state.active === null &&
      state.queued.length === 0 &&
      state.subscribers.size === 0 &&
      state.error === undefined
    ) {
      queues.delete(sessionId);
      pendingCounts.delete(sessionId);
    }
  };
  const notifyQueue = (sessionId: string): void => {
    queueSequence++;
    const state = queues.get(sessionId);
    if (state === undefined) return;
    const current = view(sessionId, state);
    for (const subscriber of state.subscribers) subscriber.push(structuredClone(current));
  };
  const sync = (sessionId: string, events: readonly SessionEvent[]): SessionExecutionQueue => {
    const projection = projectAgentExecutionQueue(events);
    const previous = queues.get(sessionId);
    queues.set(sessionId, {
      revision: projection.revision,
      active: projection.active,
      queued: projection.queued,
      subscribers: previous?.subscribers ?? new Set(),
      ...(previous?.error === undefined ? {} : { error: previous.error }),
      ...(previous?.unresolvedAdmission === undefined
        ? {}
        : { unresolvedAdmission: previous.unresolvedAdmission }),
    });
    // An uncertain append keeps its conservative reservation until restart.
    if (previous?.error === undefined) {
      if (projection.queued.length === 0) pendingCounts.delete(sessionId);
      else pendingCounts.set(sessionId, projection.queued.length);
    }
    return projection;
  };
  const load = async (sessionId: string) => {
    const events = await options.sessionStore.read(sessionId);
    return { events, projection: sync(sessionId, events) };
  };
  const block = (sessionId: string): void => {
    const current = queues.get(sessionId) ?? {
      revision: 0,
      active: null,
      queued: [],
      subscribers: new Set<QueueSubscriber>(),
    };
    current.error = {
      code: 'execution-persistence-error',
      message: 'Execution persistence is uncertain; restart is required',
    };
    queues.set(sessionId, current);
    notifyQueue(sessionId);
  };
  const requireMutable = (sessionId: string): void => {
    if (closed) throw new AgentExecutionError('execution-closed', 'Execution admission is closed');
    if (queues.get(sessionId)?.error !== undefined)
      throw new AgentExecutionError(
        'execution-persistence-error',
        'Session queue is blocked by uncertain persistence',
      );
  };
  const append = async (
    sessionId: string,
    batch: readonly NewSessionEvent[],
  ): Promise<readonly SessionEvent[]> => {
    try {
      return await options.sessionStore.append(sessionId, batch);
    } catch (cause: unknown) {
      let events: readonly SessionEvent[];
      try {
        events = await options.sessionStore.read(sessionId);
      } catch {
        block(sessionId);
        throw new AppendFailure(true, cause);
      }
      const confirmed = batch.map((item) =>
        events.find(
          (event) =>
            event.type === item.type &&
            canonicalJson(event.payload) === canonicalJson(item.payload),
        ),
      );
      if (confirmed.every((event): event is SessionEvent => event !== undefined)) return confirmed;
      throw new AppendFailure(false, cause);
    }
  };
  const snapshot = (accepted: SessionExecution, state?: LiveExecution): AgentExecutionSnapshot =>
    structuredClone({
      executionId: accepted.executionId,
      requestId: accepted.requestId,
      sessionId: accepted.sessionId,
      turnId: accepted.turnId,
      userMessageId: accepted.userMessageId,
      input: accepted.input,
      ...(accepted.fileContext === undefined
        ? {}
        : { fileAttachments: fileAttachmentSummaries(accepted.fileContext) }),
      ...(accepted.runInput === undefined
        ? {}
        : {
            effectiveSettings: {
              useProviderDefaults: false,
              ...(accepted.runInput.temperature === undefined
                ? {}
                : { temperature: accepted.runInput.temperature }),
              ...(accepted.runInput.maxTokens === undefined
                ? {}
                : { maxTokens: accepted.runInput.maxTokens }),
            },
          }),
      createdAt: accepted.createdAt,
      status: state?.status ?? accepted.status,
      cursor: cursor(accepted.executionId, state?.sequence ?? 0),
      events: state !== undefined && !terminalStatuses.has(state.status) ? state.events : [],
      ...((state?.durableThroughSequence ?? accepted.durableThroughSequence) === undefined
        ? {}
        : {
            durableThroughSequence:
              state?.durableThroughSequence ?? accepted.durableThroughSequence,
          }),
      ...(state?.error === undefined
        ? accepted.reason === undefined
          ? {}
          : { error: { code: accepted.reason, message: accepted.reason } }
        : { error: state.error }),
    });
  const lookup = async (
    sessionId: string,
    executionId: string,
  ): Promise<{ accepted: SessionExecution; state: LiveExecution | undefined }> => {
    requireId(sessionId);
    requireId(executionId);
    const state = live.get(executionId);
    if (state?.accepted.sessionId === sessionId) return { accepted: state.accepted, state };
    const accepted = (await records(sessionId)).find((item) => item.executionId === executionId);
    if (accepted === undefined)
      throw new AgentExecutionError('execution-not-found', 'Execution does not exist');
    return { accepted, state: live.get(executionId) };
  };
  const publish = (state: LiveExecution, frame: AgentExecutionFrame): void => {
    const size = bytes(frame);
    state.ring.push({ sequence: state.sequence, frame: structuredClone(frame), bytes: size });
    state.ringBytes += size;
    while (state.ring.length > ringMaxFrames || state.ringBytes > ringMaxBytes)
      state.ringBytes -= state.ring.shift()?.bytes ?? 0;
    for (const subscriber of state.subscribers) subscriber.push(structuredClone(frame));
  };
  const status = (state: LiveExecution, value: AgentExecutionStatus): void => {
    state.status = value;
    state.sequence += 1;
    publish(state, {
      type: 'status',
      cursor: cursor(state.accepted.executionId, state.sequence),
      status: value,
      ...(state.durableThroughSequence === undefined
        ? {}
        : { durableThroughSequence: state.durableThroughSequence }),
      ...(state.error === undefined ? {} : { error: state.error }),
    });
    notifyQueue(state.accepted.sessionId);
  };
  const event = (state: LiveExecution, incoming: AgentRuntimeEvent): void => {
    if (state.outputLimited) return;
    const parsed = agentRuntimeEventSchema.parse(incoming);
    const last = state.events.at(-1);
    const coalesced =
      (parsed.type === 'text-delta' || parsed.type === 'reasoning-delta') &&
      last?.type === parsed.type;
    const extraBytes = coalesced
      ? bytes(parsed.text) - 2
      : bytes(parsed) + (state.events.length === 0 ? 0 : 1);
    // Reserve space for terminal/error metadata and cursor growth at the cap.
    if (
      state.events.length + (coalesced ? 0 : 1) > snapshotMaxEvents ||
      state.outputBytes + extraBytes + 1024 > snapshotMaxBytes
    ) {
      state.outputLimited = true;
      state.error = {
        code: 'execution-output-limit',
        message: 'Execution output exceeds the live snapshot limit',
      };
      status(state, 'cancelling');
      state.controller.abort(
        new AgentExecutionError('execution-output-limit', state.error.message),
      );
      return;
    }
    if (coalesced)
      state.events[state.events.length - 1] = { type: parsed.type, text: last.text + parsed.text };
    else state.events.push(structuredClone(parsed));
    state.outputBytes += extraBytes;
    state.sequence += 1;
    publish(state, {
      type: 'event',
      cursor: cursor(state.accepted.executionId, state.sequence),
      event: structuredClone(parsed),
    });
  };
  const markPersistenceError = (state: LiveExecution, cause: unknown): void => {
    state.error = {
      code: 'execution-persistence-error',
      message: 'Execution terminal state could not be persisted',
    };
    status(state, 'persistence-error');
    block(state.accepted.sessionId);
    void cause;
  };

  const taskStop = (task: BoundExecution): TaskStopReason | undefined => {
    if (task.stopReason !== undefined) return task.stopReason;
    const reason = task.authority.getStopReason?.() ?? (closed ? 'shutdown' : undefined);
    if (reason !== undefined) task.stopReason = taskStopReasonSchema.parse(reason);
    return task.stopReason;
  };

  const taskPersistenceError = (admission: boolean, cause: unknown): AgentExecutionError =>
    new AgentExecutionError(
      admission ? 'execution-admission-uncertain' : 'execution-persistence-error',
      admission
        ? 'Task execution acceptance could not be determined. Retry with the same authority.'
        : 'Task execution terminal state could not be confirmed. Retry settlement.',
      { cause },
    );

  const clearTaskBlock = (sessionId: string): void => {
    const state = queues.get(sessionId);
    if (state !== undefined) delete state.error;
  };

  const signalTask = (task: BoundExecution): void => {
    const change = task.change;
    task.change = changeSignal();
    change.notify();
  };

  const publishTaskCleanup = (task: BoundExecution): void => {
    if (task.cleanup !== undefined) return;
    if (task.stopReason !== undefined && task.lease !== undefined && !task.startsClosed) {
      task.lease.options.closeStarts?.(task.stopReason);
      task.startsClosed = true;
    }
    const durable = task.durable;
    if (
      durable !== undefined &&
      task.pendingLaunches === 0 &&
      (durable !== null || task.stopReason !== undefined)
    ) {
      if (!task.released) {
        task.lease?.options.release?.();
        task.released = true;
      }
      const common = {
        identity: task.authority.identity,
        launchClosed: true,
        pendingLaunches: 0,
        cleanupComplete: true,
      } as const;
      if (durable === null)
        task.cleanup = Object.freeze({
          ...common,
          acceptance: 'none',
          exactAcceptanceAbsent: true,
        });
      else if (
        durable.status !== 'queued' &&
        durable.status !== 'accepted' &&
        durable.durableThroughSequence !== undefined
      ) {
        const stop = taskStopReasonSchema.safeParse(durable.reason);
        const reason =
          durable.status === 'cancelled' && stop.success
            ? stop.data
            : durable.status === 'failed' && durable.reason === 'generation-unavailable'
              ? durable.reason
              : undefined;
        task.cleanup = Object.freeze({
          ...common,
          acceptance: 'accepted',
          executionStatus: durable.status,
          terminalSequence: durable.durableThroughSequence,
          ...(reason === undefined ? {} : { reason }),
        });
      }
      if (task.cleanup !== undefined) {
        delete task.running;
        delete task.finish;
        delete task.issue;
        const { sessionId } = task.authority.identity;
        if (reservedTasks.get(sessionId) === task) reservedTasks.delete(sessionId);
      }
    }
    signalTask(task);
  };

  const closeInterruptedTurn = (turn: SessionTurn, reason: string): NewSessionEvent[] => [
    ...turn.steps.flatMap((step): NewSessionEvent[] =>
      step.status === 'running'
        ? [
            {
              type: 'step.completed',
              payload: { turnId: turn.turnId, stepId: step.stepId, status: 'failed' },
            },
          ]
        : [],
    ),
    { type: 'turn.completed', payload: { turnId: turn.turnId, status: 'failed', reason } },
  ];

  const pump = async (state: LiveExecution): Promise<void> => {
    let failure: unknown;
    let hasFailure = false;
    let startDenied = false;
    let completion: Extract<AgentRuntimeEvent, { type: 'completed' }> | undefined;
    try {
      if (!state.controller.signal.aborted) {
        const task = state.task;
        if (task === undefined) {
          await options.admit(state.accepted.sessionId);
          if (closed) state.controller.abort();
        } else {
          const stop = taskStop(task);
          if (stop !== undefined) state.controller.abort(stop);
          else {
            try {
              task.lease!.options.assertCanStartSync();
            } catch (error: unknown) {
              startDenied = true;
              const stop = taskStop(task);
              if (stop !== undefined) state.controller.abort(stop);
              throw error;
            }
          }
        }
        state.controller.signal.throwIfAborted();
        status(state, 'running');
        const stream = state.runner.run({
          ...structuredClone(state.accepted.runInput ?? state.accepted.input),
          sessionId: state.accepted.sessionId,
          executionIdentity: {
            executionId: state.accepted.executionId,
            turnId: state.accepted.turnId,
            userMessageId: state.accepted.userMessageId,
          },
          signal: state.controller.signal,
        });
        for await (const incoming of stream) {
          if (incoming.type === 'completed') completion = incoming;
          else event(state, incoming);
        }
      }
    } catch (error: unknown) {
      failure = error;
      hasFailure = true;
    }
    const finish = async (): Promise<void> => {
      try {
        await gate(state.accepted.sessionId, async () => {
          const task = state.task;
          if (task?.durable !== undefined) return;
          const persisted = await options.sessionStore.read(state.accepted.sessionId);
          const started = persisted.some(
            (item) =>
              item.type === 'turn.started' &&
              item.payload.turnId === state.accepted.turnId &&
              item.payload.executionId === state.accepted.executionId,
          );
          const turnTerminal = persisted.find(
            (item) =>
              item.type === 'turn.completed' && item.payload.turnId === state.accepted.turnId,
          );
          const missingTerminal = started && turnTerminal?.type !== 'turn.completed';
          if (missingTerminal && task === undefined) {
            markPersistenceError(state, failure);
            return;
          }
          const stopBeforeTurn = !started && task !== undefined ? taskStop(task) : undefined;
          const cancelledBeforeTurn =
            state.controller.signal.aborted || stopBeforeTurn !== undefined;
          if (!started && !hasFailure && !cancelledBeforeTurn)
            throw new Error('Runner ended without a durable Turn');
          const outcome = missingTerminal
            ? 'interrupted'
            : turnTerminal?.type === 'turn.completed'
              ? turnTerminal.payload.status
              : cancelledBeforeTurn
                ? 'cancelled'
                : 'failed';
          let reason =
            (state.outputLimited ? 'execution-output-limit' : undefined) ??
            (turnTerminal?.type === 'turn.completed' ? turnTerminal.payload.reason : undefined) ??
            (hasFailure &&
            typeof failure === 'object' &&
            failure !== null &&
            'code' in failure &&
            typeof failure.code === 'string'
              ? failure.code
              : undefined);
          if (task !== undefined) {
            if (missingTerminal) reason = 'execution-persistence-error';
            else if (outcome === 'cancelled') reason = taskStop(task) ?? 'task-cancelled';
            else if (startDenied && !started) reason = 'generation-unavailable';
          }
          const originalFinish =
            task === undefined
              ? undefined
              : persisted.find(
                  (event) =>
                    event.type === 'execution.finished' &&
                    event.payload.executionId === state.accepted.executionId,
                );
          const interruptedTurn = missingTerminal
            ? projectSession(persisted).turns.find((turn) => turn.turnId === state.accepted.turnId)
            : undefined;
          const finished =
            originalFinish?.type === 'execution.finished'
              ? [originalFinish]
              : await append(state.accepted.sessionId, [
                  ...(interruptedTurn === undefined
                    ? []
                    : closeInterruptedTurn(interruptedTurn, 'execution-persistence-error')),
                  {
                    type: 'execution.finished',
                    payload: {
                      executionId: state.accepted.executionId,
                      status: outcome,
                      ...(reason === undefined ? {} : { reason }),
                    },
                  },
                ]);
          const terminalSequence = finished.at(-1)?.sequence;
          if (terminalSequence === undefined)
            throw new Error('Execution terminal append returned no event');
          state.durableThroughSequence = terminalSequence;
          // Queue observers can already be waiting for the first terminal status
          // notification. Project its confirmed removal before publishing any view.
          if (task !== undefined) clearTaskBlock(state.accepted.sessionId);
          const confirmed = originalFinish === undefined ? [...persisted, ...finished] : persisted;
          sync(state.accepted.sessionId, confirmed);
          if (task !== undefined) {
            task.durable = projectAgentExecutions(confirmed).find(
              (execution) => execution.executionId === state.accepted.executionId,
            )!;
            delete state.error;
          }
          // Legacy completion is forwarded only after durability; it is terminal
          // bookkeeping rather than part of the bounded, reconstructable live view.
          if (completion !== undefined && !state.outputLimited) {
            state.sequence += 1;
            publish(state, {
              type: 'event',
              cursor: cursor(state.accepted.executionId, state.sequence),
              event: completion,
            });
          }
          status(state, task?.durable?.status ?? outcome);
          for (const subscriber of state.subscribers) subscriber.finish();
          state.subscribers.clear();
          // Detached initial snapshots and subscriber queues own their copies.
          // Retained subscription handles must not keep the complete live view.
          state.events.length = 0;
          state.ring.length = 0;
          state.ringBytes = 0;
          state.outputBytes = 0;
          live.delete(state.accepted.executionId);
          if (task === undefined) await claimNext(state.accepted.sessionId);
        });
      } catch (error: unknown) {
        markPersistenceError(state, error);
        if (state.task !== undefined) state.task.issue = taskPersistenceError(false, error);
      } finally {
        if (state.task !== undefined) publishTaskCleanup(state.task);
      }
    };
    if (state.task !== undefined) state.task.finish = finish;
    await finish();
  };

  const install = (
    accepted: SessionExecution,
    runner: AgentRunner = options.runner,
    task?: BoundExecution,
  ): LiveExecution => {
    const state: LiveExecution = {
      accepted,
      runner,
      ...(task === undefined ? {} : { task }),
      controller: new AbortController(),
      subscribers: new Set(),
      ring: [],
      events: [],
      status: 'accepted',
      sequence: 0,
      ringBytes: 0,
      outputBytes: bytes(snapshot(accepted)),
      outputLimited: false,
      promise: Promise.resolve(),
    };
    live.set(accepted.executionId, state);
    if (task !== undefined) task.running = state;
    // The barrier releases the mutation gate before entering Runner or plugin code.
    state.promise = (async () => {
      await gate(accepted.sessionId, async () => {
        if (closed) state.controller.abort();
      });
      await pump(state);
    })();
    return state;
  };
  const claimNext = async (sessionId: string): Promise<void> => {
    const current = queues.get(sessionId);
    if (
      closed ||
      current?.error !== undefined ||
      (current?.active !== null && current?.active !== undefined) ||
      current?.queued.length === 0 ||
      current === undefined
    )
      return;
    const head = current.queued[0];
    if (head === undefined) return;
    try {
      const { events } = await load(sessionId);
      if (events.some((event) => event.type === 'agent.task.origin')) return;
      const accepted = projectAgentExecutions(events).find(
        (item) => item.executionId === head.executionId,
      );
      if (accepted === undefined) throw new Error('Missing accepted queue head');
      const appended = await append(sessionId, [
        { type: 'execution.claimed', payload: { executionId: head.executionId } },
      ]);
      sync(sessionId, [...events, ...appended]);
      install({ ...accepted, status: 'accepted' });
      notifyQueue(sessionId);
    } catch {
      block(sessionId);
    }
  };

  const taskFor = (token: TaskLaunchAuthority): BoundExecution => {
    const authority = readTaskLaunchAuthority(token);
    if (authority.service !== undefined && authority.service !== service)
      throw taskBindingConflict('Task authority belongs to a different execution service');
    authority.service = service;
    let task = bound.get(token);
    if (task === undefined) {
      task = {
        token,
        authority,
        reservation: 'none',
        pendingLaunches: 0,
        released: false,
        startsClosed: false,
        change: changeSignal(),
      };
      bound.set(token, task);
    }
    return task;
  };

  const loadTask = async (task: BoundExecution, requireOrigin: boolean) => {
    const { identity, originDigest, inputDigest } = task.authority;
    const { sessionId } = identity;
    let events: readonly SessionEvent[];
    try {
      events = await options.sessionStore.read(sessionId);
    } catch (cause: unknown) {
      block(sessionId);
      task.issue = taskPersistenceError(task.reservation !== 'confirmed', cause);
      throw task.issue;
    }
    const origin = events.find((event) => event.type === 'agent.task.origin');
    if (
      !(events.length === 0 && !requireOrigin) &&
      (events[0]?.type !== 'session.created' ||
        origin?.type !== 'agent.task.origin' ||
        origin.sequence !== 2 ||
        origin.sessionId !== sessionId ||
        agentTaskFactDigest(origin.payload) !== originDigest)
    )
      throw taskBindingConflict('Child Session does not have the exact task origin');
    const projection = events.length === 0 ? undefined : projectSession(events);
    const executions = projectAgentExecutions(events);
    const accepted = executions[0];
    if (
      accepted !== undefined &&
      (executions.length !== 1 ||
        accepted.executionId !== identity.executionId ||
        accepted.requestId !== identity.requestId ||
        accepted.turnId !== identity.turnId ||
        accepted.userMessageId !== identity.userMessageId ||
        accepted.requestDigest !== inputDigest ||
        agentTaskFactDigest(accepted.input) !== inputDigest ||
        accepted.dispatch !== 'queued' ||
        accepted.runInput === undefined ||
        agentTaskFactDigest(accepted.runInput) !== inputDigest ||
        accepted.fileContext !== undefined)
    )
      throw taskBindingConflict('Child execution does not match the accepted task');
    if (accepted !== undefined && task.reservation === 'none')
      throw taskBindingConflict('Child execution has no matching retained binding');
    if (accepted !== undefined) task.reservation = 'confirmed';
    else if (task.reservation === 'confirmed')
      throw taskPersistenceError(true, new Error('Confirmed task acceptance is missing'));
    else {
      task.reservation = 'none';
      if (reservedTasks.get(sessionId) === task && task.stopReason === undefined)
        reservedTasks.delete(sessionId);
    }
    clearTaskBlock(sessionId);
    sync(sessionId, events);
    delete task.issue;
    return { events, accepted, projection };
  };

  const finishUnstartedTask = async (
    task: BoundExecution,
    events: readonly SessionEvent[],
    accepted: SessionExecution,
    reason: TaskStopReason | 'generation-unavailable',
  ): Promise<AgentExecutionSnapshot> => {
    const { sessionId, executionId } = accepted;
    const selectedReason = (task.unstartedFinishReason ??= reason);
    try {
      const appended = await append(sessionId, [
        {
          type: 'execution.finished',
          payload: {
            executionId,
            status: selectedReason === 'generation-unavailable' ? 'failed' : 'cancelled',
            reason: selectedReason,
          },
        },
      ]);
      const confirmed = [...events, ...appended];
      const finished = projectAgentExecutions(confirmed)[0];
      if (finished?.durableThroughSequence === undefined)
        throw new Error('Task terminal append was not confirmed');
      clearTaskBlock(sessionId);
      sync(sessionId, confirmed);
      task.durable = finished;
      notifyQueue(sessionId);
      return snapshot(finished);
    } catch (cause: unknown) {
      block(sessionId);
      task.issue = taskPersistenceError(false, cause);
      throw task.issue;
    }
  };

  const cancelTaskLocked = async (
    task: BoundExecution,
  ): Promise<AgentExecutionSnapshot | undefined> => {
    const { sessionId } = task.authority.identity;
    const previous = reservedTasks.get(sessionId);
    if (previous !== undefined && previous !== task)
      throw taskBindingConflict('Child Session already has a different task binding');
    if (task.durable !== undefined)
      return task.durable === null ? undefined : snapshot(task.durable);
    const reason = taskStop(task) ?? 'task-cancelled';
    task.stopReason = reason;
    reservedTasks.set(sessionId, task);
    const state = task.running;
    if (state !== undefined) {
      if (task.finish === undefined) {
        if (state.status !== 'cancelling') status(state, 'cancelling');
        state.controller.abort(reason);
      }
      return snapshot(state.accepted, state);
    }
    const { events, accepted } = await loadTask(task, false);
    if (accepted === undefined) {
      task.durable = null;
      return undefined;
    }
    if (accepted.durableThroughSequence !== undefined) {
      task.durable = accepted;
      return snapshot(accepted);
    }
    return finishUnstartedTask(task, events, accepted, reason);
  };

  const boundPort: BoundTaskExecutionPort = {
    async launchBoundTask(request, token, leaseToken) {
      const authority = readTaskLaunchAuthority(token);
      const lease = readTaskRunnerLease(token, leaseToken);
      const parsed = boundTaskLaunchSchema.safeParse(request);
      if (!parsed.success)
        throw new AgentExecutionError('execution-invalid-input', 'Bound task launch is invalid');
      const { sessionId, requestId, identity, input } = parsed.data;
      if (
        agentTaskFactDigest({ sessionId, requestId, ...identity }) !==
          agentTaskFactDigest(authority.identity) ||
        agentTaskFactDigest(input) !== authority.inputDigest
      )
        throw taskBindingConflict('Task execution identity or input conflicts');
      const task = taskFor(token);
      task.pendingLaunches++;
      try {
        return await gate(sessionId, async () => {
          const reserved = reservedTasks.get(sessionId);
          if (reserved !== undefined && reserved !== task)
            throw taskBindingConflict('Child Session already has a different task binding');
          if (task.lease !== undefined && task.lease.token !== leaseToken)
            throw taskBindingConflict('Child execution already has a different runner lease');
          if (task.durable !== undefined) {
            if (task.durable !== null) return snapshot(task.durable);
            throw new AgentExecutionError('execution-closed', 'Task execution admission is closed');
          }
          let { events, accepted, projection } = await loadTask(task, true);
          if (accepted === undefined) {
            if (taskStop(task) !== undefined) {
              task.durable = null;
              throw new AgentExecutionError(
                'execution-closed',
                'Task execution admission is closed',
              );
            }
            if (projection?.archivedAt !== undefined || projection?.deletedAt !== undefined)
              throw new AgentExecutionError('execution-closed', 'Task Session is not runnable');
            lease.assertCanStartSync();
            task.lease = { token: leaseToken, options: lease };
            task.reservation = 'unconfirmed';
            reservedTasks.set(sessionId, task);
            const payload = executionAcceptedPayloadSchema.parse({
              ...identity,
              requestId,
              requestDigest: authority.inputDigest,
              input: authority.input,
              runInput: authority.input,
              dispatch: 'queued',
            });
            let appendFailure: unknown;
            try {
              await options.sessionStore.append(sessionId, [
                { type: 'execution.accepted', payload },
                { type: 'execution.claimed', payload: { executionId: identity.executionId } },
              ]);
            } catch (cause: unknown) {
              appendFailure = cause;
            }
            ({ events, accepted, projection } = await loadTask(task, true));
            if (accepted === undefined) {
              if (taskStop(task) !== undefined) task.durable = null;
              throw new AgentExecutionError(
                'execution-persistence-error',
                'Task execution acceptance did not commit',
                { cause: appendFailure },
              );
            }
          }
          if (accepted.durableThroughSequence !== undefined) {
            if (task.running === undefined) task.durable = accepted;
            return snapshot(accepted);
          }
          if (task.running !== undefined) return snapshot(accepted, task.running);
          if (task.unstartedFinishReason !== undefined)
            return finishUnstartedTask(task, events, accepted, task.unstartedFinishReason);
          const stop = taskStop(task);
          if (stop !== undefined) return finishUnstartedTask(task, events, accepted, stop);
          const acceptanceIndex = events.findIndex((event) => event.type === 'execution.accepted');
          const claim = events[acceptanceIndex + 1];
          if (
            accepted.status !== 'accepted' ||
            claim?.type !== 'execution.claimed' ||
            claim.payload.executionId !== accepted.executionId
          ) {
            task.issue = taskPersistenceError(
              true,
              new Error('Task execution claim is not confirmed'),
            );
            block(sessionId);
            throw task.issue;
          }
          if (projection?.archivedAt !== undefined || projection?.deletedAt !== undefined)
            return finishUnstartedTask(task, events, accepted, 'ownership-lost');
          try {
            lease.assertCanStartSync();
          } catch {
            return finishUnstartedTask(
              task,
              events,
              accepted,
              taskStop(task) ?? 'generation-unavailable',
            );
          }
          const state = install(accepted, lease.runner, task);
          notifyQueue(sessionId);
          return snapshot(accepted, state);
        });
      } finally {
        task.pendingLaunches--;
        publishTaskCleanup(task);
      }
    },
    async cancelBoundTask(token) {
      const task = taskFor(token);
      const { sessionId } = task.authority.identity;
      try {
        const result = await gate(sessionId, () => cancelTaskLocked(task));
        if (task.finish !== undefined && task.issue !== undefined) {
          await task.finish();
          if (task.issue !== undefined) throw task.issue;
          if (task.durable !== undefined && task.durable !== null) return snapshot(task.durable);
        }
        return result;
      } finally {
        publishTaskCleanup(task);
      }
    },
    async whenSettled(token) {
      const task = taskFor(token);
      const unstartedFinishReason = task.unstartedFinishReason;
      if (task.finish !== undefined && task.issue !== undefined) await task.finish();
      else if (unstartedFinishReason !== undefined && task.issue !== undefined) {
        try {
          await gate(task.authority.identity.sessionId, async () => {
            if (task.durable !== undefined) return;
            const { events, accepted } = await loadTask(task, true);
            if (accepted === undefined)
              throw taskBindingConflict('Missing accepted task execution');
            if (accepted.durableThroughSequence !== undefined) task.durable = accepted;
            else await finishUnstartedTask(task, events, accepted, unstartedFinishReason);
          });
        } finally {
          publishTaskCleanup(task);
        }
      } else if (task.issue !== undefined && task.stopReason !== undefined)
        await boundPort.cancelBoundTask(token);
      while (task.cleanup === undefined) {
        if (task.issue !== undefined) throw task.issue;
        await task.change.promise;
      }
      return task.cleanup;
    },
  };

  const service: AgentExecutionService = {
    async launch(sessionId, request) {
      requireId(sessionId);
      const parsed = agentExecutionLaunchSchema.safeParse(request);
      if (!parsed.success)
        throw new AgentExecutionError('execution-invalid-input', 'Execution input is invalid');
      const frozen = structuredClone(parsed.data);
      const requestDigest = digest(frozen.input);
      const replay = (
        existing: readonly SessionExecution[],
        observedLive = new Map(live),
      ): AgentExecutionSnapshot | undefined => {
        const item = existing.find((item) => item.requestId === frozen.requestId);
        if (item === undefined) return undefined;
        if (item.requestDigest !== requestDigest)
          throw new AgentExecutionError(
            'execution-request-conflict',
            'Request identifier already belongs to different input',
          );
        return snapshot(item, live.get(item.executionId) ?? observedLive.get(item.executionId));
      };
      // Exact durable replay precedes all lifecycle/default/capacity checks.
      const observedLive = new Map(live);
      const observed = await options.sessionStore.read(sessionId);
      refuseOrdinaryTaskLaunch(observed);
      const previous = replay(projectAgentExecutions(observed), observedLive);
      const unresolved = queues.get(sessionId)?.unresolvedAdmission;
      const reconciliation = unresolved?.requestId === frozen.requestId;
      if (previous !== undefined && !reconciliation) return previous;
      return gate(sessionId, async () => {
        const { events, projection } = await load(sessionId);
        refuseOrdinaryTaskLaunch(events);
        const unresolved = queues.get(sessionId)?.unresolvedAdmission;
        if (unresolved?.requestId === frozen.requestId) {
          if (unresolved.requestDigest !== requestDigest)
            throw new AgentExecutionError(
              'execution-request-conflict',
              'Ambiguous request identifier belongs to different input',
            );
          const candidate = projectAgentExecutions(events).find(
            (item) => item.executionId === unresolved.executionId,
          );
          const state = queues.get(sessionId)!;
          const hasOtherBlock = [...live.values()].some(
            (item) => item.accepted.sessionId === sessionId && item.status === 'persistence-error',
          );
          if (!hasOtherBlock) {
            if (
              closed &&
              candidate !== undefined &&
              (candidate.status === 'queued' || candidate.status === 'accepted')
            ) {
              const appended = await append(sessionId, [
                {
                  type: 'execution.finished',
                  payload: {
                    executionId: candidate.executionId,
                    status: 'cancelled',
                    reason: 'service-closed',
                  },
                },
              ]);
              delete state.unresolvedAdmission;
              delete state.error;
              sync(sessionId, [...events, ...appended]);
              notifyQueue(sessionId);
              return snapshot({
                ...candidate,
                status: 'cancelled',
                reason: 'service-closed',
                durableThroughSequence: appended.at(-1)!.sequence,
              });
            }
            delete state.unresolvedAdmission;
            delete state.error;
            // Recompute pending reservations only after this exact ambiguity is resolved.
            sync(sessionId, events);
            if (candidate?.status === 'accepted' && !live.has(candidate.executionId))
              install(candidate);
            if (candidate?.status === 'queued') await claimNext(sessionId);
            notifyQueue(sessionId);
          }
        }
        const previous = replay(projectAgentExecutions(events));
        if (previous !== undefined) return previous;
        requireMutable(sessionId);
        await options.admit(sessionId);
        requireMutable(sessionId);
        const immediate = projection.active === null && projection.queued.length === 0;
        const globalPending = [...pendingCounts.values()].reduce(
          (total, count) => total + count,
          0,
        );
        if (!immediate && (projection.queued.length >= 10 || globalPending >= 100))
          throw new AgentExecutionError('execution-queue-full', 'Execution waiting queue is full');
        const resolved =
          options.resolveInput === undefined
            ? { ...structuredClone(frozen.input), useProviderDefaults: false }
            : await options.resolveInput(sessionId, structuredClone(frozen.input));
        const effective = agentExecutionInputSchema.safeParse(resolved);
        if (!effective.success || effective.data.useProviderDefaults !== false)
          throw new AgentExecutionError(
            'execution-invalid-input',
            'Effective execution input is invalid',
          );
        const immutable = (value: typeof frozen.input): unknown => {
          const {
            temperature: _temperature,
            maxTokens: _maxTokens,
            useProviderDefaults: _defaults,
            ...rest
          } = value;
          void _temperature;
          void _maxTokens;
          void _defaults;
          return rest;
        };
        if (
          canonicalJson(immutable(effective.data)) !== canonicalJson(immutable(frozen.input)) ||
          (frozen.input.temperature !== undefined &&
            effective.data.temperature !== frozen.input.temperature) ||
          (frozen.input.maxTokens !== undefined &&
            effective.data.maxTokens !== frozen.input.maxTokens) ||
          (frozen.input.useProviderDefaults === false &&
            (effective.data.temperature !== frozen.input.temperature ||
              effective.data.maxTokens !== frozen.input.maxTokens))
        )
          throw new AgentExecutionError(
            'execution-invalid-input',
            'Effective execution input changed immutable request fields',
          );
        requireMutable(sessionId);
        const executionIdentity = {
          executionId: randomUUID(),
          turnId: randomUUID(),
          userMessageId: randomUUID(),
        };
        let fileContext: CapturedFileContext | undefined;
        let captureSignal: AbortSignal | undefined;
        if (frozen.input.files !== undefined) {
          if (options.captureFiles === undefined)
            throw new AgentExecutionError(
              'execution-file-unavailable',
              'Project file capture is unavailable',
            );
          captureSignal = AbortSignal.any([captureController.signal, AbortSignal.timeout(5000)]);
          try {
            captureSignal.throwIfAborted();
            const captured = await options.captureFiles(sessionId, frozen.input.files, {
              signal: captureSignal,
            });
            captureSignal.throwIfAborted();
            fileContext = capturedFileContextSchema.parse(structuredClone(captured));
          } catch (error: unknown) {
            if (captureSignal.aborted)
              throw new AgentExecutionError(
                'execution-file-capture-timeout',
                'Project file capture ended before acceptance',
              );
            if (error instanceof AgentExecutionError) throw error;
            throw new AgentExecutionError(
              'execution-file-capture-failed',
              'Project files could not be captured',
            );
          }
        }
        requireMutable(sessionId);
        const accepted: SessionExecution = {
          ...executionIdentity,
          requestId: frozen.requestId,
          requestDigest,
          input: frozen.input,
          dispatch: 'queued',
          runInput: structuredClone(effective.data),
          ...(fileContext === undefined ? {} : { fileContext }),
          sessionId,
          createdAt: new Date().toISOString(),
          status: immediate ? 'accepted' : 'queued',
        };
        if (
          bytes(snapshot(accepted)) + 1024 > snapshotMaxBytes ||
          bytes(effective.data) + 1024 > snapshotMaxBytes ||
          bytes(accepted) + 1024 > snapshotMaxBytes
        )
          throw new AgentExecutionError(
            'execution-output-limit',
            'Execution input exceeds the live snapshot limit',
          );
        const {
          sessionId: _sessionId,
          createdAt: _createdAt,
          status: _status,
          ...payload
        } = accepted;
        void _sessionId;
        void _createdAt;
        void _status;
        if (!executionAcceptedPayloadSchema.safeParse(payload).success)
          throw new AgentExecutionError(
            'execution-file-capture-failed',
            'Captured files do not match the accepted input',
          );
        // After append begins, only durable reconciliation can decide acceptance.
        if (captureSignal?.aborted)
          throw new AgentExecutionError(
            'execution-file-capture-timeout',
            'Project file capture ended before acceptance',
          );
        const batch: NewSessionEvent[] = [
          { type: 'execution.accepted', payload },
          ...(immediate
            ? [
                {
                  type: 'execution.claimed' as const,
                  payload: { executionId: accepted.executionId },
                },
              ]
            : []),
        ];
        // Reservation remains conservative if both append and reconciliation read fail.
        if (!immediate) pendingCounts.set(sessionId, (pendingCounts.get(sessionId) ?? 0) + 1);
        let appended: readonly SessionEvent[];
        try {
          appended = await append(sessionId, batch);
        } catch (error: unknown) {
          if (error instanceof AppendFailure && !error.uncertain) {
            sync(sessionId, events);
            cleanup(sessionId);
          } else if (error instanceof AppendFailure && error.uncertain) {
            queues.get(sessionId)!.unresolvedAdmission = {
              requestId: frozen.requestId,
              requestDigest,
              executionId: accepted.executionId,
            };
          }
          throw new AgentExecutionError(
            error instanceof AppendFailure && error.uncertain
              ? 'execution-admission-uncertain'
              : 'execution-persistence-error',
            'Execution acceptance could not be confirmed',
            { cause: error },
          );
        }
        const durableAccepted = {
          ...accepted,
          createdAt: appended[0]?.occurredAt ?? accepted.createdAt,
        };
        // Reuse the confirmed durable prefix; avoid a second read after acceptance.
        sync(sessionId, [...events, ...appended]);
        const state = immediate ? install(durableAccepted) : undefined;
        notifyQueue(sessionId);
        return snapshot(durableAccepted, state);
      });
    },
    async list(sessionId) {
      requireId(sessionId);
      const observedLive = new Map(live);
      return projectAgentExecutionQueue(await options.sessionStore.read(sessionId))
        .executions.slice(-100)
        .reverse()
        .map((accepted) =>
          summary(
            accepted,
            live.get(accepted.executionId) ?? observedLive.get(accepted.executionId),
          ),
        );
    },
    async get(sessionId, executionId) {
      const { accepted, state } = await lookup(sessionId, executionId);
      return snapshot(accepted, state);
    },
    async subscribe(sessionId, executionId, after) {
      if (after !== undefined && !agentExecutionCursorSchema.safeParse(after).success)
        throw new AgentExecutionError('execution-invalid-input', 'Execution cursor is invalid');
      const { accepted, state } = await lookup(sessionId, executionId);
      let initial: AgentExecutionFrame[] = [
        { type: 'snapshot', snapshot: snapshot(accepted, state) },
      ];
      if (state !== undefined && after !== undefined) {
        const [cursorEpoch, cursorExecution, rawSequence] = after.split(':');
        const sequence = Number(rawSequence);
        if (
          cursorEpoch === epoch &&
          cursorExecution === executionId &&
          sequence <= state.sequence &&
          sequence >= (state.ring[0]?.sequence ?? state.sequence + 1) - 1
        ) {
          const replay = state.ring.filter((item) => item.sequence > sequence);
          if (
            replay.length <= subscriberMaxFrames &&
            replay.reduce((total, item) => total + item.bytes, 0) <= ringMaxBytes
          )
            initial = replay.map((item) => structuredClone(item.frame));
        }
      }
      const queued: { frame: AgentExecutionFrame; bytes: number }[] = [];
      let queuedBytes = 0;
      let ended = state === undefined || terminalStatuses.has(state.status);
      const subscribers = state?.subscribers;
      let pending: ((value: IteratorResult<AgentExecutionFrame>) => void) | undefined;
      const close = (): void => {
        ended = true;
        queued.length = 0;
        queuedBytes = 0;
        subscribers?.delete(subscriber);
        pending?.({ done: true, value: undefined });
        pending = undefined;
      };
      const subscriber: Subscriber = {
        push(frame) {
          if (ended) return;
          if (pending !== undefined) {
            const resolve = pending;
            pending = undefined;
            resolve({ done: false, value: frame });
            return;
          }
          const size = bytes(frame);
          if (queued.length >= subscriberMaxFrames || queuedBytes + size > ringMaxBytes) {
            close();
            return;
          }
          queued.push({ frame, bytes: size });
          queuedBytes += size;
        },
        finish() {
          ended = true;
          if (queued.length === 0) {
            pending?.({ done: true, value: undefined });
            pending = undefined;
          }
        },
        close,
      };
      if (!ended) subscribers?.add(subscriber);
      const iterator: AsyncIterator<AgentExecutionFrame> = {
        next() {
          const item = queued.shift();
          if (item !== undefined) {
            queuedBytes -= item.bytes;
            return Promise.resolve({ done: false, value: item.frame });
          }
          if (ended) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => {
            pending = resolve;
          });
        },
        return() {
          close();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
      return {
        initial: structuredClone(initial),
        events: { [Symbol.asyncIterator]: () => iterator },
        close,
      };
    },
    async cancel(sessionId, executionId) {
      return gate(sessionId, async () => {
        const { accepted, state } = await lookup(sessionId, executionId);
        if (accepted.status === 'queued')
          throw new AgentExecutionError(
            'execution-not-active',
            'Queued execution requires explicit queue cancellation',
          );
        if (
          state !== undefined &&
          !terminalStatuses.has(state.status) &&
          state.status !== 'persistence-error'
        ) {
          if (state.status !== 'cancelling') status(state, 'cancelling');
          state.controller.abort();
        }
        return snapshot(accepted, state);
      });
    },
    async queue(sessionId) {
      requireId(sessionId);
      return gate(sessionId, async () => {
        await load(sessionId);
        const current = view(sessionId, queues.get(sessionId)!);
        cleanup(sessionId);
        return current;
      });
    },
    async subscribeQueue(sessionId) {
      requireId(sessionId);
      return gate(sessionId, async () => {
        await load(sessionId);
        const subscribers = queues.get(sessionId)!.subscribers;
        let latest: AgentExecutionQueueSnapshot | undefined;
        let pending: ((value: IteratorResult<AgentExecutionQueueSnapshot>) => void) | undefined;
        let ended = false;
        const close = (): void => {
          ended = true;
          latest = undefined;
          subscribers.delete(subscriber);
          pending?.({ done: true, value: undefined });
          pending = undefined;
          cleanup(sessionId);
        };
        const subscriber: QueueSubscriber = {
          push(value) {
            if (ended) return;
            if (pending !== undefined) {
              const resolve = pending;
              pending = undefined;
              resolve({ done: false, value });
            } else latest = value;
          },
          close,
        };
        subscribers.add(subscriber);
        const iterator: AsyncIterator<AgentExecutionQueueSnapshot> = {
          next() {
            if (latest !== undefined) {
              const value = latest;
              latest = undefined;
              return Promise.resolve({ done: false, value });
            }
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve) => {
              pending = resolve;
            });
          },
          return() {
            close();
            return Promise.resolve({ done: true, value: undefined });
          },
        };
        queueSequence++;
        return {
          initial: [view(sessionId, queues.get(sessionId)!)],
          events: { [Symbol.asyncIterator]: () => iterator },
          close,
        };
      });
    },
    async reorderQueue(sessionId, request) {
      requireId(sessionId);
      const parsed = agentExecutionQueueReorderSchema.safeParse(request);
      if (!parsed.success)
        throw new AgentExecutionError('execution-invalid-input', 'Invalid execution queue reorder');
      const frozen = structuredClone(parsed.data);
      const requestDigest = digest({ kind: 'reorder', ...frozen });
      return gate(sessionId, async () => {
        const { events, projection } = await load(sessionId);
        refuseOrdinaryTaskLaunch(events);
        const previous = projection.controls.find((item) => item.requestId === frozen.requestId);
        if (previous !== undefined) {
          if (previous.requestDigest !== requestDigest)
            throw new AgentExecutionError(
              'execution-request-conflict',
              'Queue control identifier conflicts',
            );
          const current = view(sessionId, queues.get(sessionId)!);
          cleanup(sessionId);
          return current;
        }
        requireMutable(sessionId);
        if (frozen.expectedRevision !== projection.revision)
          throw new AgentExecutionError('execution-queue-conflict', 'Queue revision changed');
        if (
          frozen.executionIds.length !== projection.queued.length ||
          frozen.executionIds.some(
            (id) => !projection.queued.some((item) => item.executionId === id),
          )
        )
          throw new AgentExecutionError('execution-queue-conflict', 'Queue membership changed');
        try {
          const appended = await append(sessionId, [
            { type: 'execution.queue-reordered', payload: { ...frozen, requestDigest } },
          ]);
          sync(sessionId, [...events, ...appended]);
        } catch (error: unknown) {
          throw new AgentExecutionError(
            'execution-persistence-error',
            'Queue reorder could not be confirmed',
            { cause: error },
          );
        }
        notifyQueue(sessionId);
        return view(sessionId, queues.get(sessionId)!);
      });
    },
    async cancelQueued(sessionId, executionId, request) {
      requireId(sessionId);
      requireId(executionId);
      const parsed = agentExecutionQueuedCancelSchema.safeParse(request);
      if (!parsed.success)
        throw new AgentExecutionError(
          'execution-invalid-input',
          'Invalid queued execution cancellation',
        );
      const frozen = structuredClone(parsed.data);
      const requestDigest = digest({ kind: 'cancel', executionId, ...frozen });
      return gate(sessionId, async () => {
        const { events, projection } = await load(sessionId);
        refuseOrdinaryTaskLaunch(events);
        const previous = projection.controls.find((item) => item.requestId === frozen.requestId);
        if (previous !== undefined) {
          if (previous.requestDigest !== requestDigest)
            throw new AgentExecutionError(
              'execution-request-conflict',
              'Queue control identifier conflicts',
            );
          const current = view(sessionId, queues.get(sessionId)!);
          cleanup(sessionId);
          return current;
        }
        requireMutable(sessionId);
        if (frozen.expectedRevision !== projection.revision)
          throw new AgentExecutionError('execution-queue-conflict', 'Queue revision changed');
        if (!projection.queued.some((item) => item.executionId === executionId))
          throw new AgentExecutionError('execution-not-queued', 'Execution is no longer queued');
        try {
          const appended = await append(sessionId, [
            {
              type: 'execution.finished',
              payload: {
                executionId,
                status: 'cancelled',
                reason: 'queue-cancelled',
                queueRequest: { ...frozen, requestDigest },
              },
            },
          ]);
          sync(sessionId, [...events, ...appended]);
        } catch (error: unknown) {
          throw new AgentExecutionError(
            'execution-persistence-error',
            'Queued cancellation could not be confirmed',
            { cause: error },
          );
        }
        notifyQueue(sessionId);
        return view(sessionId, queues.get(sessionId)!);
      });
    },
    async recover(sessionIds) {
      for (const sessionId of sessionIds)
        await gate(sessionId, async () => {
          if (reservedTasks.has(sessionId)) return;
          const events = await options.sessionStore.read(sessionId);
          const projection = events.length === 0 ? undefined : projectSession(events);
          for (const accepted of projectAgentExecutions(events)) {
            if (
              (accepted.status !== 'accepted' && accepted.status !== 'queued') ||
              live.has(accepted.executionId)
            )
              continue;
            const turn = projection?.turns.find((item) => item.turnId === accepted.turnId);
            const batch: NewSessionEvent[] = [];
            if (turn?.status === 'running')
              batch.push(...closeInterruptedTurn(turn, 'server-restarted'));
            batch.push({
              type: 'execution.finished',
              payload: {
                executionId: accepted.executionId,
                status:
                  turn !== undefined && turn.status !== 'running' ? turn.status : 'interrupted',
                ...(turn !== undefined && turn.status !== 'running'
                  ? turn.reason === undefined
                    ? {}
                    : { reason: turn.reason }
                  : { reason: 'server-restarted' }),
              },
            });
            await append(sessionId, batch);
          }
          await load(sessionId);
          notifyQueue(sessionId);
        });
    },
    async withSessionIdle(sessionId, operation) {
      requireId(sessionId);
      return gate(sessionId, async () => {
        if (closed)
          throw new AgentExecutionError('execution-closed', 'Execution admission is closed');
        if (
          (await records(sessionId)).some(
            (item) => item.status === 'accepted' || item.status === 'queued',
          ) ||
          queues.get(sessionId)?.error !== undefined
        )
          throw new AgentExecutionError(
            'execution-busy',
            'Session already has an active execution',
          );
        return operation();
      });
    },
    closeSync() {
      closed = true;
      captureController.abort();
      for (const sessionId of queues.keys()) notifyQueue(sessionId);
    },
    async drain() {
      service.closeSync();
      let failed = false;
      const { states, tasks } = await gate('', async () => {
        const states = [...live.values()].filter((state) => state.task === undefined);
        const tasks = [...reservedTasks.values()];
        for (const state of states)
          if (state.status !== 'persistence-error') {
            if (state.status !== 'cancelling') status(state, 'cancelling');
            state.controller.abort();
          }
        for (const [sessionId, state] of queues) {
          if (reservedTasks.has(sessionId)) continue;
          if (state.error !== undefined) {
            failed = true;
            continue;
          }
          try {
            const { events, projection } = await load(sessionId);
            const batch: NewSessionEvent[] = projection.queued.map((item) => ({
              type: 'execution.finished',
              payload: {
                executionId: item.executionId,
                status: 'cancelled',
                reason: 'service-closed',
              },
            }));
            if (batch.length !== 0) {
              const appended = await append(sessionId, batch);
              sync(sessionId, [...events, ...appended]);
              notifyQueue(sessionId);
            }
          } catch {
            failed = true;
            block(sessionId);
          }
        }
        return { states, tasks };
      });
      const taskOutcomes = await Promise.allSettled(
        tasks.map(async (task) => {
          await boundPort.cancelBoundTask(task.token);
          await task.running?.promise;
          await boundPort.whenSettled(task.token);
        }),
      );
      await Promise.all(states.map((state) => state.promise));
      for (const state of queues.values()) {
        if (state.error !== undefined) failed = true;
        for (const subscriber of [...state.subscribers]) subscriber.close();
      }
      if (
        failed ||
        states.some((state) => state.status === 'persistence-error') ||
        taskOutcomes.some((outcome) => outcome.status === 'rejected')
      )
        throw new AgentExecutionError(
          'execution-persistence-error',
          'One or more execution terminal states could not be persisted',
        );
    },
  };
  registerBoundTaskExecutionPort(service, boundPort);
  return service;
}
