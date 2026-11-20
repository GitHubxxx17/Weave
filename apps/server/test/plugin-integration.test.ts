import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlmProviderRegistry, type LlmProviderRegistry } from '@weave/llm';
import type { StreamEvent } from '@weave/protocol';
import type { WeavePlugin } from '@weave/plugin';
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
});
