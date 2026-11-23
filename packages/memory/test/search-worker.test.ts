import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSqliteMemoryStore } from '../src/index.js';
import type { MemoryCommitGuard, MemoryStore } from '../src/types.js';

const scope = { kind: 'project' as const, projectId: 'd495a6df-265d-4fc7-93c8-a4452c197b62' };
const user = { kind: 'user' as const };
const guard: MemoryCommitGuard = {
  assertAuthorized() {},
  assertNewMutation() {},
  beforeCommit() {},
};
const stores: MemoryStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function open(
  options: {
    searchWorkerFactory?: (url: URL, options: WorkerOptions) => Pick<Worker, 'once' | 'terminate'>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'weave-search-'));
  dirs.push(dir);
  const store = createSqliteMemoryStore({ filename: join(dir, 'memory.sqlite'), ...options });
  stores.push(store);
  return store;
}
function save(
  store: MemoryStore,
  title: string,
  selectedScope: typeof scope | typeof user = scope,
) {
  return store.commit(
    {
      kind: 'create',
      expectedRevision: 0,
      key: {
        scope: selectedScope,
        requestId: randomUUID(),
        callerKey: 'local-user',
        digest: 'a'.repeat(64),
      },
      provenance: { actor: 'local-user' },
      content: { title, content: 'Needle body', tags: ['test'] },
    },
    guard,
  );
}

describe('bounded memory search workers', () => {
  it('returns one read snapshot with stable cross-scope ordering and keyset pages', async () => {
    const store = open();
    save(store, 'Needle', scope);
    save(store, 'Needle', user);
    save(store, 'Other', scope);
    const first = await store.search({ scopes: [scope, user], limit: 2, query: 'ＮＥＥＤＬＥ' });
    expect(first.entries).toHaveLength(2);
    expect(first.entries.every((entry) => entry.title === 'Needle')).toBe(true);
    expect(first.scopeHeads).toEqual([
      { scope, sequence: 3 },
      { scope: user, sequence: 2 },
    ]);
    expect(first.hasMore).toBe(true);
    const next = await store.search({
      scopes: [scope, user],
      limit: 2,
      query: 'needle',
      after: first.keys.at(-1)!,
    });
    expect(next.entries.map((entry) => entry.title)).toEqual(['Other']);
    save(store, 'Needle newest');
    const changed = await store.search({ scopes: [scope, user], limit: 2, query: 'needle' });
    expect(changed.scopeHeads[0]?.sequence).toBe(4);
    expect(changed.entries[0]?.title).toBe('Needle newest');
    expect(first.entries.every((entry) => Buffer.byteLength(entry.excerpt) <= 512)).toBe(true);
  });
  it('breaks equal title/timestamp ties by project scope then binary UUID', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T00:00:00.000Z'));
    try {
      const store = open();
      const userResult = save(store, 'Needle', user);
      const first = save(store, 'Needle');
      const second = save(store, 'Needle');
      const ids = [first.result, second.result]
        .map((result) => ('memoryId' in result ? result.memoryId : ''))
        .sort();
      const page = await store.search({ scopes: [user, scope], query: 'needle', limit: 50 });
      expect(page.entries.map((entry) => entry.ref.memoryId)).toEqual([
        ...ids,
        'memoryId' in userResult.result ? userResult.result.memoryId : '',
      ]);
      expect(page.keys.map((key) => key.scopeRank)).toEqual([0, 0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps cancelled worker slots occupied until actual exit and drains the same cleanup', async () => {
    class DelayedWorker extends EventEmitter {
      terminationRequests = 0;
      terminate(): Promise<number> {
        this.terminationRequests += 1;
        return new Promise((resolve) => this.once('exit', () => resolve(0)));
      }
    }
    const workers: DelayedWorker[] = [];
    const store = open({
      searchWorkerFactory: () => {
        const worker = new DelayedWorker();
        workers.push(worker);
        return worker as Pick<Worker, 'once' | 'terminate'>;
      },
    });
    const a = new AbortController();
    const b = new AbortController();
    const one = store.search({ scopes: [scope], limit: 1 }, a.signal);
    const two = store.search({ scopes: [scope], limit: 1 }, b.signal);
    a.abort();
    await expect(one).rejects.toMatchObject({ code: 'memory-cancelled' });
    await expect(store.search({ scopes: [scope], limit: 1 })).rejects.toMatchObject({
      code: 'memory-busy',
    });
    expect(workers[0]?.terminationRequests).toBe(1);
    workers[0]?.emit('exit', 0);
    const c = new AbortController();
    const three = store.search({ scopes: [scope], limit: 1 }, c.signal);
    expect(workers).toHaveLength(3);
    b.abort();
    c.abort();
    await expect(two).rejects.toMatchObject({ code: 'memory-cancelled' });
    await expect(three).rejects.toMatchObject({ code: 'memory-cancelled' });
    store.closeSync();
    store.closeSync();
    expect(workers[1]?.terminationRequests).toBe(1);
    expect(workers[2]?.terminationRequests).toBe(1);
    const closing = store.close();
    let finished = false;
    void closing.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    workers[1]?.emit('exit', 0);
    workers[2]?.emit('exit', 0);
    await closing;
  });
  it('terminates deadline-expired workers once and retains slots until exit', async () => {
    vi.useFakeTimers();
    const workers: (EventEmitter & { terminateCount: number; terminate(): Promise<number> })[] = [];
    const store = open({
      searchWorkerFactory: () => {
        const worker = Object.assign(new EventEmitter(), {
          terminateCount: 0,
          terminate() {
            this.terminateCount += 1;
            return Promise.resolve(0);
          },
        });
        workers.push(worker);
        return worker as Pick<Worker, 'once' | 'terminate'>;
      },
    });
    try {
      const a = store.search({ scopes: [scope], limit: 1 }).catch((error: unknown) => error);
      const b = store.search({ scopes: [scope], limit: 1 }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await a).toMatchObject({ code: 'memory-cancelled' });
      expect(await b).toMatchObject({ code: 'memory-cancelled' });
      await expect(store.search({ scopes: [scope], limit: 1 })).rejects.toMatchObject({
        code: 'memory-busy',
      });
      store.closeSync();
      expect(workers.map((worker) => worker.terminateCount)).toEqual([1, 1]);
      workers.forEach((worker) => worker.emit('exit', 0));
      await store.drain();
    } finally {
      vi.useRealTimers();
    }
  });
  it('shares the two live worker slots across owners', async () => {
    const workers: EventEmitter[] = [];
    const factory = () => {
      const worker = new EventEmitter();
      workers.push(worker);
      return Object.assign(worker, { terminate: () => Promise.resolve(0) }) as Pick<
        Worker,
        'once' | 'terminate'
      >;
    };
    const first = open({ searchWorkerFactory: factory });
    const second = open({ searchWorkerFactory: factory });
    const controller = new AbortController();
    const a = first.search({ scopes: [scope], limit: 1 }, controller.signal);
    const b = second.search({ scopes: [scope], limit: 1 }, controller.signal);
    const outcomes = [a.catch((error: unknown) => error), b.catch((error: unknown) => error)];
    const third = second.search({ scopes: [scope], limit: 1 });
    const handled = third.catch((error: unknown) => error);
    await Promise.resolve();
    expect(workers).toHaveLength(2);
    controller.abort();
    workers.forEach((worker) => worker.emit('exit', 0));
    expect(await handled).toMatchObject({ code: 'memory-busy' });
    await Promise.all(outcomes);
  });
  it('enforces the candidate cap across two scopes while allowing separate queries', async () => {
    const store = open();
    for (let i = 0; i < 10001; i += 1) save(store, `record ${i}`, i < 5000 ? scope : user);
    await expect(
      store.search({ scopes: [scope, user], limit: 1, query: 'missing' }),
    ).rejects.toMatchObject({ code: 'memory-limit' });
    expect(
      (await store.search({ scopes: [scope], limit: 1, query: 'record' })).entries,
    ).toHaveLength(1);
    expect(
      (await store.search({ scopes: [user], limit: 1, query: 'record' })).entries,
    ).toHaveLength(1);
  }, 30000);
});
