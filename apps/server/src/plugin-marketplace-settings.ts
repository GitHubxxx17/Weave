import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  canonicalMarketplaceUrl,
  marketplaceRemoteId,
  marketplaceSourceIdSchema,
  marketplaceSourceNameSchema,
  type MarketplaceSource,
} from './plugin-marketplace-source-types.js';

const maxBytes = 1024 * 1024;
const maxEvents = 1024;
const eventSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    sequence: z.number().int().min(1).max(maxEvents),
    operation: z.literal('add'),
    id: marketplaceSourceIdSchema,
    name: marketplaceSourceNameSchema,
    url: z.string().max(2048),
  }),
  z.strictObject({
    sequence: z.number().int().min(1).max(maxEvents),
    operation: z.literal('remove'),
    id: marketplaceSourceIdSchema,
  }),
]);
type Event = z.infer<typeof eventSchema>;
export interface MarketplaceSettings {
  readonly initial: readonly MarketplaceSource[];
  readonly available: boolean;
  append(
    event:
      | Omit<Extract<Event, { operation: 'add' }>, 'sequence'>
      | Omit<Extract<Event, { operation: 'remove' }>, 'sequence'>,
  ): Promise<void>;
}

/** A single Server owns this append-only settings log; it never repairs unknown bytes. */
export async function openMarketplaceSettings(file: string): Promise<MarketplaceSettings> {
  let available = true;
  let length = 0;
  let sequence = 0;
  let identity: { dev: number; ino: number } | undefined;
  const active = new Map<string, MarketplaceSource>();
  try {
    if (!isAbsolute(file) || file.includes('\0')) throw new Error();
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (handle !== undefined) {
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) throw new Error();
        identity = { dev: stat.dev, ino: stat.ino };
        const bytes = Buffer.alloc(maxBytes + 1);
        while (length < bytes.length) {
          const next = await handle.read(bytes, length, bytes.length - length, null);
          if (next.bytesRead === 0) break;
          length += next.bytesRead;
        }
        if (length > maxBytes) throw new Error();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
        if (text !== '' && !text.endsWith('\n')) throw new Error();
        for (const line of text === '' ? [] : text.slice(0, -1).split('\n')) {
          const event = eventSchema.parse(JSON.parse(line) as unknown);
          if (event.sequence !== sequence + 1 || !event.id.startsWith('remote-')) throw new Error();
          if (event.operation === 'add') {
            if (
              canonicalMarketplaceUrl(event.url) !== event.url ||
              marketplaceRemoteId(event.url) !== event.id ||
              active.has(event.id) ||
              active.size >= 10
            )
              throw new Error();
            active.set(event.id, {
              id: event.id,
              name: event.name,
              url: event.url,
              kind: 'remote',
              status: 'unfetched',
              stale: false,
              removable: true,
            });
          } else if (!active.delete(event.id)) throw new Error();
          sequence = event.sequence;
        }
      } finally {
        await handle.close();
      }
    }
  } catch {
    available = false;
    active.clear();
  }
  return {
    initial: [...active.values()],
    get available() {
      return available;
    },
    async append(input) {
      if (sequence >= maxEvents) available = false;
      if (!available) throw new Error('Marketplace settings unavailable');
      const event = eventSchema.parse({ ...input, sequence: sequence + 1 });
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
      if (length + bytes.length > maxBytes) {
        available = false;
        throw new Error('Marketplace settings full');
      }
      try {
        const handle = await open(
          file,
          constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK |
            (identity === undefined ? constants.O_CREAT | constants.O_EXCL : 0),
          0o600,
        );
        try {
          const stat = await handle.stat();
          if (
            !stat.isFile() ||
            stat.size !== length ||
            (identity !== undefined && (stat.dev !== identity.dev || stat.ino !== identity.ino))
          )
            throw new Error();
          identity ??= { dev: stat.dev, ino: stat.ino };
          await handle.writeFile(bytes);
          await handle.sync();
          length += bytes.length;
          sequence++;
        } finally {
          await handle.close();
        }
      } catch {
        available = false;
        throw new Error('Marketplace settings unavailable');
      }
    },
  };
}
