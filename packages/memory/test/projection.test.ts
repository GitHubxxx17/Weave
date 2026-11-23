import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createSqliteMemoryStore } from '../src/index.js';
import { parseMemoryEvent } from '../src/projection.js';

const scope = { kind: 'user' as const };
const guard = { assertAuthorized() {}, assertNewMutation() {}, beforeCommit() {} };
describe('memory fact authority', () => {
  it('rebuilds every derived table from immutable facts and rejects invalid receipt versions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-projection-'));
    const filename = join(dir, 'memory.sqlite');
    const store = createSqliteMemoryStore({ filename });
    try {
      const request = {
        scope,
        requestId: randomUUID(),
        callerKey: 'local-user',
        digest: 'a'.repeat(64),
      };
      const receipt = store.commit(
        {
          kind: 'create',
          key: request,
          provenance: { actor: 'local-user' },
          expectedRevision: 0,
          content: { title: 'Title', content: 'Body', tags: ['ＴＡＧ'] },
        },
        guard,
      );
      const db = new DatabaseSync(filename);
      const raw = db.prepare('SELECT payload_json FROM memory_events').get()?.payload_json;
      expect(typeof raw).toBe('string');
      const event: unknown = JSON.parse(String(raw));
      expect(() => parseMemoryEvent({ ...(event as object), version: 2 })).toThrow();
      expect(() =>
        parseMemoryEvent({ ...(event as object), receipt: { ...receipt, version: 2 } }),
      ).toThrow();
      for (const table of [
        'memory_current',
        'memory_requests',
        'memory_access_current',
        'memory_scope_heads',
      ])
        db.exec(`DELETE FROM ${table}`);
      store.rebuild();
      expect(store.lookupReceipt(request)).toEqual(receipt);
      expect(store.list({ scopes: [scope], limit: 1 }).entries[0]?.title).toBe('Title');
      expect(() => db.exec('DELETE FROM memory_events')).toThrow();
      db.close();
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('classifies malformed persisted JSON as a persistence failure on explicit history reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-json-'));
    const filename = join(dir, 'memory.sqlite');
    const store = createSqliteMemoryStore({ filename });
    try {
      const receipt = store.commit(
        {
          kind: 'create',
          key: { scope, requestId: randomUUID(), callerKey: 'local-user', digest: 'a'.repeat(64) },
          provenance: { actor: 'local-user' },
          expectedRevision: 0,
          content: { title: 'Title', content: 'Body', tags: [] },
        },
        guard,
      );
      if (!('memoryId' in receipt.result)) throw new Error('Expected record');
      const db = new DatabaseSync(filename);
      db.exec('DROP TRIGGER memory_events_no_update');
      db.exec("UPDATE memory_events SET payload_json = '{broken'");
      db.close();
      const memoryId = receipt.result.memoryId;
      expect(() => store.history(scope, memoryId)).toThrow(
        expect.objectContaining({ code: 'memory-persistence-error' }),
      );
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses unknown schema versions rather than treating the database as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-version-'));
    const filename = join(dir, 'memory.sqlite');
    const db = new DatabaseSync(filename);
    db.exec('PRAGMA user_version = 2');
    db.close();
    try {
      expect(() => createSqliteMemoryStore({ filename })).toThrow(
        expect.objectContaining({ code: 'memory-persistence-error' }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
