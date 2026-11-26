import type { Hono, MiddlewareHandler } from 'hono';

import { isTrustedAuthority } from './local-authority.js';

export class ExecutionHttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 413 | 415,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Runs before CORS so preflight cannot skip local control-plane admission. */
export function registerAgentExecutionGuards(
  app: Hono,
  studioOrigin?: string,
  prefixes: readonly string[] = [
    '/sessions/:sessionId/executions',
    '/sessions/:sessionId/executions/*',
  ],
  errors = {
    forbidden: {
      code: 'execution-request-forbidden',
      message: 'Execution control requires a trusted local Host and Origin',
    },
    contentType: {
      code: 'execution-unsupported-media-type',
      message: 'Execution control requires application/json',
    },
  },
  trustedHost?: string,
): void {
  const guard: MiddlewareHandler = async (context, next) => {
    context.header('Cache-Control', 'no-store');
    let allowed =
      isTrustedAuthority(context.req.header('Host') ?? '', trustedHost) &&
      context.req.header('Sec-Fetch-Site')?.trim().toLowerCase() !== 'cross-site';
    const origin = context.req.header('Origin');
    if (origin !== undefined) {
      try {
        const value = new URL(origin);
        allowed &&=
          (value.protocol === 'http:' || value.protocol === 'https:') &&
          value.origin === origin &&
          (studioOrigin === undefined
            ? isTrustedAuthority(value.host, trustedHost)
            : origin === studioOrigin);
      } catch {
        allowed = false;
      }
    }
    if (!allowed) return context.json({ error: errors.forbidden }, 403);
    if (context.req.method === 'OPTIONS') {
      if (studioOrigin !== undefined) context.header('Access-Control-Allow-Origin', studioOrigin);
      context.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      context.header('Access-Control-Allow-Headers', 'Content-Type,Last-Event-ID');
      context.header('Vary', 'Origin');
      return context.body(null, 204);
    }
    if (
      context.req.method === 'POST' &&
      context.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !==
        'application/json'
    ) {
      return context.json({ error: errors.contentType }, 415);
    }
    return next();
  };
  for (const prefix of prefixes) app.use(prefix, guard);
}

export async function readExecutionJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new ExecutionHttpError(
      413,
      'execution-request-too-large',
      'Execution input exceeds the request limit',
    );
  }
  const reader = request.body?.getReader();
  if (reader === undefined)
    throw new ExecutionHttpError(400, 'execution-invalid-input', 'JSON body is required');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ExecutionHttpError(
          413,
          'execution-request-too-large',
          'Execution input exceeds the request limit',
        );
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new ExecutionHttpError(400, 'execution-invalid-input', 'Request body must be UTF-8 JSON');
  }
}
