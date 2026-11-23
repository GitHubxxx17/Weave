import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  agentTaskStatusInputSchema,
  agentTaskViewSchema,
  agentTaskWaitInputSchema,
  taskIdentifierSchema,
  type AgentTaskView,
} from '@weave/protocol';
import { z } from 'zod';
import { boundAgentTaskEnvelope, type AgentTaskEnvelope } from './agent-task-result.js';
import { AgentTaskError, type AgentTaskService } from './agent-task-service.js';
import type { ApprovalBroker, ApprovalRequest } from './approval-types.js';

type BoundedEnvelope = AgentTaskEnvelope & { readonly truncated: boolean };

export interface AgentTaskTreeSnapshot {
  readonly tasks: readonly AgentTaskView[];
  readonly cursor: string;
  readonly epoch: string;
  readonly rootSessionId: string;
  readonly revision: number;
  readonly changed: boolean;
  readonly totalCount: number;
  readonly truncated: boolean;
  readonly nextCursor?: string | undefined;
}

export interface AgentTaskObserver {
  status(rootSessionId: string, input: unknown): BoundedEnvelope;
  wait(rootSessionId: string, input: unknown, signal?: AbortSignal): Promise<BoundedEnvelope>;
  snapshot(rootSessionId: string, after?: string): AgentTaskTreeSnapshot;
  subscribe(rootSessionId: string, listener: () => void): () => void;
  close(): void;
}

interface AgentTaskObserverOptions {
  readonly service: Pick<AgentTaskService, 'snapshot' | 'subscribe'>;
  readonly approvalBroker: Pick<ApprovalBroker, 'list' | 'subscribe'>;
}

const maxObservers = 64;
const maxDetachedRoots = 64;
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const digestSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const cursorFields = {
  epoch: z.uuid(),
  root: digestSchema,
  revision: z.number().int().nonnegative().safe(),
};
const cursorPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...cursorFields, kind: z.literal('tree') }),
  z.strictObject({ ...cursorFields, kind: z.literal('wait'), targets: digestSchema }),
  z.strictObject({
    ...cursorFields,
    kind: z.literal('page'),
    position: z.number().int().nonnegative().safe(),
  }),
]);
const cursorFrameSchema = z
  .string()
  .max(600)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
type CursorPayload = z.infer<typeof cursorPayloadSchema>;
type CursorScope = Pick<CursorPayload, 'epoch' | 'root' | 'revision'>;

interface TaskObservation {
  readonly view: AgentTaskView;
  readonly terminalRevision?: number | undefined;
  readonly pending: ReadonlyMap<string, number>;
}

interface RootObservation {
  readonly epoch: string;
  revision: number;
  tasks: ReadonlyMap<string, TaskObservation>;
  liveRuns: ReadonlySet<string>;
  dirty: boolean;
  scheduled: boolean;
  readonly listeners: Set<() => void>;
}

function invalidInput(message: string): AgentTaskError {
  return new AgentTaskError('agent-task-invalid-input', message);
}

function observerClosed(): AgentTaskError {
  return new AgentTaskError('agent-task-closed', 'Agent task observation is closed');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function targetDigest(ids: readonly string[]): string {
  return digest(JSON.stringify([...ids].sort()));
}

function runKey(sessionId: string, executionId: string, turnId: string): string {
  return JSON.stringify([sessionId, executionId, turnId]);
}

function approvalRunKey(request: ApprovalRequest): string | undefined {
  const { sessionId, executionId, turnId } = request;
  if (sessionId !== undefined && executionId !== undefined && turnId !== undefined)
    return runKey(sessionId, executionId, turnId);
  return undefined;
}

export function createAgentTaskObserver({
  service,
  approvalBroker,
}: AgentTaskObserverOptions): AgentTaskObserver {
  const secret = randomBytes(32);
  const activeRoots = new Map<string, RootObservation>();
  const detachedRoots = new Map<string, RootObservation>();
  const stopWaits = new Set<() => void>();
  let subscriptions = 0;
  let closed = false;

  function rootObservation(root: string): RootObservation {
    if (closed) throw observerClosed();
    if (!taskIdentifierSchema.safeParse(root).success)
      throw invalidInput('Invalid root Session ID');
    return (
      activeRoots.get(root) ??
      detachedRoots.get(root) ?? {
        epoch: randomUUID(),
        revision: 0,
        tasks: new Map(),
        liveRuns: new Set(),
        dirty: true,
        scheduled: false,
        listeners: new Set(),
      }
    );
  }

  function rememberDetached(root: string, observation: RootObservation): void {
    if (closed || observation.listeners.size !== 0) return;
    detachedRoots.delete(root);
    detachedRoots.set(root, observation);
    if (detachedRoots.size > maxDetachedRoots) {
      const oldest = detachedRoots.keys().next();
      if (!oldest.done) detachedRoots.delete(oldest.value);
    }
  }

  function listen(root: string, observation: RootObservation, listener: () => void): () => boolean {
    if (observation.listeners.size === 0) {
      detachedRoots.delete(root);
      activeRoots.set(root, observation);
      observation.dirty = true;
    }
    observation.listeners.add(listener);
    return () => {
      if (!observation.listeners.delete(listener)) return false;
      if (observation.listeners.size === 0) {
        activeRoots.delete(root);
        rememberDetached(root, observation);
      }
      return true;
    };
  }

  function signature(body: string): Buffer {
    return createHmac('sha256', secret).update(body).digest();
  }

  function encode(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${signature(body).toString('base64url')}`;
  }

  function decode<K extends CursorPayload['kind']>(
    cursor: string,
    kind: K,
    rootDigest: string,
    epoch: string,
  ): Extract<CursorPayload, { kind: K }> {
    const error = () => invalidInput('Invalid Agent task cursor');
    if (!cursorFrameSchema.safeParse(cursor).success) throw error();
    const [body, mac] = cursor.split('.') as [string, string];
    const bytes = Buffer.from(body, 'base64url');
    const givenMac = Buffer.from(mac, 'base64url');
    if (bytes.toString('base64url') !== body || givenMac.toString('base64url') !== mac)
      throw error();
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw error();
    }
    const parsed = cursorPayloadSchema.safeParse(raw);
    if (!parsed.success || parsed.data.kind !== kind || parsed.data.root !== rootDigest)
      throw error();
    if (parsed.data.epoch === epoch && !timingSafeEqual(givenMac, signature(body))) throw error();
    return parsed.data as Extract<CursorPayload, { kind: K }>;
  }

  function readRoot(root: string, observation: RootObservation, refresh = false): void {
    if (!refresh && !observation.dirty) return;
    let tasks: readonly AgentTaskView[];
    let approvals: readonly ApprovalRequest[];
    do {
      observation.dirty = false;
      try {
        tasks = service.snapshot(root);
        approvals = approvalBroker.list();
      } catch (cause: unknown) {
        observation.dirty = true;
        throw cause;
      }
    } while (observation.dirty);

    const pendingByRun = new Map<string, Set<string>>();
    for (const request of approvals) {
      if (
        request.status !== 'pending' ||
        !taskIdentifierSchema.safeParse(request.approvalId).success
      )
        continue;
      const key = approvalRunKey(request);
      if (key === undefined) continue;
      const ids = pendingByRun.get(key) ?? new Set<string>();
      ids.add(request.approvalId);
      pendingByRun.set(key, ids);
    }
    const nextTasks = new Map<string, TaskObservation>();
    const liveRuns = new Set<string>();
    const nextRevision = observation.revision + 1;
    let changed = false;
    for (const source of tasks) {
      if (source.rootSessionId !== root || source.parentSessionId !== root) continue;
      const previous = observation.tasks.get(source.taskId);
      const terminal = terminalStatuses.has(source.status);
      let ids: string[] = [];
      if (!terminal) {
        const key = runKey(source.childSessionId, source.childExecutionId, source.childTurnId);
        liveRuns.add(key);
        ids = [...(pendingByRun.get(key) ?? [])];
      }
      const pending = new Map(ids.map((id) => [id, previous?.pending.get(id) ?? nextRevision]));
      const view = agentTaskViewSchema.parse({
        ...source,
        pendingApprovalIds: ids.slice(0, 4),
        pendingApprovalCount: ids.length,
      });
      nextTasks.set(source.taskId, {
        view,
        terminalRevision: terminal ? (previous?.terminalRevision ?? nextRevision) : undefined,
        pending,
      });
      changed ||=
        !isDeepStrictEqual(previous?.view, view) || !isDeepStrictEqual(previous?.pending, pending);
    }
    if (changed || nextTasks.size !== observation.tasks.size) {
      if (!Number.isSafeInteger(nextRevision)) throw observerClosed();
      observation.revision = nextRevision;
      observation.tasks = nextTasks;
      observation.liveRuns = liveRuns;
    }
  }

  function invalidate(observation: RootObservation): void {
    observation.dirty = true;
    if (observation.scheduled || observation.listeners.size === 0) return;
    observation.scheduled = true;
    queueMicrotask(() => {
      observation.scheduled = false;
      if (closed || observation.listeners.size === 0) return;
      for (const listener of [...observation.listeners]) {
        try {
          listener();
        } catch {
          // Observation callbacks cannot interrupt task state transitions.
        }
      }
    });
  }

  const unsubscribeTasks = service.subscribe((root) => {
    const observation = activeRoots.get(root) ?? detachedRoots.get(root);
    if (observation !== undefined) invalidate(observation);
  });
  const unsubscribeApprovals = approvalBroker.subscribe(({ request }) => {
    if (activeRoots.size === 0) return;
    const key = approvalRunKey(request);
    if (key === undefined) return;
    for (const observation of activeRoots.values()) {
      if (observation.dirty || observation.liveRuns.has(key)) invalidate(observation);
    }
  });

  function select(observation: RootObservation, ids: readonly string[]): TaskObservation[] {
    return ids.map((id) => {
      const task = observation.tasks.get(id);
      if (task === undefined)
        throw new AgentTaskError('agent-task-not-found', 'Agent task does not belong to this root');
      return task;
    });
  }

  function previousRevision(cursor: CursorPayload, observation: RootObservation): number {
    if (cursor.epoch !== observation.epoch) return -1;
    if (cursor.revision > observation.revision)
      throw invalidInput('Invalid Agent task cursor revision');
    return cursor.revision;
  }

  function pageOf(
    observation: RootObservation,
    fields: CursorScope,
    position: number,
    limit: number,
  ) {
    const end = position + limit;
    const ordered = [...observation.tasks.values()].reverse().sort((left, right) => {
      const leftTerminal = left.terminalRevision !== undefined;
      const rightTerminal = right.terminalRevision !== undefined;
      if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
      return Date.parse(right.view.acceptedAt) - Date.parse(left.view.acceptedAt);
    });
    return {
      tasks: ordered.slice(position, end).map(({ view }) => view),
      nextCursor:
        end < ordered.length ? encode({ ...fields, kind: 'page', position: end }) : undefined,
    };
  }

  return {
    status(root, input) {
      const parsed = agentTaskStatusInputSchema.safeParse(input);
      if (!parsed.success) throw invalidInput('Invalid Agent task status input');
      const observation = rootObservation(root);
      rememberDetached(root, observation);
      readRoot(root, observation, true);
      const fields = {
        epoch: observation.epoch,
        root: digest(root),
        revision: observation.revision,
      };
      if ('taskIds' in parsed.data) {
        const { taskIds } = parsed.data;
        return boundAgentTaskEnvelope({
          tasks: select(observation, taskIds).map(({ view }) => view),
          cursor: encode({ ...fields, kind: 'wait', targets: targetDigest(taskIds) }),
        });
      }
      const { cursor, limit } = parsed.data;
      let position = 0;
      if (cursor !== undefined) {
        const page = decode(cursor, 'page', fields.root, fields.epoch);
        if (
          page.epoch !== fields.epoch ||
          page.revision !== observation.revision ||
          page.position >= observation.tasks.size
        )
          throw invalidInput('Invalid Agent task page cursor');
        position = page.position;
      }
      return boundAgentTaskEnvelope(
        {
          ...pageOf(observation, fields, position, limit),
          cursor: encode({ ...fields, kind: 'page', position }),
        },
        { mode: 'list' },
      );
    },
    async wait(root, input, signal) {
      const parsed = agentTaskWaitInputSchema.safeParse(input);
      if (!parsed.success) throw invalidInput('Invalid Agent task wait input');
      const observation = rootObservation(root);
      signal?.throwIfAborted();
      const { taskIds, timeoutMs, after } = parsed.data;
      const fields = {
        epoch: observation.epoch,
        root: digest(root),
        kind: 'wait' as const,
        targets: targetDigest(taskIds),
      };
      const afterCursor =
        after === undefined ? undefined : decode(after, 'wait', fields.root, fields.epoch);
      if (afterCursor !== undefined && afterCursor.targets !== fields.targets)
        throw invalidInput('Agent task wait cursor targets differ');
      if (stopWaits.size >= maxObservers)
        throw new AgentTaskError('agent-task-capacity', 'Too many concurrent Agent task waits');

      return new Promise<BoundedEnvelope>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let finished = false;
        function cleanup(): void {
          finished = true;
          detach();
          stopWaits.delete(onClose);
          signal?.removeEventListener('abort', onAbort);
          clearTimeout(timer);
        }
        function fail(error: unknown): void {
          cleanup();
          reject(error);
        }
        function onClose(): void {
          fail(observerClosed());
        }
        function onAbort(): void {
          fail(signal?.reason);
        }
        function inspect(expired: boolean, refresh = false): boolean {
          if (finished) return true;
          try {
            readRoot(root, observation, refresh);
            if (finished) return true;
            const previous =
              afterCursor === undefined ? -1 : previousRevision(afterCursor, observation);
            const selected = select(observation, taskIds);
            const allSettled = selected.every(
              ({ terminalRevision }) => terminalRevision !== undefined,
            );
            const actionable = selected.filter(
              ({ terminalRevision, pending }) =>
                (terminalRevision ?? -1) > previous ||
                [...pending.values()].some((revision) => revision > previous),
            );
            if (!allSettled && actionable.length === 0 && !expired) return false;
            const timedOut = expired && actionable.length === 0 && !allSettled;
            let truncated = false;
            const tasks = (timedOut ? selected : actionable).map(({ view, terminalRevision }) => {
              if (timedOut && terminalRevision !== undefined && view.preview !== '') {
                truncated = true;
                return { ...view, preview: '', previewTruncated: true };
              }
              return view;
            });
            const result = boundAgentTaskEnvelope({
              tasks,
              cursor: encode({ ...fields, revision: observation.revision }),
              changed: actionable.length > 0,
              allSettled,
              timedOut,
              truncated,
            });
            cleanup();
            resolve(result);
          } catch (cause: unknown) {
            fail(cause);
          }
          return true;
        }
        function onChange(): void {
          inspect(false);
        }
        const detach = listen(root, observation, onChange);
        stopWaits.add(onClose);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (!inspect(timeoutMs === 0, true))
          timer = setTimeout(() => inspect(true, true), timeoutMs);
      });
    },
    snapshot(root, after) {
      const observation = rootObservation(root);
      rememberDetached(root, observation);
      readRoot(root, observation, true);
      const fields = {
        epoch: observation.epoch,
        root: digest(root),
        kind: 'tree' as const,
        revision: observation.revision,
      };
      const previous =
        after === undefined
          ? -1
          : previousRevision(decode(after, 'tree', fields.root, fields.epoch), observation);
      const metadata = {
        epoch: fields.epoch,
        rootSessionId: root,
        revision: observation.revision,
        changed: observation.revision > previous,
        totalCount: observation.tasks.size,
      };
      // Joining the two JSON objects removes two braces and adds one comma.
      const maxBytes = 24_576 - Buffer.byteLength(JSON.stringify(metadata)) + 1;
      const page = boundAgentTaskEnvelope(
        { ...pageOf(observation, fields, 0, 16), cursor: encode(fields) },
        { mode: 'list', maxBytes },
      );
      return { ...page, ...metadata };
    },
    subscribe(root, listener) {
      const observation = rootObservation(root);
      if (subscriptions >= maxObservers)
        throw new AgentTaskError('agent-task-capacity', 'Too many Agent task tree observers');
      const detach = listen(root, observation, () => listener());
      subscriptions += 1;
      return () => {
        if (detach()) subscriptions -= 1;
      };
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribeTasks();
      unsubscribeApprovals();
      for (const stop of stopWaits) stop();
      for (const observation of activeRoots.values()) observation.listeners.clear();
      activeRoots.clear();
      detachedRoots.clear();
    },
  };
}
