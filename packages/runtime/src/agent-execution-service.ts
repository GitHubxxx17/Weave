import { createHash, randomUUID } from 'node:crypto';
import {
  projectAgentExecutions,
  projectSession,
  type NewSessionEvent,
  type SessionExecution,
} from '@weave/session';
import { agentRuntimeEventSchema, type AgentRuntimeEvent } from './agent-types.js';
import {
  AgentExecutionError,
  agentExecutionCursorSchema,
  agentExecutionLaunchSchema,
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

/** Owns execution production independently from every detachable observer. */
export function createAgentExecutionService(
  options: AgentExecutionServiceOptions,
): AgentExecutionService {
  const epoch = randomUUID();
  const live = new Map<string, LiveExecution>();
  const gates = new Map<string, Promise<void>>();
  let closed = false;

  const cursor = (executionId: string, sequence: number): string =>
    `${epoch}:${executionId}:${sequence}`;
  const gate = async <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = gates.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.set(sessionId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (gates.get(sessionId) === current) gates.delete(sessionId);
    }
  };
  const requireId = (value: string): void => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 240)
      throw new AgentExecutionError('execution-invalid-input', 'Execution identifier is invalid');
  };
  const records = async (sessionId: string) =>
    projectAgentExecutions(await options.sessionStore.read(sessionId));
  const snapshot = (accepted: SessionExecution, state?: LiveExecution): AgentExecutionSnapshot =>
    structuredClone({
      executionId: accepted.executionId,
      requestId: accepted.requestId,
      sessionId: accepted.sessionId,
      turnId: accepted.turnId,
      userMessageId: accepted.userMessageId,
      input: accepted.input,
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
    void cause;
  };

  const pump = async (state: LiveExecution): Promise<void> => {
    let failure: unknown;
    let hasFailure = false;
    let completion: Extract<AgentRuntimeEvent, { type: 'completed' }> | undefined;
    try {
      if (!state.controller.signal.aborted) {
        await options.admit(state.accepted.sessionId);
        state.controller.signal.throwIfAborted();
        status(state, 'running');
        const stream = options.runner.run({
          ...structuredClone(state.accepted.input),
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
      const appended = await options.sessionStore.append(state.accepted.sessionId, [
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
      live.delete(state.accepted.executionId);
    } catch (error: unknown) {
      markPersistenceError(state, error);
    }
  };

  const service: AgentExecutionService = {
    async launch(sessionId, request) {
      requireId(sessionId);
      const parsed = agentExecutionLaunchSchema.safeParse(request);
      if (!parsed.success)
        throw new AgentExecutionError('execution-invalid-input', 'Execution input is invalid');
      const frozen = structuredClone(parsed.data);
      const digest = createHash('sha256').update(canonicalJson(frozen.input), 'utf8').digest('hex');
      return gate(sessionId, async () => {
        const existing = await records(sessionId);
        const replay = existing.find((item) => item.requestId === frozen.requestId);
        if (replay !== undefined) {
          if (replay.requestDigest !== digest)
            throw new AgentExecutionError(
              'execution-request-conflict',
              'Request identifier already belongs to different input',
            );
          return snapshot(replay, live.get(replay.executionId));
        }
        if (closed)
          throw new AgentExecutionError('execution-closed', 'Execution admission is closed');
        if (existing.some((item) => item.status === 'accepted'))
          throw new AgentExecutionError(
            'execution-busy',
            'Session already has an active execution',
          );
        await options.admit(sessionId);
        if (closed)
          throw new AgentExecutionError('execution-closed', 'Execution admission is closed');
        const accepted: SessionExecution = {
          executionId: randomUUID(),
          requestId: frozen.requestId,
          requestDigest: digest,
          turnId: randomUUID(),
          userMessageId: randomUUID(),
          input: frozen.input,
          sessionId,
          createdAt: new Date().toISOString(),
          status: 'accepted',
        };
        if (bytes(snapshot(accepted)) + 1024 > snapshotMaxBytes)
          throw new AgentExecutionError(
            'execution-output-limit',
            'Execution input exceeds the live snapshot limit',
          );
        const appended = await options.sessionStore.append(sessionId, [
          {
            type: 'execution.accepted',
            payload: {
              executionId: accepted.executionId,
              requestId: accepted.requestId,
              requestDigest: digest,
              turnId: accepted.turnId,
              userMessageId: accepted.userMessageId,
              input: structuredClone(accepted.input),
            },
          },
        ]);
        const durableAccepted = {
          ...accepted,
          createdAt: appended[0]?.occurredAt ?? accepted.createdAt,
        };
        const state: LiveExecution = {
          accepted: durableAccepted,
          controller: new AbortController(),
          subscribers: new Set(),
          ring: [],
          events: [],
          status: 'accepted',
          sequence: 0,
          ringBytes: 0,
          outputBytes: bytes(snapshot(durableAccepted)),
          outputLimited: false,
          promise: Promise.resolve(),
        };
        live.set(accepted.executionId, state);
        const receipt = snapshot(durableAccepted, state);
        state.promise = Promise.resolve().then(() => pump(state));
        return receipt;
      });
    },
    async list(sessionId) {
      requireId(sessionId);
      // Keep any state that settles while durable history is being read, so
      // its stale accepted record cannot briefly appear active without output.
      const observedLive = new Map(live);
      return (await records(sessionId))
        .slice(-100)
        .reverse()
        .map((accepted) => {
          const {
            input: _input,
            events: _events,
            ...summary
          } = snapshot(
            accepted,
            live.get(accepted.executionId) ?? observedLive.get(accepted.executionId),
          );
          void _input;
          void _events;
          return summary;
        });
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
      let pending: ((value: IteratorResult<AgentExecutionFrame>) => void) | undefined;
      const close = (): void => {
        ended = true;
        queued.length = 0;
        queuedBytes = 0;
        state?.subscribers.delete(subscriber);
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
      if (!ended) state?.subscribers.add(subscriber);
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
      const { accepted, state } = await lookup(sessionId, executionId);
      if (
        state !== undefined &&
        !terminalStatuses.has(state.status) &&
        state.status !== 'persistence-error'
      ) {
        if (state.status !== 'cancelling') status(state, 'cancelling');
        state.controller.abort();
      }
      return snapshot(accepted, state);
    },
    async recover(sessionIds) {
      for (const sessionId of sessionIds)
        await gate(sessionId, async () => {
          const events = await options.sessionStore.read(sessionId);
          const projection = events.length === 0 ? undefined : projectSession(events);
          for (const accepted of projectAgentExecutions(events)) {
            if (accepted.status !== 'accepted' || live.has(accepted.executionId)) continue;
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
                ...(turn?.status !== 'running' && turn?.reason !== undefined
                  ? { reason: turn.reason }
                  : turn === undefined || turn.status === 'running'
                    ? { reason: 'server-restarted' }
                    : {}),
              },
            });
            await options.sessionStore.append(sessionId, batch);
          }
        });
    },
    async withSessionIdle(sessionId, operation) {
      requireId(sessionId);
      return gate(sessionId, async () => {
        if (closed)
          throw new AgentExecutionError('execution-closed', 'Execution admission is closed');
        if ((await records(sessionId)).some((item) => item.status === 'accepted'))
          throw new AgentExecutionError(
            'execution-busy',
            'Session already has an active execution',
          );
        return operation();
      });
    },
    closeSync() {
      closed = true;
    },
    async drain() {
      closed = true;
      await Promise.all([...gates.values()]);
      const states = [...live.values()];
      for (const state of states)
        if (state.status !== 'persistence-error') {
          if (state.status !== 'cancelling') status(state, 'cancelling');
          state.controller.abort();
        }
      await Promise.all(states.map((state) => state.promise));
      if (states.some((state) => state.status === 'persistence-error'))
        throw new AgentExecutionError(
          'execution-persistence-error',
          'One or more execution terminal states could not be persisted',
        );
    },
  };
  return service;
}
