import fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PluginArtifactError } from '@weave/plugin-host';
import * as pluginHostPackage from '@weave/plugin-host';
import { describe, expect, it, vi } from 'vitest';
import {
  createManagedPluginInstaller,
  type ManagedImportPreview,
  type ManagedImportRequest,
  type ManagedPluginInstallerOptions,
} from '../src/managed-plugin-installer.js';
import { PluginStoreOwnershipError } from '../src/plugin-store-ownership-types.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import { createServerShutdown } from '../src/server-shutdown.js';
import { createRealManagedCompositionFixture } from './support/managed-plugin-composition-fixture.js';

const stale = { code: 'plugin-preview-stale' };
const capacity = { code: 'plugin-preview-capacity' };
const collision = { code: 'plugin-managed-id-conflict' };
const unavailable = { code: 'plugin-installer-unavailable' };

function request(review: ManagedImportPreview, requestId = 'import-request'): ManagedImportRequest {
  return {
    requestId,
    command: {
      kind: 'import',
      previewId: review.previewId,
      expectedInstallSequence: review.expectedInstallSequence,
    },
  };
}

function loss() {
  return new PluginStoreOwnershipError('plugin-store-ownership-lost', 'test ownership loss');
}

type Fixture = Awaited<ReturnType<typeof createRealManagedCompositionFixture>>;

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const fixture = await createRealManagedCompositionFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

function manager(
  fixture: Fixture,
  options?: Parameters<Fixture['compose']>[0],
  installerOverrides: Partial<ManagedPluginInstallerOptions> = {},
) {
  const host = fixture.compose(options);
  const snapshotSync = vi.fn(fixture.authority.snapshotSync);
  const lookupSync = vi.fn(fixture.authority.lookupSync);
  const commitSync = vi.fn(fixture.authority.commitSync);
  const preview = vi.fn(fixture.owned.preview);
  const stage = vi.fn(fixture.owned.stage);
  const scan = vi.fn(host.localSource!.inspectDeclarationClaims);
  const adopt = vi.fn(host.managed!.adoptCommittedAuthoritySync);
  let monotonic = 100;
  let wall = 0;
  const installerOptions: ManagedPluginInstallerOptions = {
    coordinator: host.coordinator,
    composition: { ...host.managed!, adoptCommittedAuthoritySync: adopt },
    authority: { snapshotSync, lookupSync, commitSync },
    store: { preview, stage },
    inspectLocalClaims: scan,
    reservedIds: new Set(),
    applySelection: host.applyManagedSelection!,
    monotonicNow: () => monotonic,
    wallNow: () => wall,
    ...installerOverrides,
  };
  const installer = createManagedPluginInstaller(installerOptions);
  return {
    host,
    installer,
    installerOptions,
    preview,
    stage,
    scan,
    adopt,
    snapshotSync,
    lookupSync,
    commitSync,
    advance(elapsed: number, wallElapsed = elapsed) {
      monotonic += elapsed;
      wall += wallElapsed;
    },
  };
}

describe('managed plugin installer', () => {
  it('derives the production scratch root as a hidden sibling and asserts ownership before acquisition', () =>
    withFixture(async (fixture) => {
      const { directory } = await fixture.writeSource('notes');
      const calls: string[] = [];
      const create = vi.spyOn(pluginHostPackage, 'createGithubPluginAcquirer').mockReturnValue({
        async withSource(_source, use, signal) {
          expect(calls.at(-1)).toBe('lease');
          calls.push('acquire');
          return use(directory, signal!);
        },
      });
      try {
        const m = manager(fixture, undefined, { store: fixture.owned });
        const assertLease = m.installerOptions.composition.assertCommandLeaseSync;
        vi.spyOn(m.installerOptions.composition, 'assertCommandLeaseSync').mockImplementation(
          () => {
            calls.push('lease');
            return assertLease();
          },
        );
        expect(create).toHaveBeenCalledExactlyOnceWith({
          directory: join(
            fixture.owned.binding.storeDirectory,
            '..',
            `.${basename(fixture.owned.binding.storeDirectory)}.github-acquisition`,
          ),
        });
        await m.installer.previewGithub({
          repository: 'https://github.com/weave/notes',
          commit: 'a'.repeat(40),
          subdirectory: '',
        });
        expect(calls).toEqual(['lease', 'acquire', 'lease']);
        m.installer.closeSync();
      } finally {
        create.mockRestore();
      }
    }));

  it.each(['coordinator', 'unpublished'] as const)(
    'drains the wired installer before %s disposal completes',
    (operation) =>
      withFixture(async (fixture) => {
        const entered = Promise.withResolvers<void>();
        const cleanup = Promise.withResolvers<void>();
        let cleaned = false;
        const host = fixture.compose({
          installer: true,
          githubAcquirer: {
            async withSource(_source, _use, signal) {
              entered.resolve();
              await new Promise<void>((resolve) =>
                signal!.addEventListener('abort', () => resolve(), { once: true }),
              );
              await cleanup.promise;
              cleaned = true;
              throw signal!.reason;
            },
          },
        });
        const pending = host
          .installer!.previewGithub({
            repository: 'https://github.com/weave/notes',
            commit: 'a'.repeat(40),
            subdirectory: '',
          })
          .catch((cause: unknown) => cause);
        await entered.promise;
        let disposed = false;
        const disposal = (
          operation === 'coordinator' ? host.coordinator.dispose() : host.closeUnpublished()
        ).then(() => {
          disposed = true;
        });
        try {
          await Promise.resolve();
          expect(disposed).toBe(false);
          expect(cleaned).toBe(false);
        } finally {
          cleanup.resolve();
        }
        expect(await pending).toMatchObject(unavailable);
        await disposal;
        expect(cleaned).toBe(true);
        await expect(
          host.installer!.previewGithub({
            repository: 'https://github.com/weave/notes',
            commit: 'a'.repeat(40),
            subdirectory: '',
          }),
        ).rejects.toMatchObject(unavailable);
      }),
  );

  it('fails preview and import before durable authority when remote cleanup fails', () =>
    withFixture(async (fixture) => {
      const { directory } = await fixture.writeSource('notes');
      let failCleanup = true;
      const failure = new Error('private cleanup');
      const m = manager(fixture, undefined, {
        githubAcquirer: {
          async withSource(_source, use, signal) {
            const result = await use(directory, signal!);
            if (failCleanup) throw failure;
            return result;
          },
        },
      });
      const source = {
        repository: 'https://github.com/weave/notes',
        commit: 'a'.repeat(40),
        subdirectory: '',
      };
      await expect(m.installer.previewGithub(source)).rejects.toBe(failure);
      expect(m.snapshotSync).not.toHaveBeenCalled();
      failCleanup = false;
      const review = await m.installer.previewGithub(source);
      failCleanup = true;
      await expect(m.installer.import(request(review))).rejects.toBe(failure);
      expect(m.commitSync).not.toHaveBeenCalled();
      expect(fixture.authority.snapshotSync().heads.operationSequence).toBe(0);
      m.installer.closeSync();
    }));

  it('reacquires reviewed GitHub bytes in a new directory, commits after cleanup and replays offline', () =>
    withFixture(async (fixture) => {
      const marker = join(fixture.root, 'must-never-execute');
      const first = await fixture.writeSource('notes', 'source', marker);
      const second = await fixture.writeSource('notes', 'source', marker);
      const normalizedSecond = await fs.realpath(second.directory);
      const source = {
        repository: 'https://github.com/weave/notes',
        commit: 'a'.repeat(40),
        subdirectory: 'plugins/notes',
      };
      let acquired = 0;
      let cleaned = 0;
      const m = manager(fixture, undefined, {
        githubAcquirer: {
          async withSource(_source, use, signal) {
            const directory = acquired++ === 0 ? first.directory : second.directory;
            try {
              return await use(directory, signal!);
            } finally {
              await fs.rm(directory, { recursive: true });
              cleaned++;
            }
          },
        },
      });
      const initial = m.host.coordinator.generationSnapshot();
      const review = await m.installer.previewGithub({
        ...source,
        repository: 'https://github.com/WEAVE/Notes',
      });
      expect(review.github).toEqual(source);
      expect(cleaned).toBe(1);
      expect(JSON.stringify(review)).not.toContain(first.directory);
      m.commitSync.mockImplementation((input) => {
        expect(cleaned).toBe(2);
        return fixture.authority.commitSync(input);
      });
      const original = request(review);
      const imported = await m.installer.import(original);
      expect(imported).toMatchObject({
        kind: 'committed',
        application: { status: 'not-required' },
      });
      expect(fixture.authority.snapshotSync()).toMatchObject({
        installations: [
          { selection: null, candidates: [{ provenance: { kind: 'github', ...source } }] },
        ],
        trustEvents: [],
      });
      expect(m.host.coordinator.generationSnapshot()).toEqual(initial);
      expect(m.stage.mock.calls[0]?.[0]).toMatchObject({
        sourceDirectory: second.directory,
        expectedSource: { ...review.candidate, sourceDirectory: normalizedSecond },
      });
      m.installer.closeSync();
      await expect(m.installer.import(original, AbortSignal.abort())).resolves.toMatchObject({
        kind: 'replayed',
        operation: imported.operation,
      });
      expect(acquired).toBe(2);
      await m.installer.drain();
      expect(await fixture.exists(marker)).toBe(false);
      await fixture.authority.close();
      const reopened = createSqlitePluginAuthorityDatabase({ filename: fixture.databaseFile });
      const offline = createManagedPluginInstaller({
        ...m.installerOptions,
        authority: reopened,
        githubAcquirer: {
          async withSource() {
            throw new Error('Network unavailable after restart');
          },
        },
      });
      try {
        offline.closeSync();
        await expect(offline.import(original, AbortSignal.abort())).resolves.toMatchObject({
          kind: 'replayed',
          operation: imported.operation,
        });
      } finally {
        offline.closeSync();
        await offline.drain();
        await reopened.close();
      }
    }));

  it('invalidates a GitHub review when reacquisition changes its measured bytes', () =>
    withFixture(async (fixture) => {
      const first = await fixture.writeSource('notes');
      const second = await fixture.writeSource('notes', 'changed');
      let acquired = 0;
      const m = manager(fixture, undefined, {
        githubAcquirer: {
          async withSource(_source, use, signal) {
            return use(acquired++ === 0 ? first.directory : second.directory, signal!);
          },
        },
      });
      const review = await m.installer.previewGithub({
        repository: 'https://github.com/weave/notes',
        commit: 'a'.repeat(40),
        subdirectory: '',
      });
      await expect(m.installer.import(request(review))).rejects.toMatchObject(stale);
      await expect(m.installer.import(request(review, 'again'))).rejects.toMatchObject(stale);
      expect(acquired).toBe(2);
      expect(m.stage).not.toHaveBeenCalled();
      expect(fixture.authority.snapshotSync().heads.operationSequence).toBe(0);
      m.installer.closeSync();
    }));

  it('passes acquisition deadline cancellation to preview and stage while preserving a retryable review', () =>
    withFixture(async (fixture) => {
      const { directory } = await fixture.writeSource('notes');
      const deadline = new AbortController();
      const m = manager(fixture, undefined, {
        githubAcquirer: {
          async withSource(_source, use) {
            return use(directory, deadline.signal);
          },
        },
      });
      const review = await m.installer.previewGithub({
        repository: 'https://github.com/weave/notes',
        commit: 'a'.repeat(40),
        subdirectory: '',
      });
      expect(m.preview.mock.calls[0]?.[0].signal).toBe(deadline.signal);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      m.stage.mockImplementationOnce(async (input) => {
        expect(input.signal).toBe(deadline.signal);
        entered.resolve();
        await release.promise;
        return fixture.owned.stage(input);
      });
      const importing = m.installer.import(request(review)).catch((cause: unknown) => cause);
      await entered.promise;
      const timeout = new Error('deadline reached');
      deadline.abort(timeout);
      release.resolve();
      expect(await importing).toBe(timeout);
      expect(m.commitSync).not.toHaveBeenCalled();
      m.installer.closeSync();
    }));

  it('cancels a fresh GitHub import before commit and waits for reacquisition cleanup', () =>
    withFixture(async (fixture) => {
      const { directory } = await fixture.writeSource('notes');
      const entered = Promise.withResolvers<void>();
      const cleanup = Promise.withResolvers<void>();
      let call = 0;
      let cleaned = false;
      const m = manager(fixture, undefined, {
        githubAcquirer: {
          async withSource(_source, use, signal) {
            if (call++ === 0) return use(directory, signal!);
            entered.resolve();
            await new Promise<void>((resolve) =>
              signal!.addEventListener('abort', () => resolve(), { once: true }),
            );
            await cleanup.promise;
            cleaned = true;
            throw signal!.reason;
          },
        },
      });
      const review = await m.installer.previewGithub({
        repository: 'https://github.com/weave/notes',
        commit: 'a'.repeat(40),
        subdirectory: '',
      });
      const caller = new AbortController();
      const pending = m.installer
        .import(request(review), caller.signal)
        .catch((cause: unknown) => cause);
      await entered.promise;
      caller.abort(new Error('caller cancelled'));
      let drained = false;
      const drain = m.installer.drain().then(() => {
        drained = true;
      });
      try {
        await Promise.resolve();
        expect(drained).toBe(false);
        expect(m.commitSync).not.toHaveBeenCalled();
      } finally {
        cleanup.resolve();
      }
      expect(await pending).toMatchObject(unavailable);
      await drain;
      expect(cleaned).toBe(true);
      expect(fixture.authority.snapshotSync().heads.operationSequence).toBe(0);
      m.installer.closeSync();
    }));

  it('drains remote preview cleanup after close before allowing shutdown to release ownership', () =>
    withFixture(async (fixture) => {
      const entered = Promise.withResolvers<void>();
      const cleanup = Promise.withResolvers<void>();
      const cleaned = Promise.withResolvers<void>();
      const m = manager(fixture, undefined, {
        githubAcquirer: {
          async withSource(_source, _use, signal) {
            entered.resolve();
            await new Promise<void>((resolve) =>
              signal!.addEventListener('abort', () => resolve(), { once: true }),
            );
            await cleanup.promise;
            cleaned.resolve();
            throw signal!.reason;
          },
        },
      });
      const pending = m.installer
        .previewGithub({
          repository: 'https://github.com/weave/notes',
          commit: 'a'.repeat(40),
          subdirectory: '',
        })
        .catch((cause: unknown) => cause);
      await entered.promise;
      let released = false;
      const shutdown = createServerShutdown({
        resources: () => ({
          installer: m.installer,
          owned: {
            quiesce: fixture.owned.quiesce,
            async close() {
              await cleaned.promise;
              released = true;
              await fixture.owned.close();
            },
          },
        }),
        disposeHost: async () => {},
        stopRuntime: async () => {},
        closeProjectStore() {},
        closeProviderSettingsStore() {},
        closeManualTrustStore() {},
        closeMcpAuthorityStore() {},
      });
      const stopped = shutdown.stop();
      try {
        await Promise.resolve();
        expect(released).toBe(false);
        expect(() => fixture.owned.assertHeldSync()).not.toThrow();
      } finally {
        cleanup.resolve();
      }
      expect(await pending).toMatchObject(unavailable);
      await stopped;
      expect(released).toBe(true);
    }));

  it('checks the input and allows one pending inspection and 64 live reviews', () =>
    withFixture(async (fixture) => {
      const m = manager(fixture);
      const { directory } = await fixture.writeSource('notes');
      for (const path of ['relative', '', '/invalid\0path']) {
        await expect(m.installer.preview(path)).rejects.toMatchObject({
          code: 'plugin-invalid-request',
        });
      }
      expect(m.preview).not.toHaveBeenCalled();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      m.preview.mockImplementationOnce(async (input) => {
        const result = await fixture.owned.preview(input);
        entered.resolve();
        await release.promise;
        return result;
      });
      const pending = m.installer.preview(directory);
      try {
        await entered.promise;
        await expect(m.installer.preview(directory)).rejects.toMatchObject(capacity);
        m.advance(200, 300);
      } finally {
        release.resolve();
      }
      const first = await pending;
      expect(first.expiresAt).toBe('1970-01-01T00:10:00.300Z');
      const ids = new Set([first.previewId]);
      for (let index = 1; index < 64; index++) {
        ids.add((await m.installer.preview(directory)).previewId);
      }
      expect(ids.size).toBe(64);
      m.advance(599_999, 900_000);
      await expect(m.installer.preview(directory)).rejects.toMatchObject(capacity);
      m.advance(1, -1_000_000);
      await expect(m.installer.import(request(first))).rejects.toMatchObject(stale);
      await expect(m.installer.preview(directory)).resolves.toHaveProperty('previewId');
      m.installer.closeSync();
    }));

  it('reviews observable data and imports without executing, trusting, selecting or rebuilding', () =>
    withFixture(async (fixture) => {
      const m = manager(fixture);
      await m.host.coordinator.reload();
      const initial = m.host.coordinator.generationSnapshot();
      const marker = join(fixture.root, 'plugin-executed-private');
      const { directory, manifest } = await fixture.writeSource(
        'notes',
        'private-source-code',
        marker,
      );
      const normalized = await fs.realpath(directory);
      const linkedParent = join(fixture.root, 'linked-parent-private');
      await fs.symlink(fixture.root, linkedParent, 'dir');
      const requested = join(linkedParent, basename(directory));
      const review = await m.installer.preview(requested);
      expect(review).toStrictEqual({
        previewId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        expectedInstallSequence: 0,
        expiresAt: '1970-01-01T00:10:00.000Z',
        candidate: {
          manifest,
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          files: 2,
          bytes: expect.any(Number),
        },
      });
      expect(JSON.stringify(review)).not.toContain(directory);
      expect(JSON.stringify(review)).not.toContain(requested);
      expect(JSON.stringify(review)).not.toContain(normalized);
      expect(JSON.stringify(review)).not.toContain('index.mjs');
      expect(JSON.stringify(review)).not.toContain('private-source-code');
      const artifacts = join(fixture.owned.binding.storeDirectory, 'artifacts');
      expect(await fixture.exists(artifacts)).toBe(false);
      const calls: string[] = [];
      m.scan.mockImplementation(async (signal) => {
        const staged = calls.includes('stage');
        calls.push('scan');
        expect(fixture.authority.snapshotSync().heads.installSequence).toBe(0);
        expect(await fixture.exists(join(artifacts, review.candidate.digest))).toBe(staged);
        return m.host.localSource!.inspectDeclarationClaims(signal);
      });
      m.stage.mockImplementation(async (input) => {
        calls.push('stage');
        expect(input).toMatchObject({
          sourceDirectory: requested,
          expectedSource: { ...review.candidate, sourceDirectory: normalized },
        });
        return fixture.owned.stage(input);
      });
      m.snapshotSync.mockImplementation(() => {
        calls.push('head');
        return fixture.authority.snapshotSync();
      });
      m.commitSync.mockImplementation((input) => {
        calls.push('commit');
        expect(input.prepared).toMatchObject({
          kind: 'import',
          artifact: { ...review.candidate, pluginId: 'notes' },
          provenance: { kind: 'local-directory', sourceDirectory: normalized },
        });
        return fixture.authority.commitSync(input);
      });
      const input = request(review);
      expect(await m.installer.import(input)).toMatchObject({
        kind: 'committed',
        application: { status: 'not-required' },
        observed: { generation: initial, members: [] },
      });
      expect(calls).toEqual(['head', 'scan', 'stage', 'scan', 'head', 'commit']);
      expect(await m.installer.import(input)).toMatchObject({ kind: 'replayed' });
      expect(m.adopt).toHaveBeenCalledOnce();
      expect(m.host.coordinator.generationSnapshot()).toEqual(initial);
      expect(fixture.authority.snapshotSync()).toMatchObject({
        installations: [{ pluginId: 'notes', selection: null }],
        trustEvents: [],
      });
      expect(await fixture.exists(marker)).toBe(false);
      m.snapshotSync.mockClear();
      fixture.readAuthoritySync.mockClear();
      expect(m.installer.snapshot()).toEqual({
        authority: fixture.authority.snapshotSync(),
        observed: { generation: initial, members: [] },
      });
      expect(m.snapshotSync).not.toHaveBeenCalled();
      expect(fixture.readAuthoritySync).not.toHaveBeenCalled();
      m.installer.closeSync();
    }));

  it('compares the live head before the submitted head and retires an invalidated review', () =>
    withFixture(async (fixture) => {
      const m = manager(fixture);
      const { directory } = await fixture.writeSource('notes');
      const review = await m.installer.preview(directory);
      const valid = request(review);
      const wrong = { ...valid, command: { ...valid.command, expectedInstallSequence: 1 } };
      await expect(m.installer.import(wrong)).rejects.toMatchObject({
        code: 'plugin-authority-conflict',
      });
      expect(m.stage).not.toHaveBeenCalled();
      await expect(m.installer.import(valid)).resolves.toMatchObject({ kind: 'committed' });
      const old = await m.installer.preview(directory);
      await fixture.seedManaged('advance', 'next', false);
      const staleAndWrong = {
        ...request(old, 'stale'),
        command: { ...request(old).command, expectedInstallSequence: 0 },
      };
      await expect(m.installer.import(staleAndWrong)).rejects.toMatchObject(stale);
      m.snapshotSync.mockClear();
      await expect(m.installer.import(request(old, 'old'))).rejects.toMatchObject(stale);
      expect(m.snapshotSync).not.toHaveBeenCalled();
      m.installer.closeSync();
    }));

  it('consumes a no-op and reconciles identical retries before expiry, cancellation or ownership checks', () =>
    withFixture(async (fixture) => {
      await fixture.seedManaged('notes', 'source', false);
      const m = manager(fixture);
      const { directory } = await fixture.writeSource('notes');
      const review = await m.installer.preview(directory);
      const original = request(review);
      const first = await m.installer.import(original);
      expect(first).toMatchObject({ kind: 'committed', application: { status: 'not-required' } });
      expect(fixture.authority.snapshotSync().heads.installSequence).toBe(
        review.expectedInstallSequence,
      );
      await expect(m.installer.import(request(review, 'consumed'))).rejects.toMatchObject(stale);
      m.advance(600_000);
      fixture.loseOwnership(loss());
      m.stage.mockClear();
      m.adopt.mockClear();
      m.scan.mockClear();
      m.snapshotSync.mockClear();
      fixture.readMcp.mockClear();
      await expect(m.installer.import(original, AbortSignal.abort())).resolves.toMatchObject({
        kind: 'replayed',
        operation: first.operation,
      });
      await expect(
        m.installer.import({
          ...original,
          command: { ...original.command, expectedInstallSequence: 0 },
        }),
      ).rejects.toMatchObject({ code: 'plugin-authority-request-conflict' });
      await expect(m.installer.preview(directory)).rejects.toMatchObject(unavailable);
      await expect(m.installer.import(request(review, 'fresh-under-loss'))).rejects.toMatchObject(
        unavailable,
      );
      expect(m.stage).not.toHaveBeenCalled();
      expect(m.adopt).not.toHaveBeenCalled();
      expect(m.scan).not.toHaveBeenCalled();
      expect(m.snapshotSync).not.toHaveBeenCalled();
      expect(fixture.readMcp).not.toHaveBeenCalled();
      m.installer.closeSync();
    }));

  it('preserves a review through transient scan and stage failures and retires it once commit throws', () =>
    withFixture(async (fixture) => {
      const m = manager(fixture);
      const { directory } = await fixture.writeSource('notes');
      const review = await m.installer.preview(directory);
      const original = request(review);
      m.scan.mockResolvedValueOnce({ pluginIds: [], complete: false });
      await expect(m.installer.import(original)).rejects.toMatchObject({
        code: 'plugin-managed-namespace-unavailable',
      });
      const storage = new PluginArtifactError(
        'plugin-artifact-capacity',
        'temporary fixture capacity',
      );
      m.stage.mockRejectedValueOnce(storage);
      await expect(m.installer.import(original)).rejects.toBe(storage);
      const writeFailure = new Error('commit threw before SQLite progress');
      m.commitSync.mockImplementationOnce(() => {
        throw writeFailure;
      });
      await expect(m.installer.import(original)).rejects.toBe(writeFailure);
      expect(fixture.authority.snapshotSync().heads.installSequence).toBe(0);
      expect(m.host.coordinator.generationSnapshot().acceptingRuns).toBe(true);
      await expect(m.installer.import(original)).rejects.toMatchObject(stale);
      m.installer.closeSync();
    }));

  it('retires a reviewed source whose bytes changed before stage', () =>
    withFixture(async (fixture) => {
      const m = manager(fixture);
      const { directory } = await fixture.writeSource('notes');
      const review = await m.installer.preview(directory);
      await fs.writeFile(join(directory, 'index.mjs'), '// source edited');
      await expect(m.installer.import(request(review))).rejects.toMatchObject(stale);
      expect(m.commitSync).not.toHaveBeenCalled();
      m.snapshotSync.mockClear();
      await expect(m.installer.import(request(review))).rejects.toMatchObject(stale);
      expect(m.snapshotSync).not.toHaveBeenCalled();
      m.installer.closeSync();
    }));

  it('checks the exclusive review deadline again immediately before commit', () =>
    withFixture(async (fixture) => {
      const m = manager(fixture);
      const { directory } = await fixture.writeSource('notes');
      const review = await m.installer.preview(directory);
      m.stage.mockImplementationOnce(async (input) => {
        const artifact = await fixture.owned.stage(input);
        m.advance(600_000);
        return artifact;
      });
      await expect(m.installer.import(request(review))).rejects.toMatchObject(stale);
      expect(m.commitSync).not.toHaveBeenCalled();
      expect(fixture.authority.snapshotSync().heads.installSequence).toBe(0);
      m.installer.closeSync();
    }));

  it('returns the saved authority and original cause when synchronous adoption fails', () =>
    withFixture(async (fixture) => {
      let failAdoption = false;
      const m = manager(fixture, {
        readLocalTrustEventsSync() {
          if (failAdoption) throw undefined;
          return [];
        },
      });
      const { directory } = await fixture.writeSource('notes');
      const input = request(await m.installer.preview(directory));
      const before = m.host.coordinator.generationSnapshot();
      failAdoption = true;
      const result = await m.installer.import(input);
      expect(result).toMatchObject({
        kind: 'committed',
        savedAuthority: fixture.authority.snapshotSync(),
        application: { status: 'failed', failureKind: 'adoption', cause: undefined },
        observed: { generation: before, members: [] },
      });
      expect(m.installer.snapshot().authority).toEqual(fixture.authority.snapshotSync());
      await expect(m.installer.import(input)).resolves.toMatchObject({ kind: 'replayed' });
      expect(m.adopt).toHaveBeenCalledOnce();
      m.installer.closeSync();
    }));

  it.each(['before stage', 'after stage'] as const)(
    'rejects a manual claim appearing %s',
    (phase) =>
      withFixture(async (fixture) => {
        const m = manager(fixture);
        const { directory } = await fixture.writeSource('notes');
        const review = await m.installer.preview(directory);
        if (phase === 'before stage') {
          const manual = await fixture.seedManual('notes', 'manual', false);
          await fs.unlink(join(manual.directory, 'index.mjs'));
          m.scan.mockImplementationOnce(async (signal) => ({
            ...(await m.host.localSource!.inspectDeclarationClaims(signal)),
            complete: false,
          }));
        } else {
          m.stage.mockImplementationOnce(async (input) => {
            const artifact = await fixture.owned.stage(input);
            await fixture.seedManual('notes', 'manual', false);
            return artifact;
          });
        }
        await expect(m.installer.import(request(review))).rejects.toMatchObject(collision);
        expect(m.stage).toHaveBeenCalledTimes(phase === 'before stage' ? 0 : 1);
        expect(m.commitSync).not.toHaveBeenCalled();
        await fs.rm(join(fixture.pluginsDirectory, 'notes'), { recursive: true });
        await expect(m.installer.import(request(review))).rejects.toMatchObject(stale);
        m.installer.closeSync();
      }),
  );

  it.each(['transaction', 'head advanced', 'conflict after head advanced'] as const)(
    'retires the resolved token during late %s without applying a decision',
    (path) =>
      withFixture(async (fixture) => {
        if (path === 'transaction') await fixture.seedManaged('notes', 'source', false);
        const m = manager(fixture);
        const { directory } = await fixture.writeSource('notes');
        const review = await m.installer.preview(directory);
        const original = request(review);
        const generation = m.host.coordinator.generationSnapshot();
        if (path === 'transaction') {
          m.commitSync.mockImplementationOnce((input) => {
            expect(fixture.authority.commitSync(input).kind).toBe('committed');
            return fixture.authority.commitSync(input);
          });
        } else {
          m.stage.mockImplementationOnce(async (input) => {
            const artifact = await fixture.owned.stage(input);
            fixture.authority.commitSync({
              request:
                path === 'head advanced'
                  ? original
                  : {
                      ...original,
                      command: { ...original.command, previewId: 'external-review' },
                    },
              prepared: {
                kind: 'import',
                artifact: { ...review.candidate, pluginId: 'notes' },
                provenance: {
                  kind: 'local-directory',
                  sourceDirectory: await fs.realpath(directory),
                },
              },
            });
            // The second scan sees a claim, but the advancing head must be processed first.
            await fixture.seedManual('notes', 'manual', false);
            return artifact;
          });
        }
        if (path === 'conflict after head advanced') {
          await expect(m.installer.import(original)).rejects.toMatchObject({
            code: 'plugin-authority-request-conflict',
          });
        } else {
          await expect(m.installer.import(original)).resolves.toMatchObject({ kind: 'replayed' });
        }
        expect(m.lookupSync).toHaveBeenCalledTimes(path === 'transaction' ? 1 : 2);
        expect(m.commitSync).toHaveBeenCalledTimes(path === 'transaction' ? 1 : 0);
        expect(m.adopt).not.toHaveBeenCalled();
        expect(m.host.coordinator.generationSnapshot()).toEqual(generation);
        m.snapshotSync.mockClear();
        await expect(m.installer.import(request(review, 'new'))).rejects.toMatchObject(stale);
        expect(m.snapshotSync).not.toHaveBeenCalled();
        m.installer.closeSync();
      }),
  );

  it.each(['before publication', 'after publication', 'after commit'] as const)(
    'handles cancellation %s',
    (phase) =>
      withFixture(async (fixture) => {
        const m = manager(fixture);
        const { directory } = await fixture.writeSource('notes');
        const review = await m.installer.preview(directory);
        const input = request(review);
        const caller = new AbortController();
        if (phase === 'after commit') {
          m.commitSync.mockImplementationOnce((input) => {
            const committed = fixture.authority.commitSync(input);
            caller.abort();
            return committed;
          });
          await expect(m.installer.import(input, caller.signal)).resolves.toMatchObject({
            kind: 'committed',
            application: { status: 'not-required' },
          });
          expect(m.adopt).toHaveBeenCalledOnce();
          await expect(m.installer.import(input, caller.signal)).resolves.toMatchObject({
            kind: 'replayed',
          });
        } else {
          m.stage.mockImplementationOnce(async (input) => {
            if (phase === 'before publication') caller.abort();
            const artifact = await fixture.owned.stage(input);
            caller.abort();
            return artifact;
          });
          await expect(m.installer.import(input, caller.signal)).rejects.toMatchObject(unavailable);
          expect(fixture.authority.snapshotSync().heads.installSequence).toBe(0);
          expect(
            await fixture.exists(
              join(fixture.owned.binding.storeDirectory, 'artifacts', review.candidate.digest),
            ),
          ).toBe(phase === 'after publication');
          await expect(m.installer.import(input)).resolves.toMatchObject({ kind: 'committed' });
        }
        m.installer.closeSync();
      }),
  );

  it('closes admission on observed loss before a pending preview can read authority', () =>
    withFixture(async (fixture) => {
      const m = manager(fixture);
      const { directory } = await fixture.writeSource('notes');
      m.preview.mockImplementationOnce(async (options) => {
        const reviewed = await fixture.owned.preview(options);
        fixture.loseOwnership(loss());
        return reviewed;
      });
      await expect(m.installer.preview(directory)).rejects.toMatchObject(unavailable);
      await expect(m.installer.preview(directory)).rejects.toMatchObject(unavailable);
      expect(m.snapshotSync).not.toHaveBeenCalled();
      expect(m.preview).toHaveBeenCalledOnce();
      m.installer.closeSync();
    }));

  it('cancels a detached scan on ownership loss without staging or reading a second live head', () =>
    withFixture(async (fixture) => {
      const m = manager(fixture);
      const { directory } = await fixture.writeSource('notes');
      const review = await m.installer.preview(directory);
      const entered = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<void>();
      m.scan.mockImplementationOnce(async (signal) => {
        entered.resolve(signal);
        await release.promise;
        return m.host.localSource!.inspectDeclarationClaims(signal);
      });
      m.snapshotSync.mockClear();
      const pending = expect(m.installer.import(request(review))).rejects.toMatchObject(
        unavailable,
      );
      try {
        const signal = await entered.promise;
        fixture.loseOwnership(loss());
        expect(signal.aborted).toBe(true);
      } finally {
        release.resolve();
        await pending;
        m.installer.closeSync();
      }
      expect(m.stage).not.toHaveBeenCalled();
      expect(m.snapshotSync).toHaveBeenCalledOnce();
    }));

  it('uses the wired MCP claim, even when it is untrusted or retained only by a running turn', () =>
    withFixture(async (fixture) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const close = vi.fn(async () => {});
      await fixture.seedMcp('remote', false);
      const host = fixture.compose({
        installer: true,
        mcpConnect: async () => ({
          tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
          stderrBytes: 0,
          validateInput: () => ({ valid: true }),
          async callTool() {
            entered.resolve();
            await release.promise;
            return { content: [{ type: 'text', text: 'pinned' }] };
          },
          close,
        }),
      });
      const installer = host.installer!;
      const { directory } = await fixture.writeSource('mcp-remote');
      await expect(
        installer.import(request(await installer.preview(directory))),
      ).rejects.toMatchObject(collision);
      await fixture.seedMcp('other');
      const { directory: retained } = await fixture.writeSource('mcp-other');
      const first = await host.coordinator.reload();
      const active = fixture.runTool(first.members[0]!.manifest.contributes!.tools![0]!);
      try {
        await Promise.race([
          entered.promise,
          active.then(() => {
            throw new Error('No pinned MCP tool');
          }),
        ]);
        await fixture.mutateMcp({ kind: 'remove', serverId: 'other' });
        await host.coordinator.reload();
        expect(host.coordinator.snapshot().members).toEqual([]);
        expect(close).not.toHaveBeenCalled();
        await expect(
          installer.import(request(await installer.preview(retained))),
        ).rejects.toMatchObject(collision);
      } finally {
        release.resolve();
        await active;
      }
      await expect.poll(() => host.coordinator.retainedGenerations()).toHaveLength(1);
      await expect(
        installer.import(request(await installer.preview(retained))),
      ).resolves.toMatchObject({ kind: 'committed' });
    }));

  it.each(['preview', 'import'] as const)(
    'closes admission and holds the lease until a draining %s finishes',
    (operation) =>
      withFixture(async (fixture) => {
        const m = manager(fixture);
        const { directory } = await fixture.writeSource('notes');
        const review = operation === 'import' ? await m.installer.preview(directory) : undefined;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        if (operation === 'preview') {
          const lstat = fs.lstat;
          vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
            if (path === directory) {
              entered.resolve();
              await release.promise;
            }
            return lstat(path, options);
          });
        } else {
          m.scan.mockImplementationOnce(async (signal) => {
            entered.resolve();
            await release.promise;
            return m.host.localSource!.inspectDeclarationClaims(signal);
          });
        }
        const calls: string[] = [];
        const beginDrain = m.host.coordinator.beginOwnedDrainSync;
        vi.spyOn(m.host.coordinator, 'beginOwnedDrainSync').mockImplementation(() => {
          calls.push('coordinator');
          beginDrain();
        });
        const shutdown = createServerShutdown({
          resources: () => ({
            installer: {
              closeSync() {
                calls.push('installer');
                m.installer.closeSync();
              },
            },
            coordinator: m.host.coordinator,
            owned: {
              quiesce() {
                calls.push('quiesce');
                return fixture.owned.quiesce();
              },
              async close() {
                await fixture.owned.close();
                calls.push('lease');
              },
            },
            authority: {
              close() {
                expect(calls.at(-1)).toBe('lease');
                calls.push('authority');
                return fixture.authority.close();
              },
            },
          }),
          disposeHost: async () => {},
          stopRuntime: async () => {},
          closeProjectStore() {},
          closeProviderSettingsStore() {},
          closeManualTrustStore() {},
          closeMcpAuthorityStore() {},
        });
        const pending = (
          review === undefined
            ? m.installer.preview(directory)
            : m.installer.import(request(review))
        ).catch((error: unknown) => error);
        try {
          await entered.promise;
          const stopped = shutdown.stop();
          await expect(m.installer.preview(directory)).rejects.toMatchObject(unavailable);
          expect(() => fixture.owned.assertHeldSync()).not.toThrow();
          expect(fixture.authority.snapshotSync().heads.installSequence).toBe(0);
          expect(calls).toEqual(['installer', 'coordinator', 'quiesce']);
          release.resolve();
          expect(await pending).toMatchObject(
            operation === 'preview' ? unavailable : { code: 'plugin-host-disposed' },
          );
          await stopped;
          expect(calls).toEqual(['installer', 'coordinator', 'quiesce', 'lease', 'authority']);
        } finally {
          release.resolve();
          vi.restoreAllMocks();
          await pending;
        }
      }),
  );
});
