import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionCoordinator } from '../src/extension-coordinator.js';
import {
  createManagedArtifactReclaimer,
  digestsInUse,
  type ManagedArtifactStore,
} from '../src/managed-artifact-reclaimer.js';
import {
  currentCandidates,
  retainedArtifactDigests,
  retainedDigestsByPlugin,
} from '../src/managed-artifact-retention.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import type { ManagedCommitInput, PluginAuthorityDatabase } from '../src/plugin-authority-types.js';
import {
  activateInput,
  artifact,
  decisionInput,
  importInput,
} from './support/plugin-authority-fixtures.js';

const digest = (letter: string) => letter.repeat(64);
const [d1, d2, d3] = [digest('1'), digest('2'), digest('3')];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openAuthority(): Promise<PluginAuthorityDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'weave-reclaim-'));
  const authority = createSqlitePluginAuthorityDatabase({
    filename: join(directory, 'authority.sqlite'),
  });
  cleanups.push(async () => {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  });
  return authority;
}

function commit(authority: PluginAuthorityDatabase, input: ManagedCommitInput): void {
  authority.commitSync(input);
}

function importDigest(authority: PluginAuthorityDatabase, name: string, value: string): void {
  commit(
    authority,
    importInput(name, authority.snapshotSync().heads.installSequence, artifact(value)),
  );
}

function activateDigest(authority: PluginAuthorityDatabase, name: string, value: string): void {
  commit(authority, activateInput(name, authority.snapshotSync(), artifact(value)));
}

describe('managed artifact retention', () => {
  it('retains the selection and pending imports but retires the replaced version', async () => {
    const authority = await openAuthority();
    importDigest(authority, 'i1', d1);
    importDigest(authority, 'i1b', d1);
    expect(retainedDigestsByPlugin(authority.snapshotSync()).get('notes')).toEqual(new Set([d1]));
    activateDigest(authority, 'a1', d1);
    importDigest(authority, 'i2', d2);
    // Imported but not yet activated: kept, so the user can still confirm it.
    expect(retainedArtifactDigests(authority.snapshotSync())).toEqual(new Set([d1, d2]));
    activateDigest(authority, 'a2', d2);
    const snapshot = authority.snapshotSync();
    expect(retainedArtifactDigests(snapshot)).toEqual(new Set([d2]));
    const record = snapshot.installations[0]!;
    expect(record.candidates.map(({ digest: value }) => value)).toEqual([d1, d2]);
    expect(currentCandidates(snapshot, 'notes', record.candidates).map((c) => c.digest)).toEqual([
      d2,
    ]);
  });

  it('retains an older version again when it is re-imported after an update', async () => {
    const authority = await openAuthority();
    importDigest(authority, 'i1', d1);
    activateDigest(authority, 'a1', d1);
    importDigest(authority, 'i2', d2);
    activateDigest(authority, 'a2', d2);
    expect(retainedArtifactDigests(authority.snapshotSync())).toEqual(new Set([d2]));
    // Known content records an operation without a new install event.
    importDigest(authority, 'i1-again', d1);
    expect(retainedArtifactDigests(authority.snapshotSync())).toEqual(new Set([d1, d2]));
    activateDigest(authority, 'a1-again', d1);
    expect(retainedArtifactDigests(authority.snapshotSync())).toEqual(new Set([d1]));
  });

  it('retires everything after uninstall and keeps later imports', async () => {
    const authority = await openAuthority();
    importDigest(authority, 'i1', d1);
    activateDigest(authority, 'a1', d1);
    commit(authority, decisionInput('uninstall', 'u1', authority.snapshotSync()));
    expect(retainedArtifactDigests(authority.snapshotSync())).toEqual(new Set());
    importDigest(authority, 'i3', d3);
    expect(retainedArtifactDigests(authority.snapshotSync())).toEqual(new Set([d3]));
  });
});

function fakeCoordinator(
  generations: () => ReturnType<ExtensionCoordinator['retainedGenerations']>,
): Pick<ExtensionCoordinator, 'mutateManaged' | 'retainedGenerations'> {
  return {
    retainedGenerations: generations,
    async mutateManaged(_sourceId, operation) {
      const step = await operation({
        assertOpenSync() {},
        signal: new AbortController().signal,
      });
      if (step.disposition !== 'skip-rebuild') throw new Error('Unexpected disposition');
      return {
        kind: 'replayed',
        replay: step.replay,
        observed: { generation: { id: 1, acceptingRuns: true }, members: [] },
      } as never;
    },
  };
}

function memberUsing(value: string) {
  return {
    sourceId: 'local',
    pluginId: 'notes',
    origin: 'managed',
    identity: JSON.stringify(['notes', value, 'managed', 2]),
    managedIdentity: { digest: value, activationSequence: 2 },
    manifest: artifact(value).manifest,
  };
}

function fakeStore(initial: readonly string[]) {
  const present = new Set(initial);
  const removed: string[] = [];
  const store: ManagedArtifactStore = {
    list: () => Promise.resolve([...present].sort()),
    remove(value) {
      removed.push(value);
      return Promise.resolve(present.delete(value));
    },
  };
  return { store, present, removed };
}

describe('managed artifact reclaimer', () => {
  it('deletes retired and orphaned artifacts and keeps the selection', async () => {
    const authority = await openAuthority();
    importDigest(authority, 'i1', d1);
    activateDigest(authority, 'a1', d1);
    importDigest(authority, 'i2', d2);
    activateDigest(authority, 'a2', d2);
    const orphan = digest('9');
    const { store, present } = fakeStore([d1, d2, orphan]);
    const reclaimer = createManagedArtifactReclaimer({
      coordinator: fakeCoordinator(() => []),
      authority,
      store,
    });
    await expect(reclaimer.reclaim()).resolves.toEqual({
      removed: [d1, orphan].sort(),
      deferred: [],
      failed: [],
    });
    expect([...present]).toEqual([d2]);
    reclaimer.close();
  });

  it('defers deletion while a retained Generation still uses the old artifact', async () => {
    vi.useFakeTimers();
    try {
      const authority = await openAuthority();
      importDigest(authority, 'i1', d1);
      activateDigest(authority, 'a1', d1);
      importDigest(authority, 'i2', d2);
      activateDigest(authority, 'a2', d2);
      let generations: ReturnType<ExtensionCoordinator['retainedGenerations']> = [
        { generationId: 1, current: false, members: [memberUsing(d1)] as never },
        { generationId: 2, current: true, members: [memberUsing(d2)] as never },
      ];
      const { store, present } = fakeStore([d1, d2]);
      const reclaimer = createManagedArtifactReclaimer({
        coordinator: fakeCoordinator(() => generations),
        authority,
        store,
        retryDelayMs: 1000,
      });
      await expect(reclaimer.reclaim()).resolves.toEqual({
        removed: [],
        deferred: [d1],
        failed: [],
      });
      expect(present.has(d1)).toBe(true);
      // The old Generation is released; the scheduled retry deletes the artifact.
      generations = [{ generationId: 2, current: true, members: [memberUsing(d2)] as never }];
      await vi.advanceTimersByTimeAsync(1000);
      await reclaimer.drain();
      expect([...present]).toEqual([d2]);
      reclaimer.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never deletes when a member identity cannot be read', async () => {
    const authority = await openAuthority();
    importDigest(authority, 'i1', d1);
    activateDigest(authority, 'a1', d1);
    importDigest(authority, 'i2', d2);
    activateDigest(authority, 'a2', d2);
    const unknown = { ...memberUsing(d1), identity: 'not json', managedIdentity: undefined };
    const { store, present } = fakeStore([d1, d2]);
    const reclaimer = createManagedArtifactReclaimer({
      coordinator: fakeCoordinator(() => [
        { generationId: 1, current: true, members: [unknown] as never },
      ]),
      authority,
      store,
      retryDelayMs: 60_000,
    });
    await expect(reclaimer.reclaim()).resolves.toMatchObject({ removed: [], deferred: [d1] });
    expect(present.has(d1)).toBe(true);
    reclaimer.close();
  });

  it('keeps going after one removal fails and reports it', async () => {
    const authority = await openAuthority();
    importDigest(authority, 'i1', d1);
    activateDigest(authority, 'a1', d1);
    importDigest(authority, 'i2', d2);
    activateDigest(authority, 'a2', d2);
    const orphan = digest('9');
    const { store, present } = fakeStore([d1, d2, orphan]);
    const failing: ManagedArtifactStore = {
      list: store.list,
      remove: (value, options) =>
        value === d1 ? Promise.reject(new Error('busy')) : store.remove(value, options),
    };
    const errors: unknown[] = [];
    const reclaimer = createManagedArtifactReclaimer({
      coordinator: fakeCoordinator(() => []),
      authority,
      store: failing,
      retryDelayMs: 60_000,
      onError: (error) => errors.push(error),
    });
    await expect(reclaimer.reclaim()).resolves.toEqual({
      removed: [orphan],
      deferred: [],
      failed: [d1],
    });
    expect(errors).toHaveLength(1);
    expect([...present].sort()).toEqual([d1, d2].sort());
    reclaimer.close();
  });

  it('reads managed digests from retained Generations only', () => {
    const other = { ...memberUsing(d3), origin: 'manual', managedIdentity: undefined };
    expect(
      digestsInUse([
        { generationId: 1, current: true, members: [memberUsing(d1), other] as never },
      ]),
    ).toEqual(new Set([d1]));
  });
});
