/* global AbortController */
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, extname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { createScenario, scenarioOptionsSchema } from './scenario.mjs';

const optionsSchema = scenarioOptionsSchema.extend({
  intervalMs: z.number().int().min(0).max(100).default(20),
  distDirectory: z.string().min(1).optional(),
});
const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const fixtureError = (code) => ({ error: { code, message: 'Isolated performance fixture' } });
const streamInput = z.object({
  sessionId: z.enum(['benchmark-history', 'benchmark-control']),
  userMessage: z.object({
    role: z.literal('user'),
    content: z
      .array(
        z.object({
          type: z.literal('text'),
          text: z.string().max(10000),
        }),
      )
      .max(1),
  }),
  provider: z.literal('mock'),
  model: z.string().max(100),
});
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

/** Test-only server. Its only disk reads are built Studio assets inside dist. */
export async function startPerformanceFixture(input) {
  const options = optionsSchema.parse(input);
  const scenario = createScenario(options.count, options.variant);
  const dist = resolve(
    options.distDirectory ??
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../studio/dist'),
  );
  const streams = new Set();
  const sockets = new Set();
  let closing;
  const json = (response, data, status = 200) => {
    response.writeHead(status, jsonHeaders);
    response.end(JSON.stringify(data));
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) json(response, fixtureError('benchmark-invalid-request'), 400);
      else response.destroy();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  async function handle(request, response) {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'POST' && path === '/agent/runs/stream') {
      let body = '';
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16384) {
          json(response, fixtureError('benchmark-body-too-large'), 413);
          return;
        }
        body += chunk.toString('utf8');
      }
      const parsed = streamInput.safeParse(JSON.parse(body));
      if (!parsed.success) {
        json(response, fixtureError('benchmark-invalid-input'), 400);
        return;
      }
      const controller = new AbortController();
      streams.add(controller);
      response.once('close', () => controller.abort());
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      response.flushHeaders();
      try {
        for (let index = 0; index < 100; index++) {
          if (controller.signal.aborted) return;
          const text = `benchmark-stream-${String(index).padStart(3, '0')} `;
          response.write(
            `event: text-delta\ndata: ${JSON.stringify({ type: 'text-delta', text })}\n\n`,
          );
          await delay(options.intervalMs, undefined, { signal: controller.signal });
        }
        response.end(
          `event: completed\ndata: ${JSON.stringify({ type: 'completed', turnId: 'benchmark-live' })}\n\n`,
        );
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        streams.delete(controller);
      }
      return;
    }
    if (request.method !== 'GET') {
      json(response, fixtureError('benchmark-not-found'), 404);
      return;
    }
    if (path === '/projects') {
      json(response, { projects: [scenario.project], warnings: [] });
      return;
    }
    const session = scenario.sessions.find((s) => path === `/sessions/${s.id}`);
    if (session) {
      json(response, session);
      return;
    }
    if (path === '/settings/providers') {
      json(response, {
        providers: [
          {
            id: 'mock',
            label: '性能基线',
            type: 'mock',
            defaultModel: 'benchmark',
            hasApiKey: false,
            editable: false,
          },
        ],
        defaultProvider: 'mock',
        canManage: false,
      });
      return;
    }
    if (path === '/plugins') {
      json(response, { plugins: [] });
      return;
    }
    if (path === '/commands') {
      json(response, { commands: [] });
      return;
    }
    if (path === '/plugins/panels') {
      json(response, {
        schemaVersion: 1,
        serverEpoch: 'a'.repeat(32),
        generation: 1,
        authorityEpoch: 1,
        acceptingRuns: true,
        panels: [],
      });
      return;
    }
    if (path === '/approvals') {
      json(response, { approvals: [] });
      return;
    }
    if (path === '/approvals/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      response.write('event: approval.snapshot\ndata: {"approvals":[]}\n\n');
      return;
    }
    if (path === '/mcp' || path === '/plugins/managed') {
      json(
        response,
        fixtureError(path === '/mcp' ? 'mcp-management-disabled' : 'plugin-installer-disabled'),
        404,
      );
      return;
    }
    if (/^\/sessions\/benchmark-(history|control)\/skills$/.test(path)) {
      json(response, { entries: [], complete: true, warnings: [] });
      return;
    }
    if (path === '/' || path.startsWith('/assets/')) {
      try {
        const root = await realpath(dist);
        const candidate = await realpath(
          resolve(root, path === '/' ? 'index.html' : `.${decodeURIComponent(path)}`),
        );
        const rel = relative(root, candidate);
        if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(root, rel) !== candidate)
          throw new Error('outside dist');
        const data = await readFile(candidate);
        response.writeHead(200, {
          'content-type': `${mime[extname(candidate)] ?? 'application/octet-stream'}; charset=utf-8`,
          'cache-control': 'no-store',
        });
        response.end(data);
        return;
      } catch {
        /* Report missing build or invalid path as an ordinary fixture 404. */
      }
    }
    json(response, fixtureError('benchmark-not-found'), 404);
  }
  await new Promise((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListening);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      closing ??= new Promise((resolveClose, reject) => {
        for (const controller of streams) controller.abort();
        server.close((error) => (error ? reject(error) : resolveClose()));
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
