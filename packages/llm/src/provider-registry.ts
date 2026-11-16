import { z } from 'zod';
import type { LlmClient } from './client.js';

/** Provider implementation categories exposed by the local Registry. */
export type LlmProviderType = 'mock' | 'openai-compatible';

/** Provider registration kept inside the Runtime process. */
export interface LlmProviderRegistration {
  /** Stable id used by Agent requests. */
  readonly id: string;
  /** Human-readable name shown by Studio. */
  readonly label: string;
  /** Implementation family used by this Provider. */
  readonly type: LlmProviderType;
  /** Private client instance used by Runtime. */
  readonly client: LlmClient;
  /** Default model shown when Studio selects this Provider. */
  readonly defaultModel?: string;
}

/** Public Provider metadata safe to return to browser callers. */
export interface LlmProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly type: LlmProviderType;
  readonly defaultModel?: string;
}

/** Registry used by Runtime to resolve model clients without vendor coupling. */
export interface LlmProviderRegistry {
  /** Adds one Provider and rejects duplicate ids. */
  register(provider: LlmProviderRegistration): void;
  /** Resolves the private client for one Provider id. */
  get(providerId: string): LlmClient | undefined;
  /** Reads public metadata for one Provider id. */
  getDescriptor(providerId: string): LlmProviderDescriptor | undefined;
  /** Lists public Provider metadata without private client configuration. */
  list(): readonly LlmProviderDescriptor[];
}

const providerTypeSchema = z.enum(['mock', 'openai-compatible']);
const providerRegistrationSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    type: providerTypeSchema,
    client: z.custom<LlmClient>(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'stream' in value &&
        typeof value.stream === 'function',
    ),
    defaultModel: z.string().trim().min(1).optional(),
  })
  .strict();

function toDescriptor(provider: {
  readonly id: string;
  readonly label: string;
  readonly type: LlmProviderType;
  readonly defaultModel?: string | undefined;
}): LlmProviderDescriptor {
  return Object.freeze({
    id: provider.id,
    label: provider.label,
    type: provider.type,
    ...(provider.defaultModel === undefined ? {} : { defaultModel: provider.defaultModel }),
  });
}

/**
 * Creates a process-local Registry for model Provider clients.
 *
 * The Registry deliberately stores private clients separately from public
 * descriptors so metadata endpoints cannot accidentally serialize secrets.
 */
export function createLlmProviderRegistry(
  providers: readonly LlmProviderRegistration[] = [],
): LlmProviderRegistry {
  const clients = new Map<string, LlmClient>();
  const descriptors = new Map<string, LlmProviderDescriptor>();

  const register = (providerInput: LlmProviderRegistration): void => {
    const provider = providerRegistrationSchema.parse(providerInput);
    if (clients.has(provider.id)) {
      throw new Error(`LLM provider "${provider.id}" is already registered`);
    }

    clients.set(provider.id, provider.client);
    descriptors.set(provider.id, toDescriptor(provider));
  };

  for (const provider of providers) {
    register(provider);
  }

  return Object.freeze({
    register,
    get(providerId: string): LlmClient | undefined {
      return clients.get(providerId);
    },
    getDescriptor(providerId: string): LlmProviderDescriptor | undefined {
      return descriptors.get(providerId);
    },
    list(): readonly LlmProviderDescriptor[] {
      return Object.freeze([...descriptors.values()]);
    },
  });
}
