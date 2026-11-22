import * as pluginHost from '@weave/plugin-host';
import { describe, expect, it, vi } from 'vitest';
import type {
  ManagedSelectionRequest,
  ManagedSelectionResult,
} from '../src/managed-selection-manager.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import { PluginAuthorityError, type ManagedRequest } from '../src/plugin-authority-types.js';
import { PluginStoreOwnershipError } from '../src/plugin-store-ownership-types.js';
import { createRealManagedCompositionFixture } from './support/managed-plugin-composition-fixture.js';
import { activateInput, decisionInput, importInput } from './support/plugin-authority-fixtures.js';

function selection(request: ManagedRequest): ManagedSelectionRequest {
  if (request.command.kind === 'import') throw new Error('Expected a selection command');
  return { ...request, command: request.command };
}

type Fixture = Awaited<ReturnType<typeof createRealManagedCompositionFixture>>;

function activate(
  f: Fixture,
  pluginId = 'notes',
  requestId = 'choose-notes',
  intent: 'activate' | 'rollback' = 'activate',
) {
  const current = f.authority.snapshotSync();
  const {
    pluginId: id,
    digest,
    manifest,
    files,
    bytes,
  } = current.installations.find((record) => record.pluginId === pluginId)!.candidates.at(-1)!;
  return activateInput(
    requestId,
    current,
    { pluginId: id, digest, manifest, files, bytes },
    intent,
  );
}

function decision(
  f: Fixture,
  kind: 'enable' | 'disable' | 'revoke' | 'uninstall',
  requestId = kind,
  immediate = false,
) {
  return selection(decisionInput(kind, requestId, f.authority.snapshotSync(), immediate).request);
}

function observation(host: ReturnType<Fixture['compose']>) {
  const { generation, members } = host.coordinator.snapshot();
  return { generation, members };
}

function gateCommandRead(f: Fixture) {
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  f.readOwned.mockImplementationOnce(async (digest, options) => {
    const artifact = await f.owned.read(digest, options);
    entered.resolve(options!.signal!);
    await release.promise;
    return artifact;
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

describe('queued managed selection', () => {
  it('applies the saved activation and replays it without checking runtime state', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManaged('notes', 'selected text', false);
      const host = f.compose();
      const apply = host.applyManagedSelection!;
      const before = f.authority.snapshotSync();
      const request = selection(
        activateInput('choose-notes', before, before.installations[0]!.candidates[0]).request,
      );
      const publish = vi.spyOn(f.runtime.serverHost, 'commit');
      const abort = vi.spyOn(f.runtime.serverHost.controller()!, 'abortActiveRuns');

      const result = await apply(request);
      expect(result.kind).toBe('committed');
      if (result.kind !== 'committed') throw new Error('Expected a committed result');
      expect(result.application).toEqual({ status: 'applied' });
      expect(result.observed).toEqual(observation(host));
      expect(result.savedAuthority).toEqual(f.authority.snapshotSync());
      expect(result.operation.decision.pluginAfter.selection).toMatchObject({
        digest: before.installations[0]!.candidates[0]!.digest,
      });
      expect(f.readOwned.mock.calls.length).toBeGreaterThan(0);
      expect(publish).toHaveBeenCalledOnce();

      const disabled = await apply(
        selection(decisionInput('disable', 'disable-notes', result.savedAuthority).request),
      );
      expect(disabled.kind === 'committed' && disabled.application.status).toBe('applied');
      const currentAuthority = f.authority.snapshotSync();
      const reads = [f.assertHeldSync, f.readOwned, f.readMcp, f.readAuthoritySync, publish, abort];
      for (const spy of reads) spy.mockClear();

      await expect(apply(request, AbortSignal.abort('caller left'))).resolves.toEqual({
        kind: 'replayed',
        operation: result.operation,
        currentAuthority,
        observed: observation(host),
      });
      await expect(
        apply({ ...request, command: { ...request.command, expectedTrustSequence: 999 } }),
      ).rejects.toMatchObject({
        code: 'plugin-authority-request-conflict',
      });
      await expect(
        apply(importInput('reject-import', 0).request as ManagedSelectionRequest),
      ).rejects.toMatchObject({
        code: 'plugin-authority-invalid',
      });
      for (const spy of reads) expect(spy).not.toHaveBeenCalled();
      expect(host.coordinator.snapshot().members).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('discards provisional evidence when another connection commits the same request ID', async () => {
    const f = await createRealManagedCompositionFixture();
    const secondConnection = createSqlitePluginAuthorityDatabase({ filename: f.databaseFile });
    const gate = gateCommandRead(f);
    let pending: Promise<unknown> | undefined;
    try {
      await f.seedManaged('notes', 'unselected', false);
      const host = f.compose();
      const input = activate(f);
      const initial = host.coordinator.snapshot();
      const cached = f.authority.snapshotSync();
      const adoption = vi.spyOn(host.localSource!, 'adoptExplicitSelectionSync');
      const publish = vi.spyOn(f.runtime.serverHost, 'commit');
      const abort = vi.spyOn(f.runtime.serverHost.controller()!, 'abortActiveRuns');
      const commit = f.authority.commitSync;
      const leaseCallsAtReplay: number[] = [];
      vi.spyOn(f.authority, 'commitSync').mockImplementation((input) => {
        const result = commit(input);
        expect(result.kind).toBe('replayed');
        leaseCallsAtReplay.push(f.assertHeldSync.mock.calls.length);
        return result;
      });

      pending = host.applyManagedSelection!(selection(input.request));
      await Promise.race([
        gate.entered,
        pending.then(() => {
          throw new Error('Expected a provisional read');
        }),
      ]);
      const external = secondConnection.commitSync(input);
      expect(external.kind).toBe('committed');
      gate.release();

      await expect(pending).resolves.toEqual({
        kind: 'replayed',
        operation: external.operation,
        currentAuthority: secondConnection.snapshotSync(),
        observed: { generation: initial.generation, members: initial.members },
      });
      expect(f.readOwned).toHaveBeenCalledOnce();
      expect(leaseCallsAtReplay).toEqual([2]);
      expect(f.assertHeldSync).toHaveBeenCalledTimes(leaseCallsAtReplay[0]!);
      for (const spy of [f.readMcp, f.readAuthoritySync, adoption, publish, abort])
        expect(spy).not.toHaveBeenCalled();
      expect(host.coordinator.snapshot()).toEqual(initial);
      expect(host.managed!.cachedAuthoritySync()).toEqual(cached);
    } finally {
      gate.release();
      await Promise.allSettled([pending]);
      await secondConnection.close();
      await f.close();
    }
  });

  it('rejects an active evidence ticket during shutdown without writing its operation', async () => {
    const f = await createRealManagedCompositionFixture();
    const gate = gateCommandRead(f);
    let pending: Promise<unknown> | undefined;
    try {
      await f.seedManaged('notes', 'unselected', false);
      const host = f.compose();
      const request = selection(activate(f).request);
      const before = f.authority.snapshotSync();
      pending = host.applyManagedSelection!(request).catch((cause: unknown) => cause);
      const signal = await Promise.race([
        gate.entered,
        pending.then(() => {
          throw new Error('Expected gated evidence');
        }),
      ]);
      host.coordinator.beginOwnedDrainSync();
      expect(signal.aborted).toBe(true);
      gate.release();
      await expect(pending).resolves.toMatchObject({ code: 'plugin-host-disposed' });
      expect(f.authority.snapshotSync()).toEqual(before);
      expect(f.authority.lookupSync(request)).toEqual({ kind: 'absent' });
    } finally {
      gate.release();
      await Promise.allSettled([pending]);
      await f.close();
    }
  });

  it.each([false, true])(
    'cancels fresh command evidence before any write (reader rejects: %s)',
    async (rejectRead) => {
      const f = await createRealManagedCompositionFixture();
      const entered = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<void>();
      const caller = new AbortController();
      const reason = Symbol('caller left');
      let pending: Promise<unknown> | undefined;
      try {
        await f.seedManaged('notes', 'unselected', false);
        const host = f.compose();
        const request = selection(activate(f).request);
        const before = f.authority.snapshotSync();
        const commit = vi.spyOn(f.authority, 'commitSync');
        f.readOwned.mockImplementationOnce(async (digest, options) => {
          const artifact = await f.owned.read(digest, options);
          const signal = options!.signal!;
          entered.resolve(signal);
          await release.promise;
          if (rejectRead) signal.throwIfAborted();
          return artifact;
        });
        pending = host.applyManagedSelection!(request, caller.signal).catch(
          (cause: unknown) => cause,
        );
        const signal = await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('Expected gated evidence');
          }),
        ]);
        caller.abort(reason);
        release.resolve();

        expect(signal.aborted).toBe(true);
        await expect(pending).resolves.toMatchObject({
          code: 'plugin-installer-unavailable',
          cause: reason,
        });
        expect(commit).not.toHaveBeenCalled();
        expect(f.authority.snapshotSync()).toEqual(before);
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
        await f.close();
      }
    },
  );

  it('completes adoption and publication when the client aborts inside the successful commit', async () => {
    const f = await createRealManagedCompositionFixture();
    const caller = new AbortController();
    try {
      await f.seedManaged('notes', 'selected', false);
      const host = f.compose();
      const request = selection(activate(f).request);
      const commit = f.authority.commitSync;
      vi.spyOn(f.authority, 'commitSync').mockImplementationOnce((input) => {
        const saved = commit(input);
        caller.abort(new Error('caller left'));
        return saved;
      });

      const result = await host.applyManagedSelection!(request, caller.signal);
      expect(caller.signal.aborted).toBe(true);
      expect(result).toMatchObject({
        kind: 'committed',
        application: { status: 'applied' },
        observed: { generation: { acceptingRuns: true }, members: [{ pluginId: 'notes' }] },
      });
      expect(host.managed!.cachedAuthoritySync()).toEqual(f.authority.snapshotSync());
    } finally {
      await f.close();
    }
  });

  it('rejects stale heads, selection and manifest and missing exact enable trust before reading bytes', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManaged('notes', 'selected');
      const host = f.compose();
      const request = selection(activate(f).request);
      if (request.command.kind !== 'activate') throw new Error('Expected activation');
      const staleCommands = [
        { ...request.command, expectedInstallSequence: 0 },
        { ...request.command, expectedTrustSequence: 0 },
        { ...request.command, previousSelection: null },
        { ...request.command, manifest: { ...request.command.manifest, name: 'Stale' } },
      ];
      for (const command of staleCommands) {
        await expect(host.applyManagedSelection!({ ...request, command })).rejects.toMatchObject({
          code: 'plugin-authority-conflict',
        });
      }
      f.authority.commitSync(decisionInput('revoke', 'revoke-trust', f.authority.snapshotSync()));
      await expect(host.applyManagedSelection!(decision(f, 'enable'))).rejects.toMatchObject({
        code: 'plugin-authority-activation-required',
      });
      expect(f.readOwned).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it.each([
    'identity',
    'plugin-artifact-conflict',
    'plugin-artifact-not-found',
    'plugin-artifact-corrupt',
    'plugin-artifact-io',
  ] as const)(
    'classifies command artifact read failure %s without reaching commit',
    async (code) => {
      const f = await createRealManagedCompositionFixture();
      try {
        const artifact = await f.seedManaged('notes', 'selected', false);
        const host = f.compose();
        const request = selection(activate(f).request);
        const commit = vi.spyOn(f.authority, 'commitSync');
        const cause =
          code === 'identity' ? undefined : new pluginHost.PluginArtifactError(code, 'private');
        if (cause === undefined)
          f.readOwned.mockResolvedValueOnce({ ...artifact, bytes: artifact.bytes + 1 });
        else f.readOwned.mockRejectedValueOnce(cause);
        const failed = host.applyManagedSelection!(request);
        if (code === 'plugin-artifact-io') await expect(failed).rejects.toBe(cause);
        else await expect(failed).rejects.toMatchObject({ code: 'plugin-artifact-unavailable' });
        expect(commit).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );

  it.each(['withdrawal', 'publication-and-cancellation'] as const)(
    'blocks admission on a saved revoke with closed readback and preserves %s failures in order',
    async (mode) => {
      const f = await createRealManagedCompositionFixture();
      try {
        await f.seedManaged('notes', 'live');
        const host = f.compose();
        await host.coordinator.reload();
        const request = decision(f, 'revoke', 'uncertain-revoke', true);
        const before = f.authority.snapshotSync();
        const primary = new Error('commit acknowledgement failed');
        const proof = new PluginAuthorityError('plugin-authority-closed', 'proof unavailable');
        const publication = new Error('private publication failure');
        const blockFailure = new Error('private backstop failure');
        const commit = f.authority.commitSync;
        const block = host.coordinator.blockManagedAdoptionFailureSync;
        const withdraw = host.localSource!.withdrawExplicitSelectionSync;
        const commitSpy = vi.spyOn(f.authority, 'commitSync').mockImplementationOnce((input) => {
          expect(commit(input).kind).toBe('committed');
          vi.spyOn(f.authority, 'snapshotSync').mockImplementationOnce(() => {
            throw proof;
          });
          throw primary;
        });
        vi.spyOn(host.coordinator, 'blockManagedAdoptionFailureSync').mockImplementationOnce(
          (...args) => {
            block(...args);
            expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(false);
            throw blockFailure;
          },
        );
        const withdrawal = vi.spyOn(host.localSource!, 'withdrawExplicitSelectionSync');
        withdrawal.mockImplementationOnce((...args) => {
          expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(false);
          const cancel = withdraw(...args);
          if (mode === 'withdrawal') {
            cancel();
            throw undefined;
          }
          return () => {
            cancel();
            throw undefined;
          };
        });
        if (mode === 'publication-and-cancellation') {
          vi.spyOn(host.coordinator, 'observeAuthorityBatchSync').mockImplementationOnce(() => {
            expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(false);
            throw publication;
          });
        }
        const revoke = vi.spyOn(host.coordinator, 'retryImmediateRevocation');
        const cause = await host.applyManagedSelection!(request).catch((error: unknown) => error);
        expect(cause).toBeInstanceOf(AggregateError);
        expect(cause).toHaveProperty('name', 'ManagedCommitFailure');
        const aggregate = cause as AggregateError;
        expect(aggregate.cause).toBe(primary);
        expect(aggregate.errors).toStrictEqual([
          primary,
          proof,
          blockFailure,
          ...(mode === 'publication-and-cancellation' ? [publication] : []),
          undefined,
        ]);
        expect(commitSpy).toHaveBeenCalledOnce();
        expect(withdrawal).toHaveBeenCalledOnce();
        expect(revoke).not.toHaveBeenCalled();
        expect(f.authority.snapshotSync().heads.trustSequence).toBe(before.heads.trustSequence + 1);
        expect(host.managed!.cachedAuthoritySync()).toEqual(before);
        expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(false);
      } finally {
        await f.close();
      }
    },
  );

  it('preserves admission and the exact busy exception after matching healthy proof readback', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManaged('notes', 'live');
      const host = f.compose();
      const before = await host.coordinator.reload();
      const request = decision(f, 'revoke');
      const busy = new PluginAuthorityError('plugin-authority-busy', 'rolled back');
      const commit = vi.spyOn(f.authority, 'commitSync').mockImplementationOnce(() => {
        throw busy;
      });
      const proof = vi.spyOn(f.authority, 'snapshotSync');
      const withdraw = vi.spyOn(host.localSource!, 'withdrawExplicitSelectionSync');
      await expect(host.applyManagedSelection!(request)).rejects.toBe(busy);
      expect(commit).toHaveBeenCalledOnce();
      expect(proof).toHaveBeenCalledTimes(2);
      expect(withdraw).not.toHaveBeenCalled();
      expect(observation(host)).toEqual({ generation: before.generation, members: before.members });
    } finally {
      await f.close();
    }
  });

  it('replays a recorded operation after loss while rejecting fresh work and conflicts', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManaged('notes', 'selected');
      const host = f.compose();
      await host.coordinator.reload();
      const request = decision(f, 'enable');
      const saved = await host.applyManagedSelection!(request);
      expect(saved.kind).toBe('committed');
      const loss = new PluginStoreOwnershipError('plugin-store-ownership-lost', 'Lease lost');
      f.loseOwnership(loss);
      const admission = host.coordinator.generationSnapshot();
      expect(admission.acceptingRuns).toBe(false);
      const adoption = vi.spyOn(host.localSource!, 'adoptExplicitSelectionSync');
      const publish = vi.spyOn(f.runtime.serverHost, 'commit');
      const abort = vi.spyOn(f.runtime.serverHost.controller()!, 'abortActiveRuns');
      for (const spy of [f.assertHeldSync, f.readOwned, f.readMcp, f.readAuthoritySync])
        spy.mockClear();
      const currentAuthority = f.authority.snapshotSync();

      await expect(host.applyManagedSelection!(request)).resolves.toEqual({
        kind: 'replayed',
        operation: saved.operation,
        currentAuthority,
        observed: observation(host),
      });
      await expect(
        host.applyManagedSelection!({
          ...request,
          command: { ...request.command, expectedTrustSequence: 999 },
        }),
      ).rejects.toMatchObject({ code: 'plugin-authority-request-conflict' });
      await expect(host.applyManagedSelection!(decision(f, 'disable'))).rejects.toMatchObject({
        code: 'plugin-explicit-authority-failed',
        cause: loss,
      });
      for (const spy of [
        f.assertHeldSync,
        f.readOwned,
        f.readMcp,
        f.readAuthoritySync,
        adoption,
        publish,
        abort,
      ])
        expect(spy).not.toHaveBeenCalled();
      expect(host.coordinator.generationSnapshot()).toEqual(admission);
      expect(f.authority.snapshotSync()).toEqual(currentAuthority);
    } finally {
      await f.close();
    }
  });

  it('uses the new activation sequence when reactivating the same digest and enables disabled selection', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManaged('notes', 'same bytes');
      const host = f.compose();
      const old = await host.coordinator.reload();
      const original = f.authority.snapshotSync().installations[0]!.selection!;
      const result = await host.applyManagedSelection!(
        selection(activate(f, 'notes', 'rollback', 'rollback').request),
      );
      if (result.kind !== 'committed') throw new Error('Expected a committed result');
      const chosen = result.operation.decision.pluginAfter.selection!;
      expect(result.operation.command).toMatchObject({ kind: 'activate', intent: 'rollback' });
      expect(chosen.digest).toBe(original.digest);
      expect(chosen.activationSequence).toBeGreaterThan(original.activationSequence);
      expect(result.application.status).toBe('applied');
      expect(result.observed.generation.id).toBeGreaterThan(old.generation.id);
      expect(result.observed.members).toMatchObject([
        {
          managedIdentity: {
            digest: original.digest,
            activationSequence: chosen.activationSequence,
          },
        },
      ]);
      expect(host.coordinator.snapshot().members.map(({ identity }) => identity)).toEqual([
        JSON.stringify(['notes', original.digest, 'managed', chosen.activationSequence]),
      ]);

      await host.applyManagedSelection!(decision(f, 'disable'));
      expect(host.coordinator.snapshot().members).toEqual([]);
      const enabled = await host.applyManagedSelection!(decision(f, 'enable'));
      if (enabled.kind !== 'committed') throw new Error('Expected enabled decision');
      expect(enabled.application.status).toBe('applied');
      expect(enabled.operation.decision.pluginAfter.selection).toEqual(chosen);
      expect(JSON.stringify(await f.runTool('notes'))).toContain('same bytes');
    } finally {
      await f.close();
    }
  });

  it.each(['disable', 'revoke', 'uninstall'] as const)(
    'passes bytes-free %s preparation while still refreshing unrelated runtime members',
    async (kind) => {
      const f = await createRealManagedCompositionFixture();
      try {
        const target = await f.seedManaged('notes', 'remove');
        const other = await f.seedManaged('other', 'keep');
        const host = f.compose();
        await host.coordinator.reload();
        f.readOwned.mockClear();
        const commit = f.authority.commitSync;
        vi.spyOn(f.authority, 'commitSync').mockImplementationOnce((input) => {
          expect(input.prepared).toEqual({ kind });
          expect(f.readOwned).not.toHaveBeenCalled();
          return commit(input);
        });

        const result = await host.applyManagedSelection!(decision(f, kind));
        expect(result.kind === 'committed' && result.application.status).toBe('applied');
        expect(f.readOwned.mock.calls.map(([digest]) => digest)).toContain(other.digest);
        expect(f.readOwned.mock.calls.map(([digest]) => digest)).not.toContain(target.digest);
        expect(host.coordinator.snapshot().members.map(({ pluginId }) => pluginId)).toEqual([
          'other',
        ]);
      } finally {
        await f.close();
      }
    },
  );

  it('keeps a raw terminal throw of undefined on the saved decision and skips work when replayed', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManaged('notes', 'selected', false);
      const host = f.compose();
      const request = selection(activate(f).request);
      const initial = host.coordinator.generationSnapshot();
      const commit = vi.spyOn(f.runtime.serverHost, 'commit').mockImplementationOnce(() => {
        throw undefined;
      });
      const result = await host.applyManagedSelection!(request);
      if (result.kind !== 'committed')
        throw new Error('Expected durable decision despite publication failure');
      expect(result.application).toEqual({
        status: 'failed',
        failureKind: 'publication',
        cause: undefined,
      });
      expect(Object.hasOwn(result.application, 'cause')).toBe(true);
      expect(result.observed.generation).toEqual(initial);
      expect(f.authority.lookupSync(request).kind).toBe('replayed');
      const adoption = vi.spyOn(host.localSource!, 'adoptExplicitSelectionSync');
      const abort = vi.spyOn(f.runtime.serverHost.controller()!, 'abortActiveRuns');
      for (const spy of [f.assertHeldSync, f.readOwned, f.readMcp, f.readAuthoritySync, commit])
        spy.mockClear();
      await expect(host.applyManagedSelection!(request)).resolves.toEqual({
        kind: 'replayed',
        operation: result.operation,
        currentAuthority: result.savedAuthority,
        observed: observation(host),
      });
      for (const spy of [
        f.assertHeldSync,
        f.readOwned,
        f.readMcp,
        f.readAuthoritySync,
        commit,
        adoption,
        abort,
      ])
        expect(spy).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it.each(['notes', 'other'] as const)(
    'keeps the original %s load cause private and applies any surviving target',
    async (failureId) => {
      const f = await createRealManagedCompositionFixture();
      const loadFailure = new Error(`Private load failure for ${failureId}`);
      const createSource = pluginHost.createLocalPluginSource;
      const inject = vi
        .spyOn(pluginHost, 'createLocalPluginSource')
        .mockImplementationOnce((options) =>
          createSource({
            ...options,
            async importModule(url) {
              if (url.includes(failureDigest)) throw loadFailure;
              return import(url);
            },
          }),
        );
      let failureDigest: string;
      try {
        const target = await f.seedManaged('notes', 'target', false);
        const other = await f.seedManaged('other', 'other');
        failureDigest = failureId === 'notes' ? target.digest : other.digest;
        const host = f.compose();
        const result = await host.applyManagedSelection!(selection(activate(f).request));
        if (result.kind !== 'committed') throw new Error('Expected a committed result');
        const rendered = host.coordinator.snapshot();
        expect(rendered.failed.map(({ pluginId }) => pluginId)).toEqual([failureId]);
        expect(result.observed.generation).toEqual(rendered.generation);
        if (failureId === 'notes') {
          expect(result.application.status).toBe('failed');
          if (result.application.status !== 'failed') throw new Error('Expected failure');
          expect(result.application.failureKind).toBe('preparation');
          expect(result.application.cause).toMatchObject({ cause: loadFailure });
          expect((result.application.cause as Error).cause).toBe(loadFailure);
        } else {
          expect(result.application.status).toBe('applied');
          expect(Object.hasOwn(result.application, 'cause')).toBe(false);
        }
      } finally {
        inject.mockRestore();
        await f.close();
      }
    },
  );

  it('adopts a new MCP claim before runtime readback and omits a cause for the denied target', async () => {
    const f = await createRealManagedCompositionFixture();
    const marker = `${f.root}/denied-imported`;
    try {
      const target = await f.seedManaged('mcp-remote', 'denied', false, marker);
      const host = f.compose();
      const firstRuntimeRefresh = vi.fn(async () => {
        expect(f.authority.snapshotSync().installations[0]!.selection?.digest).toBe(target.digest);
        expect(f.readOwned.mock.calls.map(([digest]) => digest)).toEqual([target.digest]);
        await f.seedMcp('remote', false);
        return f.mcpStore.read();
      });
      f.readMcp.mockImplementationOnce(firstRuntimeRefresh);
      const result = await host.applyManagedSelection!(
        selection(activate(f, 'mcp-remote').request),
      );
      if (result.kind !== 'committed') throw new Error('Expected a committed result');
      expect(firstRuntimeRefresh).toHaveBeenCalledOnce();
      expect(result.application).toEqual({
        status: 'failed',
        failureKind: 'preparation',
      });
      expect(Object.hasOwn(result.application, 'cause')).toBe(false);
      expect(result.observed).toEqual(observation(host));
      expect(f.readOwned.mock.calls.map(([digest]) => digest)).toEqual([target.digest]);
      expect(host.coordinator.snapshot().members).toEqual([]);
      expect(await f.exists(marker)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('preserves the first ticket snapshot and raw refresh failure when a second ticket runs', async () => {
    const f = await createRealManagedCompositionFixture();
    const gate = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first: Promise<ManagedSelectionResult> | undefined;
    let second: typeof first;
    try {
      await f.seedManaged('notes', 'live');
      const host = f.compose();
      const before = await host.coordinator.reload();
      const primary = new Error('Private MCP authority refresh failure');
      f.readMcp.mockImplementationOnce(async () => {
        gate.resolve();
        await release.promise;
        throw primary;
      });
      first = host.applyManagedSelection!(decision(f, 'disable'));
      await Promise.race([
        gate.promise,
        first.then(() => {
          throw new Error('Expected a gated refresh');
        }),
      ]);
      second = host.applyManagedSelection!(decision(f, 'enable'));
      release.resolve();
      const [failed, applied] = await Promise.all([first, second]);
      if (failed.kind !== 'committed' || applied.kind !== 'committed')
        throw new Error('Expected two committed decisions');
      if (failed.application.status !== 'failed') throw new Error('Expected failure');
      expect(failed.application.failureKind).toBe('publication');
      expect(failed.observed.generation).toMatchObject({
        id: before.generation.id,
        acceptingRuns: false,
      });
      expect(failed.application.cause).toBeInstanceOf(pluginHost.ExplicitLocalAuthorityError);
      expect((failed.application.cause as Error).cause).toBe(primary);
      expect(failed.savedAuthority.heads.operationSequence + 1).toBe(
        applied.savedAuthority.heads.operationSequence,
      );
      expect(applied.application).toEqual({ status: 'applied' });
      expect(applied.observed).toEqual(observation(host));
      expect(applied.observed.generation.id).toBeGreaterThan(failed.observed.generation.id);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
      await f.close();
    }
  });

  it('retries immediate cancellation exactly once after committed adoption and withdrawal both throw', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManaged('notes', 'live');
      const host = f.compose();
      const before = await host.coordinator.reload();
      const primary = new Error('Private adoption failure');
      const secondary = new Error('Private withdrawal failure');
      const adoption = vi
        .spyOn(host.localSource!, 'adoptExplicitSelectionSync')
        .mockImplementationOnce(() => {
          throw primary;
        });
      const withdrawal = vi
        .spyOn(host.localSource!, 'withdrawExplicitSelectionSync')
        .mockImplementationOnce(() => {
          throw secondary;
        });
      const retry = vi.spyOn(host.coordinator, 'retryImmediateRevocation');
      const abort = vi.spyOn(f.runtime.serverHost.controller()!, 'abortActiveRuns');
      const request = decision(f, 'disable', 'disable-immediately', true);
      const result = await host.applyManagedSelection!(request);
      if (result.kind !== 'committed')
        throw new Error('Expected durable decision despite adoption failure');
      if (result.application.status !== 'failed') throw new Error('Expected failure');
      expect(result.application.failureKind).toBe('adoption');
      expect(result.observed.generation).toMatchObject({
        id: before.generation.id,
        acceptingRuns: false,
      });
      expect(result.application.cause).toBeInstanceOf(AggregateError);
      expect((result.application.cause as AggregateError).cause).toBe(primary);
      expect((result.application.cause as AggregateError).errors).toEqual([primary, secondary]);
      expect(retry).toHaveBeenCalledExactlyOnceWith('local-esm', 'notes', 'managed');
      expect(abort).toHaveBeenCalledOnce();
      expect(adoption).toHaveBeenCalledOnce();
      expect(withdrawal).toHaveBeenCalledOnce();
      await expect(host.applyManagedSelection!(request)).resolves.toEqual({
        kind: 'replayed',
        operation: result.operation,
        currentAuthority: result.savedAuthority,
        observed: observation(host),
      });
      expect(retry).toHaveBeenCalledOnce();
      expect(abort).toHaveBeenCalledOnce();
      expect(adoption).toHaveBeenCalledOnce();
      expect(withdrawal).toHaveBeenCalledOnce();
      expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(false);
      expect((await host.coordinator.reload()).generation.acceptingRuns).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('preserves both errors when publishing withdrawal fails after committed adoption throws', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManaged('notes', 'live');
      const host = f.compose();
      const before = await host.coordinator.reload();
      const adoption = new Error('Private adoption failure');
      const publication = new Error('Private withdrawal observer failure');
      vi.spyOn(host.localSource!, 'adoptExplicitSelectionSync').mockImplementationOnce(() => {
        throw adoption;
      });
      const observe = vi
        .spyOn(host.coordinator, 'observeAuthorityBatchSync')
        .mockImplementationOnce((changes) => {
          expect(changes.get('local-esm')?.snapshot.eligible).toEqual([]);
          expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(false);
          throw publication;
        });
      const retry = vi.spyOn(host.coordinator, 'retryImmediateRevocation');
      const result = await host.applyManagedSelection!(
        decision(f, 'disable', 'observer-failure', true),
      );

      if (result.kind !== 'committed') throw new Error('Expected a committed disable');
      expect(observe).toHaveBeenCalledOnce();
      expect(result.savedAuthority).toEqual(f.authority.snapshotSync());
      if (result.application.status !== 'failed') throw new Error('Expected failure');
      expect(result.application.failureKind).toBe('adoption');
      expect(result.observed.generation).toMatchObject({
        id: before.generation.id,
        acceptingRuns: false,
      });
      expect(retry).toHaveBeenCalledExactlyOnceWith('local-esm', 'notes', 'managed');
      expect(result.application.cause).toBeInstanceOf(AggregateError);
      const cause = result.application.cause as AggregateError;
      expect(cause.cause).toBe(adoption);
      expect(cause.errors).toHaveLength(2);
      expect(cause.errors[0]).toBe(adoption);
      expect(cause.errors[1]).toBe(publication);
    } finally {
      await f.close();
    }
  });

  it('blocks a displaced manual member when paired withdrawal fails without cancelling it as managed', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManual('notes', 'manual');
      const host = f.compose();
      const before = await host.coordinator.reload();
      expect(before.members).toMatchObject([{ pluginId: 'notes', origin: 'manual' }]);
      await f.seedManaged('notes', 'unselected managed', false);
      const primary = new Error('Private adoption failure');
      const secondary = new Error('Private withdrawal failure');
      vi.spyOn(host.localSource!, 'adoptExplicitSelectionSync').mockImplementationOnce(() => {
        throw primary;
      });
      vi.spyOn(host.localSource!, 'withdrawExplicitSelectionSync').mockImplementationOnce(() => {
        throw secondary;
      });
      const abort = vi.spyOn(f.runtime.serverHost.controller()!, 'abortActiveRuns');
      const retry = vi.spyOn(host.coordinator, 'retryImmediateRevocation');
      const result = await host.applyManagedSelection!(
        decision(f, 'uninstall', 'immediate-manual-comparison', true),
      );
      if (result.kind !== 'committed') throw new Error('Expected a committed uninstall');
      expect(result.application.status).toBe('failed');
      expect(result.observed.generation).toMatchObject({
        id: before.generation.id,
        acceptingRuns: false,
      });
      expect(host.coordinator.snapshot().members).toEqual(before.members);
      expect(retry).toHaveBeenCalledExactlyOnceWith('local-esm', 'notes', 'managed');
      expect(abort).not.toHaveBeenCalled();
      const recovered = await host.coordinator.reload();
      expect(recovered.members).toEqual([]);
      expect(recovered.generation.acceptingRuns).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('retains both a failed override trust read and its failed committed withdrawal', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManaged('notes', 'selected');
      const primary = new Error('Private override trust read failure');
      const secondary = new Error('Private withdrawal failure');
      let failTrustRead = false;
      const host = f.compose({
        readLocalTrustEventsSync() {
          if (failTrustRead) throw primary;
          return f.authority.snapshotSync().trustEvents;
        },
      });
      const before = await host.coordinator.reload();
      failTrustRead = true;
      const withdraw = vi
        .spyOn(host.localSource!, 'withdrawExplicitSelectionSync')
        .mockImplementationOnce(() => {
          throw secondary;
        });

      const result = await host.applyManagedSelection!(decision(f, 'disable'));
      if (result.kind !== 'committed')
        throw new Error('Expected durable decision despite override failure');
      if (result.application.status !== 'failed') throw new Error('Expected failure');
      expect(result.application.failureKind).toBe('adoption');
      expect(result.observed.generation).toMatchObject({
        id: before.generation.id,
        acceptingRuns: false,
      });
      expect(result.application.cause).toBeInstanceOf(AggregateError);
      expect((result.application.cause as AggregateError).cause).toBe(primary);
      expect((result.application.cause as AggregateError).errors).toEqual([primary, secondary]);
      expect(withdraw).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });
});
