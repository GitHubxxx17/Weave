import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getAgentTaskTree,
  observeAgentTaskTree,
  stopAgentTask,
} from '../src/features/tasks/task-api.js';

const taskId = '00000000-0000-4000-8000-000000000001';
const initial = {
  tasks: [],
  cursor: 'first-cursor',
  epoch: 'first-epoch',
  rootSessionId: 'root',
  revision: 2,
  changed: true,
  totalCount: 0,
  truncated: false,
};

function eventStream(...chunks: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Studio task API', () => {
  it('validates GET root identity and sends the existing task path and stop receipt ID', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(initial))
      .mockResolvedValueOnce(Response.json({ ...initial, rootSessionId: 'foreign' }))
      .mockResolvedValueOnce(Response.json({ tasks: [] }, { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    await expect(getAgentTaskTree('root', { cursor: 'a+b' })).resolves.toEqual(initial);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/sessions/root/tasks?cursor=a%2Bb');
    await expect(getAgentTaskTree('root')).rejects.toMatchObject({ code: 'task-api-protocol' });
    await stopAgentTask('root', taskId, 'click:1');
    expect(String(fetch.mock.calls[2]?.[0])).toContain(`/sessions/root/tasks/${taskId}/cancel`);
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ operationId: 'click:1' }),
    });
  });

  it('applies ordered chunked snapshots and reconnects with an opaque cursor', async () => {
    vi.useFakeTimers();
    const next = { ...initial, epoch: 'next-epoch', revision: 1, cursor: 'next-cursor' };
    const frame = `event: tasks\r\ndata: ${JSON.stringify(initial)}\r\n\r\n`;
    const stale = { ...initial, revision: 1, cursor: 'stale-cursor' };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        eventStream(
          frame.slice(0, 18),
          frame.slice(18),
          `event: tasks\ndata: ${JSON.stringify(stale)}\n\n`,
        ),
      )
      .mockResolvedValueOnce(eventStream(`event: tasks\ndata: ${JSON.stringify(next)}\n\n`));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const snapshots = vi.fn((snapshot) => {
      if (snapshot.epoch === next.epoch) controller.abort();
    });
    const observe = observeAgentTaskTree('root', snapshots, controller.signal);
    const aborted = expect(observe).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1000);
    await aborted;
    expect(snapshots.mock.calls).toEqual([[initial], [next]]);
    expect(String(fetch.mock.calls[1]?.[0])).toContain('after=first-cursor');
  });

  it('cancels an oversized JSON response before parsing or waiting for completion', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(24_577));
            },
            cancel,
          }),
        ),
      ),
    );
    await expect(getAgentTaskTree('root')).rejects.toMatchObject({ code: 'task-api-protocol' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
