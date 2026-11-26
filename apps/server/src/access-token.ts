import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

/** Cookie that carries the access token after the first `?token=` visit. */
export const accessTokenCookie = 'weave_access_token';
const tokenPattern = /^[A-Za-z0-9._~-]{16,256}$/;

/** Generates a 32-byte random access token encoded as base64url. */
export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Validates an operator-supplied `WEAVE_ACCESS_TOKEN`; the value is never echoed. */
export function parseAccessToken(value: string): string {
  if (!tokenPattern.test(value)) {
    throw new Error(
      'WEAVE_ACCESS_TOKEN must be 16 to 256 characters from A-Z, a-z, 0-9, ".", "_", "~" and "-"',
    );
  }
  return value;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function matches(expected: Buffer, candidate: string | undefined): boolean {
  // Hashing first gives equal-length buffers, so the comparison is constant time
  // regardless of the candidate length.
  return candidate !== undefined && timingSafeEqual(expected, digest(candidate));
}

function unauthorized(context: Parameters<Parameters<Hono['use']>[1]>[0]) {
  context.header('Cache-Control', 'no-store');
  context.header('WWW-Authenticate', 'Bearer');
  return context.json(
    {
      error: {
        code: 'access-token-required',
        message: 'A valid access token is required',
      },
    },
    401,
  );
}

/**
 * Requires the access token on every request except `/health`.
 *
 * Accepted credentials: the `weave_access_token` cookie or an
 * `Authorization: Bearer` header. A page request carrying `?token=` is
 * exchanged for the cookie and redirected to the same URL without the token, so
 * the token does not stay in the address bar or the history entry.
 */
export function registerAccessTokenGuard(app: Hono, token: string): void {
  const expected = digest(token);
  app.use('*', async (context, next) => {
    if (context.req.path === '/health') return next();

    const url = new URL(context.req.url);
    const queryToken = url.searchParams.get('token');
    if (queryToken !== null && (context.req.method === 'GET' || context.req.method === 'HEAD')) {
      if (!matches(expected, queryToken)) return unauthorized(context);
      url.searchParams.delete('token');
      setCookie(context, accessTokenCookie, token, {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
      });
      context.header('Cache-Control', 'no-store');
      context.header('Referrer-Policy', 'no-referrer');
      return context.redirect(`${url.pathname.replace(/^\/+/, '/')}${url.search}`, 302);
    }

    const authorization = context.req.header('Authorization');
    const bearer = /^Bearer (\S+)$/i.exec(authorization ?? '')?.[1];
    if (matches(expected, bearer) || matches(expected, getCookie(context, accessTokenCookie))) {
      return next();
    }
    return unauthorized(context);
  });
}
