import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { agentTaskViewSchema, taskIdentifierSchema, taskIdSchema } from '@weave/protocol';
import {
  AgentTaskError,
  boundAgentTaskEnvelope,
  type AgentTaskErrorCode,
  type AgentTaskObserver,
  type AgentTaskService,
  type AgentTaskTreeSnapshot,
} from '@weave/runtime';
import type { ProjectStore } from '@weave/workspace';
import { ExecutionHttpError, readExecutionJson } from './agent-execution-guard.js';
import { detachedEventStream } from './detached-event-stream.js';
import { SessionServiceError, type SessionDetail, type SessionService } from './session-service.js';

export interface AgentTaskAppOptions {
  readonly agentTaskService?:
    Pick<AgentTaskService, 'requestCancel' | 'snapshot' | 'stopAll' | 'stopParentTurn'> | undefined;
  readonly agentTaskObserver?:
    Pick<AgentTaskObserver, 'status' | 'snapshot' | 'subscribe'> | undefined;
  readonly sessionService?: SessionService | undefined;
  readonly projectStore?: ProjectStore | undefined;
}

const path = '/sessions/:sessionId/tasks';
const maxSnapshotBytes = 24_576;
const maxFrames = 64;
const maxQueuedBytes = 256 * 1024;
const encoder = new TextEncoder();
const cursorSchema = z
  .string()
  .max(600)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
const operationSchema = z.strictObject({ operationId: taskIdentifierSchema });
const listQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^(?:[1-9]|1[0-6])$/)
    .transform(Number)
    .optional(),
  cursor: cursorSchema.optional(),
});
const eventQuerySchema = z.strictObject({ after: cursorSchema.optional() });
const emptyQuerySchema = z.strictObject({});
const taskErrors = {
  'agent-task-invalid-input': [400, 'Agent task request is invalid'],
  'agent-task-not-found': [404, 'Agent task or Session was not found'],
  'agent-task-not-permitted': [404, 'Agent task or Session was not found'],
  'agent-task-busy': [409, 'Stop active Agent tasks before changing this Session'],
  'agent-task-request-conflict': [409, 'Agent task operation conflicts with an earlier request'],
  'agent-task-capacity': [409, 'Agent task observation capacity is full'],
  'agent-task-closed': [503, 'Agent task service is unavailable'],
  'agent-task-persistence-error': [
    503,
    'Agent task request could not be confirmed; retry the same request',
  ],
} as const satisfies Record<AgentTaskErrorCode, readonly [400 | 404 | 409 | 503, string]>;

export function agentTaskErrorResponse(context: Context, error: AgentTaskError): Response {
  const [status, message] = taskErrors[error.code];
  return context.json({ error: { code: error.code, message } }, status);
}

function errorResponse(context: Context, error: unknown): Response {
  if (error instanceof ExecutionHttpError)
    return context.json({ error: { code: error.code, message: error.message } }, error.status);
  if (error instanceof AgentTaskError) return agentTaskErrorResponse(context, error);
  if (error instanceof SessionServiceError && error.code === 'session-not-found')
    return agentTaskErrorResponse(context, notFound());
  return agentTaskErrorResponse(context, unavailable());
}

const invalid = () => new AgentTaskError('agent-task-invalid-input', 'Invalid Agent task request');
const notFound = () =>
  new AgentTaskError('agent-task-not-found', 'Agent task or Session was not found');
const unavailable = () =>
  new AgentTaskError('agent-task-closed', 'Agent task service is unavailable');

function query<T>(context: Context, schema: z.ZodType<T>): T {
  const params = new URL(context.req.url).searchParams;
  const values = Object.fromEntries(params);
  const parsed = schema.safeParse(values);
  if (!parsed.success || Object.keys(values).length !== params.size) throw invalid();
  return parsed.data;
}

function encodeSnapshot(snapshot: AgentTaskTreeSnapshot): Uint8Array {
  const payload = JSON.stringify(snapshot);
  if (
    Buffer.byteLength(payload) > maxSnapshotBytes ||
    !cursorSchema.safeParse(snapshot.cursor).success
  )
    throw unavailable();
  return encoder.encode(`id: ${snapshot.cursor}\nevent: tasks\ndata: ${payload}\n\n`);
}

function taskEventStream(
  observer: Pick<AgentTaskObserver, 'snapshot' | 'subscribe'>,
  root: string,
  after: string | undefined,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const queue: Uint8Array[] = [];
  let bytes = 0;
  let closed = false;
  let lastCursor: string | undefined;
  let waiting: ((result: IteratorResult<Uint8Array>) => void) | undefined;
  let unsubscribe = (): void => undefined;
  function close(): void {
    if (closed) return;
    closed = true;
    unsubscribe();
    queue.length = 0;
    bytes = 0;
    waiting?.({ done: true, value: undefined });
    waiting = undefined;
  }
  unsubscribe = observer.subscribe(root, () => {
    if (closed || lastCursor === undefined) return;
    try {
      const snapshot = observer.snapshot(root, lastCursor);
      if (!snapshot.changed) return;
      const frame = encodeSnapshot(snapshot);
      lastCursor = snapshot.cursor;
      if (waiting !== undefined) {
        const resolve = waiting;
        waiting = undefined;
        resolve({ done: false, value: frame });
      } else if (queue.length >= maxFrames || bytes + frame.byteLength > maxQueuedBytes) {
        close();
      } else {
        queue.push(frame);
        bytes += frame.byteLength;
      }
    } catch {
      close();
    }
  });

  try {
    const snapshot = observer.snapshot(root, after);
    const initial = encodeSnapshot(snapshot);
    queue.push(initial);
    bytes = initial.byteLength;
    lastCursor = snapshot.cursor;
    const iterator: AsyncIterator<Uint8Array> = {
      async next() {
        const frame = queue.shift();
        if (frame !== undefined) {
          bytes -= frame.byteLength;
          return { done: false, value: frame };
        }
        if (closed) return { done: true, value: undefined };
        return new Promise((resolve) => {
          waiting = resolve;
        });
      },
    };
    return detachedEventStream(
      { initial: [], events: { [Symbol.asyncIterator]: () => iterator }, close },
      signal,
      (frame) => frame,
    );
  } catch (error) {
    close();
    throw error;
  }
}

/** A child and its root must each be attached to exactly one common Project. */
export async function resolveAgentTaskRoot(
  detail: SessionDetail,
  sessionService: SessionService,
  projectStore: ProjectStore,
): Promise<string> {
  const root = detail.taskOrigin?.rootSessionId ?? detail.id;
  if (
    detail.taskOrigin !== undefined &&
    (root === detail.id || detail.taskOrigin.parentSessionId !== root)
  )
    throw notFound();
  const rootDetail = root === detail.id ? detail : await sessionService.get(root);
  if (rootDetail.deletedAt !== undefined || rootDetail.taskOrigin !== undefined) throw notFound();
  const childProjects: string[] = [];
  const rootProjects: string[] = [];
  for (const project of await projectStore.listProjects()) {
    const refs = await projectStore.listSessionRefs(project.id);
    if (refs.some((ref) => ref.projectId === project.id && ref.sessionId === detail.id))
      childProjects.push(project.id);
    if (refs.some((ref) => ref.projectId === project.id && ref.sessionId === root))
      rootProjects.push(project.id);
  }
  if (
    childProjects.length !== 1 ||
    rootProjects.length !== 1 ||
    childProjects[0] !== rootProjects[0]
  )
    throw notFound();
  return root;
}

/** Mounts local task observations and Runtime-owned stop controls. */
export function registerAgentTaskRoutes(app: Hono, options: AgentTaskAppOptions): void {
  async function scope(context: Context, control = false) {
    const id = taskIdentifierSchema.safeParse(context.req.param('sessionId'));
    if (!id.success) throw invalid();
    const { sessionService, projectStore } = options;
    if (sessionService === undefined || projectStore === undefined) throw unavailable();
    const detail = await sessionService.get(id.data);
    if (control && detail.deletedAt !== undefined) throw notFound();
    return {
      root: await resolveAgentTaskRoot(detail, sessionService, projectStore),
      origin: detail.taskOrigin,
    };
  }
  function observer() {
    if (options.agentTaskObserver === undefined) throw unavailable();
    return options.agentTaskObserver;
  }
  async function operation(context: Context) {
    query(context, emptyQuerySchema);
    const parsed = operationSchema.safeParse(await readExecutionJson(context.req.raw, 4096));
    if (!parsed.success) throw invalid();
    if (options.agentTaskService === undefined) throw unavailable();
    return { operationId: parsed.data.operationId, service: options.agentTaskService };
  }
  function taskId(context: Context): string {
    const parsed = taskIdSchema.safeParse(context.req.param('taskId'));
    if (!parsed.success) throw invalid();
    return parsed.data;
  }
  app.get(path, async (context) => {
    try {
      const { limit, cursor } = query(context, listQuerySchema);
      const { root } = await scope(context);
      const source = observer();
      const snapshot = source.snapshot(root);
      if (cursor === undefined && (limit === undefined || limit === 16))
        return context.json(snapshot);
      const { epoch, rootSessionId, revision, changed, totalCount } = snapshot;
      const metadata = { epoch, rootSessionId, revision, changed, totalCount };
      const page = source.status(root, {
        limit: limit ?? 16,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const maxBytes = maxSnapshotBytes - Buffer.byteLength(JSON.stringify(metadata)) + 1;
      const bounded = boundAgentTaskEnvelope(
        { ...page, cursor: snapshot.cursor },
        { mode: 'list', maxBytes },
      );
      return context.json({ ...bounded, ...metadata });
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  app.get(`${path}/events`, async (context) => {
    try {
      const { after } = query(context, eventQuerySchema);
      const header = context.req.header('Last-Event-ID');
      if (
        header !== undefined &&
        (!cursorSchema.safeParse(header).success || (after !== undefined && header !== after))
      )
        throw invalid();
      const { root } = await scope(context);
      const stream = taskEventStream(observer(), root, after ?? header, context.req.raw.signal);
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  app.get(`${path}/:taskId`, async (context) => {
    try {
      query(context, emptyQuerySchema);
      const id = taskId(context);
      const { root } = await scope(context);
      const task = observer().status(root, { taskIds: [id] }).tasks[0];
      if (task?.taskId !== id || task.rootSessionId !== root) throw notFound();
      return context.json(task);
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  app.post(`${path}/:taskId/cancel`, async (context) => {
    try {
      const id = taskId(context);
      const { service, operationId } = await operation(context);
      const { root, origin } = await scope(context, true);
      if (origin !== undefined && origin.taskId !== id) throw notFound();
      const tasks = await service.requestCancel(root, [id], operationId, 'task-cancelled');
      return context.json({ tasks: agentTaskViewSchema.array().max(1).parse(tasks) }, 202);
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  app.post(`${path}/stop-all`, async (context) => {
    try {
      const { service, operationId } = await operation(context);
      const { root, origin } = await scope(context, true);
      if (origin !== undefined) throw notFound();
      const { tasks } = boundAgentTaskEnvelope({
        tasks: await service.stopAll(root, operationId),
        cursor: 'receipt',
      });
      return context.json({ tasks }, 202);
    } catch (error) {
      return errorResponse(context, error);
    }
  });
}
