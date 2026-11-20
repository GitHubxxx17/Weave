import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createPluginHost } from '../src/index.js';
import { removeTempDirectories, writeFileIn } from './support/fixtures.js';
import { gate, harness, until } from './support/host-fixtures.js';

afterEach(removeTempDirectories);

describe('PluginHost durable trust changes', () => {
  it('does not block admission or cancel active runs when append rejects', async () => {
    const h = await harness(['a'], true);
    const host = await createPluginHost(h.options);
    const before = host.snapshot();
    const failure = new Error('disk full');
    h.trustStore.append = () => Promise.reject(failure);
    await expect(host.revoke('a', { immediate: true })).rejects.toBe(failure);
    expect(h.calls.blocks).toEqual([]);
    expect(h.calls.aborts).toEqual([]);
    expect(host.snapshot()).toEqual(before);
    await host.dispose();
  });

  it('blocks and cancels only after durable append, before a failed replacement starts', async () => {
    const h = await harness(['a'], true);
    const appendStarted = gate();
    const appendRelease = gate();
    const rebuildStarted = gate();
    const rebuildRelease = gate();
    const append = h.trustStore.append;
    h.trustStore.append = async (event) => {
      appendStarted.resolve();
      await appendRelease.promise;
      return append(event);
    };
    let rebuilding = false;
    const assemble = h.options.assemble;
    const host = await createPluginHost({
      ...h.options,
      assemble: async (plugins) => {
        if (!rebuilding) return assemble(plugins);
        expect(h.calls.blocks.at(-1)).toMatchObject({ code: 'plugin-generation-blocked' });
        expect(h.calls.aborts).toHaveLength(1);
        expect(host.snapshot()).toMatchObject({
          trustSequence: 2,
          plugins: [{ state: 'pending-trust' }],
          generation: { acceptingRuns: false },
        });
        rebuildStarted.resolve();
        await rebuildRelease.promise;
        throw new Error('cannot replace');
      },
    });
    const original = host.snapshot();
    rebuilding = true;
    const revoking = host.revoke('a', { immediate: true });
    await appendStarted.promise;
    expect(h.calls.blocks).toEqual([]);
    expect(h.calls.aborts).toEqual([]);
    appendRelease.resolve();
    await rebuildStarted.promise;
    rebuildRelease.resolve();
    const result = await revoking;
    expect(result).toMatchObject({
      unchanged: false,
      error: { code: 'plugin-reload-failed' },
      snapshot: {
        trustSequence: 2,
        generation: { id: original.generation.id, acceptingRuns: false },
        plugins: [{ state: 'pending-trust', active: { digest: h.ready[0]!.digest } }],
      },
    });
    await expect(
      host.runner.run({ sessionId: 'new' })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ code: 'plugin-generation-blocked' });
    await host.dispose();
  });

  it('folds externally appended revocation, retains the block on failure, and publishes recovery', async () => {
    const h = await harness(['a'], true);
    let fail = false;
    const assemble = h.options.assemble;
    const host = await createPluginHost({
      ...h.options,
      assemble: (plugins) =>
        fail ? Promise.reject(new Error('rebuild unavailable')) : assemble(plugins),
    });
    await h.trustStore.append({ kind: 'revoked', pluginId: 'a' });
    fail = true;
    const result = await host.reload();
    expect(result.snapshot).toMatchObject({
      plugins: [{ state: 'pending-trust', active: { generation: 2 } }],
      generation: { acceptingRuns: false },
    });
    expect(h.calls.blocks).toHaveLength(1);
    expect(h.calls.aborts).toHaveLength(0);
    fail = false;
    const recovered = await host.reload();
    expect(recovered.snapshot.generation).toMatchObject({ acceptingRuns: true, plugins: [] });
    expect(recovered.unchanged).toBe(false);
    expect((await host.reload()).unchanged).toBe(true);
    await host.dispose();
  });

  it('requires one unique ready candidate when enabling the same trusted digest', async () => {
    const h = await harness(['a'], true);
    const host = await createPluginHost(h.options);
    await host.setEnabled('a', false);
    await host.setEnabled('a', true);
    expect((await h.trustStore.events()).map((event) => event.kind)).toEqual([
      'trusted',
      'disabled',
      'enabled',
    ]);
    await host.setEnabled('a', true);
    expect((await h.trustStore.events()).map((event) => event.kind)).toEqual([
      'trusted',
      'disabled',
      'enabled',
    ]);
    await host.dispose();
  });

  it('keeps a completed result detached from later durable decisions and retries errors', async () => {
    const h = await harness(['a']);
    const host = await createPluginHost(h.options);
    const trusted = await host.trust('a', h.ready[0]!.digest);
    await host.setEnabled('a', false);
    expect(trusted.snapshot).toMatchObject({
      trustSequence: 1,
      plugins: [{ state: 'loaded', trusted: { enabled: true } }],
      generation: { acceptingRuns: true },
    });
    await host.dispose();
  });

  it('does not publish if an already started append completes during close', async () => {
    const h = await harness(['a'], true);
    const appending = gate();
    const release = gate();
    const append = h.trustStore.append;
    h.trustStore.append = async (event) => {
      appending.resolve();
      await release.promise;
      return append(event);
    };
    const host = await createPluginHost(h.options);
    const revoking = host.revoke('a');
    await appending.promise;
    const closing = host.dispose();
    release.resolve();
    await expect(revoking).rejects.toMatchObject({ code: 'plugin-host-disposed' });
    await closing;
    expect((await h.trustStore.events()).at(-1)?.kind).toBe('revoked');
    expect(host.snapshot()).toMatchObject({
      trustSequence: 2,
      generation: { id: 2, acceptingRuns: false },
    });
    expect(h.calls.assemblies).toHaveLength(1);
  });

  it('reads changed disk on a trailing pass rather than returning the active pass snapshot', async () => {
    const h = await harness(['a'], true);
    const assembling = gate();
    const release = gate();
    let hold = false;
    const assemble = h.options.assemble;
    const host = await createPluginHost({
      ...h.options,
      assemble: async (plugins) => {
        if (hold) {
          hold = false;
          assembling.resolve();
          await release.promise;
        }
        return assemble(plugins);
      },
    });
    await h.trustStore.append({ kind: 'disabled', pluginId: 'a' });
    hold = true;
    const active = host.reload();
    await assembling.promise;
    const trailing = host.reload();
    await writeFileIn(path.join(h.directory, 'a'), 'index.js', 'changed while assembling');
    release.resolve();
    const first = await active;
    const last = await trailing;
    expect(first.snapshot.plugins[0]!.state).toBe('disabled');
    expect(last.snapshot.plugins[0]!.state).toBe('changed');
    await host.dispose();
  });

  it('releases the administrative queue after a rejected mutation', async () => {
    const h = await harness();
    const host = await createPluginHost(h.options);
    const invalid = host.revoke('missing');
    const reloaded = host.reload();
    await expect(invalid).rejects.toMatchObject({ code: 'plugin-not-found' });
    await expect(reloaded).resolves.toMatchObject({ unchanged: true });
    await until(() => h.calls.assemblies.length === 0);
    await host.dispose();
  });

  it.each(['revoke', 'disable'] as const)(
    'honors a later immediate %s while the durable decision is already blocked',
    async (operation) => {
      const h = await harness(['a'], true);
      let reject = false;
      const assemble = h.options.assemble;
      const host = await createPluginHost({
        ...h.options,
        assemble: (plugins) =>
          reject ? Promise.reject(new Error('replacement unavailable')) : assemble(plugins),
      });
      reject = true;
      if (operation === 'revoke') await host.revoke('a');
      else await host.setEnabled('a', false);
      const eventCount = (await h.trustStore.events()).length;
      expect(h.calls.aborts).toHaveLength(0);
      if (operation === 'revoke') await host.revoke('a', { immediate: true });
      else await host.setEnabled('a', false, { immediate: true });
      expect(h.calls.aborts).toHaveLength(1);
      expect((await h.trustStore.events()).length).toBe(eventCount);
      await host.dispose();
    },
  );

  it('folds external revocation before an unreadable-root reload can fail', async () => {
    const h = await harness(['a'], true);
    const host = await createPluginHost(h.options);
    await h.trustStore.append({ kind: 'revoked', pluginId: 'a' });
    await rm(h.directory, { recursive: true });
    await writeFile(h.directory, 'not a directory');
    await expect(host.reload()).rejects.toMatchObject({ code: 'plugin-unreadable' });
    expect(host.snapshot()).toMatchObject({
      trustSequence: 2,
      plugins: [{ state: 'pending-trust' }],
      generation: { acceptingRuns: false },
    });
    await host.dispose();
  });

  it.each(['revoke', 'disable'] as const)(
    'records %s and blocks despite an unreadable discovery root',
    async (operation) => {
      const h = await harness(['a'], true);
      const host = await createPluginHost(h.options);
      const previous = host.snapshot();
      await rm(h.directory, { recursive: true });
      await writeFile(h.directory, 'plugins root is now a regular file');
      const result =
        operation === 'revoke'
          ? host.revoke('a', { immediate: true })
          : host.setEnabled('a', false, { immediate: true });
      await expect(result).rejects.toMatchObject({ code: 'plugin-unreadable' });
      expect((await h.trustStore.events()).at(-1)?.kind).toBe(
        operation === 'revoke' ? 'revoked' : 'disabled',
      );
      expect(h.calls.aborts).toHaveLength(1);
      expect(host.snapshot()).toMatchObject({
        directory: h.directory,
        trustSequence: 2,
        generation: { id: previous.generation.id, acceptingRuns: false, plugins: [{ id: 'a' }] },
      });
      expect(host.list()[0]!.state).toBe(operation === 'revoke' ? 'pending-trust' : 'disabled');
      await host.dispose();
    },
  );
});
