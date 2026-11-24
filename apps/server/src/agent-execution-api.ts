import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  AgentExecutionError,
  AgentTaskError,
  agentExecutionCursorSchema,
  agentExecutionLaunchSchema,
  agentExecutionQueueReorderSchema,
  agentExecutionQueuedCancelSchema,
  type AgentExecutionFrame,
  type AgentExecutionService,
  type AgentExecutionSubscription,
} from '@weave/runtime';
import type { ProjectStore } from '@weave/workspace';
import { detachedEventStream } from './detached-event-stream.js';
import { ExecutionHttpError, readExecutionJson } from './agent-execution-guard.js';
import {
  agentTaskErrorResponse,
  resolveAgentTaskRoot,
  type AgentTaskAppOptions,
} from './agent-task-api.js';
import { SessionServiceError, type SessionDetail, type SessionService } from './session-service.js';

export interface AgentExecutionAppOptions {
  readonly agentExecutionService?: AgentExecutionService | undefined;
  readonly sessionService?: SessionService | undefined;
  readonly projectStore?: ProjectStore | undefined;
  readonly agentTaskService?: AgentTaskAppOptions['agentTaskService'];
}

function errorResponse(context: Context, error: unknown): Response {
  if (error instanceof ExecutionHttpError)
    return context.json({ error: { code: error.code, message: error.message } }, error.status);
  if (error instanceof AgentTaskError) return agentTaskErrorResponse(context, error);
  if (error instanceof AgentExecutionError) {
    const status =
      error.code === 'execution-not-found'
        ? 404
        : error.code === 'execution-invalid-input'
          ? 400
          : [
                'execution-busy',
                'execution-request-conflict',
                'execution-queue-full',
                'execution-queue-conflict',
                'execution-not-queued',
                'execution-not-active',
                'execution-task-session-read-only',
                'execution-file-changed',
              ].includes(error.code)
            ? 409
            : error.code === 'execution-output-limit' || error.code === 'execution-file-too-large'
              ? 413
              : error.code === 'execution-file-unavailable' ||
                  error.code === 'execution-file-invalid-utf8' ||
                  error.code === 'execution-context-unavailable' ||
                  error.code === 'execution-context-git-unavailable'
                ? 422
                : error.code === 'execution-file-capture-failed' ||
                    error.code === 'execution-context-capture-failed'
                  ? 500
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
  return detachedEventStream(subscription, signal, encodeFrame);
}

/** Validation and transport only; execution lifetime belongs to Runtime. */
export function registerAgentExecutionRoutes(app: Hono, options: AgentExecutionAppOptions): void {
  async function serviceFor(
    context: Context,
  ): Promise<{ service: AgentExecutionService; sessionId: string; detail: SessionDetail }> {
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
    return { service, sessionId: sessionId.data, detail };
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
  app.get('/sessions/:sessionId/executions/queue', async (context) => {
    try {
      noQuery(context);
      const { service, sessionId } = await serviceFor(context);
      return context.json(await service.queue(sessionId));
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  app.get('/sessions/:sessionId/executions/queue/events', async (context) => {
    try {
      noQuery(context);
      const { service, sessionId } = await serviceFor(context);
      const subscription = await service.subscribeQueue(sessionId);
      return new Response(
        detachedEventStream(subscription, context.req.raw.signal, (snapshot) =>
          new TextEncoder().encode(
            `id: ${snapshot.cursor}\nevent: queue\ndata: ${JSON.stringify(snapshot)}\n\n`,
          ),
        ),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        },
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  app.post('/sessions/:sessionId/executions/queue/reorder', async (context) => {
    try {
      noQuery(context);
      const parsed = agentExecutionQueueReorderSchema.safeParse(
        await readExecutionJson(context.req.raw, 16 * 1024),
      );
      if (!parsed.success)
        throw new AgentExecutionError('execution-invalid-input', 'Invalid queue reorder');
      const { service, sessionId } = await serviceFor(context);
      return context.json(await service.reorderQueue(sessionId, parsed.data));
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  app.post('/sessions/:sessionId/executions/:executionId/cancel-queued', async (context) => {
    try {
      noQuery(context);
      const parsed = agentExecutionQueuedCancelSchema.safeParse(
        await readExecutionJson(context.req.raw, 4096),
      );
      if (!parsed.success)
        throw new AgentExecutionError('execution-invalid-input', 'Invalid queued cancellation');
      const { service, sessionId } = await serviceFor(context);
      return context.json(
        await service.cancelQueued(sessionId, executionIdFor(context), parsed.data),
      );
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
      const { service, sessionId, detail } = await serviceFor(context);
      const executionId = executionIdFor(context);
      const tasks = options.agentTaskService;
      const { taskOrigin } = detail;
      if (tasks === undefined) {
        if (taskOrigin !== undefined)
          throw new AgentTaskError('agent-task-closed', 'Agent task control is unavailable');
        return context.json(await service.cancel(sessionId, executionId), 202);
      }

      const execution = await service.get(sessionId, executionId);
      // Hash the existing identity so retry IDs remain bounded even for legacy IDs.
      const operationId = `execution-stop:${createHash('sha256')
        .update(JSON.stringify([sessionId, executionId]))
        .digest('hex')}`;
      const root = await resolveAgentTaskRoot(
        detail,
        options.sessionService!,
        options.projectStore!,
      );
      if (taskOrigin !== undefined) {
        const task = tasks.snapshot(root).find(({ taskId }) => taskId === taskOrigin.taskId);
        if (
          task?.childSessionId !== sessionId ||
          task.childExecutionId !== executionId ||
          task.childTurnId !== execution.turnId
        )
          throw new AgentExecutionError('execution-not-found', 'Task execution was not found');
        await tasks.requestCancel(root, [taskOrigin.taskId], operationId, 'task-cancelled');
        return context.json(await service.get(sessionId, executionId), 202);
      }
      if (execution.status === 'queued')
        throw new AgentExecutionError(
          'execution-not-active',
          'Queued execution requires explicit queue cancellation',
        );
      await tasks.stopParentTurn(root, execution.turnId, operationId);
      return context.json(await service.cancel(sessionId, executionId), 202);
    } catch (error) {
      return errorResponse(context, error);
    }
  });
}
