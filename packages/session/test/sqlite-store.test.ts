import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSqliteSessionEventStore,
  type SessionEventStore,
  type SessionStoreError,
} from '../src/index.js';

const temporaryFiles: string[] = [];

afterEach(async () => {
  const files = temporaryFiles.splice(0);
  await Promise.all(
    files.flatMap((filename) => [
      rm(filename, { force: true }),
      // WAL leaves sidecar files next to the database.
      rm(`${filename}-wal`, { force: true }),
      rm(`${filename}-shm`, { force: true }),
    ]),
  );
});

function createTemporaryFilename(): string {
  const filename = join(tmpdir(), `weave-session-${randomUUID()}.sqlite`);
  temporaryFiles.push(filename);
  return filename;
}

async function withStore(
  callback: (store: SessionEventStore, filename: string) => Promise<void>,
): Promise<void> {
  const filename = createTemporaryFilename();
  const store = createSqliteSessionEventStore({ filename });
  try {
    await callback(store, filename);
  } finally {
    await store.close();
  }
}

describe('SQLite Session Event Store', () => {
  it('restores events after closing and reopening the database', async () => {
    const filename = createTemporaryFilename();
    const first = createSqliteSessionEventStore({ filename });

    await first.append('session-1', [
      { type: 'session.created', payload: { title: 'Persisted' } },
      { type: 'turn.started', payload: { turnId: 'turn-1' } },
    ]);
    await first.close();

    const reopened = createSqliteSessionEventStore({ filename });
    const events = await reopened.read('session-1');

    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events[0]?.payload).toEqual({ title: 'Persisted' });

    await reopened.close();
  });

  it('restores lifecycle tombstones without deleting earlier events', async () => {
    const filename = createTemporaryFilename();
    const first = createSqliteSessionEventStore({ filename });

    await first.append('session-1', [
      { type: 'session.created', payload: { title: 'Persisted' } },
      { type: 'session.archived', payload: {} },
      { type: 'session.deleted', payload: { reason: '测试删除' } },
    ]);
    await first.close();

    const reopened = createSqliteSessionEventStore({ filename });
    const events = await reopened.read('session-1');

    expect(events.map((event) => event.type)).toEqual([
      'session.created',
      'session.archived',
      'session.deleted',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    await reopened.close();
  });

  it('isolates sessions and supports incremental reads', async () => {
    await withStore(async (store) => {
      await store.append('session-1', [
        { type: 'session.created', payload: { title: 'One' } },
        { type: 'turn.started', payload: { turnId: 'turn-1' } },
      ]);
      await store.append('session-2', [{ type: 'session.created', payload: { title: 'Two' } }]);

      expect(
        (await store.read('session-1', { afterSequence: 1 })).map((event) => event.sequence),
      ).toEqual([2]);
      expect((await store.read('session-2')).map((event) => event.sequence)).toEqual([1]);
    });
  });

  it('rejects invalid input before writing', async () => {
    await withStore(async (store) => {
      const error = await store
        .append('session-1', [
          { type: 'session.created', payload: { title: 'Valid' } },
          { type: 'turn.started', payload: { turnId: '' } },
        ])
        .catch((caughtError: unknown) => caughtError as SessionStoreError);

      expect(error).toMatchObject({ code: 'session-store-invalid-input' });
      expect(await store.read('session-1')).toEqual([]);
    });
  });

  it('rejects reads and writes after close', async () => {
    const filename = createTemporaryFilename();
    const store = createSqliteSessionEventStore({ filename });
    await store.close();
    await store.close();

    const appendError = await store
      .append('session-1', [])
      .catch((error: unknown) => error as SessionStoreError);
    const readError = await store
      .read('session-1')
      .catch((error: unknown) => error as SessionStoreError);

    expect(appendError).toMatchObject({ code: 'session-store-closed' });
    expect(readError).toMatchObject({ code: 'session-store-closed' });
  });
});

const legacyTableSql = `
  CREATE TABLE IF NOT EXISTS session_events (
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (session_id, sequence)
  )
`;

describe('SQLite Session Event Store hardening', () => {
  it('runs in WAL mode so other connections read committed events', async () => {
    const filename = createTemporaryFilename();
    const store = createSqliteSessionEventStore({ filename });
    await store.append('session-1', [{ type: 'session.created', payload: { title: 'WAL' } }]);

    const reader = new DatabaseSync(filename);
    try {
      expect(reader.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      const rows = reader
        .prepare('SELECT sequence FROM session_events WHERE session_id = ? ORDER BY sequence')
        .all('session-1');
      expect(rows.map((row) => row.sequence)).toEqual([1]);
    } finally {
      reader.close();
    }

    await store.close();
  });

  it('lets two connections on one file interleave appends and read each other', async () => {
    const filename = createTemporaryFilename();
    const a = createSqliteSessionEventStore({ filename });
    const b = createSqliteSessionEventStore({ filename, busyTimeoutMs: 1000 });

    await a.append('session-1', [{ type: 'session.created', payload: { title: 'A' } }]);
    await b.append('session-1', [{ type: 'turn.started', payload: { turnId: 'turn-1' } }]);
    await a.append('session-1', [
      { type: 'step.started', payload: { turnId: 'turn-1', stepId: 'step-1', kind: 'model' } },
    ]);

    expect((await b.read('session-1')).map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect((await a.read('session-1')).map((event) => event.type)).toEqual([
      'session.created',
      'turn.started',
      'step.started',
    ]);

    await a.close();
    await b.close();
  });

  it('records the schema version on a fresh database', async () => {
    const filename = createTemporaryFilename();
    const store = createSqliteSessionEventStore({ filename });
    await store.append('session-1', [{ type: 'session.created', payload: {} }]);
    await store.close();

    const reader = new DatabaseSync(filename);
    try {
      expect(reader.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    } finally {
      reader.close();
    }
  });

  it('refuses to open a database written by a newer schema version', async () => {
    const filename = createTemporaryFilename();
    const seed = new DatabaseSync(filename);
    seed.exec('PRAGMA user_version = 999');
    seed.close();

    const error = await (async () => {
      try {
        createSqliteSessionEventStore({ filename }).close();
        return undefined;
      } catch (caught) {
        return caught as SessionStoreError;
      }
    })();

    expect(error).toMatchObject({ code: 'session-store-migration' });
  });

  it('upgrades a legacy database that has rows but no schema version', async () => {
    const filename = createTemporaryFilename();
    const seed = new DatabaseSync(filename);
    seed.exec(legacyTableSql);
    seed
      .prepare(
        `INSERT INTO session_events
          (session_id, sequence, event_id, type, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'session-1',
        1,
        randomUUID(),
        'session.created',
        '2026-11-15T00:00:01.000Z',
        JSON.stringify({ title: 'Legacy' }),
      );
    expect(seed.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
    seed.close();

    const store = createSqliteSessionEventStore({ filename });
    const events = await store.read('session-1');
    expect(events.map((event) => event.type)).toEqual(['session.created']);
    expect(events[0]?.payload).toEqual({ title: 'Legacy' });

    // New appends continue the sequence on the upgraded database.
    await store.append('session-1', [{ type: 'turn.started', payload: { turnId: 'turn-1' } }]);
    expect((await store.read('session-1')).map((event) => event.sequence)).toEqual([1, 2]);
    await store.close();

    const reader = new DatabaseSync(filename);
    try {
      expect(reader.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    } finally {
      reader.close();
    }
  });
});
