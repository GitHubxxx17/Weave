import {
  createOpenAiCompatibleClient,
  type LlmClient,
  type LlmProviderDescriptor,
  type LlmProviderRegistration,
  type LlmProviderRegistry,
} from '@weave/llm';
import { defaultProviderIdleTimeoutMs } from './llm-providers.js';
import {
  createProviderSettingsInputSchema,
  providerSettingsDescriptorSchema,
  providerSettingsRecordSchema,
  updateProviderSettingsInputSchema,
  type CreateProviderSettingsInput,
  type ProviderSettingsDescriptor,
  type ProviderSettingsRecord,
  type UpdateProviderSettingsInput,
} from './provider-settings-types.js';
import type { ProviderSecretCodec } from './provider-secret-codec.js';
import {
  ProviderSettingsStoreError,
  type ProviderSettingsStore,
} from './provider-settings-store.js';

export type ProviderSettingsManagerErrorCode =
  | 'provider-settings-invalid'
  | 'provider-settings-not-found'
  | 'provider-settings-duplicate'
  | 'provider-settings-protected'
  | 'provider-settings-secret-unavailable'
  | 'provider-settings-secret-invalid'
  | 'provider-settings-provider-invalid'
  | 'provider-settings-api-key-required'
  | 'provider-settings-storage'
  | 'provider-settings-busy';

export class ProviderSettingsManagerError extends Error {
  readonly code: ProviderSettingsManagerErrorCode;

  constructor(code: ProviderSettingsManagerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderSettingsManagerError';
    this.code = code;
  }
}

export interface ProviderSettingsManager {
  list(): Promise<readonly ProviderSettingsDescriptor[]>;
  create(input: CreateProviderSettingsInput): Promise<ProviderSettingsDescriptor>;
  update(id: string, input: UpdateProviderSettingsInput): Promise<ProviderSettingsDescriptor>;
  remove(id: string): Promise<void>;
  setDefault(id: string): Promise<void>;
  getDefaultProvider(): string;
  refresh(): Promise<void>;
}

export interface CreateProviderSettingsManagerOptions {
  readonly store: ProviderSettingsStore;
  readonly registry: LlmProviderRegistry;
  readonly secretCodec: ProviderSecretCodec;
  /** Current combined catalog; writes remain in the host-owned source registry. */
  readonly catalog?: (() => LlmProviderRegistry) | undefined;
  readonly reserveProvider?: ((id: string) => () => void) | undefined;
  readonly claimProvider?: ((id: string) => void) | undefined;
  readonly releaseProviderClaim?: ((id: string) => void) | undefined;
  readonly createClient?: (options: {
    readonly baseUrl: string;
    readonly apiKey: string;
  }) => LlmClient;
  readonly initialDefaultProvider?: string;
}

const defaultCreateClient = (options: {
  readonly baseUrl: string;
  readonly apiKey: string;
}): LlmClient =>
  createOpenAiCompatibleClient({ ...options, idleTimeoutMs: defaultProviderIdleTimeoutMs });

function normalizeId(id: string): string {
  return id.trim();
}

/** Compares endpoints without treating a trailing slash as a different service. */
function normalizeBaseUrl(baseUrl: string): string {
  return new URL(baseUrl.trim()).href.replace(/\/+$/, '');
}

/**
 * Applies an optional numeric update field: an omitted input keeps the current
 * value, an explicit `null` clears it, and a number sets it.
 */
function setOptionalNumber(
  target: {
    contextWindowTokens?: number | undefined;
    temperature?: number | undefined;
    maxTokens?: number | undefined;
  },
  key: 'contextWindowTokens' | 'temperature' | 'maxTokens',
  input: number | null | undefined,
  current: number | undefined,
): void {
  const next = input === undefined ? current : input === null ? undefined : input;
  if (next === undefined) {
    delete target[key];
  } else {
    target[key] = next;
  }
}

function throwInvalid(cause?: unknown): never {
  throw new ProviderSettingsManagerError(
    'provider-settings-invalid',
    'Provider configuration is invalid',
    cause === undefined ? undefined : { cause },
  );
}

function mapStoreError(error: unknown): never {
  if (error instanceof ProviderSettingsStoreError) {
    if (error.code === 'provider-settings-not-found') {
      throw new ProviderSettingsManagerError('provider-settings-not-found', error.message, {
        cause: error,
      });
    }
    if (error.code === 'provider-settings-invalid') {
      throw new ProviderSettingsManagerError('provider-settings-invalid', error.message, {
        cause: error,
      });
    }
    throw new ProviderSettingsManagerError(
      error.code === 'provider-settings-busy'
        ? 'provider-settings-busy'
        : 'provider-settings-storage',
      error.message,
      { cause: error },
    );
  }
  throw error;
}

function getDescriptor(record: ProviderSettingsRecord): ProviderSettingsDescriptor {
  return providerSettingsDescriptorSchema.parse({
    id: record.id,
    label: record.label,
    type: record.type,
    baseUrl: record.baseUrl,
    defaultModel: record.defaultModel,
    hasApiKey: record.encryptedApiKey !== null,
    editable: true,
    ...(record.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: record.contextWindowTokens }),
    ...(record.temperature === undefined ? {} : { temperature: record.temperature }),
    ...(record.maxTokens === undefined ? {} : { maxTokens: record.maxTokens }),
  });
}

function isManagedRecord(
  records: ReadonlyMap<string, ProviderSettingsRecord>,
  id: string,
): boolean {
  return records.has(id);
}

/**
 * Coordinates persisted Provider settings and the process-local LLM Registry.
 *
 * The manager owns only Provider ids loaded from its Store. Existing Providers
 * from the environment or trusted plugins remain outside its deletion scope.
 */
export function createProviderSettingsManager(
  options: CreateProviderSettingsManagerOptions,
): ProviderSettingsManager {
  const createClient = options.createClient ?? defaultCreateClient;
  const catalog = () => options.catalog?.() ?? options.registry;
  const managedRecords = new Map<string, ProviderSettingsRecord>();
  let defaultProvider = options.initialDefaultProvider ?? 'mock';

  function ensureCodecAvailable(): void {
    if (!options.secretCodec.isAvailable()) {
      throw new ProviderSettingsManagerError(
        'provider-settings-secret-unavailable',
        '系统密钥存储不可用',
      );
    }
  }

  function resolveClient(record: ProviderSettingsRecord): LlmClient | undefined {
    if (record.encryptedApiKey === null) {
      return undefined;
    }
    let apiKey: string;
    try {
      apiKey = options.secretCodec.decrypt(record.encryptedApiKey);
    } catch (error: unknown) {
      throw new ProviderSettingsManagerError(
        'provider-settings-secret-invalid',
        'Provider API Key 解密失败',
        { cause: error },
      );
    }
    try {
      return createClient({ baseUrl: record.baseUrl, apiKey });
    } catch (error: unknown) {
      throw new ProviderSettingsManagerError(
        'provider-settings-provider-invalid',
        'Provider 客户端创建失败',
        { cause: error },
      );
    }
  }

  function registerRecord(record: ProviderSettingsRecord): void {
    const client = resolveClient(record);
    if (client === undefined) {
      return;
    }
    const registration: LlmProviderRegistration = {
      id: record.id,
      label: record.label,
      type: record.type,
      client,
      defaultModel: record.defaultModel,
      ...(record.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: record.contextWindowTokens }),
      ...(record.temperature === undefined ? {} : { temperature: record.temperature }),
      ...(record.maxTokens === undefined ? {} : { maxTokens: record.maxTokens }),
    };
    if (options.registry.getDescriptor(record.id) === undefined) {
      options.registry.register(registration);
    } else if (record.id !== 'mock') {
      options.registry.replace(registration);
    } else {
      throw new ProviderSettingsManagerError(
        'provider-settings-protected',
        '内置 Provider 不可覆盖',
      );
    }
  }

  async function list(): Promise<readonly ProviderSettingsDescriptor[]> {
    let records: readonly ProviderSettingsRecord[];
    try {
      records = await options.store.list();
    } catch (error: unknown) {
      return mapStoreError(error);
    }
    const recordMap = new Map(records.map((record) => [record.id, record]));
    const descriptors = catalog()
      .list()
      .map((descriptor: LlmProviderDescriptor) => {
        const record = recordMap.get(descriptor.id);
        if (record !== undefined) {
          return getDescriptor(record);
        }
        return providerSettingsDescriptorSchema.parse({
          ...descriptor,
          hasApiKey: descriptor.type !== 'mock',
          editable: false,
        });
      });
    for (const record of records) {
      if (!descriptors.some((descriptor) => descriptor.id === record.id)) {
        descriptors.push(getDescriptor(record));
      }
    }
    return Object.freeze(descriptors);
  }

  async function refresh(): Promise<void> {
    let records: readonly ProviderSettingsRecord[];
    try {
      records = await options.store.list();
    } catch (error: unknown) {
      return mapStoreError(error);
    }

    const refreshedIds = new Set(records.map((record) => record.id));
    for (const id of managedRecords.keys()) {
      options.registry.remove(id);
      if (!refreshedIds.has(id)) options.releaseProviderClaim?.(id);
    }
    managedRecords.clear();

    for (const input of records) {
      const parsed = providerSettingsRecordSchema.safeParse(input);
      if (!parsed.success) {
        throw new ProviderSettingsManagerError(
          'provider-settings-invalid',
          'Provider configuration is invalid',
          { cause: parsed.error },
        );
      }
      const record = parsed.data;
      managedRecords.set(record.id, record);
      options.claimProvider?.(record.id);
      try {
        registerRecord(record);
      } catch (error: unknown) {
        if (
          error instanceof ProviderSettingsManagerError &&
          (error.code === 'provider-settings-secret-invalid' ||
            error.code === 'provider-settings-provider-invalid')
        ) {
          continue;
        }
        throw error;
      }
    }

    const savedDefault = records.find(
      (record) =>
        record.isDefault &&
        record.encryptedApiKey !== null &&
        options.registry.get(record.id) !== undefined,
    );
    if (savedDefault !== undefined) {
      defaultProvider = savedDefault.id;
    } else if (
      defaultProvider !== 'mock' &&
      options.registry.getDescriptor(defaultProvider) === undefined
    ) {
      defaultProvider = 'mock';
    }
  }

  return {
    list,

    async create(input: CreateProviderSettingsInput): Promise<ProviderSettingsDescriptor> {
      const parsed = createProviderSettingsInputSchema.safeParse(input);
      if (!parsed.success) {
        return throwInvalid(parsed.error);
      }
      ensureCodecAvailable();
      const id = normalizeId(parsed.data.id);
      if (id === 'mock' || managedRecords.has(id)) {
        throw new ProviderSettingsManagerError(
          'provider-settings-duplicate',
          `Provider "${id}" 已存在`,
        );
      }
      if (catalog().getDescriptor(id) !== undefined) {
        throw new ProviderSettingsManagerError(
          'provider-settings-protected',
          `Provider "${id}" 由其他模块管理`,
        );
      }

      let release: (() => void) | undefined;
      try {
        release = options.reserveProvider?.(id);
      } catch (error: unknown) {
        throw new ProviderSettingsManagerError(
          'provider-settings-protected',
          `Provider "${id}" 由其他模块管理`,
          { cause: error },
        );
      }
      try {
        const now = new Date().toISOString();
        const record: ProviderSettingsRecord = {
          id,
          label: parsed.data.label,
          type: parsed.data.type,
          baseUrl: parsed.data.baseUrl,
          encryptedApiKey: options.secretCodec.encrypt(parsed.data.apiKey),
          defaultModel: parsed.data.defaultModel,
          isDefault: parsed.data.makeDefault,
          ...(parsed.data.contextWindowTokens === undefined
            ? {}
            : { contextWindowTokens: parsed.data.contextWindowTokens }),
          ...(parsed.data.temperature === undefined
            ? {}
            : { temperature: parsed.data.temperature }),
          ...(parsed.data.maxTokens === undefined ? {} : { maxTokens: parsed.data.maxTokens }),
          createdAt: now,
          updatedAt: now,
        };
        try {
          await options.store.create(record);
        } catch (error: unknown) {
          return mapStoreError(error);
        }
        // A successful create is already durable even if a later default update
        // fails. Retain its ownership and managed record before the next await.
        managedRecords.set(record.id, record);
        options.claimProvider?.(record.id);
        if (record.isDefault) {
          for (const existing of managedRecords.values()) {
            if (existing.id !== record.id && existing.isDefault) {
              try {
                await options.store.update({ ...existing, isDefault: false });
              } catch (error: unknown) {
                return mapStoreError(error);
              }
              managedRecords.set(existing.id, { ...existing, isDefault: false });
            }
          }
        }
        registerRecord(record);
        if (parsed.data.makeDefault) {
          defaultProvider = record.id;
        }
        return getDescriptor(record);
      } finally {
        release?.();
      }
    },

    async update(
      idInput: string,
      input: UpdateProviderSettingsInput,
    ): Promise<ProviderSettingsDescriptor> {
      const id = normalizeId(idInput);
      const parsedInput = updateProviderSettingsInputSchema.safeParse(input);
      if (!parsedInput.success || id.length === 0) {
        return throwInvalid(parsedInput.success ? undefined : parsedInput.error);
      }
      ensureCodecAvailable();
      if (id === 'mock' || !isManagedRecord(managedRecords, id)) {
        throw new ProviderSettingsManagerError(
          'provider-settings-protected',
          `Provider "${id}" 不能由设置管理`,
        );
      }
      const current = managedRecords.get(id);
      if (current === undefined) {
        throw new ProviderSettingsManagerError(
          'provider-settings-not-found',
          `Provider "${id}" 不存在`,
        );
      }

      const hasNewApiKey =
        parsedInput.data.apiKey !== undefined && parsedInput.data.apiKey.trim() !== '';
      const baseUrlChanged =
        parsedInput.data.baseUrl !== undefined &&
        normalizeBaseUrl(parsedInput.data.baseUrl) !== normalizeBaseUrl(current.baseUrl);
      // A retained secret belongs to the old endpoint; never forward it to a new one.
      if (
        baseUrlChanged &&
        current.encryptedApiKey !== null &&
        !hasNewApiKey &&
        parsedInput.data.clearApiKey !== true
      ) {
        throw new ProviderSettingsManagerError(
          'provider-settings-api-key-required',
          '修改 API 地址时需要重新填写 API Key',
        );
      }

      const apiKey =
        parsedInput.data.clearApiKey === true
          ? null
          : !hasNewApiKey
            ? current.encryptedApiKey
            : options.secretCodec.encrypt(parsedInput.data.apiKey ?? '');
      const record: ProviderSettingsRecord = {
        ...current,
        label: parsedInput.data.label ?? current.label,
        baseUrl: parsedInput.data.baseUrl ?? current.baseUrl,
        defaultModel: parsedInput.data.defaultModel ?? current.defaultModel,
        encryptedApiKey: apiKey,
        isDefault:
          parsedInput.data.makeDefault === true
            ? true
            : apiKey === null
              ? false
              : current.isDefault,
        updatedAt: new Date().toISOString(),
      };
      setOptionalNumber(
        record,
        'contextWindowTokens',
        parsedInput.data.contextWindowTokens,
        current.contextWindowTokens,
      );
      setOptionalNumber(record, 'temperature', parsedInput.data.temperature, current.temperature);
      setOptionalNumber(record, 'maxTokens', parsedInput.data.maxTokens, current.maxTokens);
      if (record.isDefault) {
        for (const existing of managedRecords.values()) {
          if (existing.id !== id && existing.isDefault) {
            try {
              await options.store.update({ ...existing, isDefault: false });
            } catch (error: unknown) {
              return mapStoreError(error);
            }
            managedRecords.set(existing.id, { ...existing, isDefault: false });
          }
        }
      }
      try {
        await options.store.update(record);
      } catch (error: unknown) {
        return mapStoreError(error);
      }
      managedRecords.set(id, record);
      options.registry.remove(id);
      registerRecord(record);
      if (record.isDefault && record.encryptedApiKey !== null) {
        defaultProvider = id;
      } else if (defaultProvider === id && record.encryptedApiKey === null) {
        defaultProvider = 'mock';
      }
      return getDescriptor(record);
    },

    async remove(idInput: string): Promise<void> {
      const id = normalizeId(idInput);
      if (id.length === 0) {
        return throwInvalid();
      }
      if (id === 'mock' || !isManagedRecord(managedRecords, id)) {
        throw new ProviderSettingsManagerError(
          'provider-settings-protected',
          `Provider "${id}" 不能由设置管理`,
        );
      }
      try {
        await options.store.delete(id);
      } catch (error: unknown) {
        return mapStoreError(error);
      }
      managedRecords.delete(id);
      options.releaseProviderClaim?.(id);
      options.registry.remove(id);
      if (defaultProvider === id) {
        defaultProvider = 'mock';
      }
    },

    async setDefault(idInput: string): Promise<void> {
      const id = normalizeId(idInput);
      if (id.length === 0) {
        return throwInvalid();
      }
      if (id !== 'mock' && catalog().getDescriptor(id) === undefined) {
        throw new ProviderSettingsManagerError(
          'provider-settings-not-found',
          `Provider "${id}" 不存在`,
        );
      }
      if (id !== 'mock' && catalog().get(id) === undefined) {
        throw new ProviderSettingsManagerError(
          'provider-settings-provider-invalid',
          `Provider "${id}" 尚未配置可用 API Key`,
        );
      }
      for (const existing of managedRecords.values()) {
        if (existing.isDefault) {
          try {
            await options.store.update({ ...existing, isDefault: false });
          } catch (error: unknown) {
            return mapStoreError(error);
          }
          managedRecords.set(existing.id, { ...existing, isDefault: false });
        }
      }
      if (id !== 'mock') {
        const current = managedRecords.get(id);
        if (current !== undefined) {
          const updated = { ...current, isDefault: true, updatedAt: new Date().toISOString() };
          try {
            await options.store.update(updated);
          } catch (error: unknown) {
            return mapStoreError(error);
          }
          managedRecords.set(id, updated);
        }
      }
      defaultProvider = id;
    },

    getDefaultProvider(): string {
      return catalog().get(defaultProvider) === undefined ? 'mock' : defaultProvider;
    },

    refresh,
  };
}

export type { ProviderSettingsDescriptor };
