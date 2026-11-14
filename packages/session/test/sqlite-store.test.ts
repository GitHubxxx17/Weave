import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSqliteSessionEventStore,
  type SessionEventStore,
  type SessionStoreError,
} from '../src/index.js';

const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryFiles.splice(0).map((filename) => rm(filename, { force: true })));
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
