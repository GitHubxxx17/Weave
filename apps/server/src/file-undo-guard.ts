import type { Hono, MiddlewareHandler } from 'hono';
import { FileUndoError } from '@weave/runtime';
import { isTrustedAuthority } from './local-authority.js';
function guard(studioOrigin?: string, trustedHost?: string): MiddlewareHandler {
  return async (context, next) => {
    context.header('Cache-Control', 'no-store');
    let allowed =
      isTrustedAuthority(context.req.header('Host') ?? '', trustedHost) &&
      context.req.header('Sec-Fetch-Site')?.trim().toLowerCase() !== 'cross-site';
    const origin = context.req.header('Origin');
    if (origin !== undefined) {
      try {
        const url = new URL(origin);
        allowed &&=
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.origin === origin &&
          (studioOrigin === undefined
            ? isTrustedAuthority(url.host, trustedHost)
            : origin === studioOrigin);
      } catch {
        allowed = false;
      }
    }
    if (!allowed)
      return context.json(
        {
          error: {
            code: 'undo-request-forbidden',
            message: 'File undo requires a trusted local origin and Host',
          },
        },
        403,
      );
    if (context.req.method === 'OPTIONS') {
      if (studioOrigin !== undefined) {
        context.header('Access-Control-Allow-Origin', studioOrigin);
        context.header('Access-Control-Allow-Methods', 'GET,POST,HEAD,OPTIONS');
        context.header('Access-Control-Allow-Headers', 'Content-Type');
        context.header('Vary', 'Origin');
      }
      return context.body(null, 204);
    }
    if (
      context.req.method === 'POST' &&
      context.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !==
        'application/json'
    )
      return context.json(
        {
          error: {
            code: 'undo-unsupported-media-type',
            message: 'File undo requires application/json',
          },
        },
        415,
      );
    return next();
  };
}
/** Must precede global CORS so OPTIONS cannot skip local admission. */
export function registerFileUndoGuards(
  app: Hono,
  options: {
    readonly studioOrigin?: string | undefined;
    readonly trustedHost?: string | undefined;
  },
) {
  for (const path of [
    '/projects/:projectId/sessions/:sessionId/undo',
    '/projects/:projectId/sessions/:sessionId/file-undo',
  ])
    app.use(path, guard(options.studioOrigin, options.trustedHost));
}
export async function readFileUndoRequest(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (reader === undefined)
    throw new FileUndoError('undo-invalid-input', 'Request body is required');
  const body = new Uint8Array(4096);
  let count = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      if (value.value.byteLength > body.byteLength - count) {
        void reader.cancel().catch(() => undefined);
        throw new FileUndoError('undo-request-too-large', 'File undo request exceeds 4096 bytes');
      }
      body.set(value.value, count);
      count += value.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, count)),
    ) as unknown;
  } catch {
    throw new FileUndoError('undo-invalid-input', 'Request body must be UTF-8 JSON');
  }
}
