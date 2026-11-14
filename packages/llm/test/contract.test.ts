import { describe, expect, it } from 'vitest';
import { createLlmError, createMockLlmClient } from '../src/index.js';

const request = {
  provider: 'mock',
  model: 'test-model',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: '开始' }] }],
};

describe('LLM contract', () => {
  it('replays deterministic events in order', async () => {
    const client = createMockLlmClient([
      { type: 'text-delta', text: '分析' },
      { type: 'text-delta', text: '完成' },
      { type: 'finish', reason: 'stop' },
    ]);

    const events = [];
    for await (const event of client.stream(request)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'text-delta', text: '分析' },
      { type: 'text-delta', text: '完成' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('validates the request before replaying events', async () => {
    const client = createMockLlmClient([{ type: 'finish', reason: 'stop' }]);
    const invalidRequest = {
      provider: 'mock',
      model: 'test-model',
      messages: [{ role: 'invalid' }],
    };

    await expect(
      (async () => {
        for await (const event of client.stream(invalidRequest as never)) {
          expect(event).toBeDefined();
        }
      })(),
    ).rejects.toThrow();
  });

  it('stops emitting after AbortSignal is aborted', async () => {
    const controller = new AbortController();
    const client = createMockLlmClient([
      { type: 'text-delta', text: 'first' },
      { type: 'text-delta', text: 'second' },
    ]);

    const iterator = client.stream(request, { signal: controller.signal })[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({
      type: 'text-delta',
      text: 'first',
    });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels a delayed event when AbortSignal is aborted', async () => {
    const controller = new AbortController();
    const client = createMockLlmClient([{ type: 'text-delta', text: 'delayed' }], {
      delayMs: 50,
    });
    const iterator = client.stream(request, { signal: controller.signal })[Symbol.asyncIterator]();

    const next = iterator.next();
    controller.abort();

    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects legacy error events as protocol failures', async () => {
    const client = createMockLlmClient([
      {
        type: 'error',
        error: {
          code: 'network',
          message: 'connection failed',
          provider: 'mock',
          retryable: true,
        },
      } as never,
    ]);

    await expect(
      (async () => {
        for await (const event of client.stream(request)) {
          expect(event).toBeDefined();
        }
      })(),
    ).rejects.toMatchObject({
      code: 'protocol',
      provider: 'mock',
    });
  });
});

describe('LLM error classification', () => {
  it.each([
    ['authentication', false],
    ['invalid-request', false],
    ['context-overflow', false],
    ['cancelled', false],
    ['rate-limit', true],
    ['timeout', true],
    ['network', true],
    ['provider', false],
    ['protocol', false],
  ] as const)('uses the stable retryable default for %s', (code, retryable) => {
    expect(createLlmError({ code, message: 'diagnostic' }).retryable).toBe(retryable);
  });

  it('allows the caller to override the retryable classification', () => {
    expect(
      createLlmError({ code: 'network', message: 'diagnostic', retryable: false }),
    ).toMatchObject({
      code: 'network',
      message: 'diagnostic',
      retryable: false,
    });
  });
});
