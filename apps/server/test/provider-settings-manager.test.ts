import { describe, expect, it } from 'vitest';
import {
  createLlmProviderRegistry,
  createMockLlmClient,
  type LlmClient,
  type LlmProviderRegistry,
} from '@weave/llm';
import {
  createProviderSettingsManager,
  type ProviderSettingsManager,
} from '../src/provider-settings-manager.js';
import type { ProviderSecretCodec } from '../src/provider-secret-codec.js';
import type { ProviderSettingsRecord } from '../src/provider-settings-types.js';
import type { ProviderSettingsStore } from '../src/provider-settings-store.js';

function createRecord(overrides: Partial<ProviderSettingsRecord> = {}): ProviderSettingsRecord {
  const now = new Date().toISOString();
  return {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    encryptedApiKey: 'cipher:first-key',
    defaultModel: 'deepseek-chat',
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createStore(records: readonly ProviderSettingsRecord[] = []): ProviderSettingsStore {
  const values = new Map(records.map((record) => [record.id, record]));
  return {
    async list() {
      return [...values.values()];
    },
    async get(id) {
      return values.get(id);
    },
    async create(record) {
      values.set(record.id, record);
    },
    async update(record) {
      values.set(record.id, record);
    },
    async delete(id) {
      values.delete(id);
    },
    async close() {},
  };
}

function createCodec(): ProviderSecretCodec {
  return {
    isAvailable: () => true,
    encrypt: (value) => `cipher:${value}`,
    decrypt: (value) => value.replace(/^cipher:/, ''),
  };
}

function createManager(
  options: {
    readonly records?: readonly ProviderSettingsRecord[];
    readonly registry?: LlmProviderRegistry;
    readonly createdKeys?: string[];
  } = {},
): {
  readonly manager: ProviderSettingsManager;
  readonly registry: LlmProviderRegistry;
  readonly createdKeys: string[];
} {
  const registry =
    options.registry ??
    createLlmProviderRegistry([
      {
        id: 'mock',
        label: '本地演示',
        type: 'mock',
        client: createMockLlmClient([{ type: 'finish', reason: 'stop' }]),
        defaultModel: 'weave-local-demo',
      },
    ]);
  const createdKeys = options.createdKeys ?? [];
  const manager = createProviderSettingsManager({
    store: createStore(options.records),
    registry,
    secretCodec: createCodec(),
    createClient: ({ apiKey }) => {
      createdKeys.push(apiKey);
      return createMockLlmClient([{ type: 'finish', reason: 'stop' }]);
    },
  });
  return { manager, registry, createdKeys };
}

describe('Provider Settings Manager', () => {
  it('loads encrypted records and registers only Providers with usable keys', async () => {
    const { manager, registry } = createManager({
      records: [
        createRecord({ id: 'deepseek', encryptedApiKey: 'cipher:secret' }),
        createRecord({ id: 'missing-key', encryptedApiKey: null }),
      ],
    });

    await manager.refresh();

    expect(manager.getDefaultProvider()).toBe('mock');
    expect(registry.get('deepseek')).toBeDefined();
    expect(registry.get('missing-key')).toBeUndefined();
    await expect(manager.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'deepseek', hasApiKey: true, editable: true }),
        expect.objectContaining({ id: 'missing-key', hasApiKey: false, editable: true }),
      ]),
    );
  });

  it('updates the same Registry so the next run uses a newly saved API key', async () => {
    const createdKeys: string[] = [];
    const { manager, registry } = createManager({ createdKeys });
    const registryBefore = registry;

    await manager.create({
      id: 'deepseek',
      label: 'DeepSeek',
      type: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'first-key',
      defaultModel: 'deepseek-chat',
      makeDefault: true,
    });
    await manager.update('deepseek', { apiKey: 'second-key' });

    expect(registry).toBe(registryBefore);
    expect(createdKeys).toEqual(['first-key', 'second-key']);
    expect(manager.getDefaultProvider()).toBe('deepseek');
  });

  it('does not remove a Provider owned by another module', async () => {
    const pluginClient: LlmClient = createMockLlmClient([{ type: 'finish', reason: 'stop' }]);
    const registry = createLlmProviderRegistry([
      {
        id: 'mock',
        label: '本地演示',
        type: 'mock',
        client: createMockLlmClient([{ type: 'finish', reason: 'stop' }]),
      },
      {
        id: 'plugin-provider',
        label: '插件 Provider',
        type: 'openai-compatible',
        client: pluginClient,
      },
    ]);
    const { manager } = createManager({ registry });

    await expect(manager.remove('plugin-provider')).rejects.toMatchObject({
      code: 'provider-settings-protected',
    });
    expect(registry.get('plugin-provider')).toBe(pluginClient);
  });

  it('requires a new API key before an existing key is used with a different endpoint', async () => {
    const createdKeys: string[] = [];
    const { manager, registry } = createManager({ createdKeys, records: [createRecord()] });
    await manager.refresh();
    const clientBefore = registry.get('deepseek');

    await expect(
      manager.update('deepseek', { baseUrl: 'https://api.openai.com/v1', apiKey: '' }),
    ).rejects.toMatchObject({ code: 'provider-settings-api-key-required' });
    await expect(
      manager.update('deepseek', { baseUrl: 'https://api.openai.com/v1' }),
    ).rejects.toMatchObject({ code: 'provider-settings-api-key-required' });

    expect(registry.get('deepseek')).toBe(clientBefore);
    await expect(manager.list()).resolves.toContainEqual(
      expect.objectContaining({ id: 'deepseek', baseUrl: 'https://api.deepseek.com' }),
    );

    await manager.update('deepseek', { baseUrl: 'https://api.openai.com/v1', apiKey: 'new-key' });
    expect(createdKeys).toEqual(['first-key', 'new-key']);
  });

  it('keeps the existing API key when the endpoint only differs by a trailing slash', async () => {
    const createdKeys: string[] = [];
    const { manager } = createManager({ createdKeys, records: [createRecord()] });
    await manager.refresh();

    await manager.update('deepseek', {
      baseUrl: 'https://api.deepseek.com/',
      apiKey: '',
      label: 'DeepSeek 主账号',
    });

    expect(createdKeys).toEqual(['first-key', 'first-key']);
  });

  it('allows changing the endpoint while explicitly clearing the old API key', async () => {
    const { manager, registry } = createManager({ records: [createRecord()] });
    await manager.refresh();

    await manager.update('deepseek', { baseUrl: 'https://api.openai.com/v1', clearApiKey: true });

    expect(registry.get('deepseek')).toBeUndefined();
    await expect(manager.list()).resolves.toContainEqual(
      expect.objectContaining({ baseUrl: 'https://api.openai.com/v1', hasApiKey: false }),
    );
  });

  it('clearing a key keeps metadata but removes the Provider from the callable Registry', async () => {
    const { manager, registry } = createManager({
      records: [createRecord({ encryptedApiKey: 'cipher:key' })],
    });
    await manager.refresh();

    await manager.update('deepseek', { clearApiKey: true });

    expect(registry.get('deepseek')).toBeUndefined();
    await expect(manager.list()).resolves.toContainEqual(
      expect.objectContaining({ id: 'deepseek', hasApiKey: false }),
    );
  });

  it('keeps the Mock Provider available when a saved key cannot be decrypted', async () => {
    const codec: ProviderSecretCodec = {
      isAvailable: () => true,
      encrypt: (value) => `cipher:${value}`,
      decrypt: () => {
        throw new Error('invalid ciphertext');
      },
    };
    const isolatedManager = createProviderSettingsManager({
      store: {
        ...createStore([createRecord({ encryptedApiKey: 'cipher:broken', isDefault: true })]),
      },
      registry: createLlmProviderRegistry([
        {
          id: 'mock',
          label: '本地演示',
          type: 'mock',
          client: createMockLlmClient([]),
          defaultModel: 'weave-local-demo',
        },
      ]),
      secretCodec: codec,
    });

    await isolatedManager.refresh();

    expect(isolatedManager.getDefaultProvider()).toBe('mock');
    await expect(isolatedManager.list()).resolves.toContainEqual(
      expect.objectContaining({ id: 'deepseek', hasApiKey: true }),
    );
  });
});
