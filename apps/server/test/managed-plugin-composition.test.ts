import { rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryTrustStore,
  ExplicitLocalAuthorityError,
  type PluginArtifact,
  type RecordedPluginTrustEvent,
} from '@weave/plugin-host';
import { createLocalExtensionSource } from '../src/local-extension-source.js';
import { createRealManagedCompositionFixture } from './support/managed-plugin-composition-fixture.js';
import { decisionInput } from './support/plugin-authority-fixtures.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('selected managed authority', () => {
  it.each([
    ['digest', (artifact: PluginArtifact) => ({ ...artifact, digest: '0'.repeat(64) })],
    [
      'ID',
      (artifact: PluginArtifact) => ({
        ...artifact,
        descriptor: {
          ...artifact.descriptor,
          manifest: { ...artifact.descriptor.manifest, id: 'other' },
        },
      }),
    ],
    ['files', (artifact: PluginArtifact) => ({ ...artifact, files: artifact.files + 1 })],
    ['bytes', (artifact: PluginArtifact) => ({ ...artifact, bytes: artifact.bytes + 1 })],
    [
      'manifest',
      (artifact: PluginArtifact) => ({
        ...artifact,
        descriptor: {
          ...artifact.descriptor,
          manifest: { ...artifact.descriptor.manifest, name: 'Other' },
        },
      }),
    ],
  ] as const)(
    'requires the returned artifact %s to match the selected durable candidate',
    async (_field, change) => {
      const f = await createRealManagedCompositionFixture();
      try {
        const artifact = await f.seedManaged('notes', 'ready');
        f.readOwned.mockImplementation(async () => change(artifact));
        const host = f.compose();
        await host.coordinator.reload();
        expect(f.readOwned).toHaveBeenCalledExactlyOnceWith(artifact.digest, {
          signal: expect.any(AbortSignal),
        });
        expect(host.coordinator.snapshot().members).toEqual([]);
        f.readOwned.mockImplementation(f.owned.read);
        await host.coordinator.reload();
        expect(host.coordinator.snapshot().members).toMatchObject([{ pluginId: 'notes' }]);
      } finally {
        await f.close();
      }
    },
  );

  it('matches canonically reordered manifests and rejects a nonmatching first-import link', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      const artifact = await f.seedManaged('notes', 'ready');
      const original = f.authority.snapshotSync();
      const invalidLink = {
        ...original,
        installations: original.installations.map((record) => ({
          ...record,
          selection: { ...record.selection!, candidateImportSequence: 999 },
        })),
      };
      f.readAuthoritySync.mockReturnValue(invalidLink);
      const host = f.compose();
      await host.coordinator.reload();
      expect(f.readOwned).not.toHaveBeenCalled();
      f.readAuthoritySync.mockImplementation(f.authority.snapshotSync);
      f.readOwned.mockImplementation(async (digest, options) => {
        const found = await f.owned.read(digest, options);
        const manifest = Object.fromEntries(
          Object.entries(found.descriptor.manifest).reverse(),
        ) as PluginArtifact['descriptor']['manifest'];
        return { ...found, descriptor: { ...found.descriptor, manifest } };
      });
      await host.coordinator.reload();
      expect(f.readOwned.mock.calls.map(([digest]) => digest)).toEqual(
        Array<string>(3).fill(artifact.digest),
      );
      expect(host.coordinator.snapshot().members).toMatchObject([{ pluginId: 'notes' }]);
    } finally {
      await f.close();
    }
  });

  it.each(['revoke', 'replacement'] as const)(
    'discards an in-flight read after %s',
    async (change) => {
      const f = await createRealManagedCompositionFixture();
      const entered = deferred();
      const released = deferred();
      let pending: Promise<unknown> | undefined;
      try {
        const artifact = await f.seedManaged('notes', 'old');
        f.readOwned.mockImplementationOnce(async () => {
          entered.resolve();
          await released.promise;
          return artifact;
        });
        const host = f.compose();
        pending = host.coordinator.reload();
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('No selected read');
          }),
        ]);
        if (change === 'revoke') {
          f.authority.commitSync(
            decisionInput('revoke', 'revoke-notes', f.authority.snapshotSync()),
          );
        } else {
          await f.seedManaged('notes', 'new');
        }
        released.resolve();
        await pending;
        expect(f.readOwned.mock.calls.every(([digest]) => digest === artifact.digest)).toBe(true);
        expect(host.coordinator.snapshot().members).toEqual([]);
        await host.coordinator.reload();
        expect(host.coordinator.snapshot().members).toHaveLength(change === 'replacement' ? 1 : 0);
      } finally {
        released.resolve();
        await pending?.catch(() => undefined);
        await f.close();
      }
    },
  );

  it('rechecks authority after an artifact read fails and withdraws a previously published member', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManaged('notes', 'ready');
      const host = f.compose();
      await host.coordinator.reload();
      const privateCause = new Error('private artifact path');
      f.readOwned.mockRejectedValue(privateCause);
      f.readOwned.mockClear();
      f.readAuthoritySync.mockClear();
      await host.coordinator.reload();
      expect(f.readAuthoritySync.mock.calls.length).toBeGreaterThan(f.readOwned.mock.calls.length);
      expect(host.coordinator.snapshot().members).toEqual([]);
      expect(JSON.stringify(host.coordinator.snapshot())).not.toContain(privateCause.message);
    } finally {
      await f.close();
    }
  });

  it.each(['missing', 'corrupt'] as const)(
    'withdraws a selected artifact with %s bytes and keeps the issue private to management',
    async (damage) => {
      const f = await createRealManagedCompositionFixture();
      try {
        const artifact = await f.seedManaged('notes', 'ready');
        const host = f.compose({ mcp: false });
        await host.coordinator.reload();
        expect(host.coordinator.snapshot().members).toHaveLength(1);
        if (damage === 'missing') await rm(artifact.directory, { recursive: true });
        else await writeFile(artifact.entry, 'corrupt payload');
        const result = await host.coordinator.reload();
        expect(result.members).toEqual([]);
        expect(JSON.stringify(result)).not.toContain(artifact.directory);
      } finally {
        await f.close();
      }
    },
  );

  it('never reads bytes for a later target after a new MCP declaration is recorded during a read', async () => {
    const f = await createRealManagedCompositionFixture();
    const entered = deferred();
    const released = deferred();
    let pending: Promise<unknown> | undefined;
    try {
      const first = await f.seedManaged('aaa', 'first');
      const later = await f.seedManaged('mcp-later', 'later');
      f.readOwned.mockImplementationOnce(async () => {
        entered.resolve();
        await released.promise;
        return first;
      });
      const host = f.compose();
      pending = host.coordinator.reload();
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('No selected read');
        }),
      ]);
      await f.seedMcp('later', false);
      released.resolve();
      await pending;
      expect(f.readOwned.mock.calls.map(([digest]) => digest)).not.toContain(later.digest);
      expect(host.coordinator.snapshot().members).toMatchObject([{ pluginId: 'aaa' }]);
    } finally {
      released.resolve();
      await pending?.catch(() => undefined);
      await f.close();
    }
  });

  it('keeps both sides of a sticky collision ineligible until the MCP declaration is removed', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      const managed = await f.seedManaged('mcp-remote', 'managed');
      const host = f.compose();
      const config = await f.createMcpConfig('remote');
      await expect(host.mcpManager!.configure(0, config)).rejects.toMatchObject({
        code: 'mcp-conflict',
      });
      expect(f.readOwned).not.toHaveBeenCalled();
      await f.seedMcp('remote');
      await f.mutateMcp({ kind: 'disable', serverId: 'remote' });
      await host.coordinator.reload();
      expect(f.readOwned).not.toHaveBeenCalled();
      expect(host.coordinator.snapshot().members).toEqual([]);
      await f.mutateMcp({ kind: 'remove', serverId: 'remote' });
      await host.coordinator.reload();
      expect(f.readOwned.mock.calls.map(([digest]) => digest)).toContain(managed.digest);
      expect(host.coordinator.snapshot().members).toMatchObject([
        { pluginId: 'mcp-remote', origin: 'managed' },
      ]);
    } finally {
      await f.close();
    }
  });

  it('uses the package manual declaration veto even when the same-ID entry is broken', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManaged('notes', 'managed');
      const manual = await f.seedManual('notes', 'manual', false);
      await rm(join(manual.directory, 'index.mjs'));
      const host = f.compose();
      await host.coordinator.reload();
      expect(f.readOwned).not.toHaveBeenCalled();
      expect(host.coordinator.snapshot().members).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.each(['main', 'MCP', 'lease'] as const)(
    'withdraws cached managed admission and preserves the cause when %s authority fails',
    async (source) => {
      const f = await createRealManagedCompositionFixture();
      try {
        await f.seedManaged('notes', 'ready');
        const host = f.compose();
        await host.coordinator.reload();
        const before = host.localSource!.snapshot();
        const original = f.runtime.serverHost.controller()!.current();
        const cause = new Error('private authority detail');
        f.readOwned.mockClear();
        if (source === 'main')
          f.readAuthoritySync.mockImplementationOnce(() => {
            throw cause;
          });
        if (source === 'MCP') f.readMcp.mockRejectedValueOnce(cause);
        if (source === 'lease')
          f.assertHeldSync.mockImplementationOnce(() => {
            throw cause;
          });
        await expect(host.coordinator.reload()).rejects.toMatchObject({
          code: 'plugin-explicit-authority-failed',
          cause,
        });
        expect(f.readOwned).not.toHaveBeenCalled();
        expect(host.localSource!.snapshot()).toMatchObject({ eligible: [] });
        expect(host.localSource!.snapshot().stamp.revision).toBeGreaterThan(before.stamp.revision);
        expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(false);
        expect(f.runtime.serverHost.controller()!.current()).toBe(original);
        await expect(f.runTool('notes')).rejects.toMatchObject({
          code: 'plugin-generation-blocked',
        });
        await host.coordinator.reload();
        expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(true);
        expect(host.coordinator.snapshot().members).toMatchObject([{ pluginId: 'notes' }]);
      } finally {
        await f.close();
      }
    },
  );

  it('publishes one effective fallback snapshot when raw adoption fails after a new sticky claim', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManual('notes', 'manual');
      await f.seedMcp('remote');
      let rawPrefix = f.authority.snapshotSync().trustEvents;
      const host = f.compose({ execution: false, readLocalTrustEventsSync: () => rawPrefix });
      await host.coordinator.reload();
      const before = host.localSource!.snapshot();
      const stampBefore = before.stamp;
      expect(before.eligible).toMatchObject([{ pluginId: 'notes', origin: 'manual' }]);
      await f.seedManaged('notes', 'import-only', false);
      await f.seedManaged('mcp-remote', 'import-only', false);
      rawPrefix = [];
      const publish = vi.spyOn(host.coordinator, 'observeAuthorityBatchSync');
      expect(() => host.managed!.adoptAuthoritySync(f.authority.snapshotSync())).toThrow(
        expect.objectContaining({
          code: 'plugin-explicit-authority-failed',
          cause: expect.any(Error),
        }),
      );
      const withdrawn = host.localSource!.snapshot();
      expect(withdrawn.eligible).toEqual([]);
      expect(withdrawn.stamp.revision).toBeGreaterThan(stampBefore.revision);
      expect(withdrawn.stamp.trustSequence).toBe(stampBefore.trustSequence);
      expect(publish).toHaveBeenCalledOnce();
      const pair = publish.mock.calls[0]![0];
      expect(pair.get('local-esm')?.snapshot).toEqual(withdrawn);
      expect(pair.get('mcp')?.snapshot.eligible).toEqual([]);
      expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(false);
      await expect(host.coordinator.reload()).rejects.toMatchObject({
        code: 'plugin-explicit-authority-failed',
      });
      expect(f.readOwned).not.toHaveBeenCalled();
      rawPrefix = f.authority.snapshotSync().trustEvents;
      await host.coordinator.reload();
      expect(host.localSource!.snapshot().eligible).toEqual([]);
      expect(host.localSource!.snapshot().stamp.revision).toBeGreaterThan(withdrawn.stamp.revision);
      expect(host.coordinator.snapshot().members).toEqual([]);
      expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('refuses to prepare against a withdrawn raw manual snapshot', async () => {
    const f = await createRealManagedCompositionFixture();
    const manual = await f.seedManual('notes', 'manual');
    const importModule = vi.fn(async () => ({}));
    const local = createLocalExtensionSource({
      discovery: { directory: dirname(manual.directory), hostVersion: '1.0.0' },
      trustStore: f.authority.trust,
      importModule,
    });
    const source = local.register(vi.fn());
    try {
      const signal = new AbortController().signal;
      await source.refresh(signal);
      const previous = source.snapshot();
      expect(previous.eligible).toMatchObject([{ pluginId: 'notes', origin: 'manual' }]);
      const failure = new ExplicitLocalAuthorityError(new Error('Raw prefix mismatch'));
      local.withdrawExplicitSelectionSync(
        new Set(['notes']),
        previous.stamp.trustSequence,
        failure,
      );
      await expect(source.prepare(previous.stamp, { signal, excluded: new Set() })).rejects.toBe(
        failure,
      );
      await expect(
        source.prepare(source.snapshot().stamp, { signal, excluded: new Set() }),
      ).rejects.toBe(failure);
      expect(importModule).not.toHaveBeenCalled();
    } finally {
      await local.close();
      await f.close();
    }
  });

  it('keeps discovery-only reservation checks free of managed reads and MCP refresh', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManaged('notes', 'managed');
      await f.seedManual('manual', 'manual', false);
      const host = f.compose();
      expect(await host.localSource!.discoveredPluginIds()).toEqual(['manual']);
      expect(f.readOwned).not.toHaveBeenCalled();
      expect(f.readMcp).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('keeps a raw override prefix separate when it is unavailable during sticky adoption', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      const { manifest, digest } = await f.seedManual('notes', 'override', false);
      const manualTrust = createMemoryTrustStore();
      await manualTrust.append({ kind: 'trusted', pluginId: 'notes', manifest, digest });
      await f.seedManaged('other', 'core first');
      await f.seedManaged('another', 'core second');
      let rawPrefix: readonly RecordedPluginTrustEvent[] | undefined;
      const host = f.compose({
        execution: false,
        readLocalTrustEventsSync: () => rawPrefix,
        localTrustStore: {
          append: manualTrust.append,
          async events() {
            rawPrefix = await manualTrust.events();
            return rawPrefix;
          },
        },
      });
      await host.coordinator.reload();
      expect(host.localSource!.snapshot().stamp.trustSequence).toBe(1);
      expect(host.coordinator.snapshot().members).toMatchObject([{ pluginId: 'notes' }]);
      await f.seedManaged('notes', 'import-only', false);
      rawPrefix = undefined;
      host.managed!.adoptAuthoritySync(f.authority.snapshotSync());
      expect(host.localSource!.snapshot()).toMatchObject({
        eligible: [],
        stamp: { trustSequence: 1 },
      });
      expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(false);
      await host.coordinator.reload();
      expect(host.coordinator.snapshot().members).toEqual([]);
      expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(true);
      expect(f.readOwned).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('validates an MCP declaration added during assembly before final local readback', async () => {
    const entered = deferred();
    const released = deferred();
    let gate = false;
    const f = await createRealManagedCompositionFixture({
      async onKernelSetup() {
        if (!gate) return;
        gate = false;
        entered.resolve();
        await released.promise;
      },
    });
    let pending: Promise<unknown> | undefined;
    try {
      const managed = await f.seedManaged('mcp-late', 'late');
      const host = f.compose();
      gate = true;
      pending = host.coordinator.reload();
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('No candidate assembly');
        }),
      ]);
      expect(f.readOwned.mock.calls.map(([digest]) => digest)).toContain(managed.digest);
      f.readOwned.mockClear();
      await f.seedMcp('late', false);
      released.resolve();
      await pending;
      expect(f.readOwned).not.toHaveBeenCalled();
      expect(host.coordinator.snapshot().members).toEqual([]);
    } finally {
      released.resolve();
      await pending?.catch(() => undefined);
      await f.close();
    }
  });

  it('releases a removed MCP claim for a new Generation while the older allocation is pinned', async () => {
    const f = await createRealManagedCompositionFixture();
    const entered = deferred();
    const released = deferred();
    let active: Promise<unknown> | undefined;
    let reload: Promise<unknown> | undefined;
    const close = vi.fn(async () => {});
    try {
      await f.seedMcp('remote');
      const host = f.compose({
        mcpConnect: async () => ({
          tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
          stderrBytes: 0,
          validateInput: () => ({ valid: true }),
          async callTool() {
            entered.resolve();
            await released.promise;
            return { content: [{ type: 'text', text: 'pinned MCP result' }] };
          },
          close,
        }),
      });
      const first = await host.coordinator.reload();
      const tool = first.members[0]!.manifest.contributes!.tools![0]!;
      active = f.runTool(tool);
      await Promise.race([
        entered.promise,
        active.then(() => {
          throw new Error('No pinned tool');
        }),
      ]);
      const managed = await f.seedManaged('mcp-remote', 'replacement');
      await f.mutateMcp({ kind: 'remove', serverId: 'remote' });
      reload = host.coordinator.reload();
      await expect.poll(() => host.coordinator.snapshot().members[0]?.origin).toBe('managed');
      expect(host.coordinator.retainedGenerations()).toContainEqual(
        expect.objectContaining({
          current: false,
          generationId: first.generation.id,
          members: first.members,
        }),
      );
      expect(close).not.toHaveBeenCalled();
      expect(f.readOwned.mock.calls.map(([digest]) => digest)).toContain(managed.digest);
      released.resolve();
      expect(JSON.stringify(await active)).toContain('pinned MCP result');
      await reload;
      await expect.poll(() => host.coordinator.retainedGenerations()).toHaveLength(1);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      released.resolve();
      await Promise.allSettled([active, reload]);
      await f.close();
    }
  });
});
