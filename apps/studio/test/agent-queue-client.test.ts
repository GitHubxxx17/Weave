import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelQueuedExecution,
  getExecutionQueue,
  observeExecutionQueue,
  reorderExecutionQueue,
} from '../src/features/agent/agent-queue-client.js';
import { observeAgentExecution } from '../src/features/agent/agent-execution-client.js';
import { streamAgentRun } from '../src/features/agent/agent-stream.js';

const queue = {
  sessionId: 's',
  revision: 4,
  cursor: 'epoch:s:4',
  active: null,
  queued: [],
  scheduler: 'ready',
  limits: { sessionQueued: 10, globalQueued: 100 },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('durable queue transport', () => {
  it('accepts the encoded queue identity for Session IDs containing delimiters', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ...queue,
          sessionId: 's:中文',
          cursor: `epoch:${encodeURIComponent('s:中文')}:4`,
        }),
      ),
    );
    await expect(getExecutionQueue('s:中文')).resolves.toMatchObject({ sessionId: 's:中文' });
    expect(fetch).toHaveBeenCalledWith(
      '/sessions/s%3A%E4%B8%AD%E6%96%87/executions/queue',
      undefined,
    );
  });
  it('does not keep observing an execution while it is queued', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const onSnapshot = vi.fn();
    await observeAgentExecution(
      {
        sessionId: 's',
        executionId: 'e',
        requestId: 'r',
        turnId: 't',
        userMessageId: 'u',
        createdAt: '2026-11-23T00:00:00.000Z',
        status: 'queued',
        cursor: 'epoch:e:0',
        events: [],
        input: {
          provider: 'p',
          model: 'm',
          permissionMode: 'ask',
          userMessage: { role: 'user', content: [{ type: 'text', text: 'later' }] },
        },
      },
      { onSnapshot, onEvent: vi.fn() },
    );
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns on a queued launch receipt without opening an execution stream', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        sessionId: 's',
        executionId: 'e',
        requestId: 'r',
        turnId: 't',
        userMessageId: 'u',
        createdAt: '2026-11-23T00:00:00.000Z',
        status: 'queued',
        cursor: 'epoch:e:0',
        events: [],
        input: {
          provider: 'p',
          model: 'm',
          permissionMode: 'ask',
          userMessage: { role: 'user', content: [{ type: 'text', text: 'later' }] },
        },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const receipt = vi.fn();
    await streamAgentRun(
      {
        sessionId: 's',
        provider: 'p',
        model: 'm',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'later' }] },
      },
      { onReceipt: receipt, onEvent: vi.fn() },
      { requestId: 'r' },
    );
    expect(receipt).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('retries explicitly uncertain admission with the same request and stops on a definite persistence block', async () => {
    vi.useFakeTimers();
    const snapshot = {
      sessionId: 's',
      executionId: 'e',
      requestId: 'r',
      turnId: 't',
      userMessageId: 'u',
      createdAt: '2026-11-23T00:00:00.000Z',
      status: 'queued',
      cursor: 'epoch:e:0',
      events: [],
      input: {
        provider: 'p',
        model: 'm',
        permissionMode: 'ask',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'later' }] },
      },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'execution-admission-uncertain', message: 'unknown append outcome' } },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'execution-persistence-error', message: 'blocked' } },
          { status: 503 },
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    const request = {
      sessionId: 's',
      provider: 'p',
      model: 'm',
      userMessage: { role: 'user' as const, content: [{ type: 'text' as const, text: 'later' }] },
    };
    const result = streamAgentRun(request, { onEvent: vi.fn() }, { requestId: 'r' });
    await vi.runAllTimersAsync();
    await result;
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
    await expect(
      streamAgentRun(request, { onEvent: vi.fn() }, { requestId: 'r2' }),
    ).rejects.toMatchObject({ code: 'execution-persistence-error' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('reconnects to replacement views and ignores stale cursors within an epoch', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const view = vi.fn((state) => {
      if (state.revision === 7) controller.abort();
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            `event: queue\ndata: ${JSON.stringify(queue)}\n\nevent: queue\ndata: ${JSON.stringify({ ...queue, revision: 3, cursor: 'epoch:s:3' })}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            `event: queue\ndata: ${JSON.stringify({ ...queue, revision: 7, cursor: 'new:s:0' })}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
    );
    const result = observeExecutionQueue('s', view, { signal: controller.signal }).catch(
      () => undefined,
    );
    await vi.runAllTimersAsync();
    await result;
    expect(view.mock.calls.map(([state]) => state.revision)).toEqual([4, 7]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('retries an ambiguous cancel using exactly the same control identity and never calls active Stop', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('lost'))
      .mockResolvedValueOnce(Response.json(queue));
    vi.stubGlobal('fetch', fetcher);
    const run = cancelQueuedExecution('s', 'e', { requestId: 'control', expectedRevision: 4 });
    await vi.runAllTimersAsync();
    await run;
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/sessions/s/executions/e/cancel-queued',
      '/sessions/s/executions/e/cancel-queued',
    ]);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe('{"requestId":"control","expectedRevision":4}');
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[0]?.[1]?.body);
  });
  it('surfaces a revision conflict without replaying a changed reorder', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code: 'execution-queue-conflict', message: 'changed' } },
          { status: 409 },
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      reorderExecutionQueue('s', {
        requestId: 'control',
        expectedRevision: 4,
        executionIds: ['e2', 'e1'],
      }),
    ).rejects.toMatchObject({ code: 'execution-queue-conflict' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
