import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PluginMarketplaceCatalog } from './plugin-marketplace.js';

export const marketplaceSourceNameSchema = z.string().trim().min(1).max(300);
export const marketplaceSourceIdSchema = z
  .string()
  .regex(/^(?:weave|operator|remote-[0-9a-f]{32})$/);
export const marketplaceSourceErrorSchema = z.enum([
  'network',
  'timeout',
  'too-large',
  'invalid-index',
  'settings-unavailable',
]);
export type MarketplaceSourceErrorCode = z.infer<typeof marketplaceSourceErrorSchema>;

export class MarketplaceSourceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MarketplaceSourceError';
  }
}

export function canonicalMarketplaceUrl(input: string): string {
  try {
    if (input.length > 2048 || input !== input.trim()) throw new Error();
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    if (url.hostname === 'github.com') {
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length < 5 || segments[2] !== 'blob' || url.search) throw new Error();
      url.hostname = 'raw.githubusercontent.com';
      url.pathname = `/${[...segments.slice(0, 2), ...segments.slice(3)].join('/')}`;
    }
    return url.href;
  } catch {
    throw new MarketplaceSourceError(
      400,
      'plugin-marketplace-invalid-request',
      'Use an HTTPS JSON index URL without credentials or a fragment',
    );
  }
}
export const marketplaceSourceUrlSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    try {
      return canonicalMarketplaceUrl(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid marketplace index URL' });
      return z.NEVER;
    }
  });
export function marketplaceRemoteId(url: string): string {
  return `remote-${createHash('sha256').update(url).digest('hex').slice(0, 32)}`;
}
export const marketplaceSourceSchema = z.strictObject({
  id: marketplaceSourceIdSchema,
  name: marketplaceSourceNameSchema,
  url: z.string().max(2048).nullable(),
  kind: z.enum(['builtin', 'local', 'remote']),
  status: z.enum(['ready', 'unfetched', 'unavailable']),
  stale: z.boolean(),
  removable: z.boolean(),
  fetchedAt: z.iso.datetime().optional(),
  errorCode: marketplaceSourceErrorSchema.optional(),
});
export const marketplaceSourcesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sources: z.array(marketplaceSourceSchema).max(12),
});
export type MarketplaceSources = z.infer<typeof marketplaceSourcesSchema>;
export type MarketplaceSource = z.infer<typeof marketplaceSourceSchema>;
export interface PluginMarketplaceManager {
  listSources(): MarketplaceSources;
  catalog(sourceId?: string): {
    readonly catalog: PluginMarketplaceCatalog;
    readonly indexSource: {
      readonly id: string;
      readonly name: string;
      readonly url: string | null;
    };
  };
  add(input: { readonly name: string; readonly url: string }): Promise<MarketplaceSources>;
  remove(id: string): Promise<MarketplaceSources>;
  refresh(sourceId: string): Promise<MarketplaceSources>;
  closeSync(): void;
  drain(): Promise<void>;
}
