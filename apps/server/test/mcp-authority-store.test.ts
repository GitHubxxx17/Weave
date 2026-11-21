import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpConfigDigest, type McpServerConfig } from '../src/mcp-environment.js';
import {
  createSqliteMcpAuthorityStore,
  McpAuthorityError,
  validateMcpAuthorityLog,
  type McpAuthorityCommand,
  type McpAuthorityLog,
  type RecordedMcpAuthorityEvent,
} from '../src/mcp-authority-store.js';

const occurredAt = '2026-11-21T00:00:00.000Z';
const filenames: string[] = [];
const stores: ReturnType<typeof createSqliteMcpAuthorityStore>[] = [];
function filename() {
  const value = join(tmpdir(), `weave-mcp-authority-${randomUUID()}.sqlite`);
  filenames.push(value);
  return value;
}
function open(file = filename(), now = () => new Date(occurredAt)) {
  const store = createSqliteMcpAuthorityStore({ filename: file, now });
  stores.push(store);
  return store;
}
function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    schemaVersion: 1,
    id: 'notes',
    label: 'Notes',
    transport: 'stdio',
    command: process.execPath,
    args: [],
    cwd: tmpdir(),
    env: {},
    ...overrides,
  };
}
function event(sequence = 1, value = config()): RecordedMcpAuthorityEvent {
  return {
    kind: 'configured',
    config: value,
    configDigest: mcpConfigDigest(value),
    schemaVersion: 1,
    sequence,
    occurredAt,
    scope: 'user',
  };
}
async function mutate(
  store: ReturnType<typeof open>,
  command: McpAuthorityCommand,
  log?: McpAuthorityLog,
) {
  const known = log ?? (await store.read());
  return store.mutate(command, { expectedSequence: known.sequence, knownPrefix: known.events });
}
function seed(
  file: string,
  json: string,
  sequence: number | bigint = 1,
  timestamp = occurredAt,
  scope = 'user',
) {
  const db = new DatabaseSync(file);
  try {
    db.prepare(
      'INSERT INTO mcp_authority_events (sequence, occurred_at, scope, event_json) VALUES (?, ?, ?, ?)',
    ).run(sequence, timestamp, scope, json);
  } finally {
    db.close();
  }
}
function database(file: string, fn: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(file);
  try {
    fn(db);
  } finally {
    db.close();
  }
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(filenames.splice(0).map((file) => rm(file, { force: true })));
});

describe('MCP durable authority', () => {
  it('persists a complete frozen log across reopen and isolates caller data', async () => {
    const file = filename();
    const store = open(file);
    const input = config({ env: { TOKEN: { fromHostEnv: 'HOST_TOKEN' } } });
    const created = await mutate(store, { kind: 'create', config: input });
    expect(created).toMatchObject({
      sequence: 1,
      appended: event(1, input),
      records: [
        {
          configDigest: mcpConfigDigest(input),
          enabled: false,
          trustState: 'untrusted',
          trustedDigest: null,
          removed: false,
          reviewed: null,
        },
      ],
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.events[0])).toBe(true);
    expect(Object.isFrozen(created.records[0]?.config.env.TOKEN)).toBe(true);
    (input.env.TOKEN as { fromHostEnv: string }).fromHostEnv = 'CHANGED';
    await store.close();
    expect(await open(file).read()).toEqual({
      sequence: created.sequence,
      events: created.events,
      records: created.records,
    });
  });

  it('preserves label-only trust and disable while digest changes require new review', async () => {
    const store = open();
    let log = await mutate(store, { kind: 'create', config: config() });
    const digest = log.records[0]!.configDigest;
    log = await mutate(store, { kind: 'trust', serverId: 'notes', configDigest: digest }, log);
    expect(log.records[0]).toMatchObject({
      enabled: true,
      trustedDigest: digest,
      trustState: 'trusted',
      reviewed: { configDigest: digest, trustedAt: occurredAt },
    });
    log = await mutate(store, { kind: 'disable', serverId: 'notes' }, log);
    log = await mutate(store, { kind: 'update', config: config({ label: 'Renamed' }) }, log);
    expect(log.records[0]).toMatchObject({
      enabled: false,
      trustedDigest: digest,
      trustState: 'trusted',
      config: { label: 'Renamed' },
      reviewed: { config: { label: 'Notes' } },
    });
    log = await mutate(store, { kind: 'enable', serverId: 'notes', configDigest: digest }, log);
    expect(log.records[0]?.enabled).toBe(true);
    log = await mutate(store, { kind: 'update', config: config({ args: ['changed'] }) }, log);
    expect(log.records[0]).toMatchObject({
      enabled: false,
      trustedDigest: null,
      trustState: 'changed',
      reviewed: { configDigest: digest },
    });
    log = await mutate(store, { kind: 'update', config: config() }, log);
    expect(log.records[0]).toMatchObject({
      trustState: 'changed',
      trustedDigest: null,
      enabled: false,
    });
    await expect(
      mutate(store, { kind: 'enable', serverId: 'notes', configDigest: digest }, log),
    ).rejects.toMatchObject({ code: 'mcp-conflict' });
    log = await mutate(store, { kind: 'revoke', serverId: 'notes' }, log);
    log = await mutate(store, { kind: 'update', config: config({ args: ['another'] }) }, log);
    expect(log.records[0]).toMatchObject({
      trustState: 'untrusted',
      trustedDigest: null,
      enabled: false,
    });
  });

  it('retains tombstones and requires new trust when an ID is recreated', async () => {
    const store = open();
    let log = await mutate(store, { kind: 'create', config: config() });
    log = await mutate(
      store,
      { kind: 'trust', serverId: 'notes', configDigest: log.records[0]!.configDigest },
      log,
    );
    log = await mutate(store, { kind: 'remove', serverId: 'notes' }, log);
    expect(log.records[0]).toMatchObject({ removed: true, enabled: false, trustedDigest: null });
    log = await mutate(store, { kind: 'create', config: config() }, log);
    expect(log.records[0]).toMatchObject({
      removed: false,
      enabled: false,
      trustedDigest: null,
      trustState: 'untrusted',
      reviewed: null,
    });
    expect(log.events).toHaveLength(4);
  });

  it('checks CAS even for no-op changes and does not consume sequence on conflicts', async () => {
    const file = filename();
    const first = open(file);
    const second = open(file);
    const log = await mutate(first, { kind: 'create', config: config() });
    const trusted = await second.mutate(
      { kind: 'trust', serverId: 'notes', configDigest: log.records[0]!.configDigest },
      { expectedSequence: 1, knownPrefix: log.events },
    );
    await expect(
      first.mutate(
        { kind: 'disable', serverId: 'notes' },
        { expectedSequence: 1, knownPrefix: log.events },
      ),
    ).rejects.toMatchObject({ code: 'mcp-conflict' });
    await expect(
      mutate(first, { kind: 'trust', serverId: 'notes', configDigest: 'a'.repeat(64) }, trusted),
    ).rejects.toMatchObject({ code: 'mcp-conflict' });
    await expect(
      mutate(first, { kind: 'create', config: config() }, trusted),
    ).rejects.toMatchObject({ code: 'mcp-conflict' });
    await expect(
      mutate(first, { kind: 'remove', serverId: 'missing' }, trusted),
    ).rejects.toMatchObject({ code: 'mcp-not-found' });
    const disabled = await mutate(first, { kind: 'disable', serverId: 'notes' }, trusted);
    const repeated = await mutate(first, { kind: 'disable', serverId: 'notes' }, disabled);
    expect(repeated).toMatchObject({ sequence: 3, appended: null });
    await expect(
      second.mutate(
        { kind: 'disable', serverId: 'notes' },
        { expectedSequence: 2, knownPrefix: trusted.events },
      ),
    ).rejects.toMatchObject({ code: 'mcp-conflict' });
    expect((await first.read()).sequence).toBe(3);
  });

  it('limits live IDs to eight while allowing a tombstone to be replaced', async () => {
    const store = open();
    let log = await store.read();
    for (let index = 0; index < 8; index++)
      log = await mutate(store, { kind: 'create', config: config({ id: `server-${index}` }) }, log);
    await expect(
      mutate(store, { kind: 'create', config: config({ id: 'ninth' }) }, log),
    ).rejects.toMatchObject({ code: 'mcp-conflict' });
    log = await mutate(store, { kind: 'remove', serverId: 'server-0' }, log);
    log = await mutate(store, { kind: 'create', config: config({ id: 'ninth' }) }, log);
    expect(log.records.filter((record) => !record.removed)).toHaveLength(8);
  });

  it('accepts a valid external suffix but rejects truncation and prefix replacement before read or append', async () => {
    const file = filename();
    const store = open(file);
    const second = open(file);
    const original = await mutate(store, { kind: 'create', config: config() });
    const suffix = await mutate(second, {
      kind: 'trust',
      serverId: 'notes',
      configDigest: original.records[0]!.configDigest,
    });
    expect(await store.read({ knownPrefix: original.events })).toEqual({
      sequence: suffix.sequence,
      events: suffix.events,
      records: suffix.records,
    });
    database(file, (db) => {
      db.exec('DELETE FROM mcp_authority_events WHERE sequence = 2');
    });
    await expect(store.read({ knownPrefix: suffix.events })).rejects.toMatchObject({
      code: 'mcp-authority-protocol',
    });
    await expect(
      store.mutate(
        { kind: 'disable', serverId: 'notes' },
        { expectedSequence: 1, knownPrefix: suffix.events },
      ),
    ).rejects.toMatchObject({ code: 'mcp-authority-protocol' });
    database(file, (db) => {
      db.prepare('UPDATE mcp_authority_events SET event_json = ? WHERE sequence = 1').run(
        JSON.stringify(event(1, config({ label: 'Rewritten' }))),
      );
    });
    await expect(store.read({ knownPrefix: original.events })).rejects.toMatchObject({
      code: 'mcp-authority-protocol',
    });
  });

  it.each([
    { json: '{broken' },
    { json: JSON.stringify({ ...event(), extra: true }) },
    { json: JSON.stringify({ ...event(), sequence: 2 }) },
    { json: JSON.stringify(event()), timestamp: 'wrong' },
    { json: JSON.stringify(event()), scope: 'project' },
    { json: JSON.stringify(event(2)), sequence: 2 },
    { json: JSON.stringify(event()), sequence: 9_007_199_254_740_992n },
    { json: JSON.stringify({ ...event(), configDigest: 'a'.repeat(64) }) },
    {
      json: JSON.stringify({
        kind: 'enabled',
        serverId: 'notes',
        configDigest: 'a'.repeat(64),
        schemaVersion: 1,
        sequence: 1,
        occurredAt,
        scope: 'user',
      }),
    },
    { json: JSON.stringify({ ...event(), occurredAt: 'not-ISO' }), timestamp: 'not-ISO' },
  ])(
    'rejects malformed metadata, digests and impossible historical transitions %#',
    async (row) => {
      const file = filename();
      const store = open(file);
      seed(file, row.json, row.sequence, row.timestamp, row.scope);
      await expect(store.read()).rejects.toMatchObject({ code: 'mcp-authority-protocol' });
      await expect(
        store.mutate(
          { kind: 'create', config: config() },
          { expectedSequence: 0, knownPrefix: [] },
        ),
      ).rejects.toMatchObject({ code: 'mcp-authority-protocol' });
      database(file, (db) => {
        expect(db.prepare('SELECT COUNT(*) AS count FROM mcp_authority_events').get()?.count).toBe(
          1,
        );
      });
    },
  );

  it('rejects interior gaps and invalid enabled or trust decisions in otherwise valid history', async () => {
    for (const kind of ['enabled', 'trusted'] as const) {
      const file = filename();
      const store = open(file);
      seed(file, JSON.stringify(event()));
      seed(
        file,
        JSON.stringify({
          kind,
          serverId: 'notes',
          configDigest: 'a'.repeat(64),
          schemaVersion: 1,
          sequence: 2,
          occurredAt,
          scope: 'user',
        }),
        2,
      );
      await expect(store.read()).rejects.toMatchObject({ code: 'mcp-authority-protocol' });
    }
    const file = filename();
    const store = open(file);
    seed(file, JSON.stringify(event()));
    seed(file, JSON.stringify(event(3, config({ id: 'other' }))), 3);
    await expect(store.read()).rejects.toMatchObject({ code: 'mcp-authority-protocol' });
  });

  it('rolls back a failed insert without changing cached callers or consuming a sequence', async () => {
    const file = filename();
    const store = open(file);
    const before = await mutate(store, { kind: 'create', config: config() });
    database(file, (db) => {
      db.exec(
        "CREATE TRIGGER reject_mcp BEFORE INSERT ON mcp_authority_events BEGIN SELECT RAISE(ABORT, 'secret sqlite detail'); END",
      );
    });
    await expect(
      mutate(
        store,
        { kind: 'trust', serverId: 'notes', configDigest: before.records[0]!.configDigest },
        before,
      ),
    ).rejects.toMatchObject({
      code: 'mcp-authority-storage',
      message: 'MCP authority storage operation failed',
    });
    expect(await store.read()).toEqual({
      sequence: before.sequence,
      events: before.events,
      records: before.records,
    });
    database(file, (db) => {
      db.exec('DROP TRIGGER reject_mcp');
    });
    expect(
      (
        await mutate(
          store,
          { kind: 'trust', serverId: 'notes', configDigest: before.records[0]!.configDigest },
          before,
        )
      ).sequence,
    ).toBe(2);
  });

  it('does not re-stat persisted paths and leaves unrelated database state intact', async () => {
    const file = filename();
    database(file, (db) => {
      db.exec(
        "PRAGMA user_version = 17; CREATE TABLE unrelated (id TEXT); INSERT INTO unrelated VALUES ('keep')",
      );
    });
    const store = open(file);
    const value = config({ command: '/does/not/exist', cwd: '/missing-directory' });
    seed(file, JSON.stringify(event(1, value)));
    expect((await store.read()).records[0]?.config).toEqual(value);
    database(file, (db) => {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(17);
      expect(db.prepare('SELECT id FROM unrelated').get()?.id).toBe('keep');
    });
  });

  it('validates injected logs against their recomputed fold and freezes independent copies', async () => {
    const store = open();
    const created = await mutate(store, { kind: 'create', config: config() });
    const log = { sequence: created.sequence, events: created.events, records: created.records };
    expect(validateMcpAuthorityLog(log)).toEqual(log);
    expect(() => validateMcpAuthorityLog({ ...log, sequence: 2 })).toThrow(
      expect.objectContaining({ code: 'mcp-authority-protocol' }),
    );
    expect(() =>
      validateMcpAuthorityLog({ ...log, records: [{ ...log.records[0], enabled: true }] }),
    ).toThrow(expect.objectContaining({ code: 'mcp-authority-protocol' }));
    expect(() =>
      validateMcpAuthorityLog({ sequence: 0, events: [], records: [] }, log.events),
    ).toThrow(expect.objectContaining({ code: 'mcp-authority-protocol' }));
    const external = structuredClone(log);
    const validated = validateMcpAuthorityLog(external);
    external.events.length = 0;
    expect(validated.events).toHaveLength(1);
    expect(Object.isFrozen(validated.records[0]?.config)).toBe(true);
  });

  it('preserves __proto__ environment references across SQLite and injected result validation', async () => {
    const store = open();
    const env = JSON.parse('{"__proto__":{"fromHostEnv":"HOST_TOKEN"}}') as McpServerConfig['env'];
    const created = await mutate(store, { kind: 'create', config: config({ env }) });
    const log = await store.read();
    expect(Object.keys(log.records[0]!.config.env)).toEqual(['__proto__']);
    expect(log.events).toEqual(created.events);
    expect(validateMcpAuthorityLog(created)).toEqual(log);
  });

  it('rejects untrusted enable and every event targeting a removed lifecycle', async () => {
    const file = filename();
    const store = open(file);
    let log = await mutate(store, { kind: 'create', config: config() });
    await expect(
      mutate(
        store,
        { kind: 'enable', serverId: 'notes', configDigest: log.records[0]!.configDigest },
        log,
      ),
    ).rejects.toMatchObject({ code: 'mcp-conflict' });
    log = await mutate(store, { kind: 'remove', serverId: 'notes' }, log);
    seed(
      file,
      JSON.stringify({
        kind: 'trusted',
        serverId: 'notes',
        configDigest: log.records[0]!.configDigest,
        schemaVersion: 1,
        sequence: 3,
        occurredAt,
        scope: 'user',
      }),
      3,
    );
    await expect(store.read()).rejects.toMatchObject({ code: 'mcp-authority-protocol' });
  });

  it('rejects invalid commands, timestamps and closed operations using fixed errors', async () => {
    const store = open();
    await expect(
      store.mutate(
        { kind: 'create', config: { ...config(), extra: 'secret' } } as McpAuthorityCommand,
        { expectedSequence: 0, knownPrefix: [] },
      ),
    ).rejects.toMatchObject({ code: 'mcp-invalid' });
    await expect(
      store.mutate({ kind: 'create', config: config() }, { expectedSequence: -1, knownPrefix: [] }),
    ).rejects.toMatchObject({ code: 'mcp-invalid' });
    const badClock = open(filename(), () => new Date('invalid'));
    await expect(mutate(badClock, { kind: 'create', config: config() })).rejects.toMatchObject({
      code: 'mcp-invalid',
    });
    await store.close();
    await store.close();
    await expect(store.read()).rejects.toBeInstanceOf(McpAuthorityError);
    await expect(store.read()).rejects.toMatchObject({ code: 'mcp-closed' });
  });
});
