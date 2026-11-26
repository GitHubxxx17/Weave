import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedInstallerError } from '../src/managed-plugin-installer-errors.js';
import type { ManagedPluginInstaller } from '../src/managed-plugin-installer.js';
import { createManagedPluginUpdater, findManagedUpdates } from '../src/managed-plugin-updater.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import type {
  PluginAuthorityDatabase,
  PluginAuthoritySnapshot,
  RecordedManagedOperation,
} from '../src/plugin-authority-types.js';
import type { PluginMarketplaceCatalog } from '../src/plugin-marketplace.js';
import { activateInput, artifact, importInput } from './support/plugin-authority-fixtures.js';

const hostVersion = '1.0.0';
const digest = (letter: string) => letter.repeat(64);
const [d1, d2] = [digest('1'), digest('2')];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function installedAuthority(): Promise<PluginAuthorityDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'weave-updater-'));
  const authority = createSqlitePluginAuthorityDatabase({
    filename: join(directory, 'authority.sqlite'),
  });
  cleanups.push(async () => {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  });
  authority.commitSync(importInput('i1', 0, artifact(d1, '1.0.0')));
  authority.commitSync(activateInput('a1', authority.snapshotSync(), artifact(d1, '1.0.0')));
  return authority;
}

function source(commit: string) {
  return {
    repository: 'https://github.com/weave/notes' as const,
    commit,
    subdirectory: '',
  };
}

function release(version: string, options: { apiVersion?: string; commit?: string } = {}) {
  const base = artifact(d2, version).manifest;
  return {
    manifest: {
      ...base,
      ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
    },
    source: source(options.commit ?? 'c'.repeat(40)),
  };
}

function catalog(...releases: ReturnType<typeof release>[]): PluginMarketplaceCatalog {
  return {
    communityStatus: 'ready',
    plugins: [
      {
        id: 'notes',
        name: 'Notes',
        description: 'Notes',
        publisher: 'Someone',
        tags: [],
        releases,
      },
    ],
  };
}

describe('managed update detection', () => {
  it('offers the newest compatible release newer than the selected version', async () => {
    const snapshot = (await installedAuthority()).snapshotSync();
    const updates = findManagedUpdates(
      snapshot,
      [
        catalog(release('1.5.0', { commit: 'a'.repeat(40) }), release('0.9.0')),
        catalog(release('2.1.0', { commit: 'b'.repeat(40) }), release('1.0.0')),
      ],
      hostVersion,
    );
    expect([...updates.keys()]).toEqual(['notes']);
    expect(updates.get('notes')).toMatchObject({
      version: '2.1.0',
      source: source('b'.repeat(40)),
    });
  });

  it('ignores same, older and incompatible releases and plugins without a selection', async () => {
    const authority = await installedAuthority();
    const snapshot = authority.snapshotSync();
    expect(
      findManagedUpdates(
        snapshot,
        [catalog(release('1.0.0'), release('0.1.0'), release('3.0.0', { apiVersion: '9.0.0' }))],
        hostVersion,
      ).size,
    ).toBe(0);
    const unselected = {
      ...snapshot,
      installations: snapshot.installations.map((record) => ({ ...record, selection: null })),
    };
    expect(findManagedUpdates(unselected, [catalog(release('2.0.0'))], hostVersion).size).toBe(0);
  });
});

function operation(
  authority: PluginAuthoritySnapshot,
  overrides: { trustBefore?: number; digest?: string } = {},
): RecordedManagedOperation {
  const { heads } = authority;
  return {
    sequence: heads.operationSequence + 1,
    evidence: {
      kind: 'import',
      artifact: { ...artifact(overrides.digest ?? d2, '2.0.0') },
      provenance: { kind: 'github', ...source('c'.repeat(40)) },
    },
    decision: {
      before: {
        installSequence: heads.installSequence,
        trustSequence: overrides.trustBefore ?? heads.trustSequence,
      },
      after: { installSequence: heads.installSequence + 1, trustSequence: heads.trustSequence },
    },
  } as unknown as RecordedManagedOperation;
}

async function updaterFixture(overrides: { trustBefore?: number; importedDigest?: string } = {}) {
  const authorityDatabase = await installedAuthority();
  const authority = authorityDatabase.snapshotSync();
  const candidate = {
    digest: d2,
    manifest: artifact(d2, '2.0.0').manifest,
    files: 2,
    bytes: 128,
  };
  const previewGithub = vi.fn(() =>
    Promise.resolve({
      previewId: 'preview-1',
      expiresAt: '2030-01-01T00:00:00.000Z',
      expectedInstallSequence: authority.heads.installSequence,
      candidate,
      github: source('c'.repeat(40)),
    }),
  );
  const importCall = vi.fn(() =>
    Promise.resolve({
      kind: 'committed',
      operation: operation(authority, {
        ...(overrides.trustBefore === undefined ? {} : { trustBefore: overrides.trustBefore }),
        ...(overrides.importedDigest === undefined ? {} : { digest: overrides.importedDigest }),
      }),
      application: { status: 'not-required' },
    }),
  );
  const applySelection = vi.fn(() => Promise.resolve({ kind: 'committed' }));
  const installer = {
    previewGithub,
    import: importCall,
    applySelection,
    snapshot: () => ({
      authority,
      observed: { generation: { id: 1, acceptingRuns: true }, members: [] },
    }),
  } as unknown as Pick<
    ManagedPluginInstaller,
    'previewGithub' | 'import' | 'applySelection' | 'snapshot'
  >;
  const updater = createManagedPluginUpdater({
    installer,
    marketplace: { catalogs: () => [catalog(release('2.0.0'))] },
    hostVersion,
  });
  return { updater, authority, previewGithub, importCall, applySelection };
}

function request(authority: PluginAuthoritySnapshot, overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'update-1',
    pluginId: 'notes',
    previewId: 'preview-1',
    candidateDigest: d2,
    previousSelection: d1,
    expectedInstallSequence: authority.heads.installSequence,
    expectedTrustSequence: authority.heads.trustSequence,
    ...overrides,
  };
}

describe('managed one-click update', () => {
  it('previews the release, then imports and activates exactly the reviewed candidate', async () => {
    const { updater, authority, previewGithub, importCall, applySelection } =
      await updaterFixture();
    expect(updater.updates().get('notes')).toMatchObject({ version: '2.0.0' });
    const preview = await updater.preview('notes');
    expect(previewGithub).toHaveBeenCalledWith(source('c'.repeat(40)), undefined);
    expect(preview).toMatchObject({
      pluginId: 'notes',
      previewId: 'preview-1',
      previousSelection: d1,
      expectedInstallSequence: authority.heads.installSequence,
      expectedTrustSequence: authority.heads.trustSequence,
      current: { digest: d1 },
      candidate: { digest: d2 },
      update: { version: '2.0.0' },
    });

    await updater.apply(request(authority));
    expect(importCall).toHaveBeenCalledWith(
      {
        requestId: 'update-1:import',
        command: {
          kind: 'import',
          previewId: 'preview-1',
          expectedInstallSequence: authority.heads.installSequence,
        },
      },
      undefined,
    );
    expect(applySelection).toHaveBeenCalledWith(
      {
        requestId: 'update-1',
        command: {
          kind: 'activate',
          pluginId: 'notes',
          digest: d2,
          manifest: artifact(d2, '2.0.0').manifest,
          previousSelection: d1,
          // Taken from the recorded import decision so a retry rebuilds the same command.
          expectedInstallSequence: authority.heads.installSequence + 1,
          expectedTrustSequence: authority.heads.trustSequence,
          intent: 'activate',
        },
      },
      undefined,
    );
  });

  it('rejects a confirmation that does not match the reviewed preview before importing', async () => {
    const { updater, authority, importCall, applySelection } = await updaterFixture();
    await updater.preview('notes');
    for (const change of [
      { previewId: 'unknown' },
      { candidateDigest: digest('3') },
      { previousSelection: digest('4') },
      { expectedInstallSequence: authority.heads.installSequence + 1 },
      { expectedTrustSequence: authority.heads.trustSequence + 1 },
      { pluginId: 'other' },
    ]) {
      await expect(updater.apply(request(authority, change))).rejects.toMatchObject({
        code: 'plugin-preview-stale',
      });
    }
    expect(importCall).not.toHaveBeenCalled();
    expect(applySelection).not.toHaveBeenCalled();
  });

  it('refuses to activate when trust moved or the imported content differs', async () => {
    const moved = await updaterFixture({ trustBefore: 7 });
    await moved.updater.preview('notes');
    await expect(moved.updater.apply(request(moved.authority))).rejects.toMatchObject({
      code: 'plugin-authority-conflict',
    });
    expect(moved.applySelection).not.toHaveBeenCalled();

    const different = await updaterFixture({ importedDigest: digest('5') });
    await different.updater.preview('notes');
    await expect(different.updater.apply(request(different.authority))).rejects.toMatchObject({
      code: 'plugin-authority-conflict',
    });
    expect(different.applySelection).not.toHaveBeenCalled();
  });

  it('rejects a release whose acquired manifest differs from its listing', async () => {
    const { updater, previewGithub } = await updaterFixture();
    previewGithub.mockResolvedValueOnce({
      previewId: 'preview-2',
      expiresAt: '2030-01-01T00:00:00.000Z',
      expectedInstallSequence: 2,
      candidate: {
        digest: d2,
        manifest: { ...artifact(d2, '2.0.0').manifest, name: 'Changed after listing' },
        files: 2,
        bytes: 128,
      },
      github: source('c'.repeat(40)),
    });
    await expect(updater.preview('notes')).rejects.toBeInstanceOf(ManagedInstallerError);
  });

  it('reports not found when no compatible update exists', async () => {
    const { authority } = await updaterFixture();
    const updater = createManagedPluginUpdater({
      installer: {
        previewGithub: vi.fn(),
        import: vi.fn(),
        applySelection: vi.fn(),
        snapshot: () => ({
          authority,
          observed: { generation: { id: 1, acceptingRuns: true }, members: [] },
        }),
      } as never,
      marketplace: { catalogs: () => [catalog(release('1.0.0'))] },
      hostVersion,
    });
    await expect(updater.preview('notes')).rejects.toMatchObject({
      code: 'plugin-authority-not-found',
    });
  });
});
