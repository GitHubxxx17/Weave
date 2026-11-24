import type { MiddlewareHandler } from 'hono';
import { pluginErrorResponseSchema } from './plugin-management-types.js';

import { isTrustedAuthority } from './local-authority.js';

function parseOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/** Every local management write shares this guard, including future subpaths. */
export function managementWriteGuard(
  studioOrigin?: string,
  trustedHost?: string,
): MiddlewareHandler {
  return async (context, next) => {
    if (
      context.req.method === 'GET' ||
      context.req.method === 'HEAD' ||
      context.req.method === 'OPTIONS'
    ) {
      return next();
    }
    const mediaType = context.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return context.json(
        pluginErrorResponseSchema.parse({
          error: {
            code: 'unsupported-media-type',
            message: 'Local management requires application/json',
          },
        }),
        415,
      );
    }
    const forbidden = () =>
      context.json(
        pluginErrorResponseSchema.parse({
          error: {
            code: 'forbidden-origin',
            message: 'Local management requires a trusted local origin and Host',
          },
        }),
        403,
      );
    if (!isTrustedAuthority(context.req.header('Host') ?? '', trustedHost)) return forbidden();
    if (context.req.header('Sec-Fetch-Site')?.trim().toLowerCase() === 'cross-site')
      return forbidden();
    const origin = context.req.header('Origin');
    if (origin !== undefined) {
      const parsed = parseOrigin(origin);
      if (
        parsed === undefined ||
        (studioOrigin === undefined
          ? !isTrustedAuthority(parsed.host, trustedHost)
          : origin !== studioOrigin)
      )
        return forbidden();
    }
    await next();
  };
}

/** Existing plugin API callers retain the same shared security boundary. */
export const pluginWriteGuard = managementWriteGuard;
