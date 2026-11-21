import { rm, writeFile } from 'node:fs/promises';

import { createPluginKernel, type PluginEnv } from '@weave/plugin';
import { afterEach, describe, expect, it } from 'vitest';

import { createLocalPluginSource } from '../src/local-plugin-source.js';
import { removeTempDirectories } from './support/fixtures.js';
import { gate, harness } from './support/host-fixtures.js';

const prepareOptions = () => ({
  signal: new AbortController().signal,
  excluded: new Set<string>(),
});

function sourceOptions(h: Awaited<ReturnType<typeof harness>>) {
  return {
    discovery: h.options.discovery,
    trustStore: h.trustStore,
    importModule: h.options.importModule,
  };
}

afterEach(removeTempDirectories);

describe('local plugin source', () => {
  it('discovers without imports and transfers fresh trusted instances to its caller', async () => {
    const h = await harness(['a']);
    const source = createLocalPluginSource(sourceOptions(h));
    const reviewed = await source.refresh();
    expect(reviewed.plugins[0]?.state).toBe('pending-trust');
    expect((await source.prepare(reviewed.stamp, prepareOptions())).items).toEqual([]);
    expect(h.calls.factories).toEqual([]);
    expect(h.calls.assemblies).toEqual([]);
    const { id, digest } = h.ready[0]!;
    await expect(
      source.mutate({ kind: 'trust', id, digest: '0'.repeat(64) }),
    ).rejects.toMatchObject({
      code: 'plugin-digest-mismatch',
    });
    expect(await h.trustStore.events()).toEqual([]);
    const trusted = await source.mutate({ kind: 'trust', id, digest });
    expect(h.calls.factories).toEqual([]);
    const first = await source.prepare(trusted.stamp, prepareOptions());
    const second = await source.prepare(trusted.stamp, prepareOptions());
    expect(first.items[0]?.plugin).not.toBe(second.items[0]?.plugin);
    expect(h.calls.factories).toEqual(['a', 'a']);
    await source.close();
    expect(h.calls.disposed).toEqual([]);
    await Promise.all([first.dispose(), first.items[0]?.dispose(), second.dispose()]);
    expect(h.calls.disposed).toEqual(['a', 'a']);
  });

  it('keeps a stable stamp for unchanged scans and rejects a rolled-back or rewritten log', async () => {
    const h = await harness(['a'], true);
    const events = await h.trustStore.events();
    const source = createLocalPluginSource(sourceOptions(h));
    const first = await source.refresh();
    expect((await source.refresh()).stamp).toEqual(first.stamp);
    expect(Object.isFrozen(first.stamp)).toBe(true);
    expect(Object.isFrozen(first.trust)).toBe(true);
    expect(Object.isFrozen(first.plugins)).toBe(true);
    expect(Object.isFrozen(first.discovery.candidates)).toBe(true);
    expect(Object.isFrozen(first.trust[0])).toBe(true);
    expect(Object.isFrozen(first.discovery.candidates[0]?.manifest)).toBe(true);
    const prepared = await source.prepare(first.stamp, prepareOptions());
    expect(await source.recheck(prepared, prepareOptions().signal)).toMatchObject({ valid: true });
    await writeFile(h.ready[0]!.entry, 'changed');
    const rechecked = await source.recheck(prepared, prepareOptions().signal);
    expect(rechecked.valid).toBe(false);
    expect(rechecked.snapshot.stamp.revision).toBeGreaterThan(first.stamp.revision);
    h.trustStore.events = async () => [];
    await expect(source.refresh()).rejects.toMatchObject({ code: 'plugin-reload-failed' });
    h.trustStore.events = async () => events.map((event) => ({ ...event, occurredAt: 'changed' }));
    await expect(source.refresh()).rejects.toMatchObject({ code: 'plugin-reload-failed' });
    expect(source.snapshot()).toBe(rechecked.snapshot);
    await prepared.dispose();
    await source.close();
  });

  it('notifies after durable fold before a subsequent discovery failure', async () => {
    const h = await harness(['a'], true);
    const pending = gate();
    const appending = gate();
    const original = h.trustStore.append;
    h.trustStore.append = async (event) => {
      appending.resolve();
      await pending.promise;
      return original(event);
    };
    const revoked: unknown[] = [];
    const source = createLocalPluginSource({
      ...sourceOptions(h),
      onAuthorityChange(change) {
        if (change.reason === 'revoked') {
          expect(source.snapshot()).toBe(change.snapshot);
          revoked.push(change);
        }
      },
    });
    await source.refresh();
    const revoke = source.mutate({ kind: 'revoke', id: 'a', immediate: true });
    await appending.promise;
    expect(revoked).toEqual([]);
    await rm(h.directory, { recursive: true });
    await writeFile(h.directory, 'not a directory');
    pending.resolve();
    await expect(revoke).rejects.toMatchObject({ code: 'plugin-unreadable' });
    expect(revoked).toMatchObject([
      {
        snapshot: { trust: [], stamp: { trustSequence: 2 } },
        affectedIds: ['a'],
        immediate: true,
      },
    ]);
    await rm(h.directory);
    await source.close();
  });

  it('reports an externally observed revoke before discovery and skips notifications for a failed append', async () => {
    const h = await harness(['a'], true);
    const changes: unknown[] = [];
    const source = createLocalPluginSource({
      ...sourceOptions(h),
      onAuthorityChange: (change) => changes.push(change),
    });
    const first = await source.refresh();
    changes.length = 0;
    const append = h.trustStore.append;
    h.trustStore.append = async () => {
      throw new Error('append failed');
    };
    await expect(source.mutate({ kind: 'revoke', id: 'a', immediate: true })).rejects.toThrow(
      'append failed',
    );
    expect(source.snapshot()).toBe(first);
    expect(changes).toEqual([]);
    await append({ kind: 'revoked', pluginId: 'a' });
    await rm(h.directory, { recursive: true });
    await writeFile(h.directory, 'not a directory');
    await expect(source.refresh()).rejects.toMatchObject({ code: 'plugin-unreadable' });
    expect(changes).toMatchObject([
      { reason: 'trust-log', affectedIds: ['a'], snapshot: { trust: [] } },
    ]);
    await rm(h.directory);
    await source.close();
  });

  it('releases a factory instance arriving after cancellation exactly once', async () => {
    const h = await harness(['a'], true);
    const entered = gate();
    const release = gate();
    h.factories.set('a', async () => {
      entered.resolve();
      await release.promise;
      return {
        setup() {},
        dispose: () => {
          h.calls.disposed.push('a');
        },
      };
    });
    const source = createLocalPluginSource(sourceOptions(h));
    const snapshot = await source.refresh();
    const abort = new AbortController();
    const prepare = source.prepare(snapshot.stamp, { ...prepareOptions(), signal: abort.signal });
    const rejected = expect(prepare).rejects.toThrow('cancel attempt');
    await entered.promise;
    abort.abort(new Error('cancel attempt'));
    release.resolve();
    await rejected;
    expect(h.calls.disposed).toEqual(['a']);
    await source.close();
    expect(h.calls.disposed).toEqual(['a']);
  });

  it('rechecks authority even when every local item was excluded', async () => {
    const h = await harness(['a'], true);
    const source = createLocalPluginSource(sourceOptions(h));
    const { id, digest } = h.ready[0]!;
    const before = await source.refresh();
    const { signal } = prepareOptions();
    const excluded = new Set([JSON.stringify([id, digest])]);
    const prepared = await source.prepare(before.stamp, { signal, excluded });
    expect(prepared.items).toEqual([]);
    expect(h.calls.factories).toEqual([]);
    await h.trustStore.append({ kind: 'revoked', pluginId: id });
    await expect(source.recheck(prepared, signal)).resolves.toMatchObject({
      valid: false,
      snapshot: { stamp: { trustSequence: 2 }, plugins: [{ state: 'pending-trust' }] },
    });
    await source.close();
  });

  it('advances the log high-water mark without changing authority revision for a no-op', async () => {
    const h = await harness(['a'], true);
    const changes: unknown[] = [];
    const source = createLocalPluginSource({
      ...sourceOptions(h),
      onAuthorityChange: (change) => changes.push(change),
    });
    const initial = await source.refresh();
    changes.length = 0;
    await h.trustStore.append({ kind: 'enabled', pluginId: 'a' });
    const latest = await source.refresh();
    expect(latest.stamp).toEqual({ revision: initial.stamp.revision, trustSequence: 2 });
    expect(changes).toEqual([]);
    const events = await h.trustStore.events();
    h.trustStore.events = async () => events.slice(0, 1);
    await expect(source.refresh()).rejects.toMatchObject({ code: 'plugin-reload-failed' });
    expect(source.snapshot()).toBe(latest);
    await source.close();
  });

  it('folds an append before waiting for another read to fill a log gap', async () => {
    const h = await harness(['a'], true);
    const rereading = gate();
    const release = gate();
    const observed = gate();
    const source = createLocalPluginSource({
      ...sourceOptions(h),
      onAuthorityChange: (change) => {
        if (change.reason === 'revoked') observed.resolve();
      },
    });
    await source.refresh();
    const events = h.trustStore.events;
    const append = h.trustStore.append;
    let reads = 0;
    h.trustStore.events = async () => {
      if (++reads === 2) {
        rereading.resolve();
        await release.promise;
      }
      return events();
    };
    h.trustStore.append = async (event) => {
      await append({ kind: 'enabled', pluginId: 'a' });
      return append(event);
    };
    const revoking = source.mutate({ kind: 'revoke', id: 'a', immediate: true });
    await rereading.promise;
    expect(source.snapshot()).toMatchObject({ trust: [], stamp: { trustSequence: 3 } });
    await observed.promise;
    release.resolve();
    await expect(revoking).resolves.toMatchObject({ stamp: { trustSequence: 3 } });
    await source.close();
  });

  it('cancels pending setup without waiting for its deadline and captures a late disposer error', async () => {
    const h = await harness(['a'], true);
    const entered = gate<PluginEnv>();
    const cleanupError = new Error('cleanup failed');
    h.factories.set('a', () => ({
      setup(env) {
        entered.resolve(env);
        return new Promise(() => {});
      },
      dispose() {
        h.calls.disposed.push('a');
        throw cleanupError;
      },
    }));
    const source = createLocalPluginSource(sourceOptions(h));
    const { stamp } = await source.refresh();
    const attempt = new AbortController();
    const prepared = await source.prepare(stamp, { signal: attempt.signal, excluded: new Set() });
    const item = prepared.items[0]!;
    expect(item.cleanupErrors).toEqual([]);
    const kernel = createPluginKernel();
    const registering = kernel.register(item.plugin);
    const rejected = expect(registering).rejects.toMatchObject({ code: 'plugin-setup-failed' });
    const env = await entered.promise;
    attempt.abort(new Error('cancel assembly'));
    expect(env.signal.aborted).toBe(true);
    await rejected;
    await Promise.all([kernel.dispose(), prepared.dispose()]);
    expect(item.cleanupErrors).toEqual([cleanupError]);
    expect(h.calls.disposed).toEqual(['a']);
    await source.close();
  });
});
