import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  canonicalMarketplaceUrl,
  marketplaceRemoteId,
  marketplaceSourceIdSchema,
  marketplaceSourceNameSchema,
} from './plugin-marketplace-source-types.js';

const maxBytes = 1024 * 1024;
const maxRemoteSources = 10;
/** The retired append-only log capped itself at 1024 events; it is still replayed under that bound. */
const maxLegacyEvents = 1024;

const storedSourceSchema = z.strictObject({
  id: marketplaceSourceIdSchema,
  name: marketplaceSourceNameSchema,
  url: z.string().max(2048),
});
const settingsFileSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sources: z.array(storedSourceSchema).max(maxRemoteSources),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const source of value.sources) {
      let valid: boolean;
      try {
        valid =
          source.id.startsWith('remote-') &&
          canonicalMarketplaceUrl(source.url) === source.url &&
          marketplaceRemoteId(source.url) === source.id &&
          !seen.has(source.id);
      } catch {
        valid = false;
      }
      if (!valid) context.addIssue({ code: 'custom', message: 'Invalid marketplace source' });
      seen.add(source.id);
    }
  });
const legacyEventSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    sequence: z.number().int().min(1).max(maxLegacyEvents),
    operation: z.literal('add'),
    id: marketplaceSourceIdSchema,
    name: marketplaceSourceNameSchema,
    url: z.string().max(2048),
  }),
  z.strictObject({
    sequence: z.number().int().min(1).max(maxLegacyEvents),
    operation: z.literal('remove'),
    id: marketplaceSourceIdSchema,
  }),
]);

export type StoredMarketplaceSource = z.infer<typeof storedSourceSchema>;
export type MarketplaceSettingsState = {
  readonly revision: number;
  readonly sources: readonly StoredMarketplaceSource[];
};
export type MarketplaceSettingsFailure = 'conflict' | 'unavailable';
export class MarketplaceSettingsError extends Error {
  constructor(
    readonly reason: MarketplaceSettingsFailure,
    message: string,
  ) {
    super(message);
    this.name = 'MarketplaceSettingsError';
  }
}
export interface MarketplaceSettings {
  readonly initial: readonly StoredMarketplaceSource[];
  readonly revision: number;
  readonly available: boolean;
  /** Replaces the whole source list when `expectedRevision` is still current. */
  replace(expectedRevision: number, sources: readonly StoredMarketplaceSource[]): Promise<void>;
}

async function readBounded(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Unsupported settings file');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const next = await handle.read(bytes, length, bytes.length - length, null);
      if (next.bytesRead === 0) break;
      length += next.bytesRead;
    }
    if (length > maxBytes) throw new Error('Settings file is too large');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    await handle.close();
  }
}

async function readCurrent(file: string): Promise<MarketplaceSettingsState | undefined> {
  const text = await readBounded(file);
  if (text === undefined) return undefined;
  const parsed = settingsFileSchema.parse(JSON.parse(text) as unknown);
  return { revision: parsed.revision, sources: parsed.sources };
}

/** Replays the retired append-only log into the current source list. Never writes to it. */
async function replayLegacy(file: string): Promise<StoredMarketplaceSource[] | undefined> {
  const text = await readBounded(file);
  if (text === undefined) return undefined;
  if (text !== '' && !text.endsWith('\n')) throw new Error('Legacy settings log is truncated');
  const active = new Map<string, StoredMarketplaceSource>();
  let sequence = 0;
  for (const line of text === '' ? [] : text.slice(0, -1).split('\n')) {
    const event = legacyEventSchema.parse(JSON.parse(line) as unknown);
    if (event.sequence !== sequence + 1 || !event.id.startsWith('remote-'))
      throw new Error('Legacy settings log is out of order');
    if (event.operation === 'add') {
      if (
        canonicalMarketplaceUrl(event.url) !== event.url ||
        marketplaceRemoteId(event.url) !== event.id ||
        active.has(event.id) ||
        active.size >= maxRemoteSources
      )
        throw new Error('Legacy settings log is invalid');
      active.set(event.id, { id: event.id, name: event.name, url: event.url });
    } else if (!active.delete(event.id)) throw new Error('Legacy settings log is invalid');
    sequence = event.sequence;
  }
  return [...active.values()];
}

/** Writes the whole state through a same-directory temporary file and an atomic rename. */
async function writeAtomic(file: string, state: MarketplaceSettingsState): Promise<void> {
  const bytes = Buffer.from(
    `${JSON.stringify({ version: 1, revision: state.revision, sources: state.sources })}\n`,
  );
  if (bytes.length > maxBytes) throw new Error('Settings file is too large');
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  try {
    const directory = await open(dirname(file), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the rename itself is already atomic.
  }
}

/**
 * Single Server owner of the current marketplace source list. The list lives in one JSON file
 * that is replaced atomically. A retired append-only log, when present and the new file is
 * not, is migrated once and left untouched on disk.
 */
export async function openMarketplaceSettings(
  file: string,
  legacyFile?: string,
): Promise<MarketplaceSettings> {
  let available = true;
  let state: MarketplaceSettingsState = { revision: 0, sources: [] };
  try {
    if (!isAbsolute(file) || file.includes('\0')) throw new Error('Invalid settings path');
    const current = await readCurrent(file);
    if (current !== undefined) state = current;
    else if (legacyFile !== undefined) {
      if (!isAbsolute(legacyFile) || legacyFile.includes('\0'))
        throw new Error('Invalid legacy settings path');
      const legacy = await replayLegacy(legacyFile);
      if (legacy !== undefined) {
        state = { revision: 1, sources: legacy };
        try {
          await writeAtomic(file, state);
        } catch {
          // Keep the replayed list readable, but refuse writes until the new file can be saved.
          available = false;
        }
      }
    }
  } catch {
    available = false;
    state = { revision: 0, sources: [] };
  }
  return {
    initial: state.sources,
    get revision() {
      return state.revision;
    },
    get available() {
      return available;
    },
    async replace(expectedRevision, sources) {
      if (!available) throw new MarketplaceSettingsError('unavailable', 'Settings unavailable');
      let disk: MarketplaceSettingsState | undefined;
      try {
        disk = await readCurrent(file);
      } catch {
        available = false;
        throw new MarketplaceSettingsError('unavailable', 'Settings unavailable');
      }
      const latest = disk ?? state;
      if (latest.revision !== expectedRevision || state.revision !== expectedRevision)
        throw new MarketplaceSettingsError('conflict', 'Settings revision conflict');
      const next = { revision: expectedRevision + 1, sources: [...sources] };
      try {
        settingsFileSchema.parse({ version: 1, ...next });
        await writeAtomic(file, next);
      } catch {
        throw new MarketplaceSettingsError('unavailable', 'Settings cannot be saved');
      }
      state = next;
    },
  };
}
