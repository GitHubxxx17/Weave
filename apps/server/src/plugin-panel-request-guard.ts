import type { MiddlewareHandler } from 'hono';
import { PanelError, panelErrorBody } from './plugin-panel-errors.js';
const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/;
function local(value: string) {
  const match = loopback.exec(value);
  return match !== null && (match[2] === undefined || Number(match[2]) <= 65535);
}
export function panelRequestGuard(studioOrigin?: string): MiddlewareHandler {
  return async (context, next) => {
    context.header('Cache-Control', 'no-store');
    let allowed =
      local(context.req.header('Host') ?? '') &&
      context.req.header('Sec-Fetch-Site')?.trim().toLowerCase() !== 'cross-site';
    const origin = context.req.header('Origin');
    if (origin !== undefined) {
      try {
        const parsed = new URL(origin);
        allowed &&=
          (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
          parsed.origin === origin &&
          (studioOrigin === undefined ? local(parsed.host) : studioOrigin === origin);
      } catch {
        allowed = false;
      }
    }
    if (!allowed) {
      const { body, status } = panelErrorBody(new PanelError('panel-request-forbidden'));
      return context.req.method === 'HEAD' || context.req.method === 'OPTIONS'
        ? context.body(null, status)
        : context.json(body, status);
    }
    if (context.req.method === 'OPTIONS') {
      // This guard precedes Hono CORS so rejected requests are also no-store.
      // Complete the same bounded preflight here without exposing panel data.
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
    ) {
      const { body, status } = panelErrorBody(new PanelError('panel-invalid-input'));
      return context.json(body, status);
    }
    await next();
  };
}
export async function readPanelRequest(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new PanelError('panel-invalid-input');
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      bytes += value.value.byteLength;
      if (bytes > 16384) {
        void reader.cancel().catch(() => undefined);
        throw new PanelError('panel-request-too-large');
      }
      chunks.push(value.value);
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)) as unknown;
    } catch {
      throw new PanelError('panel-invalid-input');
    }
  } finally {
    reader.releaseLock();
  }
}
