import { realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { Hono } from 'hono';

const contentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Studio loads only same-origin resources. `wasm-unsafe-eval` is required by the
 * syntax highlighter's WebAssembly grammar engine; inline styles come from
 * React style attributes.
 */
export const studioContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': studioContentSecurityPolicy,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

async function readableFile(root: string, relative: string): Promise<string | undefined> {
  const candidate = resolve(root, `.${sep}${relative}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) return undefined;
  try {
    // Resolve symlinks so a link inside the directory cannot escape it.
    const real = await realpath(candidate);
    if (real !== root && !real.startsWith(root + sep)) return undefined;
    return (await stat(real)).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Serves the Studio `vite build` output for every GET/HEAD request that no API
 * route handled. Paths without a file extension that match no file fall back to
 * `index.html` so client-side routes survive a reload; a missing asset (a path
 * with an extension) is a 404. Register this after every API route.
 */
export function registerStudioStatic(app: Hono, directory: string): void {
  const root = realpathSync(resolve(directory));
  app.get('*', async (context) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(context.req.path);
    } catch {
      return context.text('Bad Request', 400, securityHeaders());
    }
    if (pathname.includes('\0')) return context.text('Bad Request', 400, securityHeaders());

    const relative = pathname.replace(/^\/+/, '');
    let file = relative === '' ? undefined : await readableFile(root, relative);
    const isAsset = extname(relative) !== '';
    if (file === undefined && !isAsset) file = await readableFile(root, 'index.html');
    if (file === undefined) {
      return context.text('Not Found', 404, { ...securityHeaders(), 'Cache-Control': 'no-store' });
    }

    const body = await readFile(file);
    const isIndex = file === join(root, 'index.html');
    return context.body(new Uint8Array(body), 200, {
      ...securityHeaders(),
      'Content-Type': contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': isIndex
        ? 'no-cache'
        : file.startsWith(join(root, 'assets') + sep)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
    });
  });
}
