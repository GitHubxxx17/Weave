import {
  createLlmProviderRegistry,
  createMockLlmClient,
  createOpenAiCompatibleClient,
  type LlmProviderDescriptor,
  type LlmProviderRegistry,
} from '@weave/llm';
import type { StreamEvent } from '@weave/protocol';
import { z } from 'zod';

const defaultMockScript: readonly StreamEvent[] = [
  { type: 'text-delta', text: '这是 Weave 的本地 Agent 演示。' },
  { type: 'text-delta', text: ' 当前消息通过 SSE 增量传输。' },
  { type: 'finish', reason: 'stop' },
];

const externalProviderSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    type: z.literal('openai-compatible'),
    baseUrl: z.string().url(),
    apiKey: z.string().min(1),
    defaultModel: z.string().trim().min(1),
  })
  .strict();

const externalProvidersSchema = z.array(externalProviderSchema);

/** Configuration for one Server-owned OpenAI-compatible Provider. */
export interface ServerLlmProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly type: 'openai-compatible';
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModel: string;
}

/** Error raised when the Server Provider environment is invalid. */
export class ServerLlmProviderConfigError extends Error {
  constructor(message = 'Provider configuration is invalid', options?: ErrorOptions) {
    super(message, options);
    this.name = 'ServerLlmProviderConfigError';
  }
}

/** Result of building the Server's private registry and public metadata. */
export interface ServerLlmProviderSettings {
  readonly registry: LlmProviderRegistry;
  readonly providers: readonly LlmProviderDescriptor[];
  readonly defaultProvider: string;
}

function readExternalConfigs(environment: NodeJS.ProcessEnv): readonly ServerLlmProviderConfig[] {
  const value = environment.WEAVE_LLM_PROVIDERS?.trim();
  if (value === undefined || value === '') {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new ServerLlmProviderConfigError(undefined, { cause: error });
  }

  const result = externalProvidersSchema.safeParse(parsed);
  if (!result.success) {
    throw new ServerLlmProviderConfigError(undefined, { cause: result.error });
  }
  return result.data;
}

/**
 * Builds the local LLM Provider Registry from Server-only configuration.
 *
 * The returned descriptors contain no API key. The key remains captured by
 * the OpenAI-compatible client inside the Server process.
 */
export function createServerLlmProviders(options?: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly mockScript?: readonly StreamEvent[];
}): ServerLlmProviderSettings {
  const configs = readExternalConfigs(options?.environment ?? process.env);
  const registry = createLlmProviderRegistry();
  registry.register({
    id: 'mock',
    label: '本地演示',
    type: 'mock',
    client: createMockLlmClient(options?.mockScript ?? defaultMockScript),
    defaultModel: 'weave-local-demo',
  });

  for (const config of configs) {
    registry.register({
      id: config.id,
      label: config.label,
      type: 'openai-compatible',
      client: createOpenAiCompatibleClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        ...(options?.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      defaultModel: config.defaultModel,
    });
  }

  return {
    registry,
    providers: registry.list(),
    defaultProvider: configs[0]?.id ?? 'mock',
  };
}
