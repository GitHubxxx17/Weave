import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { managedStoreBindingSchema, type ManagedStoreBinding } from './plugin-authority-types.js';

export type PluginStoreOwnershipErrorCode =
  | 'plugin-store-invalid'
  | 'plugin-store-busy'
  | 'plugin-store-owner-mismatch'
  | 'plugin-store-recovery-required'
  | 'plugin-store-protocol'
  | 'plugin-store-storage'
  | 'plugin-store-ownership-lost'
  | 'plugin-store-closed';

export class PluginStoreOwnershipError extends Error {
  constructor(
    readonly code: PluginStoreOwnershipErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PluginStoreOwnershipError';
  }
}

export const initialBindingSchema = z.enum(['allow-unbound', 'require-bound']);

export const absoluteStorePathSchema = z
  .string()
  .refine((path) => isAbsolute(path) && !path.includes('\0'), {
    message: 'Managed store paths must be absolute and contain no NUL',
  });

export interface RecordedManagedStoreBinding {
  readonly version: 1;
  readonly sequence: 1;
  readonly kind: 'managed-store-bound';
  readonly occurredAt: string;
  readonly binding: ManagedStoreBinding;
}

export const recordedManagedStoreBindingSchema: z.ZodType<RecordedManagedStoreBinding> =
  z.strictObject({
    version: z.literal(1),
    sequence: z.literal(1),
    kind: z.literal('managed-store-bound'),
    occurredAt: z.iso.datetime(),
    binding: managedStoreBindingSchema,
  });
