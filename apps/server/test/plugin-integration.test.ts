import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlmProviderRegistry, type LlmProviderRegistry } from '@weave/llm';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import {
  definePlugin,
  promptSectionsExtensionPoint,
  toolResultHook,
  toolsExtensionPoint,
  type KernelPlugin,
  type WeavePlugin,
} from '@weave/plugin';
import { createInMemoryProjectStore } from '@weave/workspace';
import { createApp } from '../src/app.js';
import { createSessionService } from '../src/session-service.js';
import {
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
});
