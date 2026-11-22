import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamAgentRun } from '../src/features/agent/agent-stream.js';
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

  it('aborting observation closes only the reader and never posts cancel', async () => {
    const closed = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
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
      vi
        .fn()
        .mockResolvedValue(
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
