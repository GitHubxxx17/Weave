import { describe, expect, it } from 'vitest';
import { createRuntime } from '@weave/runtime';
import { createApp } from '../src/app.js';
import { createServerLlmProviders, ServerLlmProviderConfigError } from '../src/llm-providers.js';

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
      }).request('/settings/providers');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        providers: settings.providers,
        defaultProvider: 'mock',
      });
      expect(JSON.stringify(body)).not.toContain('server-secret');
    } finally {
      await runtime.stop();
    }
  });
});
