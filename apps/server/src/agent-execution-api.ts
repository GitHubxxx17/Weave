import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  AgentExecutionError,
  agentExecutionCursorSchema,
  agentExecutionLaunchSchema,
  type AgentExecutionFrame,
  type AgentExecutionService,
  type AgentExecutionSubscription,
} from '@weave/runtime';
import type { ProjectStore } from '@weave/workspace';
import { ExecutionHttpError, readExecutionJson } from './agent-execution-guard.js';
import { SessionServiceError, type SessionService } from './session-service.js';

export interface AgentExecutionAppOptions {
  readonly agentExecutionService?: AgentExecutionService | undefined;
  readonly sessionService?: SessionService | undefined;
  readonly projectStore?: ProjectStore | undefined;
}

function errorResponse(context: Context, error: unknown): Response {
  if (error instanceof ExecutionHttpError)
    return context.json({ error: { code: error.code, message: error.message } }, error.status);
  if (error instanceof AgentExecutionError) {
    const status =
      error.code === 'execution-not-found'
        ? 404
        : error.code === 'execution-invalid-input'
          ? 400
          : error.code === 'execution-busy' || error.code === 'execution-request-conflict'
            ? 409
            : error.code === 'execution-output-limit'
              ? 413
              : 503;
    return context.json({ error: { code: error.code, message: error.message } }, status);
  }
  if (error instanceof SessionServiceError) {
    const status =
      error.code === 'session-not-found' ? 404 : error.code === 'session-deleted' ? 410 : 409;
    return context.json({ error: { code: error.code, message: error.message } }, status);
  }
  return context.json(
    {
      error: {
        code: 'execution-unavailable',
        message: 'Execution state could not be read; retry the same request',
      },
    },
    503,
  );
}

function encodeFrame(frame: AgentExecutionFrame): Uint8Array {
  const cursor = frame.type === 'snapshot' ? frame.snapshot.cursor : frame.cursor;
  return new TextEncoder().encode(
    `id: ${cursor}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
  );
}

/** One pull consumes at most one frame; HTTP backpressure never owns production. */
export function executionEventStream(
  subscription: AgentExecutionSubscription,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const initial = [...subscription.initial];
  const iterator = subscription.events[Symbol.asyncIterator]();
  let ended = false;
  let pending: Promise<IteratorResult<AgentExecutionFrame>> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const close = () => {
    if (ended) return;
    ended = true;
    if (heartbeat !== undefined) clearTimeout(heartbeat);
    wake?.();
    signal.removeEventListener('abort', abort);
    subscription.close();
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  };
  const abort = () => {
    close();
    try {
      streamController?.close();
    } catch {
      /* disconnected reader */
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(controller) {
        if (ended) return;
        const first = initial.shift();
        if (first !== undefined) {
          controller.enqueue(encodeFrame(first));
          return;
        }
        pending ??= iterator.next();
        try {
          const tick = new Promise<undefined>((resolve) => {
            wake = () => resolve(undefined);
            heartbeat = setTimeout(() => resolve(undefined), 15_000);
            heartbeat.unref?.();
          });
          const next = await Promise.race([pending, tick]);
          if (heartbeat !== undefined) clearTimeout(heartbeat);
          heartbeat = undefined;
          wake = undefined;
          if (ended) return;
          if (next === undefined) {
            controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
            return;
          }
          pending = undefined;
          if (next.done) {
            close();
            controller.close();
            return;
          }
          controller.enqueue(encodeFrame(next.value));
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      cancel() {
        close();
      },
    },
    { highWaterMark: 0 },
  );
}

/** Validation and transport only; execution lifetime belongs to Runtime. */
export function registerAgentExecutionRoutes(app: Hono, options: AgentExecutionAppOptions): void {
  async function serviceFor(
    context: Context,
  ): Promise<{ service: AgentExecutionService; sessionId: string }> {
    const sessionId = z.string().min(1).max(240).safeParse(context.req.param('sessionId'));
    if (!sessionId.success)
      throw new AgentExecutionError('execution-invalid-input', 'Invalid Session identifier');
    const service = options.agentExecutionService;
    if (
      service === undefined ||
      options.sessionService === undefined ||
      options.projectStore === undefined
    ) {
      throw new AgentExecutionError('execution-closed', 'Background execution is unavailable');
    }
    const projects = await options.projectStore.listProjects();
    let attached = false;
    for (const project of projects) {
      if (
        (await options.projectStore.listSessionRefs(project.id)).some(
          (ref) => ref.sessionId === sessionId.data,
        )
      ) {
        attached = true;
        break;
      }
    }
    if (!attached)
      throw new AgentExecutionError('execution-not-found', 'Execution Session was not found');
    // Read existence/deletion, leaving runnable admission to Runtime after idempotent lookup.
    const detail = await options.sessionService.get(sessionId.data);
    if (detail.deletedAt !== undefined)
      throw new AgentExecutionError('execution-not-found', 'Execution Session was not found');
    return { service, sessionId: sessionId.data };
  }
  function executionIdFor(context: Context): string {
    const parsed = z.string().min(1).max(240).safeParse(context.req.param('executionId'));
    if (!parsed.success)
      throw new AgentExecutionError('execution-invalid-input', 'Invalid execution identifier');
    return parsed.data;
  }
  function noQuery(context: Context): void {
    if (new URL(context.req.url).searchParams.size !== 0)
      throw new AgentExecutionError('execution-invalid-input', 'Query parameters are not accepted');
  }
  app.post('/sessions/:sessionId/executions', async (context) => {
    try {
      noQuery(context);
      const parsed = agentExecutionLaunchSchema.safeParse(
        await readExecutionJson(context.req.raw, 20 * 1024 * 1024),
      );
      if (!parsed.success)
        throw new AgentExecutionError('execution-invalid-input', 'Invalid execution input');
      const { service, sessionId } = await serviceFor(context);
      return context.json(await service.launch(sessionId, parsed.data), 202);
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  app.get('/sessions/:sessionId/executions', async (context) => {
    try {
      noQuery(context);
      const { service, sessionId } = await serviceFor(context);
      return context.json(await service.list(sessionId));
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  app.get('/sessions/:sessionId/executions/:executionId', async (context) => {
    try {
      noQuery(context);
      const { service, sessionId } = await serviceFor(context);
      return context.json(await service.get(sessionId, executionIdFor(context)));
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  app.get('/sessions/:sessionId/executions/:executionId/events', async (context) => {
    try {
      const url = new URL(context.req.url);
      if (
        [...url.searchParams.keys()].some((key) => key !== 'after') ||
        url.searchParams.getAll('after').length > 1
      )
        throw new AgentExecutionError('execution-invalid-input', 'Invalid event cursor');
      const query = url.searchParams.get('after') ?? undefined;
      const header = context.req.header('Last-Event-ID');
      if (query !== undefined && header !== undefined && query !== header)
        throw new AgentExecutionError('execution-invalid-input', 'Conflicting event cursors');
      const after = query ?? header;
      if (after !== undefined && !agentExecutionCursorSchema.safeParse(after).success)
        throw new AgentExecutionError('execution-invalid-input', 'Invalid event cursor');
      const { service, sessionId } = await serviceFor(context);
      const subscription = await service.subscribe(sessionId, executionIdFor(context), after);
      return new Response(executionEventStream(subscription, context.req.raw.signal), {
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
  app.post('/sessions/:sessionId/executions/:executionId/cancel', async (context) => {
    try {
      noQuery(context);
      if (
        !z
          .object({})
          .strict()
          .safeParse(await readExecutionJson(context.req.raw, 4096)).success
      )
        throw new AgentExecutionError(
          'execution-invalid-input',
          'Cancel expects an empty JSON object',
        );
      const { service, sessionId } = await serviceFor(context);
      return context.json(await service.cancel(sessionId, executionIdFor(context)), 202);
    } catch (error) {
      return errorResponse(context, error);
    }
  });
}
