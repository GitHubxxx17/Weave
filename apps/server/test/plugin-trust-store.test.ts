import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PluginTrustEvent, RecordedPluginTrustEvent } from '@weave/plugin-host';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqlitePluginTrustStore, PluginTrustStoreError } from '../src/plugin-trust-store.js';

const occurredAt = '2026-11-21T00:00:00.000Z';
const filenames: string[] = [];
const stores: ReturnType<typeof createSqlitePluginTrustStore>[] = [];

function filename(): string {
  const result = join(tmpdir(), `weave-plugin-trust-${randomUUID()}.sqlite`);
  filenames.push(result);
  return result;
}

function openStore(file: string = filename()) {
  const store = createSqlitePluginTrustStore({ filename: file, now: () => new Date(occurredAt) });
  stores.push(store);
  return store;
}

function trusted(): PluginTrustEvent {
  return {
    kind: 'trusted',
    pluginId: 'notes',
    digest: 'a'.repeat(64),
    manifest: {
      id: 'notes',
      name: 'Notes',
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: ['command'],
      contributes: { commands: ['take-note'] },
      permissions: ['workspace:write'],
    },
  };
}

function record(sequence = 1): RecordedPluginTrustEvent {
  return { kind: 'revoked', pluginId: 'notes', sequence, occurredAt, scope: 'user' };
}

function seedRow(
  file: string,
  values: {
    readonly sequence?: number | bigint;
    readonly occurredAt?: string;
    readonly scope?: string;
    readonly json: string;
  },
): void {
  const database = new DatabaseSync(file);
  try {
    database
      .prepare(
        'INSERT INTO plugin_trust_events (sequence, occurred_at, scope, event_json) VALUES (?, ?, ?, ?)',
      )
      .run(
        values.sequence ?? 1,
        values.occurredAt ?? occurredAt,
        values.scope ?? 'user',
        values.json,
      );
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(filenames.splice(0).map((file) => rm(file, { force: true })));
});

describe('SQLite Plugin Trust Store', () => {
  it('persists every decision with stable metadata across reopen', async () => {
    const file = filename();
    const store = openStore(file);
    const decisions: PluginTrustEvent[] = [
      trusted(),
      { kind: 'disabled', pluginId: 'notes' },
      { kind: 'enabled', pluginId: 'notes' },
      { kind: 'revoked', pluginId: 'notes' },
    ];
    for (const [index, decision] of decisions.entries()) {
      await expect(store.append(decision)).resolves.toEqual({
        ...decision,
        sequence: index + 1,
        occurredAt,
        scope: 'user',
      });
    }
    await store.close();

    const reopened = openStore(file);
    await expect(reopened.events()).resolves.toEqual(
      decisions.map((decision, index) => ({
        ...decision,
        sequence: index + 1,
        occurredAt,
        scope: 'user',
      })),
    );
    await expect(reopened.append({ kind: 'revoked', pluginId: 'other' })).resolves.toMatchObject({
      sequence: 5,
    });
  });

  it('shares sequences between independent connections without replacing earlier facts', async () => {
    const file = filename();
    const first = openStore(file);
    const second = openStore(file);

    await first.append({ kind: 'enabled', pluginId: 'notes' });
    await second.append({ kind: 'disabled', pluginId: 'notes' });
    await first.append({ kind: 'revoked', pluginId: 'notes' });

    await expect(second.events()).resolves.toEqual([
      { ...record(1), kind: 'enabled' },
      { ...record(2), kind: 'disabled' },
      record(3),
    ]);
  });

  it('leaves the shared database schema version and unrelated tables untouched', async () => {
    const file = filename();
    const database = new DatabaseSync(file);
    try {
      database.exec('PRAGMA user_version = 17; CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
      database.prepare('INSERT INTO unrelated VALUES (?)').run('keep');
      const store = openStore(file);
      await store.append({ kind: 'revoked', pluginId: 'notes' });

      expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(17);
      expect(database.prepare('SELECT id FROM unrelated').get()?.id).toBe('keep');
      const row = database
        .prepare('SELECT sequence, occurred_at, scope, event_json FROM plugin_trust_events')
        .get();
      expect(row).toMatchObject({ sequence: 1, occurred_at: occurredAt, scope: 'user' });
      expect(JSON.parse(String(row?.event_json))).toEqual(record());
    } finally {
      database.close();
    }
  });

  it.each([
    { kind: 'trusted', pluginId: 'notes', digest: 'wrong', manifest: trusted().kind },
    { kind: 'revoked', pluginId: '' },
    { kind: 'revoked', pluginId: 'notes', sequence: 99 },
  ])('rejects invalid external decisions without consuming a sequence', async (event) => {
    const store = openStore();
    await expect(store.append(event as PluginTrustEvent)).rejects.toMatchObject({
      code: 'plugin-trust-invalid',
    });
    await expect(store.events()).resolves.toEqual([]);
    await expect(store.append({ kind: 'revoked', pluginId: 'notes' })).resolves.toEqual(record());
  });

  it('returns independent data so caller mutations cannot rewrite persisted trust', async () => {
    const store = openStore();
    const decision = trusted();
    const appended = await store.append(decision);
    if (appended.kind !== 'trusted' || decision.kind !== 'trusted') throw new Error('fixture');
    (decision.manifest as { name: string }).name = 'Changed caller input';
    (appended.manifest as { name: string }).name = 'Changed append result';
    const firstRead = await store.events();
    const first = firstRead[0];
    if (first?.kind !== 'trusted') throw new Error('fixture');
    (first.manifest as { name: string }).name = 'Changed read result';

    await expect(store.events()).resolves.toMatchObject([{ manifest: { name: 'Notes' } }]);
  });

  it('rejects a trust event whose reviewed manifest names another plugin', async () => {
    const store = openStore();
    const decision = trusted();
    if (decision.kind !== 'trusted') throw new Error('fixture');

    await expect(
      store.append({ ...decision, manifest: { ...decision.manifest, id: 'another' } }),
    ).rejects.toMatchObject({ code: 'plugin-trust-invalid' });
    await expect(store.events()).resolves.toEqual([]);
  });

  it.each([
    { json: '{broken' },
    { json: JSON.stringify({ ...record(), kind: 'not-a-decision' }) },
    { json: JSON.stringify({ ...record(), extra: true }) },
    { json: JSON.stringify({ ...record(), sequence: 2 }) },
    { json: JSON.stringify(record()), occurredAt: 'other timestamp' },
    { json: JSON.stringify(record()), scope: 'project' },
    { json: JSON.stringify(record(2)), sequence: 2 },
    {
      json: JSON.stringify({
        ...trusted(),
        pluginId: 'another',
        sequence: 1,
        occurredAt,
        scope: 'user',
      }),
    },
    { json: JSON.stringify(record()), sequence: 9_007_199_254_740_992n },
  ])('rejects corrupted persisted metadata or payload', async (values) => {
    const file = filename();
    const store = openStore(file);
    seedRow(file, values);

    await expect(store.events()).rejects.toMatchObject({ code: 'plugin-trust-protocol' });
  });

  it('refuses to append any fact after a corrupted persisted event', async () => {
    const file = filename();
    const store = openStore(file);
    seedRow(file, { json: '{broken' });

    await expect(store.append({ kind: 'revoked', pluginId: 'other' })).rejects.toMatchObject({
      code: 'plugin-trust-protocol',
    });
    const database = new DatabaseSync(file);
    try {
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM plugin_trust_events').get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it('rejects an interior sequence gap instead of silently folding an incomplete log', async () => {
    const file = filename();
    const store = openStore(file);
    seedRow(file, { json: JSON.stringify(record()) });
    seedRow(file, { sequence: 3, json: JSON.stringify(record(3)) });

    await expect(store.events()).rejects.toMatchObject({ code: 'plugin-trust-protocol' });
  });

  it('rolls back a failed append so the next append still takes the next contiguous sequence', async () => {
    const file = filename();
    const store = openStore(file);
    await store.append({ kind: 'revoked', pluginId: 'notes' });
    const database = new DatabaseSync(file);
    try {
      database.exec(`
        CREATE TRIGGER reject_trust_append BEFORE INSERT ON plugin_trust_events
        BEGIN SELECT RAISE(ABORT, 'injected write failure'); END
      `);
      await expect(store.append({ kind: 'enabled', pluginId: 'notes' })).rejects.toMatchObject({
        code: 'plugin-trust-storage',
      });
      await expect(store.events()).resolves.toEqual([record()]);
      database.exec('DROP TRIGGER reject_trust_append');
      await expect(store.append({ kind: 'disabled', pluginId: 'notes' })).resolves.toMatchObject({
        sequence: 2,
      });
    } finally {
      database.close();
    }
  });

  it('preserves the original storage failure when SQLite already rolled the transaction back', async () => {
    const file = filename();
    const store = openStore(file);
    const database = new DatabaseSync(file);
    try {
      database.exec(`
        CREATE TRIGGER rollback_trust_append BEFORE INSERT ON plugin_trust_events
        BEGIN SELECT RAISE(ROLLBACK, 'original append failure'); END
      `);
      await expect(store.append({ kind: 'revoked', pluginId: 'notes' })).rejects.toMatchObject({
        code: 'plugin-trust-storage',
        cause: { message: 'original append failure' },
      });
      database.exec('DROP TRIGGER rollback_trust_append');
      await expect(store.append({ kind: 'revoked', pluginId: 'notes' })).resolves.toEqual(record());
    } finally {
      database.close();
    }
  });

  it('validates the clock result before persisting the complete recorded event', async () => {
    const store = createSqlitePluginTrustStore({ filename: filename(), now: () => new Date(NaN) });
    stores.push(store);

    await expect(store.append({ kind: 'revoked', pluginId: 'notes' })).rejects.toMatchObject({
      code: 'plugin-trust-invalid',
    });
    await expect(store.events()).resolves.toEqual([]);
  });

  it('reports storage read failures through the typed storage boundary', async () => {
    const file = filename();
    const store = openStore(file);
    const database = new DatabaseSync(file);
    database.exec('DROP TABLE plugin_trust_events');
    database.close();

    await expect(store.events()).rejects.toMatchObject({ code: 'plugin-trust-storage' });
  });

  it('keeps close idempotent and rejects further reads and appends with a typed error', async () => {
    const store = openStore();
    await store.close();
    await store.close();

    await expect(store.events()).rejects.toBeInstanceOf(PluginTrustStoreError);
    await expect(store.events()).rejects.toMatchObject({ code: 'plugin-trust-closed' });
    await expect(store.append({ kind: 'revoked', pluginId: 'notes' })).rejects.toMatchObject({
      code: 'plugin-trust-closed',
    });
  });

  it('reports invalid options and storage-open failures separately', () => {
    expect(() => createSqlitePluginTrustStore({ filename: '' })).toThrow(
      expect.objectContaining({ code: 'plugin-trust-invalid' }),
    );
    expect(() =>
      createSqlitePluginTrustStore({ filename: join(filename(), 'missing', 'db') }),
    ).toThrow(expect.objectContaining({ code: 'plugin-trust-storage' }));
  });
});
