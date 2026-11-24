import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, extname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  AgentExecutionError,
  agentExecutionLaunchSchema,
  createAgentExecutionService,
} from '@weave/runtime';
import { createInMemorySessionEventStore, projectSession } from '@weave/session';
import { createScenario, scenarioOptionsSchema } from './scenario.mjs';

const optionsSchema = scenarioOptionsSchema.extend({
  streamVariant: z.enum(['text', 'tools']).default('text'),
  intervalMs: z.number().int().min(0).max(100).default(20),
  distDirectory: z.string().min(1).optional(),
});
const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const fixtureError = (code) => ({ error: { code, message: 'Isolated performance fixture' } });
const launchInput = agentExecutionLaunchSchema.refine(
  ({ input }) =>
    input.provider === 'mock' &&
    input.model.length <= 100 &&
    input.userMessage.content.length <= 1 &&
    input.userMessage.content.every((part) => part.type === 'text' && part.text.length <= 10000),
  'Use the bounded benchmark workload',
);
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
  const store = createInMemorySessionEventStore();
  for (const session of scenario.sessions)
    await store.append(session.id, [
      { type: 'session.created', payload: { title: session.title } },
    ]);
  // Exercise the actual ownership/replay boundary without a real provider or
  // workspace. Only the existing 100 paced text deltas make up the workload.
  const executions = createAgentExecutionService({
    sessionStore: store,
    admit: async (sessionId) => {
      if (!scenario.sessions.some((session) => session.id === sessionId))
        throw new AgentExecutionError('execution-not-found', 'Unknown benchmark Session');
    },
    runner: {
      run(request) {
        return {
          async *[Symbol.asyncIterator]() {
            const { turnId, userMessageId, executionId } = request.executionIdentity;
            await store.append(request.sessionId, [
              {
                type: 'message.created',
                payload: { messageId: userMessageId, message: request.userMessage },
              },
              { type: 'turn.started', payload: { turnId, userMessageId, executionId } },
            ]);
            let text = '';
            let failure;
            try {
              for (let index = 0; index < 100; index++) {
                request.signal.throwIfAborted();
                const token = `benchmark-stream-${String(index).padStart(3, '0')} `;
                text += token;
                yield { type: 'text-delta', text: token };
                await delay(options.intervalMs, undefined, { signal: request.signal });
              }
            } catch (error) {
              failure = error;
            }
            const status = request.signal.aborted ? 'cancelled' : failure ? 'failed' : 'completed';
            await store.append(request.sessionId, [
              ...(text
                ? [
                    {
                      type: 'message.created',
                      payload: {
                        messageId: `${turnId}-assistant`,
                        message: { role: 'assistant', content: [{ type: 'text', text }] },
                      },
                    },
                  ]
                : []),
              { type: 'turn.completed', payload: { turnId, status } },
            ]);
            if (failure) throw failure;
            yield { type: 'completed', turnId };
          },
        };
      },
    },
  });
  const sockets = new Set();
  let closing;
  const json = (response, data, status = 200) => {
    response.writeHead(status, jsonHeaders);
    response.end(JSON.stringify(data));
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (!response.headersSent)
        json(
          response,
          fixtureError(
            error instanceof AgentExecutionError ? error.code : 'benchmark-invalid-request',
          ),
          error instanceof AgentExecutionError
            ? error.code === 'execution-not-found'
              ? 404
              : ['execution-busy', 'execution-request-conflict'].includes(error.code)
                ? 409
                : 400
            : 400,
        );
      else response.destroy();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const queueRoute =
      /^\/sessions\/(benchmark-(?:history|control))\/executions\/queue(?:\/(events))?$/.exec(path);
    if (queueRoute && request.method === 'GET') {
      const [, sessionId, action] = queueRoute;
      if (action !== 'events') {
        json(response, await executions.queue(sessionId));
        return;
      }
      const subscription = await executions.subscribeQueue(sessionId);
      response.once('close', subscription.close);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      response.flushHeaders();
      const write = async (snapshot) => {
        if (response.destroyed) return;
        if (
          !response.write(
            `id: ${snapshot.cursor}\nevent: queue\ndata: ${JSON.stringify(snapshot)}\n\n`,
          )
        )
          await Promise.race([once(response, 'drain'), once(response, 'close')]);
      };
      try {
        for (const snapshot of subscription.initial) await write(snapshot);
        for await (const snapshot of subscription.events) {
          if (response.destroyed) break;
          await write(snapshot);
        }
        response.end();
      } finally {
        subscription.close();
      }
      return;
    }
    const executionRoute =
      /^\/sessions\/(benchmark-(?:history|control))\/executions(?:\/([^/]+)(?:\/(events|cancel))?)?$/.exec(
        path,
      );
    if (executionRoute) {
      const [, sessionId, executionId, action] = executionRoute;
      if (request.method === 'GET' && action === 'events') {
        const subscription = await executions.subscribe(
          sessionId,
          executionId,
          url.searchParams.get('after') ?? request.headers['last-event-id'],
        );
        response.once('close', subscription.close);
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
        });
        response.flushHeaders();
        const write = async (frame) => {
          if (response.destroyed) return;
          const cursor = frame.type === 'snapshot' ? frame.snapshot.cursor : frame.cursor;
          if (
            !response.write(
              `id: ${cursor}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
            )
          )
            await Promise.race([once(response, 'drain'), once(response, 'close')]);
        };
        try {
          for (const frame of subscription.initial) await write(frame);
          for await (const frame of subscription.events) {
            if (response.destroyed) break;
            await write(frame);
          }
          response.end();
        } finally {
          subscription.close();
        }
        return;
      }
      if (request.method === 'GET' && !action) {
        json(
          response,
          executionId
            ? await executions.get(sessionId, executionId)
            : await executions.list(sessionId),
        );
        return;
      }
      if (request.method !== 'POST' || (executionId && action !== 'cancel')) {
        json(response, fixtureError('benchmark-not-found'), 404);
        return;
      }
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
      const parsed = (action === 'cancel' ? z.strictObject({}) : launchInput).safeParse(
        JSON.parse(body),
      );
      if (!parsed.success) {
        json(response, fixtureError('benchmark-invalid-input'), 400);
        return;
      }
      json(
        response,
        action === 'cancel'
          ? await executions.cancel(sessionId, executionId)
          : await executions.launch(sessionId, parsed.data),
        202,
      );
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
      const projection = projectSession(await store.read(session.id));
      json(response, {
        ...session,
        lastSequence: session.lastSequence + projection.lastSequence - 1,
        messages: [
          ...session.messages,
          ...projection.messages.map(({ message, sequence, ...metadata }) => ({
            ...message,
            ...metadata,
            sequence: session.lastSequence + sequence - 1,
          })),
        ],
        turns: [
          ...session.turns,
          ...projection.turns.map((turn) => ({
            ...turn,
            provider: 'mock',
            model: 'benchmark',
            modelSteps: [],
            toolCalls: 0,
            failedToolCalls: 0,
            toolResults: [],
          })),
        ],
      });
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
    metadata: {
      logicalMessageCount: options.count,
      rawHistoryRecordCount: scenario.sessions[0].messages.length,
      historyBytes: Buffer.byteLength(JSON.stringify(scenario.sessions[0])),
      fixtureHash: createHash('sha256').update(JSON.stringify(scenario)).digest('hex'),
      executionApiMode: 'agent-execution-service',
    },
    async close() {
      closing ??= (async () => {
        executions.closeSync();
        await executions.drain();
        await new Promise((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
          for (const socket of sockets) socket.destroy();
        });
        await store.close();
      })();
      return closing;
    },
  };
}
