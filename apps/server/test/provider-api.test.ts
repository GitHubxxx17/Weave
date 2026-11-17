import { describe, expect, it } from 'vitest';
import { createRuntime } from '@weave/runtime';
import { createApp } from '../src/app.js';
import { createServerLlmProviders, ServerLlmProviderConfigError } from '../src/llm-providers.js';
import type { ProviderSettingsManager } from '../src/provider-settings-manager.js';
import type { ProviderSettingsDescriptor } from '../src/provider-settings-types.js';

const publicDeepSeek: ProviderSettingsDescriptor = {
  id: 'deepseek',
  label: 'DeepSeek',
  type: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-chat',
  hasApiKey: true,
  editable: true,
};

function createManagerStub(): {
  readonly manager: ProviderSettingsManager;
  readonly calls: {
    readonly created: unknown[];
    readonly updated: unknown[];
    readonly removed: string[];
    readonly defaults: string[];
  };
} {
  const calls = {
    created: [] as unknown[],
    updated: [] as unknown[],
    removed: [] as string[],
    defaults: [] as string[],
  };
  let descriptor: ProviderSettingsDescriptor = publicDeepSeek;
  const manager: ProviderSettingsManager = {
    async list() {
      return [descriptor];
    },
    async create(input) {
      calls.created.push(input);
      descriptor = publicDeepSeek;
      return descriptor;
    },
    async update(id, input) {
      calls.updated.push({ id, input });
      return descriptor;
    },
    async remove(id) {
      calls.removed.push(id);
    },
    async setDefault(id) {
      calls.defaults.push(id);
    },
    getDefaultProvider() {
      return 'deepseek';
    },
    async refresh() {},
  };
  return { manager, calls };
}

describe('Server LLM Provider configuration', () => {
  it('always exposes the local mock Provider by default', () => {
    const settings = createServerLlmProviders({ environment: {} });

    expect(settings.providers).toEqual([
      {
        id: 'mock',
        label: '本地演示',
        type: 'mock',
        defaultModel: 'weave-local-demo',
      },
    ]);
    expect(settings.defaultProvider).toBe('mock');
  });

  it('registers configured OpenAI-compatible Providers without exposing API keys', () => {
    const settings = createServerLlmProviders({
      environment: {
        WEAVE_LLM_PROVIDERS: JSON.stringify([
          {
            id: 'deepseek',
            label: 'DeepSeek',
            type: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKey: 'server-secret',
            defaultModel: 'deepseek-chat',
          },
        ]),
      },
    });

    expect(settings.providers).toContainEqual({
      id: 'deepseek',
      label: 'DeepSeek',
      type: 'openai-compatible',
      defaultModel: 'deepseek-chat',
    });
    expect(settings.defaultProvider).toBe('deepseek');
    expect(JSON.stringify(settings.providers)).not.toContain('server-secret');
    expect(settings.registry.get('deepseek')).toBeDefined();
  });

  it.each([
    ['not-json', 'Provider configuration is invalid'],
    [
      JSON.stringify([
        {
          id: 'deepseek',
          label: 'DeepSeek',
          type: 'openai-compatible',
          baseUrl: 'not-a-url',
          apiKey: 'server-secret',
          defaultModel: 'deepseek-chat',
        },
      ]),
      'Provider configuration is invalid',
    ],
  ])('rejects invalid Provider configuration: %s', (value, message) => {
    expect(() =>
      createServerLlmProviders({
        environment: { WEAVE_LLM_PROVIDERS: value },
      }),
    ).toThrowError(new ServerLlmProviderConfigError(message));
  });

  it('rejects duplicate Provider ids', () => {
    expect(() =>
      createServerLlmProviders({
        environment: {
          WEAVE_LLM_PROVIDERS: JSON.stringify([
            {
              id: 'mock',
              label: 'Duplicate',
              type: 'openai-compatible',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'server-secret',
              defaultModel: 'test-model',
            },
          ]),
        },
      }),
    ).toThrow('LLM provider "mock" is already registered');
  });
});

describe('GET /settings/providers', () => {
  it('returns public Provider metadata without private configuration', async () => {
    const runtime = createRuntime();
    await runtime.start();
    const settings = createServerLlmProviders({
      environment: {
        WEAVE_LLM_PROVIDERS: JSON.stringify([
          {
            id: 'deepseek',
            label: 'DeepSeek',
            type: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKey: 'server-secret',
            defaultModel: 'deepseek-chat',
          },
        ]),
      },
    });

    try {
      const response = await createApp(runtime, {
        providerRegistry: settings.registry,
        defaultProvider: settings.defaultProvider,
      }).request('/settings/providers');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        providers: settings.providers.map((provider) => ({
          ...provider,
          hasApiKey: provider.type !== 'mock',
          editable: false,
        })),
        defaultProvider: 'deepseek',
        canManage: false,
      });
      expect(JSON.stringify(body)).not.toContain('server-secret');
    } finally {
      await runtime.stop();
    }
  });

  it('returns canManage false and rejects writes in browser mode', async () => {
    const runtime = createRuntime();
    await runtime.start();
    const settings = createServerLlmProviders({ environment: {} });

    try {
      const app = createApp(runtime, {
        providerRegistry: settings.registry,
        defaultProvider: 'mock',
      });
      const response = await app.request('/settings/providers', {
        method: 'POST',
        body: JSON.stringify({
          id: 'deepseek',
          label: 'DeepSeek',
          type: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'secret',
          defaultModel: 'deepseek-chat',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'provider-settings-desktop-only',
          message: expect.any(String),
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it('creates a Provider without returning its API key', async () => {
    const runtime = createRuntime();
    await runtime.start();
    const settings = createServerLlmProviders({ environment: {} });
    const { manager, calls } = createManagerStub();

    try {
      const response = await createApp(runtime, {
        providerRegistry: settings.registry,
        providerSettingsManager: manager,
        canManageProviders: true,
      }).request('/settings/providers', {
        method: 'POST',
        body: JSON.stringify({
          id: 'deepseek',
          label: 'DeepSeek',
          type: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'server-secret',
          defaultModel: 'deepseek-chat',
          makeDefault: true,
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toEqual({ provider: publicDeepSeek });
      expect(calls.created).toEqual([
        {
          id: 'deepseek',
          label: 'DeepSeek',
          type: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'server-secret',
          defaultModel: 'deepseek-chat',
          makeDefault: true,
        },
      ]);
      expect(JSON.stringify(body)).not.toContain('server-secret');
    } finally {
      await runtime.stop();
    }
  });

  it('returns a validation error for an invalid Desktop payload', async () => {
    const runtime = createRuntime();
    await runtime.start();
    const { manager, calls } = createManagerStub();

    try {
      const response = await createApp(runtime, {
        providerSettingsManager: manager,
        canManageProviders: true,
      }).request('/settings/providers', {
        method: 'POST',
        body: JSON.stringify({
          id: 'deepseek',
          label: 'DeepSeek',
          type: 'openai-compatible',
          baseUrl: 'not-a-url',
          apiKey: 'server-secret',
          defaultModel: 'deepseek-chat',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'provider-settings-invalid',
          message: 'Provider configuration is invalid',
        },
      });
      expect(calls.created).toHaveLength(0);
    } finally {
      await runtime.stop();
    }
  });

  it('routes update, delete and default operations to the Manager', async () => {
    const runtime = createRuntime();
    await runtime.start();
    const settings = createServerLlmProviders({ environment: {} });
    const { manager, calls } = createManagerStub();

    try {
      const app = createApp(runtime, {
        providerRegistry: settings.registry,
        providerSettingsManager: manager,
        canManageProviders: true,
      });

      const updateResponse = await app.request('/settings/providers/deepseek', {
        method: 'PATCH',
        body: JSON.stringify({ label: 'DeepSeek 新名称', apiKey: '' }),
        headers: { 'content-type': 'application/json' },
      });
      const defaultResponse = await app.request('/settings/providers/deepseek/default', {
        method: 'POST',
      });
      const deleteResponse = await app.request('/settings/providers/deepseek', {
        method: 'DELETE',
      });

      expect(updateResponse.status).toBe(200);
      expect(defaultResponse.status).toBe(200);
      expect(deleteResponse.status).toBe(204);
      expect(calls.updated).toEqual([
        { id: 'deepseek', input: { label: 'DeepSeek 新名称', apiKey: '' } },
      ]);
      expect(calls.defaults).toEqual(['deepseek']);
      expect(calls.removed).toEqual(['deepseek']);
    } finally {
      await runtime.stop();
    }
  });
});
