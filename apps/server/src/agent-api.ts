import { z } from 'zod';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { skillRefsSchema, userMessageSchema } from '@weave/protocol';
import {
  AgentRunError,
  ToolExecutionError,
  toolPermissionModeSchema,
  type AgentRunner,
  type AgentExecutionService,
  type AgentRuntimeEvent,
  type Runtime,
} from '@weave/runtime';
import { SessionServiceError, type SessionService } from './session-service.js';

const agentHttpRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    userMessage: userMessageSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().finite().nonnegative().optional(),
    maxTokens: z.number().finite().nonnegative().optional(),
    reasoningEffort: z.string().min(1).optional(),
    permissionMode: toolPermissionModeSchema.optional(),
    skills: skillRefsSchema.optional(),
    useProviderDefaults: z.boolean().optional(),
  })
  .strict();

/** Runtime dependency injected into the Agent HTTP adapter. */
export interface AgentAppOptions {
  readonly agentRunner?: AgentRunner | undefined;
  readonly agentExecutionService?: AgentExecutionService | undefined;
  readonly sessionService?: SessionService | undefined;
}

function jsonError(
  context: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
): Response {
  return context.json({ error: { code, message } }, status);
}

async function readAgentRequest(
  context: Context,
): Promise<
  { readonly success: true; readonly value: z.infer<typeof agentHttpRequestSchema> } | Response
> {
  let bodyText: string;
  try {
    bodyText = await context.req.text();
  } catch {
    return jsonError(context, 400, 'agent-invalid-input', 'Agent request body is invalid');
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return jsonError(context, 400, 'agent-invalid-input', 'Agent request body is invalid');
  }

  const result = agentHttpRequestSchema.safeParse(body);
  if (!result.success) {
    return jsonError(context, 400, 'agent-invalid-input', 'Agent request body is invalid');
  }

  return { success: true, value: result.data };
}

function getAgentRunner(context: Context, options: AgentAppOptions): AgentRunner | Response {
  if (options.agentRunner === undefined) {
    return jsonError(context, 503, 'agent-service-unavailable', 'Agent service is not available');
  }
  return options.agentRunner;
}

function sessionErrorStatus(code: SessionServiceError['code']): 404 | 409 | 410 | 422 {
  if (code === 'session-not-found') {
    return 404;
  }
  if (code === 'session-projection-invalid') {
    return 422;
  }
  return code === 'session-deleted' ? 410 : 409;
}

function encodeSseEvent(encoder: TextEncoder, event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function mapAgentError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof AgentRunError || error instanceof ToolExecutionError) {
    return { code: error.code, message: error.message };
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return { code: error.code, message: error.message };
  }

  return {
    code: 'agent-internal-error',
    message: 'Agent run failed',
  };
}

function createAgentEventStream(
  runner: AgentRunner,
  request: z.infer<typeof agentHttpRequestSchema>,
  requestSignal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let iterator: AsyncIterator<AgentRuntimeEvent> | undefined;
  let abortHandler: (() => void) | undefined;
  let cleanedUp = false;
  let stopRequested = false;
  let iteratorReturnCalled = false;

  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    if (abortHandler !== undefined) {
      requestSignal.removeEventListener('abort', abortHandler);
      abortHandler = undefined;
    }
  };

  const close = (): void => {
    try {
      controller?.close();
    } catch {
      // The client may have cancelled or closed the stream already.
    }
  };

  const returnIterator = (): void => {
    if (iteratorReturnCalled || iterator?.return === undefined) {
      return;
    }
    iteratorReturnCalled = true;
    void Promise.resolve(iterator.return()).catch(() => undefined);
  };

  const stop = (): void => {
    stopRequested = true;
    cleanup();
    returnIterator();
    close();
  };

  const emitError = (error: unknown): void => {
    if (cleanedUp) {
      return;
    }
    try {
      controller?.enqueue(encodeSseEvent(encoder, 'error', { error: mapAgentError(error) }));
    } catch {
      // The client may have cancelled while the error was being encoded.
    }
  };

  const pump = async (): Promise<void> => {
    try {
      const iterable = runner.run({
        ...request,
        signal: requestSignal,
      });
      iterator = iterable[Symbol.asyncIterator]();

      if (stopRequested || requestSignal.aborted) {
        stop();
        return;
      }

      while (!stopRequested) {
        const result = await iterator.next();
        if (result.done) {
          break;
        }

        try {
          controller?.enqueue(encodeSseEvent(encoder, result.value.type, result.value));
        } catch {
          stop();
          return;
        }
      }

      if (!stopRequested) {
        cleanup();
        close();
      }
    } catch (error: unknown) {
      emitError(error);
      stop();
    }
  };

  return new ReadableStream<Uint8Array>({
    start(streamController): void {
      controller = streamController;
      abortHandler = () => {
        stop();
      };
      requestSignal.addEventListener('abort', abortHandler, { once: true });
      void pump();
    },
    cancel(): void {
      stop();
    },
  });
}

/** Mounts the HTTP route that exposes one Agent turn as an SSE stream. */
export function registerAgentRoutes(app: Hono, _runtime: Runtime, options: AgentAppOptions): void {
  app.post('/agent/runs/stream', async (context: Context) => {
    if (options.agentExecutionService !== undefined) {
      return jsonError(
        context,
        409,
        'execution-use-control-api',
        'Use the durable execution control API',
      );
    }
    const parsedBody = await readAgentRequest(context);
    if (parsedBody instanceof Response) {
      return parsedBody;
    }

    const runner = getAgentRunner(context, options);
    if (runner instanceof Response) {
      return runner;
    }
    if (options.sessionService === undefined) {
      return jsonError(
        context,
        503,
        'session-service-unavailable',
        'Session service is not available',
      );
    }
    try {
      await options.sessionService.assertRunnable(parsedBody.value.sessionId);
    } catch (error) {
      if (error instanceof SessionServiceError) {
        return jsonError(context, sessionErrorStatus(error.code), error.code, error.message);
      }
      return jsonError(context, 500, 'server-internal-error', 'Agent request failed');
    }

    const stream = createAgentEventStream(runner, parsedBody.value, context.req.raw.signal);
    return new Response(stream, {
      headers: {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      },
    });
  });
}
