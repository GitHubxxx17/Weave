import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLlmProviderRegistry, type LlmProviderRegistry } from '@weave/llm';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import {
  definePlugin,
  llmRequestHook,
  promptSectionsExtensionPoint,
  toolAroundHook,
  toolPolicyHook,
  toolResultHook,
  toolsExtensionPoint,
  turnEndHook,
  turnStartHook,
  type KernelPlugin,
  type PolicyVote,
  type TurnEndInfo,
  type TurnInfo,
  type WeavePlugin,
} from '@weave/plugin';
import type { ToolExecutionRequest, ToolExecutionResult, LlmCall } from '@weave/runtime';
import { createInMemoryProjectStore } from '@weave/workspace';
import { createApp } from '../src/app.js';
import { createSessionService } from '../src/session-service.js';
import {
  approvalBrokerService,
  createServerAgentRunner,
  createServerRuntime,
  getServerSessionStore,
  registerServerPlugins,
} from '../src/runtime.js';

const sessionId = 'plugin-integration-session';
const resources: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

function createProviderSettings(registry: LlmProviderRegistry) {
  return {
    registry,
    providers: registry.list(),
    defaultProvider: 'mock',
  } as const;
}

function createSequenceClient(scripts: readonly (readonly StreamEvent[])[]) {
  let requestIndex = 0;

  return {
    async *stream() {
      const script = scripts[requestIndex];
      requestIndex += 1;
      if (script === undefined) {
        throw new Error('Unexpected mock Provider request');
      }
      yield* script;
    },
  };
}

/** A mock client that records each request and replies with one text turn. */
function createCapturingClient(onRequest: (request: LlmRequest) => void) {
  return {
    async *stream(request: LlmRequest): AsyncIterable<StreamEvent> {
      onRequest(request);
      yield { type: 'text-delta', text: '完成' };
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

function systemInstructionText(request: LlmRequest): string {
  const system = request.messages.find((message) => message.role === 'system');
  return system === undefined
    ? ''
    : system.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

async function createSessionServiceForRuntime(
  runtime: Parameters<typeof getServerSessionStore>[0],
) {
  const projectStore = createInMemoryProjectStore();
  const project = await projectStore.createProject({
    name: 'Plugin Integration',
    folderName: 'plugin-integration',
  });
  const sessionStore = getServerSessionStore(runtime);
  await sessionStore.append(sessionId, [
    {
      type: 'session.created',
      payload: { title: '插件集成测试' },
    },
  ]);
  await projectStore.attachSession(project.id, sessionId);
  resources.push(projectStore);
  return createSessionService({ projectStore, sessionStore });
}

const echoPlugin: WeavePlugin = {
  manifest: {
    id: 'server-echo',
    name: 'Server Echo',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['tool'],
  },
  setup(context) {
    context.registerTool({
      name: 'echo',
      description: '回显文本',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      inputSchema: z.object({ text: z.string() }),
      execute: ({ text }) => text,
    });
  },
};

describe('Server Plugin integration', () => {
  it('routes a plugin Tool through the Agent Runner and Tool Pipeline', async () => {
    const providerRegistry = createLlmProviderRegistry([
      {
        id: 'mock',
        label: '本地演示',
        type: 'mock',
        client: createSequenceClient([
          [
            { type: 'tool-call-start', id: 'call-1', name: 'echo' },
            { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{"text":"来自插件"}' },
            { type: 'finish', reason: 'tool-call' },
          ],
          [
            { type: 'text-delta', text: '插件工具执行完成' },
            { type: 'finish', reason: 'stop' },
          ],
        ]),
        defaultModel: 'test-model',
      },
    ]);
    const runtime = createServerRuntime({
      providerSettings: createProviderSettings(providerRegistry),
    });
    await runtime.start();

    try {
      await registerServerPlugins(runtime, [echoPlugin]);
      const sessionService = await createSessionServiceForRuntime(runtime);
      const response = await createApp(runtime, {
        agentRunner: await createServerAgentRunner(runtime),
        sessionService,
      }).request('/agent/runs/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          userMessage: {
            role: 'user',
            content: [{ type: 'text', text: '调用 echo' }],
          },
          provider: 'mock',
          model: 'test-model',
        }),
      });

      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain(
        'event: tool-result\ndata: {"type":"tool-result","result":{"toolCallId":"call-1","name":"echo","content":"来自插件","truncated":false}}',
      );
      expect(body).toContain('event: text-delta');
      expect(body).toContain('插件工具执行完成');
      expect(body).toMatch(/event: completed\ndata: \{"type":"completed","turnId":"[^"]+"\}\n\n$/);
    } finally {
      await runtime.stop();
    }
  });

  it('does not register a plugin when its API version is unsupported', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    try {
      await expect(
        registerServerPlugins(runtime, [
          {
            ...echoPlugin,
            manifest: { ...echoPlugin.manifest, apiVersion: '2.0.0' },
          },
        ]),
      ).rejects.toMatchObject({ code: 'plugin-api-version-unsupported' });
    } finally {
      await runtime.stop();
    }
  });

  it('lets a kernel plugin contribute a tool and observe its result', async () => {
    const providerRegistry = createLlmProviderRegistry([
      {
        id: 'mock',
        label: '本地演示',
        type: 'mock',
        client: createSequenceClient([
          [
            { type: 'tool-call-start', id: 'call-1', name: 'ping' },
            { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{}' },
            { type: 'finish', reason: 'tool-call' },
          ],
          [
            { type: 'text-delta', text: '完成' },
            { type: 'finish', reason: 'stop' },
          ],
        ]),
        defaultModel: 'test-model',
      },
    ]);
    const runtime = createServerRuntime({
      providerSettings: createProviderSettings(providerRegistry),
    });
    await runtime.start();

    const observed: string[] = [];
    const pingPlugin: KernelPlugin = definePlugin({
      manifest: {
        id: 'ping',
        name: 'Ping',
        version: '1.0.0',
        apiVersion: '1.0.0',
        capabilities: ['tool'],
      },
      setup(env) {
        env.contribute(toolsExtensionPoint, (api) => {
          api.addTool({
            name: 'ping',
            description: '回 pong',
            parameters: { type: 'object', properties: {} },
            inputSchema: z.object({}),
            execute: () => 'pong',
          });
        });
        env.onHook(toolResultHook, (result: { readonly name: string }) => {
          observed.push(result.name);
        });
      },
    });

    try {
      const sessionService = await createSessionServiceForRuntime(runtime);
      const response = await createApp(runtime, {
        agentRunner: await createServerAgentRunner(runtime, { kernelPlugins: [pingPlugin] }),
        sessionService,
      }).request('/agent/runs/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          userMessage: { role: 'user', content: [{ type: 'text', text: '调用 ping' }] },
          provider: 'mock',
          model: 'test-model',
        }),
      });

      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain('"name":"ping","content":"pong"');
      expect(observed).toEqual(['ping']);
    } finally {
      await runtime.stop();
    }
  });

  it('appends plugin-contributed prompt sections to the system instructions in order', async () => {
    let systemText = '';
    const providerRegistry = createLlmProviderRegistry([
      {
        id: 'mock',
        label: '本地演示',
        type: 'mock',
        client: createCapturingClient((request) => {
          systemText = systemInstructionText(request);
        }),
        defaultModel: 'test-model',
      },
    ]);
    const runtime = createServerRuntime({
      providerSettings: createProviderSettings(providerRegistry),
    });
    await runtime.start();

    const promptPlugin: KernelPlugin = definePlugin({
      manifest: {
        id: 'prompt-contributor',
        name: 'Prompt Contributor',
        version: '1.0.0',
        apiVersion: '1.0.0',
        capabilities: ['prompt'],
        contributes: { promptSections: ['earlier', 'later'] },
      },
      setup(env) {
        env.contribute(promptSectionsExtensionPoint, (api) => {
          // Contributed out of order to prove the host sorts by `order`.
          api.addSection({ id: 'later', order: 20, text: '[[SECTION_LATER]]' });
          api.addSection({ id: 'earlier', order: 10, text: '[[SECTION_EARLIER]]' });
        });
      },
    });

    try {
      const sessionService = await createSessionServiceForRuntime(runtime);
      const response = await createApp(runtime, {
        agentRunner: await createServerAgentRunner(runtime, { kernelPlugins: [promptPlugin] }),
        sessionService,
      }).request('/agent/runs/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          userMessage: { role: 'user', content: [{ type: 'text', text: '你好' }] },
          provider: 'mock',
          model: 'test-model',
        }),
      });

      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain('完成');
      expect(systemText).toContain('[[SECTION_EARLIER]]');
      expect(systemText).toContain('[[SECTION_LATER]]');
      expect(systemText.indexOf('[[SECTION_EARLIER]]')).toBeLessThan(
        systemText.indexOf('[[SECTION_LATER]]'),
      );
    } finally {
      await runtime.stop();
    }
  });

  it('refuses to create the Agent Runner when a plugin adds a tool its manifest does not list', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    const unlistedPlugin: KernelPlugin = definePlugin({
      manifest: {
        id: 'unlisted-tool',
        name: 'Unlisted Tool',
        version: '1.0.0',
        apiVersion: '1.0.0',
        capabilities: ['tool'],
        contributes: { tools: ['listed'] },
      },
      setup(env) {
        env.contribute(toolsExtensionPoint, (api) => {
          api.addTool({
            name: 'unlisted',
            description: '清单之外的工具',
            parameters: { type: 'object', properties: {} },
            inputSchema: z.object({}),
            execute: () => 'x',
          });
        });
      },
    });

    try {
      await expect(
        createServerAgentRunner(runtime, { kernelPlugins: [unlistedPlugin] }),
      ).rejects.toMatchObject({ code: 'plugin-contributes-exceeds-manifest' });
    } finally {
      await runtime.stop();
    }
  });

  it('lets a kernel plugin wrap each tool execution, outside the result observers', async () => {
    const providerRegistry = createLlmProviderRegistry([
      {
        id: 'mock',
        label: '本地演示',
        type: 'mock',
        client: createSequenceClient([
          [
            { type: 'tool-call-start', id: 'call-1', name: 'ping' },
            { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{}' },
            { type: 'finish', reason: 'tool-call' },
          ],
          [
            { type: 'text-delta', text: '完成' },
            { type: 'finish', reason: 'stop' },
          ],
        ]),
        defaultModel: 'test-model',
      },
    ]);
    const runtime = createServerRuntime({
      providerSettings: createProviderSettings(providerRegistry),
    });
    await runtime.start();

    const observed: string[] = [];
    const wrapped: string[] = [];
    const shoutPlugin: KernelPlugin = definePlugin({
      manifest: {
        id: 'shout',
        name: 'Shout',
        version: '1.0.0',
        apiVersion: '1.0.0',
        capabilities: ['tool'],
      },
      setup(env) {
        env.contribute(toolsExtensionPoint, (api) => {
          api.addTool({
            name: 'ping',
            description: '回 pong',
            parameters: { type: 'object', properties: {} },
            inputSchema: z.object({}),
            execute: () => 'pong',
          });
        });
        env.onHook(
          toolAroundHook,
          async (
            request: ToolExecutionRequest,
            next: (request: ToolExecutionRequest) => Promise<ToolExecutionResult>,
          ) => {
            wrapped.push(request.name);
            const result = await next(request);
            return { ...result, content: result.content.toUpperCase() };
          },
        );
        env.onHook(toolResultHook, (result: { readonly content: string }) => {
          observed.push(result.content);
        });
      },
    });

    try {
      const sessionService = await createSessionServiceForRuntime(runtime);
      const response = await createApp(runtime, {
        agentRunner: await createServerAgentRunner(runtime, { kernelPlugins: [shoutPlugin] }),
        sessionService,
      }).request('/agent/runs/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          userMessage: { role: 'user', content: [{ type: 'text', text: '调用 ping' }] },
          provider: 'mock',
          model: 'test-model',
        }),
      });

      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain('"name":"ping","content":"PONG"');
      expect(wrapped).toEqual(['ping']);
      // Observers see what the model sees: the wrapped result.
      expect(observed).toEqual(['PONG']);
    } finally {
      await runtime.stop();
    }
  });

  describe('turn hooks', () => {
    function turnRecorder(turns: string[]): KernelPlugin {
      return definePlugin({
        manifest: {
          id: 'turn-recorder',
          name: 'Turn Recorder',
          version: '1.0.0',
          apiVersion: '1.0.0',
          capabilities: ['tool'],
        },
        setup(env) {
          env.onHook(turnStartHook, (info: TurnInfo) => {
            turns.push(`start ${info.sessionId} ${info.turnId}`);
          });
          env.onHook(turnEndHook, (info: TurnEndInfo) => {
            turns.push(`end ${info.turnId} ${info.status}`);
          });
        },
      });
    }

    async function runTurn(client: ReturnType<typeof createSequenceClient>, plugin: KernelPlugin) {
      const providerRegistry = createLlmProviderRegistry([
        { id: 'mock', label: '本地演示', type: 'mock', client, defaultModel: 'test-model' },
      ]);
      const runtime = createServerRuntime({
        providerSettings: createProviderSettings(providerRegistry),
      });
      await runtime.start();
      try {
        const sessionService = await createSessionServiceForRuntime(runtime);
        const response = await createApp(runtime, {
          agentRunner: await createServerAgentRunner(runtime, { kernelPlugins: [plugin] }),
          sessionService,
        }).request('/agent/runs/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            userMessage: { role: 'user', content: [{ type: 'text', text: '你好' }] },
            provider: 'mock',
            model: 'test-model',
          }),
        });
        return await response.text();
      } finally {
        await runtime.stop();
      }
    }

    it('announces the start and the end of a finished turn to kernel plugins', async () => {
      const turns: string[] = [];

      const body = await runTurn(
        createSequenceClient([
          [
            { type: 'text-delta', text: '完成' },
            { type: 'finish', reason: 'stop' },
          ],
        ]),
        turnRecorder(turns),
      );

      const turnId = /"type":"completed","turnId":"([^"]+)"/.exec(body)?.[1];
      expect(turnId).toBeDefined();
      expect(turns).toEqual([`start ${sessionId} ${turnId}`, `end ${turnId} completed`]);
    });

    it('announces the end of a turn that failed', async () => {
      const turns: string[] = [];

      await runTurn(createSequenceClient([]), turnRecorder(turns));

      expect(turns).toHaveLength(2);
      expect(turns[0]).toMatch(/^start /);
      expect(turns[1]).toMatch(/ failed$/);
    });
  });

  describe('llm request hook', () => {
    type Next = (call: LlmCall) => Promise<AsyncIterable<StreamEvent>>;

    function middlewarePlugin(
      wrap: (call: LlmCall, next: Next) => Promise<AsyncIterable<StreamEvent>>,
    ): KernelPlugin {
      return definePlugin({
        manifest: {
          id: 'llm-middleware',
          name: 'LLM Middleware',
          version: '1.0.0',
          apiVersion: '1.0.0',
          capabilities: ['tool'],
        },
        setup(env) {
          env.onHook(llmRequestHook, wrap);
        },
      });
    }

    async function runChat(client: unknown, plugin: KernelPlugin) {
      const providerRegistry = createLlmProviderRegistry([
        {
          id: 'mock',
          label: '本地演示',
          type: 'mock',
          client: client as ReturnType<typeof createSequenceClient>,
          defaultModel: 'test-model',
        },
      ]);
      const runtime = createServerRuntime({
        providerSettings: createProviderSettings(providerRegistry),
      });
      await runtime.start();
      try {
        const sessionService = await createSessionServiceForRuntime(runtime);
        const response = await createApp(runtime, {
          agentRunner: await createServerAgentRunner(runtime, { kernelPlugins: [plugin] }),
          sessionService,
        }).request('/agent/runs/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            userMessage: { role: 'user', content: [{ type: 'text', text: '我的密码是 hunter2' }] },
            provider: 'mock',
            model: 'test-model',
          }),
        });
        return await response.text();
      } finally {
        await runtime.stop();
      }
    }

    it('lets a plugin transform the model stream', async () => {
      const body = await runChat(
        createSequenceClient([
          [
            { type: 'text-delta', text: 'hello' },
            { type: 'finish', reason: 'stop' },
          ],
        ]),
        middlewarePlugin(async (call, next) => {
          const source = await next(call);
          return (async function* () {
            for await (const event of source) {
              yield event.type === 'text-delta'
                ? { ...event, text: event.text.toUpperCase() }
                : event;
            }
          })();
        }),
      );

      expect(body).toContain('HELLO');
      expect(body).not.toContain('hello');
    });

    it('lets a plugin change what is sent to the model, such as redacting a secret', async () => {
      const requests: LlmRequest[] = [];

      await runChat(
        createCapturingClient((request) => requests.push(request)),
        middlewarePlugin((call, next) =>
          next({
            ...call,
            request: {
              ...call.request,
              messages: call.request.messages.map((message) => ({
                ...message,
                content: message.content.map((part) =>
                  part.type === 'text'
                    ? { ...part, text: part.text.replace('hunter2', '[已脱敏]') }
                    : part,
                ),
              })),
            },
          }),
        ),
      );

      const sent = requests[0]?.messages
        .flatMap((message) => message.content)
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
      expect(sent).toContain('[已脱敏]');
      expect(sent).not.toContain('hunter2');
    });

    it('lets a plugin retry before it has yielded anything', async () => {
      const body = await runChat(
        createSequenceClient([
          [
            { type: 'text-delta', text: 'first attempt' },
            { type: 'finish', reason: 'stop' },
          ],
          [
            { type: 'text-delta', text: 'second attempt' },
            { type: 'finish', reason: 'stop' },
          ],
        ]),
        middlewarePlugin(async (call, next) => {
          for await (const ignored of await next(call)) {
            void ignored;
          }
          return next(call);
        }),
      );

      expect(body).toContain('second attempt');
      expect(body).not.toContain('first attempt');
    });

    it('does not let a plugin send the conversation to another model', async () => {
      const requests: LlmRequest[] = [];

      const body = await runChat(
        createCapturingClient((request) => requests.push(request)),
        middlewarePlugin((call, next) =>
          next({ ...call, request: { ...call.request, model: 'another-model' } }),
        ),
      );

      expect(body).toContain('event: error');
      expect(body).toContain('agent-stream-protocol');
      expect(requests).toHaveLength(0);
    });
  });

  describe('tool policy', () => {
    type Vote = (request: ToolExecutionRequest) => PolicyVote;

    async function runPing(votes: readonly Vote[], answer?: 'approve' | 'reject') {
      const execute = vi.fn(() => 'pong');
      const policyPlugin: KernelPlugin = definePlugin({
        manifest: {
          id: 'policy-tool',
          name: 'Policy Tool',
          version: '1.0.0',
          apiVersion: '1.0.0',
          capabilities: ['tool'],
        },
        setup(env) {
          env.contribute(toolsExtensionPoint, (api) => {
            api.addTool({
              name: 'ping',
              description: '回 pong',
              parameters: { type: 'object', properties: {} },
              inputSchema: z.object({}),
              execute,
            });
          });
          for (const vote of votes) {
            env.onHook(toolPolicyHook, vote);
          }
        },
      });
      const providerRegistry = createLlmProviderRegistry([
        {
          id: 'mock',
          label: '本地演示',
          type: 'mock',
          client: createSequenceClient([
            [
              { type: 'tool-call-start', id: 'call-1', name: 'ping' },
              { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{}' },
              { type: 'finish', reason: 'tool-call' },
            ],
            [
              { type: 'text-delta', text: '完成' },
              { type: 'finish', reason: 'stop' },
            ],
          ]),
          defaultModel: 'test-model',
        },
      ]);
      const runtime = createServerRuntime({
        providerSettings: createProviderSettings(providerRegistry),
      });
      await runtime.start();
      try {
        const sessionService = await createSessionServiceForRuntime(runtime);
        const response = await createApp(runtime, {
          agentRunner: await createServerAgentRunner(runtime, { kernelPlugins: [policyPlugin] }),
          sessionService,
        }).request('/agent/runs/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            userMessage: { role: 'user', content: [{ type: 'text', text: '调用 ping' }] },
            provider: 'mock',
            model: 'test-model',
          }),
        });
        const bodyPromise = response.text();
        const broker = runtime.get(approvalBrokerService);
        const pending = () => broker.list().filter((approval) => approval.status === 'pending');
        const asked: { operation: string; toolName: string }[] = [];
        if (answer !== undefined) {
          await vi.waitFor(() => expect(pending()).toHaveLength(1));
          const approval = pending()[0]!;
          asked.push({ operation: approval.operation, toolName: approval.toolName });
          if (answer === 'approve') {
            broker.approve(approval.approvalId);
          } else {
            broker.reject(approval.approvalId);
          }
        }
        return { body: await bodyPromise, execute, asked, approvals: broker.list().length };
      } finally {
        await runtime.stop();
      }
    }

    it('runs the tool when every policy abstains', async () => {
      const { body, execute, approvals } = await runPing([() => 'abstain']);

      expect(body).toContain('"name":"ping","content":"pong"');
      expect(execute).toHaveBeenCalledOnce();
      expect(approvals).toBe(0);
    });

    it('stops a denied call and tells the model why it failed', async () => {
      const { body, execute } = await runPing([() => 'deny']);

      expect(body).toContain('"errorCode":"tool-denied"');
      expect(body).toContain('event: completed');
      expect(execute).not.toHaveBeenCalled();
    });

    it('asks the user before running a call a policy asked about', async () => {
      const { body, execute, asked } = await runPing([() => 'ask'], 'approve');

      expect(asked).toEqual([{ operation: 'plugin.policy', toolName: 'ping' }]);
      expect(body).toContain('"name":"ping","content":"pong"');
      expect(execute).toHaveBeenCalledOnce();
    });

    it('does not run a call the user rejected after a policy asked', async () => {
      const { body, execute } = await runPing([() => 'ask'], 'reject');

      expect(body).toContain('"errorCode":"tool-approval-rejected"');
      expect(execute).not.toHaveBeenCalled();
    });

    it('takes the strictest vote across policies', async () => {
      const denied = await runPing([() => 'ask', () => 'deny', () => 'abstain']);
      const asked = await runPing([() => 'abstain', () => 'ask'], 'approve');

      expect(denied.body).toContain('"errorCode":"tool-denied"');
      expect(denied.execute).not.toHaveBeenCalled();
      expect(asked.asked).toHaveLength(1);
      expect(asked.execute).toHaveBeenCalledOnce();
    });

    it('denies the call when a policy throws', async () => {
      const { body, execute } = await runPing([
        () => {
          throw new Error('policy bug');
        },
      ]);

      expect(body).toContain('"errorCode":"tool-denied"');
      expect(execute).not.toHaveBeenCalled();
    });

    it('denies the call when a policy votes allow, which no policy can', async () => {
      const { body, execute } = await runPing([(() => 'allow') as unknown as Vote]);

      expect(body).toContain('"errorCode":"tool-denied"');
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
