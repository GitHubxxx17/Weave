import { z } from 'zod';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  ApprovalError,
  type ApprovalBroker,
  type ApprovalErrorCode,
  type Runtime,
  type RuntimeService,
} from '@weave/runtime';

const approvalIdSchema = z.string().min(1);
const decisionBodySchema = z
  .object({
    reason: z.string().min(1).max(1000).optional(),
  })
  .strict();

const approvalHttpStatus: Record<ApprovalErrorCode, ContentfulStatusCode> = {
  'approval-invalid-input': 400,
  'approval-not-found': 404,
  'approval-already-resolved': 409,
  'approval-cancelled': 409,
  'approval-expired': 409,
};

/** Runtime service definition used to resolve the server Approval Broker. */
export interface ApprovalAppOptions {
  readonly approvalBrokerService?: RuntimeService<ApprovalBroker> | undefined;
}

function jsonError(
  context: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
): Response {
  return context.json({ error: { code, message } }, status);
}

function serviceUnavailable(context: Context): Response {
  return jsonError(
    context,
    503,
    'approval-service-unavailable',
    'Approval service is not available',
  );
}

function getApprovalBroker(
  context: Context,
  runtime: Runtime,
  service: RuntimeService<ApprovalBroker> | undefined,
): ApprovalBroker | Response {
  if (service === undefined) {
    return serviceUnavailable(context);
  }

  try {
    return runtime.get(service);
  } catch {
    return serviceUnavailable(context);
  }
}

function readApprovalId(context: Context): string | Response {
  const result = approvalIdSchema.safeParse(context.req.param('approvalId'));
  return result.success
    ? result.data
    : jsonError(context, 400, 'approval-invalid-input', 'Approval id is invalid');
}

async function readDecisionReason(
  context: Context,
): Promise<{ readonly success: true; readonly reason: string | undefined } | Response> {
  let bodyText: string;
  try {
    bodyText = await context.req.text();
  } catch {
    return jsonError(context, 400, 'approval-invalid-input', 'Approval request body is invalid');
  }

  if (bodyText.trim() === '') {
    return { success: true, reason: undefined };
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return jsonError(context, 400, 'approval-invalid-input', 'Approval request body is invalid');
  }

  const result = decisionBodySchema.safeParse(body);
  return result.success
    ? { success: true, reason: result.data.reason }
    : jsonError(context, 400, 'approval-invalid-input', 'Approval request body is invalid');
}

function mapApprovalError(context: Context, error: ApprovalError): Response {
  return jsonError(context, approvalHttpStatus[error.code], error.code, error.message);
}

function mapUnexpectedError(context: Context): Response {
  return jsonError(context, 500, 'approval-internal-error', 'Approval request failed');
}

function encodeSseEvent(
  encoder: TextEncoder,
  event: string,
  data: unknown,
): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Mounts the HTTP routes that control the Runtime Approval Broker. */
export function registerApprovalRoutes(
  app: Hono,
  runtime: Runtime,
  options: ApprovalAppOptions,
): void {
  app.get('/approvals', (context: Context) => {
    const broker = getApprovalBroker(context, runtime, options.approvalBrokerService);
    if (broker instanceof Response) {
      return broker;
    }
    return context.json({ approvals: broker.list() }, 200);
  });

  app.get('/approvals/stream', (context: Context) => {
    const broker = getApprovalBroker(context, runtime, options.approvalBrokerService);
    if (broker instanceof Response) {
      return broker;
    }

    const encoder = new TextEncoder();
    const requestSignal = context.req.raw.signal;
    let unsubscribe = (): void => undefined;
    let abortHandler: (() => void) | undefined;
    let cleanedUp = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

    const cleanup = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      unsubscribe();
      unsubscribe = (): void => undefined;
      if (abortHandler !== undefined) {
        requestSignal.removeEventListener('abort', abortHandler);
        abortHandler = undefined;
      }
    };

    const close = (): void => {
      cleanup();
      try {
        streamController?.close();
      } catch {
        // The client may have already cancelled or closed the stream.
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        streamController = controller;
        unsubscribe = broker.subscribe((event) => {
          if (cleanedUp) {
            return;
          }
          try {
            controller.enqueue(encodeSseEvent(encoder, event.type, event.request));
          } catch {
            close();
          }
        });

        abortHandler = () => {
          close();
        };
        requestSignal.addEventListener('abort', abortHandler, { once: true });

        try {
          controller.enqueue(
            encodeSseEvent(encoder, 'approval.snapshot', {
              approvals: broker.list(),
            }),
          );
        } catch {
          close();
        }
      },
      cancel(): void {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      },
    });
  });

  app.get('/approvals/:approvalId', (context: Context) => {
    const broker = getApprovalBroker(context, runtime, options.approvalBrokerService);
    if (broker instanceof Response) {
      return broker;
    }
    const approvalId = readApprovalId(context);
    if (approvalId instanceof Response) {
      return approvalId;
    }

    const request = broker.get(approvalId);
    return request === undefined
      ? jsonError(context, 404, 'approval-not-found', 'Approval request was not found')
      : context.json(request, 200);
  });

  for (const decision of ['approve', 'reject', 'cancel'] as const) {
    app.post(`/approvals/:approvalId/${decision}`, async (context: Context) => {
      const broker = getApprovalBroker(context, runtime, options.approvalBrokerService);
      if (broker instanceof Response) {
        return broker;
      }
      const approvalId = readApprovalId(context);
      if (approvalId instanceof Response) {
        return approvalId;
      }

      const parsedBody = await readDecisionReason(context);
      if (parsedBody instanceof Response) {
        return parsedBody;
      }

      try {
        const request =
          decision === 'approve'
            ? broker.approve(approvalId, parsedBody.reason)
            : decision === 'reject'
              ? broker.reject(approvalId, parsedBody.reason)
              : broker.cancel(approvalId, parsedBody.reason);
        return context.json(request, 200);
      } catch (error: unknown) {
        if (error instanceof ApprovalError) {
          return mapApprovalError(context, error);
        }
        return mapUnexpectedError(context);
      }
    });
  }
}
