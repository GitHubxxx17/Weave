import type { Hono, MiddlewareHandler } from 'hono';
import { isTrustedAuthority } from './local-authority.js';

const bodyMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const managedWritePrefixes = ['/plugins', '/mcp'];

function owns(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

function requestHost(context: Parameters<MiddlewareHandler>[0]): string {
  const header = context.req.header('Host');
  if (header !== undefined) return header;
  // In-memory `app.request()` calls carry no Host header; fall back to the URL.
  try {
    return new URL(context.req.url).host;
  } catch {
    return '';
  }
}

function hasRequestBody(context: Parameters<MiddlewareHandler>[0]): boolean {
  const length = context.req.header('Content-Length');
  if (length !== undefined && length.trim() !== '0') return true;
  return context.req.header('Transfer-Encoding') !== undefined;
}

/**
 * Registers the global local-control-plane admission guard.
 *
 * It runs before every route and before CORS so DNS-rebinding, cross-site and
 * simple-form (`text/plain`) requests are rejected for every path, not only for
 * families that registered a path guard. `/health` stays open for liveness
 * probes. Path guards keep their own, more specific error codes.
 */
export function registerLocalRequestGuard(
  app: Hono,
  studioOrigin?: string,
  trustedHost?: string,
): void {
  const guard: MiddlewareHandler = async (context, next) => {
    if (context.req.path === '/health') return next();
    // Plugin and MCP management mount `managementWriteGuard` on every write
    // under these prefixes with equivalent checks and their own error codes.
    if (
      bodyMethods.has(context.req.method) &&
      managedWritePrefixes.some((p) => owns(context.req.path, p))
    ) {
      return next();
    }

    let allowed =
      isTrustedAuthority(requestHost(context), trustedHost) &&
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
    if (!allowed) {
      context.header('Cache-Control', 'no-store');
      return context.json(
        {
          error: {
            code: 'local-request-forbidden',
            message: 'The local control plane requires a trusted local Host and Origin',
          },
        },
        403,
      );
    }

    if (bodyMethods.has(context.req.method)) {
      const contentType = context.req.header('Content-Type');
      const json = contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
      if (!json && (contentType !== undefined || hasRequestBody(context))) {
        context.header('Cache-Control', 'no-store');
        return context.json(
          {
            error: {
              code: 'local-request-unsupported-media-type',
              message: 'The local control plane requires application/json request bodies',
            },
          },
          415,
        );
      }
    }
    return next();
  };
  app.use('*', guard);
}
