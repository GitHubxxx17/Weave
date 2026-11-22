import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLlmProviderRegistry, type LlmClient } from '@weave/llm';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import { createPluginSdk, definePlugin } from '@weave/plugin';
import { createAgentRunner, createApprovalBroker, createToolRegistry } from '@weave/runtime';
import { createSqliteSessionEventStore, projectSession } from '@weave/session';
import { assembleAgentKernel } from '../src/agent-kernel.js';
import { createWebModule } from '../../../plugins/official/weave-web-source/src/tools.js';

/** Real Kernel/Pipeline/Runner/SQLite; only remote HTTP and the model are deterministic adapters. */
describe('official web results across model loops and durable restart', () => {
  it('retains exact full citations and safe failures in future requests after SQLite reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weave-web-model-'));
    const filename = join(root, 'session.sqlite');
    let store = createSqliteSessionEventStore({ filename });
    let calls = 0;
    const requests: LlmRequest[] = [];
    const llm: LlmClient = {
      async *stream(request): AsyncIterable<StreamEvent> {
        requests.push(structuredClone(request));
        if (calls++ === 0) {
          yield { type: 'tool-call-start', id: 'source-call', name: 'web_fetch' };
          yield {
            type: 'tool-call-delta',
            id: 'source-call',
            argumentsDelta: JSON.stringify({ url: 'https://example.com/actual-source' }),
          };
          yield { type: 'finish', reason: 'tool-call' };
        } else if (calls === 3) {
          yield { type: 'tool-call-start', id: 'failure-call', name: 'web_fetch' };
          yield {
            type: 'tool-call-delta',
            id: 'failure-call',
            argumentsDelta: JSON.stringify({ url: 'https://127.0.0.1/' }),
          };
          yield { type: 'finish', reason: 'tool-call' };
        } else {
          yield { type: 'text-delta', text: '[Source](https://example.com/actual-source)' };
          yield { type: 'finish', reason: 'stop' };
        }
      },
    };
    const sdk = createPluginSdk();
    const module = createWebModule(sdk, {
      configuration: { status: 'unconfigured' },
      http: {
        request: async () => ({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          bytes: Buffer.from('Full public evidence. '.repeat(1500)),
        }),
      },
    });
    const plugin = definePlugin({
      manifest: {
        id: 'weave-web',
        name: 'Weave 联网',
        version: '0.1.0',
        apiVersion: '1.0.0',
        capabilities: ['tool'],
        contributes: { tools: ['web_fetch', 'web_search'] },
        permissions: ['network:request'],
      },
      setup: (env) => module.setup(env),
    });
    async function assembly() {
      const registry = createToolRegistry();
      const assembled = await assembleAgentKernel({
        toolRegistry: registry,
        providerRegistry: createLlmProviderRegistry(),
        approvalBroker: createApprovalBroker(),
        sessionStore: store,
        timeoutMs: 1000,
        registeredPlugins: [plugin],
      });
      const runner = createAgentRunner({
        llm,
        sessionStore: store,
        toolRegistry: registry,
        toolPipeline: assembled.toolPipeline,
      });
      return { ...assembled, runner };
    }
    let assembled: Awaited<ReturnType<typeof assembly>> | undefined;
    try {
      await store.append('web-session', [{ type: 'session.created', payload: {} }]);
      assembled = await assembly();
      for await (const _event of assembled.runner.run({
        sessionId: 'web-session',
        provider: 'mock',
        model: 'fixture',
        permissionMode: 'yolo',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'Read public evidence.' }] },
      }))
        void _event;
      const firstEvents = await store.read('web-session');
      const result = firstEvents.find((event) => event.type === 'tool-result.created');
      expect(result?.type).toBe('tool-result.created');
      if (result?.type !== 'tool-result.created') throw new Error('missing tool result');
      expect(result.payload.truncated).toBe(false);
      const parsed: unknown = JSON.parse(result.payload.content);
      expect(parsed).toMatchObject({
        kind: 'web-fetch',
        truncated: true,
        source: { url: 'https://example.com/actual-source' },
      });
      expect(Buffer.byteLength(result.payload.content)).toBeLessThanOrEqual(12_288);
      expect(JSON.stringify(requests[1]!.messages)).toContain('https://example.com/actual-source');
      expect(
        requests[1]!.messages
          .flatMap((message) => message.content)
          .some((part) => part.type === 'text' && part.text === result.payload.content),
      ).toBe(true);
      await assembled.kernel.dispose();
      assembled = undefined;
      await store.close();
      store = createSqliteSessionEventStore({ filename });
      assembled = await assembly();
      for await (const _event of assembled.runner.run({
        sessionId: 'web-session',
        provider: 'mock',
        model: 'fixture',
        permissionMode: 'yolo',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'Recheck sources.' }] },
      }))
        void _event;
      expect(JSON.stringify(requests[2]!.messages)).toContain('https://example.com/actual-source');
      const events = await store.read('web-session');
      const failures = events.filter(
        (event) => event.type === 'tool-result.created' && event.payload.status === 'failed',
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]!.payload).toMatchObject({
        name: 'web_fetch',
        errorCode: 'tool-execution-failed',
      });
      expect(JSON.stringify(failures[0]!.payload)).toContain('web-url-blocked');
      expect(JSON.stringify(requests[3]!.messages)).toContain('web-url-blocked');
      expect(projectSession(events).turns.map((turn) => turn.status)).toEqual([
        'completed',
        'completed',
      ]);
    } finally {
      await assembled?.kernel.dispose();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
