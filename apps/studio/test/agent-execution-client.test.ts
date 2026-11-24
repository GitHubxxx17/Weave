import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchAndObserveAgentExecution as streamAgentRun } from '../src/features/agent/agent-stream.js';
import {
  cancelAgentExecution,
  observeAgentExecution,
} from '../src/features/agent/agent-execution-client.js';
import type { AgentExecutionSnapshot } from '../src/features/agent/agent-execution-types.js';

const input = {
  sessionId: 'session-1',
  userMessage: { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] },
  provider: 'test',
  model: 'slow',
};
const snapshot: AgentExecutionSnapshot = {
  executionId: 'execution-1',
  requestId: 'request-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  userMessageId: 'user-1',
  createdAt: '2026-11-23T00:00:00.000Z',
  input: { userMessage: input.userMessage, provider: 'test', model: 'slow', permissionMode: 'ask' },
  status: 'running',
  cursor: 'epoch:execution-1:1',
  events: [],
};
function sse(frames: readonly [string, unknown][]): Response {
  return new Response(
    frames.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('recoverable execution client', () => {
  it('retries a lost acceptance response with the identical request and never starts legacy transport', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(Response.json(snapshot, { status: 202 }))
      .mockResolvedValueOnce(
        sse([
          [
            'status',
            { cursor: 'epoch:execution-1:2', status: 'completed', durableThroughSequence: 12 },
          ],
        ]),
      );
    vi.stubGlobal('fetch', fetcher);
    const receipt = vi.fn();
    const run = streamAgentRun(
      input,
      { onReceipt: receipt, onEvent: vi.fn() },
      { requestId: 'request-1' },
    );
    await vi.runAllTimersAsync();
    await run;
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      '/sessions/session-1/executions',
      '/sessions/session-1/executions',
      '/sessions/session-1/executions/execution-1/events?after=epoch%3Aexecution-1%3A1',
    ]);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({
      requestId: 'request-1',
      input: snapshot.input,
    });
    expect(receipt).toHaveBeenCalledWith(snapshot);
  });

  it('reconnects from the last cursor, ignores duplicate events and replaces the full view on a new epoch', async () => {
    vi.useFakeTimers();
    const replacement = {
      ...snapshot,
      cursor: 'new-epoch:execution-1:0',
      events: [{ type: 'text-delta', text: 'whole' }],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        sse([
          [
            'event',
            { cursor: 'epoch:execution-1:2', event: { type: 'text-delta', text: 'partial' } },
          ],
          [
            'event',
            { cursor: 'epoch:execution-1:2', event: { type: 'text-delta', text: 'duplicate' } },
          ],
        ]),
      )
      .mockResolvedValueOnce(
        sse([
          ['snapshot', replacement],
          [
            'status',
            { cursor: 'new-epoch:execution-1:1', status: 'completed', durableThroughSequence: 19 },
          ],
        ]),
      );
    vi.stubGlobal('fetch', fetcher);
    const event = vi.fn();
    const view = vi.fn();
    const connection = vi.fn();
    const run = observeAgentExecution(snapshot, {
      onEvent: event,
      onSnapshot: view,
      onConnection: connection,
    });
    await vi.runAllTimersAsync();
    await run;
    expect(event.mock.calls).toEqual([[{ type: 'text-delta', text: 'partial' }]]);
    expect(view.mock.calls).toEqual([[snapshot], [replacement]]);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('after=epoch%3Aexecution-1%3A2');
    expect(connection).toHaveBeenCalledWith('reconnecting');
  });

  it('settles from a durable terminal snapshot with sequence zero after same-epoch live state eviction', async () => {
    vi.useFakeTimers();
    const terminal = {
      ...snapshot,
      status: 'completed',
      cursor: 'epoch:execution-1:0',
      durableThroughSequence: 25,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        sse([
          [
            'event',
            { cursor: 'epoch:execution-1:2', event: { type: 'text-delta', text: 'partial' } },
          ],
        ]),
      )
      .mockResolvedValueOnce(sse([['snapshot', { type: 'snapshot', snapshot: terminal }]]))
      .mockRejectedValue(new Error('unexpected third subscription'));
    vi.stubGlobal('fetch', fetcher);
    const view = vi.fn();
    const result = observeAgentExecution(snapshot, { onEvent: vi.fn(), onSnapshot: view }).then(
      () => 'settled',
      () => 'failed',
    );
    await vi.runAllTimersAsync();
    expect(await result).toBe('settled');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(view.mock.calls).toEqual([[snapshot], [terminal]]);
  });

  it('ignores an older live snapshot and requires a persistence watermark before accepting a reset terminal snapshot', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        sse([
          [
            'snapshot',
            {
              ...snapshot,
              cursor: 'epoch:execution-1:0',
              events: [{ type: 'text-delta', text: 'stale' }],
            },
          ],
          ['snapshot', { ...snapshot, status: 'completed', cursor: 'epoch:execution-1:0' }],
        ]),
      )
      .mockRejectedValue(new Error('unexpected retry'));
    vi.stubGlobal('fetch', fetcher);
    const view = vi.fn();
    const result = observeAgentExecution(snapshot, { onEvent: vi.fn(), onSnapshot: view }).catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ code: 'agent-stream-protocol' });
    expect(view.mock.calls).toEqual([[snapshot]]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('aborting observation closes only the reader and never posts cancel', async () => {
    const closed = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({ cancel: closed }), {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const run = observeAgentExecution(
      snapshot,
      { onEvent: vi.fn() },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(closed).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses explicit cancel and keeps the server cancellation receipt authoritative', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ ...snapshot, status: 'cancelling' })),
    );
    const result = await cancelAgentExecution('session-1', 'execution-1');
    expect(result.status).toBe('cancelling');
    expect(fetch).toHaveBeenCalledWith(
      '/sessions/session-1/executions/execution-1/cancel',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('rejects foreign execution frames instead of applying them to this Turn', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sse([['snapshot', { ...snapshot, executionId: 'other', cursor: 'epoch:other:3' }]]),
        ),
    );
    await expect(observeAgentExecution(snapshot, { onEvent: vi.fn() })).rejects.toMatchObject({
      code: 'agent-stream-protocol',
    });
  });

  it('does not confirm a legacy completed event or EOF as execution completion', async () => {
    vi.useFakeTimers();
    const status = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          sse([
            [
              'event',
              { cursor: 'epoch:execution-1:2', event: { type: 'completed', turnId: 'turn-1' } },
            ],
          ]),
        )
        .mockResolvedValueOnce(
          sse([
            [
              'status',
              { cursor: 'epoch:execution-1:3', status: 'cancelled', durableThroughSequence: 21 },
            ],
          ]),
        ),
    );
    const run = observeAgentExecution(snapshot, { onEvent: vi.fn(), onStatus: status });
    await vi.runAllTimersAsync();
    await run;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(status.mock.calls).toEqual([
      [{ cursor: 'epoch:execution-1:3', status: 'cancelled', durableThroughSequence: 21 }],
    ]);
  });

  it('retries a transient acceptance HTTP failure using the original request identity', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'http-503', message: 'temporarily unavailable' } },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ ...snapshot, status: 'completed', durableThroughSequence: 8 }),
      );
    vi.stubGlobal('fetch', fetcher);
    const run = streamAgentRun(input, { onEvent: vi.fn() }, { requestId: 'request-1' });
    const result = run.then(
      () => 'complete',
      () => 'failed',
    );
    await vi.runAllTimersAsync();
    expect(await result).toBe('complete');
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  });

  it('retries the same launch if the accepted response body is lost during download', async () => {
    vi.useFakeTimers();
    const lostBody = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError('network body lost'));
        },
      }),
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(lostBody)
      .mockResolvedValueOnce(
        Response.json({ ...snapshot, status: 'cancelled', durableThroughSequence: 10 }),
      );
    vi.stubGlobal('fetch', fetcher);
    const result = streamAgentRun(input, { onEvent: vi.fn() }, { requestId: 'request-1' }).then(
      () => 'complete',
      () => 'failed',
    );
    await vi.runAllTimersAsync();
    expect(await result).toBe('complete');
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  });

  it('rejects unbounded unterminated SSE data while permitting a full bounded snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('data: ' + 'x'.repeat(9 * 1024 * 1024), {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );
    await expect(observeAgentExecution(snapshot, { onEvent: vi.fn() })).rejects.toMatchObject({
      code: 'agent-stream-protocol',
    });
  });
});

it.each([
  [503, 'execution-file-capture-timeout'],
  [500, 'execution-file-capture-failed'],
  [500, 'execution-context-capture-failed'],
])('treats capture %s as a definite rejection with one launch', async (status, code) => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ error: { code, message: '重新添加文件后发送' } }, { status }),
    );
  vi.stubGlobal('fetch', fetcher);
  const accepted = vi.fn();
  const run = streamAgentRun(
    { ...input, files: [{ path: 'src/a.ts' }] },
    { onEvent: vi.fn(), onAccepted: accepted },
  );
  const result = run.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toMatchObject({ code });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(accepted).not.toHaveBeenCalled();
});

it('freezes ordered logical file refs into every ambiguous transport retry', async () => {
  vi.useFakeTimers();
  const files = [{ path: 'b.ts' }, { path: 'a.ts' }];
  const accepted = {
    ...snapshot,
    status: 'cancelled',
    durableThroughSequence: 10,
    input: { ...snapshot.input, files },
    fileAttachments: files.map(({ path }) => ({
      path,
      encoding: 'utf-8',
      byteLength: 1,
      sha256: 'a'.repeat(64),
    })),
  };
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('lost'))
    .mockResolvedValueOnce(Response.json(accepted));
  vi.stubGlobal('fetch', fetcher);
  const run = streamAgentRun({ ...input, files }, { onEvent: vi.fn() }, { requestId: 'request-1' });
  files[0]!.path = 'edited-after-launch.ts';
  await vi.runAllTimersAsync();
  await run;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string).input.files).toEqual([
    { path: 'b.ts' },
    { path: 'a.ts' },
  ]);
  expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain('sha256');
});

it('freezes context kinds into every ambiguous retry and parses the accepted summaries', async () => {
  vi.useFakeTimers();
  const contexts = [{ kind: 'git-changes' }, { kind: 'project-tree' }] as const;
  const accepted = {
    ...snapshot,
    status: 'cancelled',
    durableThroughSequence: 10,
    input: { ...snapshot.input, contexts },
    contextAttachments: contexts.map(({ kind }) => ({
      kind,
      capturedAt: '2026-11-24T10:00:00.000Z',
      byteLength: 12,
      truncated: kind === 'project-tree',
    })),
  };
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('lost'))
    .mockResolvedValueOnce(Response.json(accepted));
  vi.stubGlobal('fetch', fetcher);
  const received = vi.fn();
  const run = streamAgentRun(
    { ...input, contexts: [...contexts] },
    { onEvent: vi.fn(), onReceipt: received },
    { requestId: 'request-1' },
  );
  await vi.runAllTimersAsync();
  await run;
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string).input.contexts).toEqual(contexts);
  expect(received.mock.calls[0]?.[0].contextAttachments).toHaveLength(2);
});

it('rejects duplicate context kinds before any request is sent', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(
    streamAgentRun(
      { ...input, contexts: [{ kind: 'git-changes' }, { kind: 'git-changes' }] },
      { onEvent: vi.fn() },
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
