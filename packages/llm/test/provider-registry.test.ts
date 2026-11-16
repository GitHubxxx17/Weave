import { describe, expect, it } from 'vitest';
import { createMockLlmClient, createLlmProviderRegistry } from '../src/index.js';

function createClient() {
  return createMockLlmClient([{ type: 'finish', reason: 'stop' }]);
}

describe('LLM Provider Registry', () => {
  it('registers and resolves a provider by id', () => {
    const client = createClient();
    const registry = createLlmProviderRegistry([
      {
        id: 'deepseek',
        label: 'DeepSeek',
        type: 'openai-compatible',
        client,
        defaultModel: 'deepseek-chat',
      },
    ]);

    expect(registry.get('deepseek')).toBe(client);
    expect(registry.getDescriptor('deepseek')).toEqual({
      id: 'deepseek',
      label: 'DeepSeek',
      type: 'openai-compatible',
      defaultModel: 'deepseek-chat',
    });
    expect(registry.list()).toEqual([
      {
        id: 'deepseek',
        label: 'DeepSeek',
        type: 'openai-compatible',
        defaultModel: 'deepseek-chat',
      },
    ]);
  });

  it('registers providers after construction', () => {
    const registry = createLlmProviderRegistry();
    const client = createClient();

    registry.register({
      id: 'mock',
      label: '本地演示',
      type: 'mock',
      client,
      defaultModel: 'weave-local-demo',
    });

    expect(registry.get('mock')).toBe(client);
  });

  it('rejects duplicate provider ids', () => {
    const registry = createLlmProviderRegistry();
    const registration = {
      id: 'mock',
      label: '本地演示',
      type: 'mock' as const,
      client: createClient(),
    };

    registry.register(registration);

    expect(() => registry.register(registration)).toThrow(
      'LLM provider "mock" is already registered',
    );
  });

  it('returns undefined for an unknown provider', () => {
    const registry = createLlmProviderRegistry();

    expect(registry.get('missing')).toBeUndefined();
    expect(registry.getDescriptor('missing')).toBeUndefined();
  });

  it('does not expose clients or private configuration through descriptors', () => {
    const registry = createLlmProviderRegistry([
      {
        id: 'deepseek',
        label: 'DeepSeek',
        type: 'openai-compatible',
        client: createClient(),
        defaultModel: 'deepseek-chat',
      },
    ]);

    const descriptors = registry.list();

    expect(descriptors[0]).not.toHaveProperty('client');
    expect(JSON.stringify(descriptors)).not.toContain('apiKey');
  });
});
