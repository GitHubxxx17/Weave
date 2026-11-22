import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { commandsExtensionPoint, createPluginKernel, type PluginCommand } from '@weave/plugin';
import { afterEach, expect, it, vi } from 'vitest';

import {
  createLocalPluginSource,
  createMemoryTrustStore,
  createPluginArtifactStore,
  createPluginHost,
  discoverLocalPlugins,
  eligibleLocalSourceCandidates,
  ExplicitLocalAuthorityError,
  localSourceCandidateIdentity,
  type ExplicitLocalCandidateChecks,
  type ExplicitLocalSelectionInput,
  type LocalPluginSourceOptions,
  type LocalSourceAuthorityChange,
  type ReadyLocalPlugin,
} from '../src/index.js';
import { descriptorFileName } from '../src/descriptor.js';
import {
  helloSource,
  makeTempDirectory,
  removeTempDirectories,
  writePlugin,
} from './support/fixtures.js';
import { gate, harness } from './support/host-fixtures.js';

afterEach(removeTempDirectories);

const id = 'z-managed';
const prepareOptions = () => ({
  signal: new AbortController().signal,
  excluded: new Set<string>(),
});

it('exposes combined eligibility and keeps the legacy manual identity', async () => {
  const manual = await harness(['a'], true);
  const source = createLocalPluginSource({
    discovery: manual.options.discovery,
    trustStore: manual.trustStore,
  });
  try {
    const snapshot = await source.refresh();
    expect(snapshot.managedEligible).toEqual([]);
    const candidates = eligibleLocalSourceCandidates(snapshot);
    expect(candidates).toMatchObject([{ id: 'a', origin: 'manual' }]);
    expect(candidates.map(localSourceCandidateIdentity)).toEqual([
      JSON.stringify(['a', manual.ready[0]!.digest]),
    ]);
    const prepared = (await source.prepare(snapshot.stamp, prepareOptions())).items[0];
    expect(prepared?.origin).toBe('manual');
    expect(prepared).not.toHaveProperty('managedIdentity');
  } finally {
    await source.close();
  }
});

async function fixture(pluginSource = helloSource) {
  const root = await makeTempDirectory();
  const directory = path.join(root, 'manual');
  const phasesFile = path.join(root, 'phases');
  await writeFile(phasesFile, '');
  const files = {
    entry: 'index.mjs',
    source: `import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(phasesFile)}, 'evaluate\\n');
      ${pluginSource}`,
  };
  const sourceDirectory = await writePlugin(path.join(root, 'input'), id, files);
  const artifacts = createPluginArtifactStore({ directory: path.join(root, 'store') });
  const artifact = await artifacts.stage({ sourceDirectory });
  const {
    digest,
    entry,
    descriptor: { manifest },
  } = artifact;
  const ready: ReadyLocalPlugin = {
    status: 'ready',
    id,
    manifest,
    digest,
    directory: artifact.directory,
    entry,
  };
  const trustStore = createMemoryTrustStore();
  await trustStore.append({ kind: 'trusted', pluginId: id, digest, manifest });
  const input = {
    stickyIds: [id],
    selections: [{ manifest, digest, activationSequence: 1, ready }],
    deniedIds: [] as string[],
    trustEvents: [...(await trustStore.events())],
  };
  const checks: ExplicitLocalCandidateChecks = {
    async verify(candidate, signal) {
      const { entry, digest } = await artifacts.read(candidate.digest, { signal });
      return { entry, digest };
    },
    assertReadySync: () => undefined,
  };
  const options: LocalPluginSourceOptions = {
    discovery: { directory },
    trustStore,
    explicitChecks: checks,
  };
  return {
    directory,
    files,
    phasesFile,
    options,
    input,
    ready,
    checks,
    trustStore,
    source: createLocalPluginSource(options),
  };
}

it('uses parsed manual declarations to block managed copies and keeps the legacy scan compatible', async () => {
  const { directory, files, source, input, ready, phasesFile } = await fixture();
  const manualDirectory = await writePlugin(directory, id, files);
  const legacy = await discoverLocalPlugins({ directory });
  expect(legacy.candidates).toMatchObject([{ id, status: 'ready', digest: ready.digest }]);
  expect((await source.refresh()).discovery).toEqual(legacy);
  const conflict = source.adoptExplicitSelectionSync(input);
  expect(conflict.managedEligible).toEqual([]);
  expect(conflict.plugins).toMatchObject([
    { id, state: 'invalid', candidate: { directory: manualDirectory } },
  ]);
  const candidate = conflict.discovery.candidates[0]!;
  expect(candidate.status).toBe('invalid');
  if (candidate.status !== 'invalid') return;
  expect(candidate.issue.message).not.toContain(directory);
  expect((await source.prepare(conflict.stamp, prepareOptions())).items).toEqual([]);
  expect(await readFile(phasesFile, 'utf8')).toBe('');

  await rm(path.join(manualDirectory, files.entry));
  const invalidManual = await source.refresh();
  expect(invalidManual.managedEligible).toEqual([]);
  expect(invalidManual.discovery.candidates[0]).toMatchObject({
    id,
    manifest: { id },
    issue: candidate.issue,
  });
  expect((await discoverLocalPlugins({ directory })).candidates[0]).toMatchObject({
    status: 'invalid',
    issue: { code: 'plugin-entry-invalid' },
  });

  await writeFile(path.join(manualDirectory, descriptorFileName), 'invalid JSON');
  const unreadable = await source.refresh();
  expect(unreadable.managedEligible).toMatchObject([{ id, origin: 'managed' }]);
  expect(unreadable.discovery.candidates[0]).toMatchObject({
    id,
    issue: { code: 'plugin-invalid-descriptor' },
  });
  await source.close();
});

it('requires a completed manual scan and accepts a genuinely absent manual root', async () => {
  const { source, input } = await fixture();
  const unscanned = source.adoptExplicitSelectionSync(input);
  expect(unscanned.managedEligible).toEqual([]);
  expect(source.mayReadManagedSync(id)).toBe(false);
  expect((await source.prepare(unscanned.stamp, prepareOptions())).items).toEqual([]);
  const scanned = await source.refresh();
  expect(scanned.discovery).toMatchObject({ exists: false, truncated: false, candidates: [] });
  expect(scanned.plugins).toEqual([]);
  expect(scanned.managedEligible).toMatchObject([{ id, origin: 'managed' }]);
  expect(source.mayReadManagedSync(id)).toBe(true);
  await source.close();
});

it('withdraws managed readiness before rethrowing an ordinary root failure and recovers', async () => {
  const { directory, source, input } = await fixture();
  await writePlugin(directory, 'manual');
  await source.refresh();
  const before = source.adoptExplicitSelectionSync(input);
  expect(before.managedEligible).toMatchObject([{ id }]);

  const previous = `${directory}-previous`;
  await rename(directory, previous);
  await writeFile(directory, 'a file at the configured root');
  try {
    await expect(source.refresh()).rejects.toMatchObject({
      code: 'plugin-unreadable',
      cause: { code: 'ENOTDIR' },
    });
    expect(source.snapshot()).toEqual({
      ...before,
      managedEligible: [],
      stamp: { ...before.stamp, revision: before.stamp.revision + 1 },
    });
    expect(source.mayReadManagedSync(id)).toBe(false);
  } finally {
    await rm(directory);
    await rename(previous, directory);
  }
  try {
    expect((await source.refresh()).managedEligible).toEqual(before.managedEligible);
    expect(source.mayReadManagedSync(id)).toBe(true);
  } finally {
    await source.close();
  }
});

it('withdraws managed readiness and retains manual rows after a listing fails on a child', async () => {
  const { directory, source, input } = await fixture();
  await writePlugin(directory, 'manual');
  await source.refresh();
  const before = source.adoptExplicitSelectionSync(input);
  expect(before.managedEligible).toMatchObject([{ id }]);

  const failure = Object.assign(new Error('Directory entry disappeared'), {
    code: 'ENOENT',
    syscall: 'lstat',
    path: path.join(directory, 'disappeared'),
  });
  const read = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(failure);
  try {
    await expect(source.refresh()).rejects.toMatchObject({
      code: 'plugin-unreadable',
      cause: failure,
    });
    expect(source.snapshot()).toEqual({
      ...before,
      managedEligible: [],
      stamp: { ...before.stamp, revision: before.stamp.revision + 1 },
    });
    expect(source.mayReadManagedSync(id)).toBe(false);
    expect((await source.refresh()).managedEligible).toEqual(before.managedEligible);
  } finally {
    read.mockRestore();
    await source.close();
  }
});

it('applies sticky and baseline reservations, denies selected IDs, and suppresses readiness on truncation', async () => {
  const { directory, files, input, options, trustStore } = await fixture();
  const source = createLocalPluginSource({
    ...options,
    discovery: { directory, maxCandidates: 1 },
  });
  await writePlugin(directory, id, files);
  await source.refresh();
  const unselected = source.adoptExplicitSelectionSync({ ...input, selections: [] });
  expect(unselected.plugins).toMatchObject([{ id, state: 'invalid' }]);
  expect(unselected.managedEligible).toEqual([]);
  const issue = { code: 'missing', message: 'Selected payload is missing' };
  const selection = { ...input.selections[0]!, ready: undefined, issue };
  const missing = source.adoptExplicitSelectionSync({ ...input, selections: [selection] });
  expect(missing.stamp).toEqual(unselected.stamp);
  expect(missing.plugins).toEqual(unselected.plugins);
  expect(missing.managedEligible).toEqual([]);
  expect(JSON.stringify(missing)).not.toContain(issue.message);

  await rm(path.join(directory, id), { recursive: true });
  await source.refresh();
  const denied = source.adoptExplicitSelectionSync({ ...input, deniedIds: [id] });
  expect(denied.managedEligible).toEqual([]);
  expect(source.mayReadManagedSync(id)).toBe(true);
  const reserved = createLocalPluginSource({
    ...options,
    discovery: { directory, reservedIds: [id] },
  });
  await reserved.refresh();
  expect(reserved.adoptExplicitSelectionSync(input).managedEligible).toEqual([]);
  expect(reserved.mayReadManagedSync(id)).toBe(false);
  await writePlugin(directory, id, files);
  expect((await reserved.refresh()).discovery.candidates[0]).toMatchObject({ status: 'invalid' });
  await rm(path.join(directory, id), { recursive: true });

  expect(source.adoptExplicitSelectionSync(input).managedEligible).toHaveLength(1);
  await writePlugin(directory, 'a');
  await writePlugin(directory, 'b');
  const truncated = await source.refresh();
  expect(truncated.discovery).toMatchObject({ truncated: true, candidates: [{ id: 'a' }] });
  expect(truncated.managedEligible).toEqual([]);
  expect(source.mayReadManagedSync(id)).toBe(false);
  await trustStore.append({ kind: 'disabled', pluginId: id });
  const log = await trustStore.events();
  const disabled = source.adoptExplicitSelectionSync({ ...input, trustEvents: log });
  expect(disabled.stamp).toEqual({ revision: truncated.stamp.revision, trustSequence: 2 });
  await rm(path.join(directory, 'b'), { recursive: true });
  expect((await source.refresh()).managedEligible).toEqual([]);
  await Promise.all([source.close(), reserved.close()]);
});

it('rejects invalid or rewritten input atomically and rejects ordinary reads behind adopted trust', async () => {
  const { options, trustStore, input, ready } = await fixture();
  const changes: LocalSourceAuthorityChange[] = [];
  const source = createLocalPluginSource({
    ...options,
    onAuthorityChange(change) {
      expect(source.snapshot()).toBe(change.snapshot);
      changes.push(change);
    },
  });
  await source.refresh();
  const current = source.adoptExplicitSelectionSync(input);
  expect(changes.at(-1)).toMatchObject({ reason: 'explicit-selection', affectedIds: [id] });
  const priorChanges = changes.length;
  const selection = input.selections[0]!;
  const cases: ExplicitLocalSelectionInput[] = [
    { ...input, unexpected: true } as ExplicitLocalSelectionInput,
    { ...input, stickyIds: [id, id] },
    { ...input, stickyIds: [] },
    { ...input, deniedIds: ['other'] },
    { ...input, deniedIds: [id, id] },
    { ...input, selections: [selection, selection] },
    { ...input, selections: [{ ...selection, activationSequence: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...input, selections: [{ ...selection, activationSequence: 0 }] },
    { ...input, selections: [{ ...selection, digest: 'A'.repeat(64) }] },
    { ...input, selections: [{ ...selection, ready: { ...ready, id: 'other' } }] },
    { ...input, selections: [{ ...selection, ready: { ...ready, digest: '0'.repeat(64) } }] },
    {
      ...input,
      selections: [
        { ...selection, ready: { ...ready, manifest: { ...ready.manifest, name: 'Other' } } },
      ],
    },
    { ...input, selections: [{ ...selection, ready: { ...ready, directory: 'relative' } }] },
    { ...input, selections: [{ ...selection, ready: { ...ready, entry: 'index.mjs' } }] },
    { ...input, selections: [{ ...selection, issue: { code: 'missing', message: 'Missing' } }] },
    { ...input, trustEvents: [] },
    { ...input, trustEvents: input.trustEvents.map((event) => ({ ...event, sequence: 2 })) },
    {
      ...input,
      trustEvents: input.trustEvents.map((event) => ({ ...event, occurredAt: 'rewritten' })),
    },
    {
      ...input,
      trustEvents: input.trustEvents.map((event) =>
        event.kind === 'trusted'
          ? { ...event, manifest: { ...event.manifest, description: undefined } }
          : event,
      ),
    },
  ];
  for (const rejected of cases) {
    expect(() => source.adoptExplicitSelectionSync(rejected)).toThrow();
    expect(source.snapshot()).toBe(current);
    expect(changes).toHaveLength(priorChanges);
  }
  const standalone = createLocalPluginSource({ ...options, explicitChecks: undefined });
  expect(() => standalone.adoptExplicitSelectionSync(input)).toThrow();
  const extra = await trustStore.append({ kind: 'enabled', pluginId: id });
  const advanced = source.adoptExplicitSelectionSync({
    ...input,
    trustEvents: [...input.trustEvents, extra],
  });
  expect(advanced.stamp).toEqual({ ...current.stamp, trustSequence: 2 });
  expect(changes).toHaveLength(priorChanges + 1);
  expect(changes.at(-1)).toMatchObject({ reason: 'explicit-selection', snapshot: advanced });
  trustStore.events = async () => input.trustEvents;
  await expect(source.refresh()).rejects.toMatchObject({ code: 'plugin-reload-failed' });
  expect(source.snapshot()).toBe(advanced);
  await Promise.all([source.close(), standalone.close()]);
});

it('keeps explicit checks out of the strict standalone host options', async () => {
  const manual = await harness();
  const { checks } = await fixture();
  const options = { ...manual.options, explicitChecks: checks };
  await expect(createPluginHost(options)).rejects.toMatchObject({
    issues: [{ code: 'unrecognized_keys', keys: ['explicitChecks'] }],
  });
});

it('keeps mismatched folded trust ineligible until an enabled exact decision is adopted', async () => {
  const { source, trustStore, input, ready } = await fixture();
  await source.refresh();
  await trustStore.append({
    kind: 'trusted',
    pluginId: id,
    digest: ready.digest,
    manifest: { ...ready.manifest, name: 'Different name' },
  });
  expect(
    source.adoptExplicitSelectionSync({
      ...input,
      trustEvents: await trustStore.events(),
    }).managedEligible,
  ).toEqual([]);
  await trustStore.append({
    kind: 'trusted',
    pluginId: id,
    digest: '0'.repeat(64),
    manifest: ready.manifest,
  });
  expect(
    source.adoptExplicitSelectionSync({
      ...input,
      trustEvents: await trustStore.events(),
    }).managedEligible,
  ).toEqual([]);
  await trustStore.append({
    kind: 'trusted',
    pluginId: id,
    digest: ready.digest,
    manifest: ready.manifest,
  });
  expect((await source.refresh()).managedEligible).toMatchObject([{ id, origin: 'managed' }]);
  await trustStore.append({ kind: 'revoked', pluginId: id });
  expect((await source.refresh()).managedEligible).toEqual([]);
  await source.close();
});

it('detaches input, preserves equivalent stamps, and rechecks activation identities after real setup', async () => {
  const { source, input, ready, directory, trustStore } = await fixture();
  await writePlugin(directory, 'a', { entry: 'index.mjs' });
  const manual = (await discoverLocalPlugins({ directory })).candidates[0] as ReadyLocalPlugin;
  await trustStore.append({
    kind: 'trusted',
    pluginId: 'a',
    digest: manual.digest,
    manifest: manual.manifest,
  });
  input.trustEvents = [...(await trustStore.events())];
  await source.refresh();

  const selection = input.selections[0]!;
  const structured = structuredClone({
    ...input,
    selections: [
      {
        ...selection,
        manifest: { ...selection.manifest },
        ready: { ...ready, manifest: { ...ready.manifest } },
      },
    ],
  });
  const current = source.adoptExplicitSelectionSync(structured);
  structured.stickyIds.length = 0;
  structured.trustEvents.length = 0;
  structured.selections[0]!.ready.entry = path.resolve('changed.mjs');
  structured.selections[0]!.ready.manifest.name = 'Changed';
  expect(current.managedEligible[0]).toMatchObject({ entry: ready.entry, manifest: { name: id } });
  expect(Object.isFrozen(current.managedEligible[0]?.manifest.capabilities)).toBe(true);
  expect(source.adoptExplicitSelectionSync(input).stamp).toEqual(current.stamp);

  const candidates = eligibleLocalSourceCandidates(current);
  const manualIdentity = JSON.stringify(['a', manual.digest]);
  const managedIdentity = JSON.stringify([id, ready.digest, 'managed', 1]);
  expect(candidates.map((candidate) => candidate.origin)).toEqual(['manual', 'managed']);
  expect(candidates.map(localSourceCandidateIdentity)).toEqual([manualIdentity, managedIdentity]);
  const { signal } = prepareOptions();
  const excluded = new Set(candidates.map(localSourceCandidateIdentity));
  expect((await source.prepare(current.stamp, { signal, excluded })).items).toEqual([]);

  const prepared = await source.prepare(current.stamp, prepareOptions());
  expect(prepared.items).toMatchObject([
    { id: 'a', origin: 'manual', identity: manualIdentity },
    {
      id,
      origin: 'managed',
      identity: managedIdentity,
      managedIdentity: { digest: ready.digest, activationSequence: selection.activationSequence },
    },
  ]);
  const kernel = createPluginKernel();
  try {
    await kernel.register(prepared.items[1]!.plugin);
    await kernel.seal();
    const commands: PluginCommand[] = [];
    kernel.extensions.collect(commandsExtensionPoint, {
      addCommand: (command) => commands.push(command),
    });
    expect(commands.map((command) => command.name)).toEqual(['hello']);
    expect((await source.recheck(prepared, signal)).valid).toBe(true);
    const changed = source.adoptExplicitSelectionSync({
      ...input,
      selections: [{ ...selection, activationSequence: 2 }],
    });
    expect(changed.stamp.revision).toBeGreaterThan(current.stamp.revision);
    expect((await source.recheck(prepared, signal)).valid).toBe(false);
  } finally {
    await kernel.dispose();
    await prepared.dispose();
    await source.close();
  }
});

it.each(['recheck', 'setup'] as const)(
  'accepts normalized equivalent manifest fields at %s',
  async (phase) => {
    const { options, checks, input } = await fixture();
    const selection = input.selections[0]!;
    const equivalent = {
      ...input,
      selections: [
        {
          ...selection,
          manifest: {
            ...selection.manifest,
            description: undefined,
            contributes: { ...selection.manifest.contributes, tools: undefined },
          },
          ready: {
            ...selection.ready,
            manifest: { ...selection.ready.manifest, host: undefined },
          },
        },
      ],
    };
    let guardCalls = 0;
    const source = createLocalPluginSource({
      ...options,
      explicitChecks: {
        ...checks,
        assertReadySync() {
          guardCalls += 1;
          if (phase === 'setup' && guardCalls === 3) {
            source.adoptExplicitSelectionSync(equivalent);
          }
          return undefined;
        },
      },
    });
    await source.refresh();
    const { stamp } = source.adoptExplicitSelectionSync(input);
    const preparation = prepareOptions();
    const prepared = await source.prepare(stamp, preparation);
    const kernel = createPluginKernel();
    try {
      if (phase === 'setup') {
        await kernel.register(prepared.items[0]!.plugin);
        expect(guardCalls).toBe(3);
      } else {
        source.adoptExplicitSelectionSync(equivalent);
      }
      expect(source.snapshot().stamp).toEqual(stamp);
      await expect(source.recheck(prepared, preparation.signal)).resolves.toMatchObject({
        valid: true,
      });
    } finally {
      await Promise.all([kernel.dispose(), prepared.dispose(), source.close()]);
    }
  },
);

it.each(['verify', 'guard'] as const)(
  'propagates authority failure from %s and disposes a prior manual item',
  async (phase) => {
    const { directory, options, checks, trustStore, input, phasesFile } = await fixture();
    const disposedFile = path.join(directory, '..', 'disposed');
    await writeFile(disposedFile, '');
    await writePlugin(directory, 'a', {
      entry: 'index.mjs',
      source: `import { appendFileSync } from 'node:fs';
      export default () => ({ setup() {}, dispose() { appendFileSync(${JSON.stringify(disposedFile)}, 'a'); } });`,
    });
    const manual = (await discoverLocalPlugins({ directory })).candidates[0] as ReadyLocalPlugin;
    await trustStore.append({
      kind: 'trusted',
      pluginId: 'a',
      digest: manual.digest,
      manifest: manual.manifest,
    });
    const authorityError = new ExplicitLocalAuthorityError();
    const source = createLocalPluginSource({
      ...options,
      explicitChecks: {
        verify:
          phase === 'verify'
            ? async () => {
                throw authorityError;
              }
            : checks.verify,
        assertReadySync:
          phase === 'guard'
            ? () => {
                throw authorityError;
              }
            : checks.assertReadySync,
      },
    });
    await source.refresh();
    const current = source.adoptExplicitSelectionSync({
      ...input,
      trustEvents: await trustStore.events(),
    });
    await expect(source.prepare(current.stamp, prepareOptions())).rejects.toBeInstanceOf(
      ExplicitLocalAuthorityError,
    );
    expect(await readFile(disposedFile, 'utf8')).toBe('a');
    expect(await readFile(phasesFile, 'utf8')).toBe('');
    await source.close();
  },
);

it('attributes an intact-authority verification mismatch to the managed identity', async () => {
  const { options, input, ready, phasesFile } = await fixture();
  const source = createLocalPluginSource({
    ...options,
    explicitChecks: {
      ...options.explicitChecks!,
      verify: async () => ({ entry: ready.entry, digest: '0'.repeat(64) }),
    },
  });
  await source.refresh();
  const { stamp } = source.adoptExplicitSelectionSync(input);
  const prepared = await source.prepare(stamp, prepareOptions());
  expect(prepared.items).toEqual([]);
  expect(prepared.failures).toMatchObject([
    {
      id,
      origin: 'managed',
      identity: JSON.stringify([id, ready.digest, 'managed', 1]),
      kind: 'identity',
      error: { code: 'plugin-digest-mismatch' },
    },
  ]);
  expect(await readFile(phasesFile, 'utf8')).toBe('');
  await source.close();
});

it('drains cancelled managed setup through the source-owned lifecycle', async () => {
  const controlFile = pathToFileURL(path.join(await makeTempDirectory(), 'control.mjs'));
  await writeFile(
    controlFile,
    `export const entered = Promise.withResolvers();
     export const pending = Promise.withResolvers();
     export const disposed = Promise.withResolvers();`,
  );
  const control = (await import(controlFile.href)) as {
    readonly entered: PromiseWithResolvers<void>;
    readonly pending: PromiseWithResolvers<void>;
    readonly disposed: PromiseWithResolvers<void>;
  };
  const { input, source } = await fixture(`
    import { entered, pending, disposed } from ${JSON.stringify(controlFile.href)};
    export default () => ({
      setup() { entered.resolve(); return pending.promise; },
      dispose() { disposed.resolve(); },
    });`);
  await source.refresh();
  const { stamp } = source.adoptExplicitSelectionSync(input);
  const attempt = new AbortController();
  const prepared = await source.prepare(stamp, { ...prepareOptions(), signal: attempt.signal });
  const kernel = createPluginKernel();
  const registration = kernel.register(prepared.items[0]!.plugin);
  const outcome = registration.catch((error: unknown) => error);
  try {
    await control.entered.promise;
    attempt.abort(new Error('attempt cancelled'));
    expect(await outcome).toMatchObject({ code: 'plugin-setup-failed' });
    let disposed = false;
    const retiring = prepared.dispose().then(() => {
      disposed = true;
    });
    await control.disposed.promise;
    await new Promise(setImmediate);
    expect(disposed).toBe(false);
    control.pending.resolve();
    await retiring;
    expect(disposed).toBe(true);
  } finally {
    control.pending.resolve();
    await Promise.all([prepared.dispose(), kernel.dispose(), source.close()]);
  }
});

it('observes a rejecting guard Promise and refuses evaluation', async () => {
  const { options, checks, input, phasesFile } = await fixture();
  const observed = gate();
  class InvalidResult extends Promise<never> {
    override then<TResult1 = never, TResult2 = never>(
      fulfill?: ((value: never) => TResult1 | PromiseLike<TResult1>) | null,
      reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      observed.resolve();
      return super.then(fulfill, reject);
    }
  }
  const source = createLocalPluginSource({
    ...options,
    explicitChecks: {
      ...checks,
      assertReadySync: () =>
        new InvalidResult((_, reject) =>
          reject(new Error('invalid result')),
        ) as unknown as undefined,
    },
  });
  await source.refresh();
  const { stamp } = source.adoptExplicitSelectionSync(input);
  await expect(source.prepare(stamp, prepareOptions())).rejects.toBeInstanceOf(
    ExplicitLocalAuthorityError,
  );
  await observed.promise;
  expect(await readFile(phasesFile, 'utf8')).toBe('');
  await source.close();
});

it('rejects readiness changed in the synchronous guard before importing the old candidate', async () => {
  const { options, checks, input, ready, phasesFile } = await fixture();
  const source = createLocalPluginSource({
    ...options,
    explicitChecks: {
      ...checks,
      assertReadySync() {
        source.adoptExplicitSelectionSync({
          ...input,
          selections: [
            {
              ...input.selections[0]!,
              ready: { ...ready, directory: path.dirname(ready.directory) },
            },
          ],
        });
        return undefined;
      },
    },
  });
  await source.refresh();
  const { stamp } = source.adoptExplicitSelectionSync(input);
  await expect(source.prepare(stamp, prepareOptions())).rejects.toBeInstanceOf(
    ExplicitLocalAuthorityError,
  );
  expect(await readFile(phasesFile, 'utf8')).toBe('');
  await source.close();
});

it('drains a verifier that reenters close synchronously before it settles', async () => {
  const { options, checks, input, ready, phasesFile } = await fixture();
  const entered = gate();
  const release = gate();
  let closing: Promise<void> | undefined;
  let closed = false;
  const source = createLocalPluginSource({
    ...options,
    explicitChecks: {
      ...checks,
      async verify(_candidate, signal) {
        closing = source.close().then(() => {
          closed = true;
        });
        entered.resolve();
        expect(signal.aborted).toBe(true);
        await release.promise;
        return { entry: ready.entry, digest: ready.digest };
      },
    },
  });
  await source.refresh();
  const { stamp } = source.adoptExplicitSelectionSync(input);
  const preparing = source.prepare(stamp, prepareOptions());
  const rejected = expect(preparing).rejects.toMatchObject({ code: 'plugin-host-disposed' });
  await entered.promise;
  await new Promise(setImmediate);
  expect(closed).toBe(false);
  release.resolve();
  await rejected;
  await closing;
  expect(closed).toBe(true);
  expect(await readFile(phasesFile, 'utf8')).toBe('');
});

it('blocks sticky manual mutations before work and after a pending read', async () => {
  const manual = await harness(['a'], true);
  const read = gate();
  const release = gate();
  const completeLog = await manual.trustStore.events();
  manual.trustStore.events = async () => {
    read.resolve();
    await release.promise;
    return completeLog;
  };
  const source = createLocalPluginSource({
    discovery: manual.options.discovery,
    trustStore: manual.trustStore,
  });
  expect(typeof source.adoptExplicitSelectionSync).toBe('function');
  const { digest } = manual.ready[0]!;
  const changing = source.mutate({ kind: 'trust', id: 'a', digest });
  const rejected = expect(changing).rejects.toMatchObject({ code: 'plugin-not-loadable' });
  await read.promise;
  source.adoptExplicitSelectionSync({
    stickyIds: ['a'],
    selections: [],
    deniedIds: [],
    trustEvents: completeLog,
  });
  release.resolve();
  await rejected;
  manual.trustStore.events = () => Promise.reject(new Error('trust should not be read'));
  for (const change of [
    { kind: 'trust', id: 'a', digest },
    { kind: 'revoke', id: 'a' },
    { kind: 'setEnabled', id: 'a', enabled: false },
  ] as const) {
    await expect(source.mutate(change)).rejects.toMatchObject({ code: 'plugin-not-loadable' });
  }
  await source.close();
});
