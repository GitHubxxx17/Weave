import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentStreamError,
  parseAgentEvent,
  parseSseFrame,
  streamAgentRun,
} from '../src/features/agent/agent-stream.js';
import type { AgentRunRequestInput, AgentRuntimeEvent } from '../src/features/agent/agent-types.js';

const request: AgentRunRequestInput = {
  sessionId: 'session-1',
  userMessage: {
    role: 'user',
    content: [{ type: 'text', text: '你好' }],
  },
  provider: 'mock',
  model: 'demo',
};

function responseFromChunks(chunks: readonly Uint8Array[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function eventFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function collectEvents(): {
  readonly events: AgentRuntimeEvent[];
  readonly onEvent: (event: AgentRuntimeEvent) => void;
} {
  const events: AgentRuntimeEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SSE frame parsing', () => {
  it('parses CRLF frames, joins data lines, and ignores empty/comment lines', () => {
    expect(
      parseSseFrame(
        ': keep-alive\r\n\r\nevent: custom\r\ndata: {"type":"text-\r\ndata: delta","text":"ok"}\r\n\r\n',
      ),
    ).toEqual({
      event: 'custom',
      data: '{"type":"text-\ndelta","text":"ok"}',
    });
  });

  it('ignores empty and comment-only frames', () => {
    expect(parseSseFrame('\r\n: comment\r\n\r\n')).toBeNull();
  });

  it('maps known events and ignores unknown events', () => {
    expect(parseAgentEvent('text-delta', '{"type":"text-delta","text":"ok"}')).toEqual({
      type: 'text-delta',
      text: 'ok',
    });
    expect(parseAgentEvent('future-event', '{}')).toBeNull();
  });
});

describe('streamAgentRun', () => {
  it('reassembles an event split across Uint8Array chunks', async () => {
    const response = responseFromChunks([
      utf8('event: text-delta\ndata: {"type":"text-delta","text":"你好"}\n'),
      utf8('\n'),
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const result = collectEvents();

    await streamAgentRun(request, result);

    expect(result.events).toEqual([{ type: 'text-delta', text: '你好' }]);
  });

  it('supports a UTF-8 character split between chunks', async () => {
    const encoded = utf8(eventFrame('text-delta', { type: 'text-delta', text: '中文' }));
    const splitAt = encoded.indexOf(0xe4);
    const response = responseFromChunks([
      encoded.slice(0, splitAt + 1),
      encoded.slice(splitAt + 1),
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const result = collectEvents();

    await streamAgentRun(request, result);

    expect(result.events).toEqual([{ type: 'text-delta', text: '中文' }]);
  });

  it('supports a final frame without a trailing empty line', async () => {
    const response = responseFromChunks([
      utf8('event: completed\ndata: {"type":"completed","turnId":"turn-1"}'),
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const result = collectEvents();

    await streamAgentRun(request, result);

    expect(result.events).toEqual([{ type: 'completed', turnId: 'turn-1' }]);
  });

  it('preserves event order and stops after an SSE error', async () => {
    const response = responseFromChunks([
      utf8(eventFrame('text-delta', { type: 'text-delta', text: 'before' })),
      utf8(
        eventFrame('error', {
          error: { code: 'agent-step-limit', message: 'Agent run failed' },
        }),
      ),
      utf8(eventFrame('text-delta', { type: 'text-delta', text: 'after' })),
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const result = collectEvents();

    await expect(streamAgentRun(request, result)).rejects.toMatchObject({
      name: 'AgentStreamError',
      code: 'agent-step-limit',
      message: 'agent-step-limit: Agent run failed',
    });
    expect(result.events).toEqual([{ type: 'text-delta', text: 'before' }]);
  });

  it('ignores unknown events while consuming known events', async () => {
    const response = responseFromChunks([
      utf8(eventFrame('future-event', { type: 'future-event', value: 'ignored' })),
      utf8(eventFrame('text-delta', { type: 'text-delta', text: 'known' })),
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const result = collectEvents();

    await streamAgentRun(request, result);

    expect(result.events).toEqual([{ type: 'text-delta', text: 'known' }]);
  });

  it('maps a non-2xx JSON response to a safe error containing its code', async () => {
    const response = new Response(
      JSON.stringify({
        error: { code: 'agent-invalid-input', message: 'Agent request body is invalid' },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    await expect(streamAgentRun(request, collectEvents())).rejects.toMatchObject({
      code: 'agent-invalid-input',
      message: 'agent-invalid-input: Agent request body is invalid',
    });
  });

  it('passes JSON headers, request body, and AbortSignal to fetch', async () => {
    const response = responseFromChunks([]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const controller = new AbortController();

    await streamAgentRun(request, collectEvents(), { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(
      '/agent/runs/stream',
      expect.objectContaining({
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      }),
    );
  });

  it('propagates AbortError unchanged', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    await expect(streamAgentRun(request, collectEvents())).rejects.toBe(abortError);
  });

  it('exports the documented error type', () => {
    const error = new AgentStreamError('agent-stream-protocol', 'Agent stream failed');

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('agent-stream-protocol');
    expect(error.message).toBe('agent-stream-protocol: Agent stream failed');
    expect(error.name).toBe('AgentStreamError');
  });
});
