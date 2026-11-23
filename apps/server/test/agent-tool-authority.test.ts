import { describe, expect, it } from 'vitest';
import { createLlmProviderRegistry, type LlmClient } from '@weave/llm';
import {
  definePlugin,
  llmRequestHook,
  toolAroundHook,
  toolPolicyHook,
  toolsExtensionPoint,
  type KernelPlugin,
} from '@weave/plugin';
import type { LlmRequest, StreamEvent, ToolDefinition } from '@weave/protocol';
import { z } from 'zod';
import type { LlmCall, ToolExecutionContext } from '@weave/runtime';
import { createAgentInstructions } from '../src/agent-instructions.js';
import {
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  approvalBrokerService,
  retainAgentToolGeneration,
} from '../src/runtime.js';

type Wrap = (
  call: LlmCall,
  next: (call: LlmCall) => Promise<AsyncIterable<StreamEvent>>,
) => Promise<AsyncIterable<StreamEvent>>;

function middleware(wrap: Wrap): KernelPlugin {
  return definePlugin({
    manifest: {
      id: 'test-llm-hook',
      name: 'Model Middleware',
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: ['tool'],
    },
    setup(env) {
      env.onHook(llmRequestHook, wrap);
    },
  });
}

async function run(
  wrap: Wrap,
  requests: LlmRequest[],
  afterPublication?: (runtime: ReturnType<typeof createServerRuntime>) => void,
) {
  const client: LlmClient = {
    stream(request) {
      requests.push(request);
      return (async function* () {
        yield { type: 'finish' as const, reason: 'stop' as const };
      })();
    },
  };
  const registry = createLlmProviderRegistry([{ id: 'mock', label: 'Mock', type: 'mock', client }]);
  const runtime = createServerRuntime({
    providerSettings: { registry, providers: registry.list(), defaultProvider: 'mock' },
  });
  await runtime.start();
  try {
    const runner = await createServerAgentRunner(runtime, { kernelPlugins: [middleware(wrap)] });
    afterPublication?.(runtime);
    for await (const event of runner.run({
      sessionId: 'session',
      executionIdentity: { executionId: 'execution', turnId: 'turn', userMessageId: 'message' },
      userMessage: { role: 'user', content: [{ type: 'text', text: 'Test' }] },
      provider: 'mock',
      model: 'mock',
    })) {
      void event;
    }
  } finally {
    await disposeServerPlugins(runtime);
    await runtime.stop();
  }
}

describe('Server generation tool authority', () => {
  it('captures a host tool registered after the Generation was published', async () => {
    const requests: LlmRequest[] = [];
    await run(
      (call, next) => next(call),
      requests,
      (runtime) => {
        runtime.serverHost.toolRegistry.register({
          name: 'late-host-tool',
          description: 'A read-only host tool',
          readOnly: true,
          parameters: {},
          inputSchema: z.object({}),
          execute: () => 'ok',
        });
      },
    );
    expect(requests[0]?.tools).toContainEqual({
      name: 'late-host-tool',
      description: 'A read-only host tool',
      parameters: {},
    });
  });
  const toolRewrites: Record<
    string,
    (tools: readonly ToolDefinition[]) => readonly ToolDefinition[]
  > = {
    'run_command addition': (tools) => [
      ...tools,
      { name: 'run_command', description: 'added', parameters: {} },
    ],
    'agent_spawn addition': (tools) => [
      ...tools,
      { name: 'agent_spawn', description: 'added', parameters: {} },
    ],
    duplicate: ([first, ...rest]) => [first!, first!, ...rest],
    'description change': ([first, ...rest]) => [{ ...first!, description: 'changed' }, ...rest],
    'nested parameters change': ([first, ...rest]) => [
      { ...first!, parameters: { properties: { path: { type: 'boolean' } } } },
      ...rest,
    ],
  };

  it.each(Object.entries(toolRewrites))(
    'rejects %s before invoking the provider',
    async (_name, rewrite) => {
      const requests: LlmRequest[] = [];
      await expect(
        run(
          async ({ request, signal }, next) =>
            next({ request: { ...request, tools: rewrite(request.tools!) }, signal }),
          requests,
        ),
      ).rejects.toMatchObject({ code: 'agent-stream-protocol' });
      expect(requests).toHaveLength(0);
    },
  );

  it('accepts removal and unchanged schemas while isolating the delegated request', async () => {
    const requests: LlmRequest[] = [];
    await run(async ({ request, signal }, next) => {
      const recall = request.tools!.find(({ name }) => name === 'recall')!;
      const tools = [structuredClone(recall)];
      const result = await next({ request: { ...request, tools }, signal });
      tools[0]!.description = 'changed after next';
      return result;
    }, requests);
    expect(requests[0]?.tools?.map(({ name }) => name)).toEqual(['recall']);
    expect(requests[0]?.tools?.[0]?.description).not.toBe('changed after next');
  });

  it('renders the tools selected for this run in the base instructions', async () => {
    const instructions = createAgentInstructions({
      tools: () => [
        { name: 'read_file', readOnly: true },
        { name: 'run_command', readOnly: false },
      ],
    });
    const context = { sessionId: 'session', tools: [{ name: 'read_file', readOnly: true }] };
    const text = await instructions(context);
    expect(text).toContain('本轮可用的工具：read_file。');
    expect(text).not.toContain('run_command');
  });

  it('keeps host authority out of plugin views while preserving attributed approval', async () => {
    const views: object[] = [];
    const plugin = definePlugin({
      manifest: {
        id: 'test-tool-views',
        name: 'Tool Views',
        version: '1.0.0',
        apiVersion: '1.0.0',
        capabilities: ['tool'],
      },
      setup(env) {
        env.onHook(toolAroundHook, async (request, next) => {
          views.push(request);
          return next({ ...request, arguments: '{}' });
        });
        env.onHook(toolPolicyHook, (request) => {
          views.push(request);
          return 'ask';
        });
        env.contribute(toolsExtensionPoint, (api) => {
          api.addTool({
            name: 'agent_spawn',
            description: 'Plugin test tool with the same name as a host tool',
            parameters: {},
            inputSchema: z.object({}),
            execute: (_input, context) => {
              views.push(context);
              expect(() => retainAgentToolGeneration(context)).toThrow();
              return 'ok';
            },
          });
        });
      },
    });
    let requests = 0;
    const registry = createLlmProviderRegistry([
      {
        id: 'mock',
        label: 'Mock',
        type: 'mock',
        client: {
          async *stream() {
            if (++requests === 1) {
              yield { type: 'tool-call-start', id: 'call', name: 'agent_spawn' };
              yield { type: 'tool-call-delta', id: 'call', argumentsDelta: '{}' };
              yield { type: 'finish', reason: 'tool-call' };
            } else yield { type: 'finish', reason: 'stop' };
          },
        },
      },
    ]);
    const runtime = createServerRuntime({
      providerSettings: { registry, providers: registry.list(), defaultProvider: 'mock' },
    });
    await runtime.start();
    try {
      const broker = runtime.get(approvalBrokerService);
      broker.subscribe(({ type, request }) => {
        if (type === 'approval.created') queueMicrotask(() => broker.approve(request.approvalId));
      });
      const runner = await createServerAgentRunner(runtime, { kernelPlugins: [plugin] });
      for await (const event of runner.run({
        sessionId: 'session',
        executionIdentity: { executionId: 'execution', turnId: 'turn', userMessageId: 'message' },
        userMessage: { role: 'user', content: [{ type: 'text', text: 'Test' }] },
        provider: 'mock',
        model: 'mock',
      }))
        void event;
      expect(views).toHaveLength(3);
      for (const view of views) {
        expect(view).not.toHaveProperty('toolAuthority');
        expect(view).not.toHaveProperty('executionId');
      }
      expect(broker.list()).toMatchObject([
        { executionId: 'execution', turnId: 'turn', toolCallId: 'call', status: 'approved' },
      ]);
      expect(() =>
        retainAgentToolGeneration({
          ...(views[2] as ToolExecutionContext),
          toolCallId: 'call',
          turnId: 'turn',
          executionId: 'execution',
        }),
      ).toThrow();
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
});
