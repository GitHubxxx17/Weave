// @vitest-environment jsdom

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

function responseFromChunks(chunks: readonly Uint8Array[], status = 200, close = true): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      if (close) {
        controller.close();
      }
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

function crlfEventFrame(event: string, data: unknown): string {
  return `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
}

function responseWithCancelTracking(chunks: readonly Uint8Array[]): {
  readonly response: Response;
  readonly wasCancelled: () => boolean;
} {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    wasCancelled: () => cancelled,
  };
}

function collectEvents(): {
  readonly events: AgentRuntimeEvent[];
  readonly onEvent: (event: AgentRuntimeEvent) => void;
} {
  const events: AgentRuntimeEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

afterEach(() => {
  delete window.weaveDesktop;
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

  it('validates every known event payload at the browser boundary', () => {
    expect(
      parseAgentEvent(
        'tool-call',
        '{"type":"tool-call","toolCall":{"id":"call-1","name":"echo","arguments":"{}"}}',
      ),
    ).toEqual({
      type: 'tool-call',
      toolCall: { id: 'call-1', name: 'echo', arguments: '{}' },
    });
    expect(
      parseAgentEvent(
        'tool-executing',
        '{"type":"tool-executing","toolCall":{"id":"call-1","name":"echo","arguments":"{}"}}',
      ),
    ).toEqual({
      type: 'tool-executing',
      toolCall: { id: 'call-1', name: 'echo', arguments: '{}' },
    });
    expect(
      parseAgentEvent(
        'tool-result',
        '{"type":"tool-result","result":{"toolCallId":"call-1","name":"echo","content":"ok","truncated":false}}',
      ),
    ).toEqual({
      type: 'tool-result',
      result: { toolCallId: 'call-1', name: 'echo', content: 'ok', truncated: false },
    });
    expect(parseAgentEvent('reasoning-delta', '{"type":"reasoning-delta","text":"分析"}')).toEqual({
      type: 'reasoning-delta',
      text: '分析',
    });
    expect(() => parseAgentEvent('tool-result', '{"type":"tool-result"}')).toThrowError(
      'agent-stream-protocol: Agent stream event is invalid',
    );
    expect(
      parseAgentEvent(
        'usage',
        '{"type":"usage","usage":{"inputTokens":120,"cacheReadTokens":96},"provider":"deepseek","model":"deepseek-flash"}',
      ),
    ).toEqual({
      type: 'usage',
      usage: { inputTokens: 120, cacheReadTokens: 96 },
      provider: 'deepseek',
      model: 'deepseek-flash',
    });
    expect(
      parseAgentEvent(
        'context',
        '{"type":"context","breakdown":{"windowTokens":128000,"sentTokens":1200,"ratio":0.0094,"trimmed":false,"categories":{"system":100,"tools":50,"userMessages":200,"assistantText":300,"assistantReasoning":0,"toolCalls":150,"toolResults":400,"skeleton":0}},"provider":"deepseek","model":"deepseek-flash"}',
      ),
    ).toMatchObject({
      type: 'context',
      breakdown: { windowTokens: 128000, sentTokens: 1200, trimmed: false },
      provider: 'deepseek',
    });
    expect(
      parseAgentEvent(
        'plan',
        '{"type":"plan","plan":{"explanation":"先读后写","items":[{"step":"读取文件","status":"in_progress"},{"step":"修改文件","status":"pending"}]}}',
      ),
    ).toEqual({
      type: 'plan',
      plan: {
        explanation: '先读后写',
        items: [
          { step: '读取文件', status: 'in_progress' },
          { step: '修改文件', status: 'pending' },
        ],
      },
    });
    expect(() =>
      parseAgentEvent('text-delta', '{"type":"reasoning-delta","text":"错位"}'),
    ).toThrowError('agent-stream-protocol: Agent stream event is invalid');
    expect(() => parseAgentEvent('text-delta', 'not-json')).toThrowError(
      'agent-stream-protocol: Agent stream data is invalid',
    );
    expect(() => parseAgentEvent('error', '{"error":{"code":"x"}}')).toThrowError(
      'agent-stream-protocol: Agent stream error is invalid',
    );
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

  it('consumes CRLF frames from the actual response stream', async () => {
    const response = responseFromChunks([
      utf8(crlfEventFrame('text-delta', { type: 'text-delta', text: 'crlf' })),
      utf8(crlfEventFrame('completed', { type: 'completed', turnId: 'turn-1' })),
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const result = collectEvents();

    await streamAgentRun(request, result);

    expect(result.events).toEqual([
      { type: 'text-delta', text: 'crlf' },
      { type: 'completed', turnId: 'turn-1' },
    ]);
  });

  it('cancels an open response after completed', async () => {
    const tracked = responseWithCancelTracking([
      utf8(eventFrame('completed', { type: 'completed', turnId: 'turn-1' })),
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(tracked.response);

    await streamAgentRun(request, collectEvents());

    expect(tracked.wasCancelled()).toBe(true);
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

  it('cancels an open response when the stream contains an invalid event', async () => {
    const tracked = responseWithCancelTracking([
      utf8('event: text-delta\ndata: {"type":"text-delta"}\n\n'),
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(tracked.response);

    await expect(streamAgentRun(request, collectEvents())).rejects.toThrowError(
      'agent-stream-protocol: Agent stream event is invalid',
    );
    expect(tracked.wasCancelled()).toBe(true);
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

  it('uses the desktop Server URL for the Agent SSE request', async () => {
    window.weaveDesktop = {
      isDesktop: true,
      serverUrl: 'http://127.0.0.1:46321/',
    };
    const response = responseFromChunks([]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    await streamAgentRun(request, collectEvents());

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:46321/agent/runs/stream',
      expect.objectContaining({
        method: 'POST',
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

it('reports transport acceptance before streaming and preserves exact Skill and sampling fields', async () => {
  const accepted = vi.fn();
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      responseFromChunks([utf8(eventFrame('completed', { type: 'completed', turnId: 'one' }))]),
    );
  await streamAgentRun(
    {
      ...request,
      temperature: 0.2,
      maxTokens: 777,
      skills: [
        {
          id: 'builtin:weave-planning',
          instructionSha256: 'a'.repeat(64),
          bundleSha256: 'b'.repeat(64),
        },
      ],
    },
    { onEvent: () => expect(accepted).toHaveBeenCalledTimes(1), onAccepted: accepted },
  );
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.skills).toEqual([
    {
      id: 'builtin:weave-planning',
      instructionSha256: 'a'.repeat(64),
      bundleSha256: 'b'.repeat(64),
    },
  ]);
  expect(body.temperature).toBe(0.2);
  expect(body.maxTokens).toBe(777);
});
