import { createHash, randomUUID } from 'node:crypto';
import {
  projectAgentExecutions,
  projectAgentExecutionQueue,
  type SessionExecutionMetadata,
  type SessionExecutionQueue,
  type SessionEvent,
  projectSession,
  type NewSessionEvent,
  type SessionExecution,
  capturedFileContextSchema,
  executionAcceptedPayloadSchema,
  fileAttachmentSummaries,
  type CapturedFileContext,
} from '@weave/session';
import { agentRuntimeEventSchema, type AgentRuntimeEvent } from './agent-types.js';
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

  const pump = async (state: LiveExecution): Promise<void> => {
    let failure: unknown;
    let hasFailure = false;
    let completion: Extract<AgentRuntimeEvent, { type: 'completed' }> | undefined;
    try {
      if (!state.controller.signal.aborted) {
        await options.admit(state.accepted.sessionId);
        if (closed) state.controller.abort();
        state.controller.signal.throwIfAborted();
        status(state, 'running');
        const stream = options.runner.run({
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
    try {
      await gate(state.accepted.sessionId, async () => {
        const persisted = await options.sessionStore.read(state.accepted.sessionId);
        const started = persisted.some(
          (item) =>
            item.type === 'turn.started' &&
            item.payload.turnId === state.accepted.turnId &&
            item.payload.executionId === state.accepted.executionId,
        );
        const turnTerminal = persisted.find(
          (item) => item.type === 'turn.completed' && item.payload.turnId === state.accepted.turnId,
        );
        if (started && turnTerminal?.type !== 'turn.completed') {
          markPersistenceError(state, failure);
          return;
        }
        if (!started && !hasFailure && !state.controller.signal.aborted)
          throw new Error('Runner ended without a durable Turn');
        const outcome =
          turnTerminal?.type === 'turn.completed'
            ? turnTerminal.payload.status
            : state.controller.signal.aborted
              ? 'cancelled'
              : 'failed';
        const reason =
          state.error?.code ??
          (turnTerminal?.type === 'turn.completed' ? turnTerminal.payload.reason : undefined) ??
          (hasFailure &&
          typeof failure === 'object' &&
          failure !== null &&
          'code' in failure &&
          typeof failure.code === 'string'
            ? failure.code
            : undefined);
        const appended = await append(state.accepted.sessionId, [
          {
            type: 'execution.finished',
            payload: {
              executionId: state.accepted.executionId,
              status: outcome,
              ...(reason === undefined ? {} : { reason }),
            },
          },
        ]);
        const terminalSequence = appended.at(-1)?.sequence;
        if (terminalSequence === undefined)
          throw new Error('Execution terminal append returned no event');
        state.durableThroughSequence = terminalSequence;
        // Queue observers can already be waiting for the first terminal status
        // notification. Project its confirmed removal before publishing any view.
        sync(state.accepted.sessionId, [...persisted, ...appended]);
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
        status(state, outcome);
        for (const subscriber of state.subscribers) subscriber.finish();
        state.subscribers.clear();
        // Detached initial snapshots and subscriber queues own their copies.
        // Retained subscription handles must not keep the complete live view.
        state.events.length = 0;
        state.ring.length = 0;
        state.ringBytes = 0;
        state.outputBytes = 0;
        live.delete(state.accepted.executionId);
        await claimNext(state.accepted.sessionId);
      });
    } catch (error: unknown) {
      markPersistenceError(state, error);
    }
  };

  const install = (accepted: SessionExecution): LiveExecution => {
    const state: LiveExecution = {
      accepted,
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
      const previous = replay(await records(sessionId), observedLive);
      const unresolved = queues.get(sessionId)?.unresolvedAdmission;
      const reconciliation = unresolved?.requestId === frozen.requestId;
      if (previous !== undefined && !reconciliation) return previous;
      return gate(sessionId, async () => {
        const { events, projection } = await load(sessionId);
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
            if (turn?.status === 'running') {
              for (const step of turn.steps)
                if (step.status === 'running')
                  batch.push({
                    type: 'step.completed',
                    payload: { turnId: turn.turnId, stepId: step.stepId, status: 'failed' },
                  });
              batch.push({
                type: 'turn.completed',
                payload: { turnId: turn.turnId, status: 'failed', reason: 'server-restarted' },
              });
            }
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
      const states = await gate('', async () => {
        const states = [...live.values()];
        for (const state of states)
          if (state.status !== 'persistence-error') {
            if (state.status !== 'cancelling') status(state, 'cancelling');
            state.controller.abort();
          }
        for (const [sessionId, state] of queues) {
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
        return states;
      });
      await Promise.all(states.map((state) => state.promise));
      for (const state of queues.values()) {
        if (state.error !== undefined) failed = true;
        for (const subscriber of [...state.subscribers]) subscriber.close();
      }
      if (failed || states.some((state) => state.status === 'persistence-error'))
        throw new AgentExecutionError(
          'execution-persistence-error',
          'One or more execution terminal states could not be persisted',
        );
    },
  };
  return service;
}
