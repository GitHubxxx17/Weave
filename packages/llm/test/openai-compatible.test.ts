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
    const diagnostic = `${'x'.repeat(20_000)} secret-for-test-only`;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(diagnostic, { status: 500 }));

    await expect(collectEvents(createClient(fetchMock))).rejects.toSatisfy((error: unknown) => {
      const message = String((error as { message?: unknown }).message);
      return message.length <= 4_096 && !message.includes('secret-for-test-only');
    });
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

  it('maps a missing response body to a protocol error', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    await expect(collectEvents(createClient(fetchMock))).rejects.toMatchObject({
      code: 'protocol',
    });
  });
});
