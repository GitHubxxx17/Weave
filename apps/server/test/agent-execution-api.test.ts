import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentExecutionError, createRuntime } from '@weave/runtime';
import { createInMemorySessionEventStore } from '@weave/session';
import { createInMemoryProjectStore } from '@weave/workspace';
import { createApp } from '../src/app.js';
import { createSessionService } from '../src/session-service.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(close.splice(0).map((fn) => fn()));
});

const input = {
  userMessage: { role: 'user', content: [{ type: 'text', text: 'continue in background' }] },
  provider: 'mock',
  model: 'test',
  permissionMode: 'ask',
};
const receipt = {
  sessionId: 's1',
  executionId: 'execution-1',
  requestId: 'request-1',
  turnId: 'turn-1',
  userMessageId: 'message-1',
  input,
  status: 'running',
  cursor: 'epoch:execution-1:1',
  createdAt: '2026-11-23T00:00:00.000Z',
  events: [],
};
const queueState = {
  sessionId: 's1',
  revision: 0,
  cursor: 'epoch:s1:0',
  active: null,
  queued: [],
  scheduler: 'ready',
  limits: { sessionQueued: 10, globalQueued: 100 },
};
const headers = { Host: 'localhost', 'Content-Type': 'application/json' };

async function fixture() {
  const runtime = createRuntime();
  await runtime.start();
  close.push(() => runtime.stop());
  const sessionStore = createInMemorySessionEventStore();
  const projectStore = createInMemoryProjectStore();
  close.push(
    () => projectStore.close(),
    () => sessionStore.close(),
  );
  const project = await projectStore.createProject({
    name: 'Background',
    folderName: 'background',
  });
  await sessionStore.append('s1', [{ type: 'session.created', payload: {} }]);
  await projectStore.attachSession(project.id, 's1');
  const sessionService = createSessionService({ projectStore, sessionStore });
  const service = {
    queue: vi.fn(async () => queueState),
    reorderQueue: vi.fn(async () => queueState),
    cancelQueued: vi.fn(async () => queueState),
    subscribeQueue: vi.fn(async () => ({
      initial: [queueState],
      events: {
        async *[Symbol.asyncIterator]() {
          /* terminal fixture */
        },
      },
      close: vi.fn(),
    })),
    launch: vi.fn(async () => receipt),
    list: vi.fn(async () => [{ ...receipt, input: undefined, events: undefined }]),
    get: vi.fn(async () => receipt),
    cancel: vi.fn(async () => ({ ...receipt, status: 'cancelling' })),
    subscribe: vi.fn(async () => ({
      initial: [{ type: 'snapshot', snapshot: receipt }],
      events: {
        async *[Symbol.asyncIterator]() {
          /* empty terminal observer */
        },
      },
      close: vi.fn(),
    })),
    recover: vi.fn(async () => undefined),
    withSessionIdle: vi.fn(async <T>(_id: string, operation: () => Promise<T>) => operation()),
    closeSync: vi.fn(),
    drain: vi.fn(async () => undefined),
  };
  // A transport stub deliberately leaves execution policy to Runtime tests.
  const app = createApp(runtime, {
    sessionService,
    projectStore,
    agentExecutionService: service,
  } as never);
  return { app, service, runtime, sessionService, projectStore };
}

describe('background execution HTTP adapter', () => {
  it.each([
    ['execution-file-too-large', 413],
    ['execution-file-unavailable', 422],
    ['execution-file-invalid-utf8', 422],
    ['execution-file-changed', 409],
    ['execution-file-capture-timeout', 503],
    ['execution-file-capture-failed', 500],
    ['execution-context-unavailable', 422],
    ['execution-context-git-unavailable', 422],
    ['execution-context-capture-failed', 500],
  ] as const)('maps definite capture error %s to HTTP %s', async (code, status) => {
    const { app, service } = await fixture();
    service.launch.mockRejectedValueOnce(new AgentExecutionError(code, 'Safe file capture error'));
    const response = await app.request('/sessions/s1/executions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: 'r', input }),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: 'Safe file capture error' } });
  });

  it('accepts strict execution input without binding the request signal to production', async () => {
    const { app, service } = await fixture();
    const response = await app.request('/sessions/s1/executions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: 'request-1', input }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(receipt);
    expect(service.launch).toHaveBeenCalledWith('s1', { requestId: 'request-1', input });
    expect(service.launch.mock.calls[0]).toHaveLength(2);
  });

  it('rejects untrusted writes before reaching Runtime', async () => {
    const { app, service } = await fixture();
    for (const extra of [
      { Host: 'evil.test' },
      { Origin: 'https://evil.test' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Content-Type': 'text/plain' },
    ]) {
      const response = await app.request('/sessions/s1/executions', {
        method: 'POST',
        headers: { ...headers, ...extra },
        body: JSON.stringify({ requestId: 'r', input }),
      });
      expect([403, 415]).toContain(response.status);
    }
    expect(service.launch).not.toHaveBeenCalled();
  });

  it('rejects internal identities, malformed JSON and unknown request fields', async () => {
    const { app, service } = await fixture();
    for (const body of [
      '{',
      JSON.stringify({ requestId: 'r', input, signal: {} }),
      JSON.stringify({ requestId: 'r', input: { ...input, permissionMode: 'everything' } }),
      JSON.stringify({
        requestId: 'r',
        input: { ...input, executionIdentity: { turnId: 'forged' } },
      }),
    ]) {
      expect(
        (await app.request('/sessions/s1/executions', { method: 'POST', headers, body })).status,
      ).toBe(400);
    }
    expect(service.launch).not.toHaveBeenCalled();
  });

  it('does not expose an unattached Session to list or launch', async () => {
    const { app, service } = await fixture();
    expect((await app.request('/sessions/foreign/executions', { headers })).status).toBe(404);
    expect(
      (
        await app.request('/sessions/foreign/executions', {
          method: 'POST',
          headers,
          body: JSON.stringify({ requestId: 'r', input }),
        })
      ).status,
    ).toBe(404);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.launch).not.toHaveBeenCalled();
  });

  it('reads a live snapshot and streams versioned frames without starting another run', async () => {
    const { app, service } = await fixture();
    const get = await app.request('/sessions/s1/executions/execution-1', { headers });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(receipt);
    const stream = await app.request(
      '/sessions/s1/executions/execution-1/events?after=epoch:execution-1:0',
      { headers },
    );
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(await stream.text()).toContain(
      `event: snapshot\ndata: ${JSON.stringify({ type: 'snapshot', snapshot: receipt })}`,
    );
    expect(service.subscribe).toHaveBeenCalledWith('s1', 'execution-1', 'epoch:execution-1:0');
    expect(service.launch).not.toHaveBeenCalled();
  });

  it('cancels only through an explicit strict JSON control operation', async () => {
    const { app, service } = await fixture();
    const response = await app.request('/sessions/s1/executions/execution-1/cancel', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'cancelling' });
    expect(service.cancel).toHaveBeenCalledWith('s1', 'execution-1');
    expect(
      (
        await app.request('/sessions/s1/executions/execution-1/cancel', {
          method: 'POST',
          headers,
          body: '{"extra":true}',
        })
      ).status,
    ).toBe(400);
  });
});

it('no longer serves the removed legacy stream route', async () => {
  const { app } = await fixture();
  const response = await app.request('/agent/runs/stream', {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId: 's1', ...input }),
  });
  expect(response.status).toBe(404);
});

it('rejects conflicting and malformed cursors before subscribing', async () => {
  const { app, service } = await fixture();
  for (const path of [
    '/sessions/s1/executions/execution-1/events?after=bad',
    '/sessions/s1/executions/execution-1/events?after=epoch:execution-1:0&after=epoch:execution-1:1',
  ])
    expect((await app.request(path, { headers })).status).toBe(400);
  expect(
    (
      await app.request('/sessions/s1/executions/execution-1/events?after=epoch:execution-1:0', {
        headers: { ...headers, 'Last-Event-ID': 'epoch:execution-1:2' },
      })
    ).status,
  ).toBe(400);
  expect(service.subscribe).not.toHaveBeenCalled();
});

it('releases only a subscriber when the HTTP reader disconnects', async () => {
  const { app, service } = await fixture();
  const closed = vi.fn();
  let release!: (result: IteratorResult<never>) => void;
  service.subscribe.mockResolvedValueOnce({
    initial: [{ type: 'snapshot', snapshot: receipt }],
    events: {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<never>>((resolve) => {
              release = resolve;
            }),
        };
      },
    },
    close() {
      closed();
      release?.({ done: true, value: undefined });
    },
  } as never);
  const response = await app.request('/sessions/s1/executions/execution-1/events', { headers });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: snapshot');
  await reader.cancel();
  expect(closed).toHaveBeenCalledOnce();
  expect(service.cancel).not.toHaveBeenCalled();
  expect(service.launch).not.toHaveBeenCalled();
});

it('bounds streamed JSON request bytes and protects CORS preflight before dispatch', async () => {
  const { app, service } = await fixture();
  const huge = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(20 * 1024 * 1024 + 1));
      controller.close();
    },
  });
  expect(
    (
      await app.request('/sessions/s1/executions', {
        method: 'POST',
        headers,
        body: huge,
        duplex: 'half',
      } as RequestInit)
    ).status,
  ).toBe(413);
  expect(
    (
      await app.request('/sessions/s1/executions', {
        method: 'OPTIONS',
        headers: { Host: 'evil.test', Origin: 'https://evil.test' },
      })
    ).status,
  ).toBe(403);
  expect(service.launch).not.toHaveBeenCalled();
});

describe('Session queue HTTP adapter', () => {
  it('serves metadata queue snapshots before dynamic execution ID routes', async () => {
    const { app, service } = await fixture();
    const response = await app.request('/sessions/s1/executions/queue', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(queueState);
    expect(service.queue).toHaveBeenCalledWith('s1');
    expect(service.get).not.toHaveBeenCalled();
  });

  it('streams authoritative queue replacements without launching work', async () => {
    const { app, service } = await fixture();
    const response = await app.request('/sessions/s1/executions/queue/events', { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toBe(
      `id: ${queueState.cursor}\nevent: queue\ndata: ${JSON.stringify(queueState)}\n\n`,
    );
    expect(service.subscribeQueue).toHaveBeenCalledWith('s1');
    expect(service.subscribe).not.toHaveBeenCalled();
    expect(service.launch).not.toHaveBeenCalled();
  });

  it('dispatches versioned reorder and queued cancel controls independently from active Stop', async () => {
    const { app, service } = await fixture();
    const reorder = {
      requestId: 'reorder-1',
      expectedRevision: 3,
      executionIds: ['queued-2', 'queued-1'],
    };
    const cancel = { requestId: 'cancel-1', expectedRevision: 4 };
    for (const [path, body] of [
      ['/sessions/s1/executions/queue/reorder', reorder],
      ['/sessions/s1/executions/queued-1/cancel-queued', cancel],
    ] as const) {
      const response = await app.request(path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(queueState);
    }
    expect(service.reorderQueue).toHaveBeenCalledWith('s1', reorder);
    expect(service.cancelQueued).toHaveBeenCalledWith('s1', 'queued-1', cancel);
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it('validates controls and rejects excess IDs, unknown fields, queries and body bytes', async () => {
    const { app, service } = await fixture();
    for (const body of [
      { requestId: 'r', expectedRevision: -1, executionIds: [] },
      {
        requestId: 'r',
        expectedRevision: 0,
        executionIds: Array.from({ length: 11 }, (_, i) => `q${i}`),
      },
      { requestId: 'r', expectedRevision: 0, executionIds: [], extra: true },
    ])
      expect(
        (
          await app.request('/sessions/s1/executions/queue/reorder', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await app.request('/sessions/s1/executions/queue/reorder', {
          method: 'POST',
          headers,
          body: ' '.repeat(16 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await app.request('/sessions/s1/executions/q/cancel-queued', {
          method: 'POST',
          headers,
          body: ' '.repeat(4097),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await app.request('/sessions/s1/executions/q/cancel-queued', {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status,
    ).toBe(400);
    expect(
      (await app.request('/sessions/s1/executions/queue/events?after=epoch:s1:1', { headers }))
        .status,
    ).toBe(400);
    expect(service.reorderQueue).not.toHaveBeenCalled();
    expect(service.cancelQueued).not.toHaveBeenCalled();
    expect(service.subscribeQueue).not.toHaveBeenCalled();
  });

  it('keeps existing Host/Origin/JSON and Session association guards for queue operations', async () => {
    const { app, service } = await fixture();
    for (const path of [
      '/sessions/s1/executions/queue/reorder',
      '/sessions/s1/executions/q/cancel-queued',
    ]) {
      expect(
        (
          await app.request(path, {
            method: 'POST',
            headers: { ...headers, Origin: 'https://evil.test' },
            body: '{}',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(path, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'text/plain' },
            body: '{}',
          })
        ).status,
      ).toBe(415);
    }
    expect((await app.request('/sessions/foreign/executions/queue', { headers })).status).toBe(404);
    expect(
      (await app.request('/sessions/foreign/executions/queue/events', { headers })).status,
    ).toBe(404);
    expect(service.queue).not.toHaveBeenCalled();
    expect(service.subscribeQueue).not.toHaveBeenCalled();
  });

  it('maps queue capacity, stale revision and claim races to explicit conflicts', async () => {
    const { app, service } = await fixture();
    for (const code of [
      'execution-queue-full',
      'execution-queue-conflict',
      'execution-not-queued',
      'execution-not-active',
    ] as const) {
      service.cancelQueued.mockRejectedValueOnce(
        new AgentExecutionError(code as never, 'conflict'),
      );
      const response = await app.request('/sessions/s1/executions/q/cancel-queued', {
        method: 'POST',
        headers,
        body: JSON.stringify({ requestId: 'r', expectedRevision: 1 }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    expect(service.cancel).not.toHaveBeenCalled();
  });
});

it('closes only the queue subscriber when a metadata SSE reader disconnects', async () => {
  const { app, service } = await fixture();
  const closed = vi.fn();
  let release: ((value: IteratorResult<never>) => void) | undefined;
  service.subscribeQueue.mockResolvedValueOnce({
    initial: [queueState],
    events: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<never>>((resolve) => {
            release = resolve;
          }),
      }),
    },
    close() {
      closed();
      release?.({ done: true, value: undefined });
    },
  } as never);
  const response = await app.request('/sessions/s1/executions/queue/events', { headers });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: queue');
  await reader.cancel();
  expect(closed).toHaveBeenCalledOnce();
  expect(service.cancel).not.toHaveBeenCalled();
  expect(service.cancelQueued).not.toHaveBeenCalled();
  expect(service.launch).not.toHaveBeenCalled();
});

it('distinguishes an ambiguous acceptance from a confirmed blocked Session for identical-request retry', async () => {
  const { app, service } = await fixture();
  service.launch.mockRejectedValueOnce(
    new AgentExecutionError(
      'execution-admission-uncertain' as never,
      'Acceptance outcome is unknown',
    ),
  );
  const response = await app.request('/sessions/s1/executions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ requestId: 'frozen-request', input }),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'execution-admission-uncertain' } });
  expect(service.launch).toHaveBeenCalledWith('s1', { requestId: 'frozen-request', input });
});
