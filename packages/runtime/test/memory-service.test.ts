import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryAccess, MemoryCurrent, MemoryReceipt, MemoryScope } from '@weave/protocol';
import { createMemoryService } from '../src/memory-service.js';
import type { MemoryStorePort } from '../src/memory-types.js';
import { MemoryError } from '../src/memory-errors.js';

function fixture() {
  const scope: MemoryScope = { kind: 'project', projectId: randomUUID() };
  const record: MemoryCurrent = {
    ref: { scope, memoryId: randomUUID(), revision: 1, sha256: 'a'.repeat(64) },
    title: 'Known preference',
    content: 'Use strict TypeScript',
    tags: ['coding'],
    provenance: { actor: 'local-user' },
    review: 'user-reviewed',
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
  };
  let access: MemoryAccess = { scope, level: 'read-write', settingRevision: 1 };
  let head = 1;
  let rollback = false;
  let localLive = true;
  const receipt: MemoryReceipt = {
    requestId: randomUUID(),
    operation: 'create',
    sequence: 1,
    subject: { kind: 'record', scope, memoryId: record.ref.memoryId, revision: 1 },
    result: record.ref,
  };
  const store: MemoryStorePort = {
    lookupReceipt: vi.fn(() => undefined),
    commit: vi.fn((mutation, guard) => {
      guard.assertAuthorized(access);
      guard.assertNewMutation(access, mutation.kind === 'create' ? undefined : record);
      guard.beforeCommit({ scope, memoryId: record.ref.memoryId });
      if (rollback) throw new MemoryError('memory-persistence-error');
      head++;
      return receipt;
    }),
    read: vi.fn(() => record),
    readRevision: vi.fn(() => record),
    readSnapshot: vi.fn(() => [record]),
    history: vi.fn(() => []),
    getAccess: vi.fn(() => access),
    getScopeHead: vi.fn(() => head),
    list: vi.fn(() => ({
      entries: [
        {
          ref: record.ref,
          title: record.title,
          tags: record.tags,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          provenance: record.provenance,
          review: record.review,
          excerpt: record.content,
        },
      ],
      keys: [
        { titleHit: 0, updatedAt: record.updatedAt, scopeRank: 0, memoryId: record.ref.memoryId },
      ],
      scopeHeads: [{ scope, sequence: head }],
      hasMore: false,
    })),
    search: vi.fn(async (input) => store.list(input)),
    closeSync: vi.fn(),
    drain: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const before = vi.fn(() => undefined);
  const resolveLocalScope = vi.fn(async () => ({
    assertCurrentSync() {
      if (!localLive) throw new MemoryError('memory-scope-forbidden');
    },
  }));
  const service = createMemoryService({
    store,
    beforeMemoryCommit: before,
    resolveLocalScope,
    resolveAgentScope: async () => {
      throw new Error('No Agent fixture');
    },
  });
  return {
    service,
    store,
    scope,
    record,
    before,
    receipt,
    resolveLocalScope,
    setAccess: (value: MemoryAccess) => {
      access = value;
    },
    rollback: () => {
      rollback = true;
    },
    revokeLocal: () => {
      localLive = false;
    },
  };
}

describe('Memory service local management and reviewed captures', () => {
  it('allows local management while Agent use is disabled, with host provenance', async () => {
    const f = fixture();
    f.setAccess({ scope: f.scope, level: 'disabled', settingRevision: 2 });
    expect(await f.service.local.read(f.scope, f.record.ref.memoryId)).toEqual(f.record);
    await f.service.local.create(f.scope, {
      operation: 'create',
      requestId: randomUUID(),
      expectedRevision: 0,
      title: 'New',
      content: 'A local edit',
      tags: [],
    });
    expect(f.store.commit).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: { actor: 'local-user' }, kind: 'create' }),
      expect.any(Object),
    );
    await expect(
      f.service.reviewedSource.capture({
        projectId: f.scope.kind === 'project' ? f.scope.projectId : '',
        refs: [f.record.ref],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'memory-disabled' });
  });
  it('captures exact reviewed records and rejects copied, stale and shut down captures', async () => {
    const f = fixture();
    const input = {
      projectId: f.scope.kind === 'project' ? f.scope.projectId : '',
      refs: [f.record.ref],
      signal: new AbortController().signal,
    };
    const capture = await f.service.reviewedSource.capture(input);
    expect(Object.isFrozen(capture)).toBe(true);
    expect(Object.isFrozen(capture.records[0]!.content)).toBe(true);
    f.service.reviewedSource.assertCurrentSync(capture);
    expect(() => f.service.reviewedSource.assertCurrentSync({ ...capture })).toThrow();
    f.setAccess({ scope: f.scope, level: 'read-only', settingRevision: 2 });
    expect(() => f.service.reviewedSource.assertCurrentSync(capture)).toThrow();
    const next = await f.service.reviewedSource.capture(input);
    f.service.closeSync();
    expect(() => f.service.reviewedSource.assertCurrentSync(next)).toThrow();
  });
  it('invalidates synchronously before a rolled back write and never restores old captures', async () => {
    const f = fixture();
    const input = {
      projectId: f.scope.kind === 'project' ? f.scope.projectId : '',
      refs: [f.record.ref],
      signal: new AbortController().signal,
    };
    const capture = await f.service.reviewedSource.capture(input);
    f.before.mockImplementation(() => {
      expect(() => f.service.reviewedSource.assertCurrentSync(capture)).toThrow();
      expect(f.store.getScopeHead(f.scope)).toBe(1);
      return undefined;
    });
    f.rollback();
    await expect(
      f.service.local.review(f.scope, { requestId: randomUUID(), targetRef: f.record.ref }),
    ).rejects.toMatchObject({ code: 'memory-persistence-error' });
    expect(f.before).toHaveBeenCalledOnce();
    expect(() => f.service.reviewedSource.assertCurrentSync(capture)).toThrow();
    expect(await f.service.reviewedSource.capture(input)).toMatchObject({ liveEpoch: 1 });
  });
  it('requires all records to be current, reviewed and in the same project', async () => {
    const f = fixture();
    const input = {
      projectId: f.scope.kind === 'project' ? f.scope.projectId : '',
      refs: [f.record.ref],
      signal: new AbortController().signal,
    };
    f.record.review = 'agent-authored';
    await expect(f.service.reviewedSource.capture(input)).rejects.toThrow();
    f.record.review = 'user-reviewed';
    await expect(
      f.service.reviewedSource.capture({ ...input, refs: [{ ...f.record.ref, revision: 2 }] }),
    ).rejects.toThrow();
    await expect(
      f.service.reviewedSource.capture({
        ...input,
        refs: [{ ...f.record.ref, scope: { kind: 'user' } }],
      }),
    ).rejects.toThrow();
    await expect(
      f.service.reviewedSource.capture({ ...input, refs: [f.record.ref, f.record.ref] }),
    ).rejects.toThrow();
  });
  it('rechecks local scope after async resolution and immediately before commit', async () => {
    const f = fixture();
    f.revokeLocal();
    await expect(
      f.service.local.remove(f.scope, {
        requestId: randomUUID(),
        memoryId: f.record.ref.memoryId,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'memory-scope-forbidden' });
    expect(f.store.commit).not.toHaveBeenCalled();
  });
  it('refuses invalid external fields before storage', async () => {
    const f = fixture();
    await expect(
      f.service.local.create(f.scope, {
        operation: 'create',
        requestId: randomUUID(),
        expectedRevision: 0,
        title: 'New',
        content: 'Text',
        tags: [],
        actor: 'agent',
      } as never),
    ).rejects.toThrow();
    expect(f.store.commit).not.toHaveBeenCalled();
  });
  it('drops a completed search snapshot after access changes away and back', async () => {
    const f = fixture();
    const gate = Promise.withResolvers<ReturnType<typeof f.store.list>>();
    vi.mocked(f.store.search).mockImplementationOnce(() => gate.promise);
    const pending = f.service.local.search(f.scope, { query: 'strict' });
    await vi.waitFor(() => expect(f.store.search).toHaveBeenCalled());
    f.setAccess({ scope: f.scope, level: 'read-write', settingRevision: 3 });
    gate.resolve(f.store.list({ scopes: [f.scope], limit: 50 }));
    await expect(pending).rejects.toMatchObject({ code: 'memory-stale-cursor' });
  });
  it('bounds draining delayed handlers and retries cleanup after they settle', async () => {
    const f = fixture();
    const gate = Promise.withResolvers<{ assertCurrentSync(): void }>();
    f.resolveLocalScope.mockImplementationOnce(() => gate.promise);
    const pending = f.service.local.read(f.scope, f.record.ref.memoryId);
    const rejectedRead = expect(pending).rejects.toMatchObject({ code: 'memory-cancelled' });
    f.service.closeSync();
    vi.useFakeTimers();
    try {
      const rejectedDrain = expect(f.service.drain()).rejects.toMatchObject({
        code: 'memory-busy',
      });
      await vi.advanceTimersByTimeAsync(5000);
      await rejectedDrain;
      expect(f.store.close).not.toHaveBeenCalled();
      gate.resolve({ assertCurrentSync() {} });
      await rejectedRead;
      await f.service.drain();
      expect(f.store.drain).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
