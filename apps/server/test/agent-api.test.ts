import { describe, expect, it } from 'vitest';
import {
  AgentRunError,
  createRuntime,
  type AgentRunner,
  type AgentRuntimeEvent,
} from '@weave/runtime';
import { createApp } from '../src/app.js';
import { createServerAgentRunner, createServerRuntime } from '../src/runtime.js';

const validRequest = {
  sessionId: 'session-http-1',
  userMessage: {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: '你好' }],
  },
  provider: 'mock',
  model: 'test-model',
};

function createRuntimeEventStream(
  events: readonly AgentRuntimeEvent[],
): AsyncIterable<AgentRuntimeEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
      yield* events;
    },
  };
}

async function readResponse(response: Response): Promise<string> {
  return response.text();
}

function createRunner(
  stream: AsyncIterable<AgentRuntimeEvent>,
  onRequest?: (request: Parameters<AgentRunner['run']>[0]) => void,
): AgentRunner {
  return {
    run(request) {
      onRequest?.(request);
      return stream;
    },
  };
}

describe('Agent HTTP/SSE API', () => {
  it('streams the deterministic local demo with the default Agent Runner', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    try {
      const response = await createApp(runtime, {
        agentRunner: createServerAgentRunner(runtime),
      }).request('/agent/runs/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validRequest),
      });

      expect(response.status).toBe(200);
      const body = await readResponse(response);
      const firstTextDelta =
        'event: text-delta\n' +
        'data: {"type":"text-delta","text":"这是 Weave 的本地 Agent 演示。"}';
      const secondTextDelta =
        'event: text-delta\n' + 'data: {"type":"text-delta","text":" 当前消息通过 SSE 增量传输。"}';

      expect(body).toContain(firstTextDelta);
      expect(body).toContain(secondTextDelta);
      expect(body.indexOf(firstTextDelta)).toBeLessThan(body.indexOf(secondTextDelta));
      expect(body).toMatch(/event: completed\ndata: \{"type":"completed","turnId":"[^"]+"\}\n\n$/);
      expect(body).not.toContain('event: error');
    } finally {
      await runtime.stop();
    }
  });

  it('streams Runtime events in order with SSE headers', async () => {
    const runtime = createRuntime();
    await runtime.start();
    let receivedSignal: AbortSignal | undefined;
    const runner = createRunner(
      createRuntimeEventStream([
        { type: 'reasoning-delta', text: '先思考' },
        { type: 'text-delta', text: '你好' },
        {
          type: 'tool-call',
          toolCall: { id: 'call-1', name: 'echo', arguments: '{}' },
        },
        {
          type: 'tool-executing',
          toolCall: { id: 'call-1', name: 'echo', arguments: '{}' },
        },
        {
          type: 'tool-result',
          result: {
            toolCallId: 'call-1',
            name: 'echo',
            content: 'ok',
            truncated: false,
          },
        },
        { type: 'completed', turnId: 'turn-1' },
      ]),
      (request) => {
        receivedSignal = request.signal;
      },
    );

    try {
      const response = await createApp(runtime, { agentRunner: runner }).request(
        '/agent/runs/stream',
        {
          method: 'POST',
          headers: {
            accept: 'text/event-stream',
            'content-type': 'application/json',
          },
          body: JSON.stringify(validRequest),
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('connection')).toBe('keep-alive');
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      await expect(readResponse(response)).resolves.toBe(
        [
          'event: reasoning-delta',
          'data: {"type":"reasoning-delta","text":"先思考"}',
          '',
          'event: text-delta',
          'data: {"type":"text-delta","text":"你好"}',
          '',
          'event: tool-call',
          'data: {"type":"tool-call","toolCall":{"id":"call-1","name":"echo","arguments":"{}"}}',
          '',
          'event: tool-executing',
          'data: {"type":"tool-executing","toolCall":{"id":"call-1","name":"echo","arguments":"{}"}}',
          '',
          'event: tool-result',
          'data: {"type":"tool-result","result":{"toolCallId":"call-1","name":"echo","content":"ok","truncated":false}}',
          '',
          'event: completed',
          'data: {"type":"completed","turnId":"turn-1"}',
          '',
          '',
        ].join('\n'),
      );
    } finally {
      await runtime.stop();
    }
  });

  it.each([
    ['not-json', 'agent-invalid-input'],
    [JSON.stringify({ ...validRequest, sessionId: '' }), 'agent-invalid-input'],
  ])('returns 400 for invalid Agent input: %s', async (body, code) => {
    const runtime = createRuntime();
    await runtime.start();
    let called = false;
    const runner = createRunner(createRuntimeEventStream([]), () => {
      called = true;
    });

    try {
      const response = await createApp(runtime, { agentRunner: runner }).request(
        '/agent/runs/stream',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code,
          message: 'Agent request body is invalid',
        },
      });
      expect(called).toBe(false);
    } finally {
      await runtime.stop();
    }
  });

  it('returns 503 when the Agent Runner is not available', async () => {
    const runtime = createRuntime();
    await runtime.start();

    try {
      const response = await createApp(runtime).request('/agent/runs/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validRequest),
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: 'agent-service-unavailable',
          message: 'Agent service is not available',
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it('maps Runner failures to one SSE error event without exposing the cause', async () => {
    const runtime = createRuntime();
    await runtime.start();
    const runner: AgentRunner = {
      run() {
        return {
          [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
            return {
              async next(): Promise<IteratorResult<AgentRuntimeEvent>> {
                throw new AgentRunError(
                  'agent-step-limit',
                  'Agent reached the maximum step count',
                  {
                    cause: new Error('/private/provider-response.json'),
                  },
                );
              },
              [Symbol.asyncIterator]() {
                return this;
              },
            };
          },
        };
      },
    };

    try {
      const response = await createApp(runtime, { agentRunner: runner }).request(
        '/agent/runs/stream',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(validRequest),
        },
      );

      expect(response.status).toBe(200);
      const body = await readResponse(response);
      expect(body).toBe(
        [
          'event: error',
          'data: {"error":{"code":"agent-step-limit","message":"Agent reached the maximum step count"}}',
          '',
          '',
        ].join('\n'),
      );
      expect(body).not.toContain('provider-response');
    } finally {
      await runtime.stop();
    }
  });

  it('calls the Agent iterator return method once when the reader is cancelled', async () => {
    const runtime = createRuntime();
    await runtime.start();
    let releasePendingNext: (() => void) | undefined;
    let returnCalls = 0;
    const runner: AgentRunner = {
      run() {
        let first = true;
        return {
          next(): Promise<IteratorResult<AgentRuntimeEvent>> {
            if (first) {
              first = false;
              return Promise.resolve({
                done: false,
                value: { type: 'text-delta', text: '开始' },
              });
            }
            return new Promise<IteratorResult<AgentRuntimeEvent>>((resolve) => {
              releasePendingNext = () => resolve({ done: true, value: undefined });
            });
          },
          async return(): Promise<IteratorResult<AgentRuntimeEvent>> {
            returnCalls += 1;
            releasePendingNext?.();
            return { done: true, value: undefined };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };

    try {
      const response = await createApp(runtime, { agentRunner: runner }).request(
        '/agent/runs/stream',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(validRequest),
        },
      );
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error('Expected an SSE response body');
      }

      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: expect.any(Uint8Array),
      });
      await reader.cancel();
      await reader.cancel();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(returnCalls).toBe(1);
    } finally {
      releasePendingNext?.();
      await runtime.stop();
    }
  });
});
