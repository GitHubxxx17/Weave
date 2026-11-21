import type { PluginTrustStore } from '@weave/plugin-host';
import { z } from 'zod';
import { createSqlitePluginAuthorityDatabase } from './plugin-authority-store.js';
import { PluginAuthorityError } from './plugin-authority-types.js';
import { PluginTrustStoreError } from './plugin-trust-sqlite.js';

export { PluginTrustStoreError, type PluginTrustStoreErrorCode } from './plugin-trust-sqlite.js';

const optionsSchema = z.object({
  filename: z.string().min(1),
  now: z.custom<() => Date>((value) => typeof value === 'function').optional(),
});

function legacyError(error: unknown): PluginTrustStoreError {
  if (error instanceof PluginTrustStoreError) return error;
  const code =
    error instanceof PluginAuthorityError && error.code === 'plugin-authority-invalid'
      ? 'plugin-trust-invalid'
      : error instanceof PluginAuthorityError && error.code === 'plugin-authority-protocol'
        ? 'plugin-trust-protocol'
        : error instanceof PluginAuthorityError && error.code === 'plugin-authority-closed'
          ? 'plugin-trust-closed'
          : 'plugin-trust-storage';
  return new PluginTrustStoreError(code, 'Plugin Trust Store database operation failed', {
    cause: error instanceof PluginAuthorityError ? (error.cause ?? error) : error,
  });
}

/** The legacy standalone facade delegates lifetime to a private authority owner. */
export function createSqlitePluginTrustStore(options: {
  readonly filename: string;
  readonly now?: () => Date;
}): PluginTrustStore & { close(): Promise<void> } {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new PluginTrustStoreError('plugin-trust-invalid', 'Plugin Trust Store input is invalid', {
      cause: parsed.error,
    });
  }
  try {
    const owner = createSqlitePluginAuthorityDatabase(parsed.data);
    return {
      append: (event) => owner.trust.append(event),
      events: () => owner.trust.events(),
      async close() {
        try {
          await owner.close();
        } catch (error: unknown) {
          throw legacyError(error);
        }
      },
    };
  } catch (error: unknown) {
    throw legacyError(error);
  }
}
