import { describe, expect, it, vi } from 'vitest';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import { createOpenAiCompatibleClient } from '../src/index.js';

const request: LlmRequest = {
  provider: 'openai-compatible',
  model: 'test-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
};

async function collectEvents(
  client: ReturnType<typeof createOpenAiCompatibleClient>,
  input = request,
  options?: Parameters<typeof client.stream>[1],
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.stream(input, options)) {
    events.push(event);
  }
  return events;
}

function streamingResponse(...frames: string[]): Response {
  return new Response(`${frames.join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function responseWithoutTrailingBoundary(...frames: string[]): Response {
  return new Response(frames.join('\n\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function responseWithBody(body: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function createClient(fetchMock: typeof fetch, options?: { readonly defaultTimeoutMs?: number }) {
  return createOpenAiCompatibleClient({
    baseUrl: 'https://provider.test/v1/',
    apiKey: 'secret-for-test-only',
    fetch: fetchMock,
    ...options,
  });
}

describe('OpenAI-compatible provider', () => {
  it('maps text streaming response into Weave events', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamingResponse(
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
        'data: [DONE]',
      ),
    );
    const client = createClient(fetchMock);

    await expect(collectEvents(client)).resolves.toEqual([
      { type: 'text-delta', text: 'Hello' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ]);
  });

  it('sends the OpenAI-compatible request shape', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => streamingResponse('data: [DONE]'));
    const client = createClient(fetchMock);
    const input: LlmRequest = {
      provider: 'openai-compatible',
      model: 'test-model',
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'System ' },
            { type: 'reasoning', text: 'context' },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Answer' }],
          toolCalls: [{ id: 'call-1', name: 'lookup', arguments: '{"q":"x"}' }],
        },
        {
          role: 'tool',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'result' }],
        },
      ],
      tools: [
        {
          name: 'lookup',
          description: 'Look something up',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
      temperature: 0.2,
      maxTokens: 128,
      reasoningEffort: 'high',
    };

    await collectEvents(client, input);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://provider.test/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-for-test-only');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'System context' },
        {
          role: 'assistant',
          content: 'Answer',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"x"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'result' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Look something up',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
          },
        },
      ],
      temperature: 0.2,
      max_tokens: 128,
      reasoning_effort: 'high',
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('maps reasoning, tool calls, finish reasons, and usage', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamingResponse(
        'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"lookup","arguments":"{\\"q\\""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":":\\"x\\"}"}}]}}]}',
        'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
        'data: [DONE]',
      ),
    );

    await expect(collectEvents(createClient(fetchMock))).resolves.toEqual([
      { type: 'reasoning-delta', text: 'think ' },
      { type: 'tool-call-start', id: 'call-1', name: 'lookup' },
      { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{"q"' },
      { type: 'tool-call-delta', id: 'call-1', argumentsDelta: ':"x"}' },
      {
        type: 'finish',
        reason: 'tool-call',
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    ]);
  });

  it('accepts nullable content fields used by DeepSeek reasoning streams', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamingResponse(
        'data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":null,"reasoning_content":"think "},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"answer","reasoning_content":null},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":null},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ),
    );

    await expect(collectEvents(createClient(fetchMock))).resolves.toEqual([
      { type: 'reasoning-delta', text: '' },
      { type: 'reasoning-delta', text: 'think ' },
      { type: 'text-delta', text: 'answer' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('preserves partial tool-call fragments and starts before deltas', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamingResponse(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1"}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"x\\"}"}}]}}]}',
        'data: [DONE]',
      ),
    );

    await expect(collectEvents(createClient(fetchMock))).resolves.toEqual([
      { type: 'tool-call-start', id: 'call-1', name: 'lookup' },
      { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{"q"' },
      { type: 'tool-call-delta', id: 'call-1', argumentsDelta: ':"x"}' },
    ]);
  });

  it('maps usage-only final chunks into the finish event', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamingResponse(
        'data: {"choices":[{"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":6,"total_tokens":11}}',
        'data: [DONE]',
      ),
    );

    await expect(collectEvents(createClient(fetchMock))).resolves.toEqual([
      {
        type: 'finish',
        reason: 'stop',
        usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
      },
    ]);
  });

  it('maps DeepSeek cache hits and reasoning tokens into usage', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamingResponse(
        'data: {"choices":[{"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":30,"total_tokens":130,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20,"completion_tokens_details":{"reasoning_tokens":12}}}',
        'data: [DONE]',
      ),
    );

    await expect(collectEvents(createClient(fetchMock))).resolves.toEqual([
      {
        type: 'finish',
        reason: 'stop',
        usage: {
          inputTokens: 100,
          outputTokens: 30,
          totalTokens: 130,
          cacheReadTokens: 80,
          reasoningTokens: 12,
        },
      },
    ]);
  });

  it('falls back to OpenAI cached_tokens and tolerates a null usage chunk', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamingResponse(
        'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}',
        'data: {"choices":[{"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":32}}}',
        'data: [DONE]',
      ),
    );

    await expect(collectEvents(createClient(fetchMock))).resolves.toEqual([
      { type: 'text-delta', text: 'hi' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { inputTokens: 40, outputTokens: 2, cacheReadTokens: 32 },
      },
    ]);
  });

  it('rejects a response that reaches EOF without [DONE]', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamingResponse(
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
      ),
    );

    await expect(collectEvents(createClient(fetchMock))).rejects.toMatchObject({
      code: 'protocol',
      retryable: false,
    });
  });

  it('accepts a final [DONE] frame without a trailing boundary', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      responseWithoutTrailingBoundary(
        'data: {"choices":[{"finish_reason":"stop"}]}',
        'data: [DONE]',
      ),
    );

    await expect(collectEvents(createClient(fetchMock))).resolves.toEqual([
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it.each([
    [401, 'authentication', false],
    [429, 'rate-limit', true],
    [500, 'provider', true],
  ] as const)('maps HTTP %s to %s', async (status, code, retryable) => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response('provider diagnostic secret-for-test-only', {
          status,
          statusText: 'Provider failure',
        }),
    );

    await expect(collectEvents(createClient(fetchMock))).rejects.toMatchObject({
      code,
      retryable,
      status,
    });
  });

  it('bounds and redacts HTTP diagnostics', async () => {
    const diagnostic = `secret-for-test-only ${'x'.repeat(20_000)}`;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(diagnostic, { status: 500 }));

    await expect(collectEvents(createClient(fetchMock))).rejects.toSatisfy((error: unknown) => {
      const message = String((error as { message?: unknown }).message);
      return message.length <= 4_096 && !message.includes('secret-for-test-only');
    });
  });

  it('redacts the configured key from network, status, and reader errors', async () => {
    const apiKey = 'configured-test-key';
    const networkFetch = vi.fn<typeof fetch>(async () => {
      throw new Error(`network failure ${apiKey}`);
    });
    const networkError = await collectEvents(
      createOpenAiCompatibleClient({
        baseUrl: 'https://provider.test/v1',
        apiKey,
        fetch: networkFetch,
      }),
    ).catch((error: unknown) => error);
    expect(networkError).toMatchObject({ code: 'network' });
    expect(String((networkError as { message?: unknown }).message)).not.toContain(apiKey);

    const statusFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(`body ${apiKey}`, {
          status: 500,
          statusText: `status ${apiKey}`,
        }),
    );
    const statusError = await collectEvents(
      createOpenAiCompatibleClient({
        baseUrl: 'https://provider.test/v1',
        apiKey,
        fetch: statusFetch,
      }),
    ).catch((error: unknown) => error);
    expect(statusError).toMatchObject({ code: 'provider' });
    expect(String((statusError as { message?: unknown }).message)).not.toContain(apiKey);

    const readerFetch = vi.fn<typeof fetch>(async () =>
      responseWithBody(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error(`reader failure ${apiKey}`));
          },
        }),
      ),
    );
    const readerError = await collectEvents(
      createOpenAiCompatibleClient({
        baseUrl: 'https://provider.test/v1',
        apiKey,
        fetch: readerFetch,
      }),
    ).catch((error: unknown) => error);
    expect(readerError).toMatchObject({ code: 'network' });
    expect(String((readerError as { message?: unknown }).message)).not.toContain(apiKey);
  });

  it('cancels the response body when iteration ends early', async () => {
    let cancelled = false;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      responseWithBody(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );

    const iterator = createClient(fetchMock).stream(request)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'text-delta', text: 'first' },
    });
    await iterator.return?.();

    expect(cancelled).toBe(true);
  });

  it('forwards AbortSignal to fetch', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const promise = collectEvents(createClient(fetchMock), request, {
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.signal).not.toBe(controller.signal);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('aborts fetch when the timeout expires', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    await expect(
      collectEvents(createClient(fetchMock), request, { timeoutMs: 10 }),
    ).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
  });

  it('maps malformed provider JSON to a protocol error', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => streamingResponse('data: {"choices":'));

    await expect(collectEvents(createClient(fetchMock))).rejects.toMatchObject({
      code: 'protocol',
      retryable: false,
    });
  });

  it('normalizes arbitrary thrown objects instead of trusting their shape', async () => {
    const apiKey = 'configured-test-key';
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw { code: 'protocol', message: apiKey };
    });

    const error = await collectEvents(
      createOpenAiCompatibleClient({
        baseUrl: 'https://provider.test/v1',
        apiKey,
        fetch: fetchMock,
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'network', retryable: true });
    expect(String((error as { message?: unknown }).message)).not.toContain(apiKey);
  });

  it('normalizes arbitrary response-reader objects instead of trusting their shape', async () => {
    const apiKey = 'configured-test-key';
    const fetchMock = vi.fn<typeof fetch>(async () =>
      responseWithBody(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error({ code: 'protocol', message: apiKey });
          },
        }),
      ),
    );

    const error = await collectEvents(
      createOpenAiCompatibleClient({
        baseUrl: 'https://provider.test/v1',
        apiKey,
        fetch: fetchMock,
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'network', retryable: true });
    expect(String((error as { message?: unknown }).message)).not.toContain(apiKey);
  });

  it('maps a missing response body to a protocol error', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    await expect(collectEvents(createClient(fetchMock))).rejects.toMatchObject({
      code: 'protocol',
    });
  });
});
