import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LlmClient } from '@weave/llm';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import {
  createInMemorySessionEventStore,
  projectSession,
  type AgentExecutionInput,
  type CapturedFileContext,
  type SessionEventStore,
} from '@weave/session';
import { z } from 'zod';
import { createAgentRunner } from '../src/agent-runner.js';
import type { AgentRunRequest, AgentRuntimeEvent } from '../src/agent-types.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createToolPipeline } from '../src/tool-pipeline.js';

const input: AgentExecutionInput = {
  provider: 'mock',
  model: 'model',
  permissionMode: 'ask',
  useProviderDefaults: false,
  userMessage: { role: 'user', content: [{ type: 'text', text: 'Explain' }] },
  files: [{ path: 'a.txt' }],
};
const identity = { executionId: 'execution', turnId: 'turn', userMessageId: 'user' };
const request: AgentRunRequest = { ...input, sessionId: 's', executionIdentity: identity };
function capture(content = '\uFEFFbefore\r\n'): CapturedFileContext {
  return {
    version: 1,
    projectId: 'project',
    rootIdentity: 'a'.repeat(64),
    files: [
      {
        path: 'a.txt',
        encoding: 'utf-8',
        byteLength: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'),
        content,
        fileIdentity: 'b'.repeat(64),
      },
    ],
  };
}
async function accepted(
  store: SessionEventStore,
  phase: 'queued' | 'claimed' | 'terminal' = 'claimed',
  content?: string,
) {
  await store.append('s', [
    { type: 'session.created', payload: {} },
    {
      type: 'execution.accepted',
      payload: {
        ...identity,
        requestId: 'request',
        requestDigest: 'c'.repeat(64),
        input,
        runInput: input,
        dispatch: 'queued',
        fileContext: capture(content),
      },
    },
    ...(phase === 'queued'
      ? []
      : [{ type: 'execution.claimed' as const, payload: { executionId: identity.executionId } }]),
    ...(phase !== 'terminal'
      ? []
      : [
          {
            type: 'execution.finished' as const,
            payload: { executionId: identity.executionId, status: 'cancelled' as const },
          },
        ]),
  ]);
}
async function collect(stream: AsyncIterable<AgentRuntimeEvent>) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function recording(requests: LlmRequest[]): LlmClient {
  return {
    async *stream(value): AsyncIterable<StreamEvent> {
      requests.push(structuredClone(value));
      yield { type: 'finish', reason: 'stop' };
    },
  };
}
function snapshots(value: LlmRequest) {
  return value.messages.flatMap((message) =>
    message.content.flatMap((part) =>
      part.type === 'text' && part.text.startsWith('Attached workspace file snapshots.')
        ? [
            JSON.parse(part.text.slice(part.text.indexOf('\n') + 1)) as {
              files: { content: string }[];
            },
          ]
        : [],
    ),
  );
}

describe('Runner accepted file context', () => {
  it('renders saved content on first call, after a tool and in the next direct Turn without filesystem access', async () => {
    const store = createInMemorySessionEventStore();
    await accepted(store);
    const requests: LlmRequest[] = [];
    const registry = createToolRegistry();
    registry.register({
      name: 'echo',
      description: 'Echo',
      parameters: { type: 'object' },
      inputSchema: z.object({}),
      execute: () => 'ok',
    });
    const runner = createAgentRunner({
      sessionStore: store,
      toolRegistry: registry,
      toolPipeline: createToolPipeline({ registry }),
      llm: {
        async *stream(value): AsyncIterable<StreamEvent> {
          requests.push(structuredClone(value));
          if (requests.length === 1) {
            yield { type: 'tool-call-start', id: 'call', name: 'echo' };
            yield { type: 'tool-call-delta', id: 'call', argumentsDelta: '{}' };
            yield { type: 'finish', reason: 'tool-call' };
          } else yield { type: 'finish', reason: 'stop' };
        },
      },
    });
    await collect(runner.run(request));
    await collect(
      runner.run({
        sessionId: 's',
        provider: 'mock',
        model: 'model',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
      }),
    );
    expect(requests).toHaveLength(3);
    for (const value of requests)
      expect(snapshots(value).map((bundle) => bundle.files[0]!.content)).toEqual([
        '\uFEFFbefore\r\n',
      ]);
    const durable = projectSession(await store.read('s'));
    expect(durable.messages.find((item) => item.messageId === 'user')?.message).toEqual(
      input.userMessage,
    );
    await store.close();
  });

  it.each(['queued', 'terminal'] as const)(
    'rejects %s before any message/Turn append, including omitted refs',
    async (phase) => {
      const store = createInMemorySessionEventStore();
      await accepted(store, phase);
      const before = await store.read('s');
      const requests: LlmRequest[] = [];
      const runner = createAgentRunner({ sessionStore: store, llm: recording(requests) });
      const { files: _files, ...omitted } = request;
      void _files;
      for (const value of [request, omitted])
        await expect(collect(runner.run(value))).rejects.toMatchObject({
          code: 'agent-invalid-input',
        });
      expect(await store.read('s')).toEqual(before);
      expect(requests).toHaveLength(0);
      await store.close();
    },
  );

  it.each([
    'missing-identity',
    'wrong-identity',
    'wrong-message',
    'wrong-refs',
    'omitted-refs',
    'wrong-provider',
    'wrong-permission',
  ] as const)('rejects %s with no new durable lifecycle', async (kind) => {
    const store = createInMemorySessionEventStore();
    await accepted(store);
    const before = await store.read('s');
    const requests: LlmRequest[] = [];
    const value: AgentRunRequest = {
      ...request,
      ...(kind === 'missing-identity' ? { executionIdentity: undefined } : {}),
      ...(kind === 'wrong-identity' ? { executionIdentity: { ...identity, turnId: 'other' } } : {}),
      ...(kind === 'wrong-message' ? { userMessage: { role: 'user', content: [] } } : {}),
      ...(kind === 'wrong-refs' ? { files: [{ path: 'b.txt' }] } : {}),
      ...(kind === 'omitted-refs' ? { files: undefined } : {}),
      ...(kind === 'wrong-provider' ? { provider: 'other' } : {}),
      ...(kind === 'wrong-permission' ? { permissionMode: 'yolo' } : {}),
    };
    await expect(
      collect(createAgentRunner({ sessionStore: store, llm: recording(requests) }).run(value)),
    ).rejects.toMatchObject({ code: 'agent-invalid-input' });
    expect(await store.read('s')).toEqual(before);
    expect(requests).toHaveLength(0);
    await store.close();
  });

  it('counts full saved text in the context budget and never calls the provider on overflow', async () => {
    const store = createInMemorySessionEventStore();
    await accepted(store, 'claimed', 'long-file-content '.repeat(400));
    const requests: LlmRequest[] = [];
    const runner = createAgentRunner({
      sessionStore: store,
      llm: recording(requests),
      context: { defaultWindowTokens: 600, reserveOutputTokens: 1, marginRatio: 0 },
    });
    const iterator = runner.run(request)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'context' } });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'agent-context-overflow' });
    expect(requests).toHaveLength(0);
    expect(projectSession(await store.read('s')).turns[0]).toMatchObject({
      status: 'failed',
      reason: 'agent-context-overflow',
    });
    await store.close();
  });

  it('rechecks the rendered request after middleware before invoking the provider', async () => {
    const store = createInMemorySessionEventStore();
    await accepted(store);
    const requests: LlmRequest[] = [];
    const runner = createAgentRunner({
      sessionStore: store,
      llm: recording(requests),
      context: { defaultWindowTokens: 1000, reserveOutputTokens: 1, marginRatio: 0 },
      llmMiddleware: (call, next) => {
        expect(snapshots(call.request)).toHaveLength(1);
        return next({
          ...call,
          request: {
            ...call.request,
            messages: [
              ...call.request.messages,
              {
                role: 'user',
                content: [{ type: 'text', text: 'middleware-growth '.repeat(1000) }],
              },
            ],
          },
        });
      },
    });
    await expect(collect(runner.run(request))).rejects.toMatchObject({
      code: 'agent-context-overflow',
    });
    expect(requests).toHaveLength(0);
    await store.close();
  });

  it('rejects an already-started exact captured identity before appending again', async () => {
    const store = createInMemorySessionEventStore();
    await accepted(store);
    const requests: LlmRequest[] = [];
    const runner = createAgentRunner({ sessionStore: store, llm: recording(requests) });
    await collect(runner.run(request));
    const before = await store.read('s');
    await expect(collect(runner.run(request))).rejects.toMatchObject({
      code: 'agent-invalid-input',
    });
    expect(await store.read('s')).toEqual(before);
    expect(requests).toHaveLength(1);
    await store.close();
  });

  it.each(['turnId', 'userMessageId'] as const)(
    'rejects a reused captured %s even with another execution id and no refs',
    async (field) => {
      const store = createInMemorySessionEventStore();
      await accepted(store, 'queued');
      const before = await store.read('s');
      const requests: LlmRequest[] = [];
      const { files: _files, ...withoutFiles } = request;
      void _files;
      const forged = {
        ...withoutFiles,
        executionIdentity: {
          executionId: 'other-execution',
          turnId: 'other-turn',
          userMessageId: 'other-user',
          [field]: identity[field],
        },
      };
      await expect(
        collect(createAgentRunner({ sessionStore: store, llm: recording(requests) }).run(forged)),
      ).rejects.toMatchObject({ code: 'agent-invalid-input' });
      expect(await store.read('s')).toEqual(before);
      expect(requests).toHaveLength(0);
      await store.close();
    },
  );
});
