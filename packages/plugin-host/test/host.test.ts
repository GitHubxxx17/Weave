import { rm } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import * as api from '../src/index.js';
import { createPluginHost } from '../src/index.js';
import { removeTempDirectories, writeFileIn, writePlugin } from './support/fixtures.js';
import { harness } from './support/host-fixtures.js';

afterEach(removeTempDirectories);

describe('PluginHost discovery and trust', () => {
  it('exports a host that retains the exact baseline runner without executing untrusted code', async () => {
    expect(api.createPluginHost).toBeTypeOf('function');
    const h = await harness(['pending']);
    const host = await createPluginHost(h.options);
    expect(host.runner).toBe(h.controller.runner);
    expect(host.snapshot()).toMatchObject({
      exists: true,
      trustSequence: 0,
      generation: { id: 1, plugins: [], acceptingRuns: true },
    });
    expect(host.list().map((plugin) => [plugin.id, plugin.state])).toEqual([
      ['pending', 'pending-trust'],
    ]);
    expect(h.calls.factories).toEqual([]);
    expect(h.calls.assemblies).toEqual([]);
    await host.dispose();
  });

  it('trusts the current exact digest and declaration before publishing a local generation', async () => {
    const h = await harness(['hello']);
    const host = await createPluginHost(h.options);
    const plugin = h.ready[0]!;
    const result = await host.trust(plugin.id, plugin.digest);
    expect(await h.trustStore.events()).toEqual([
      expect.objectContaining({
        kind: 'trusted',
        pluginId: plugin.id,
        digest: plugin.digest,
        manifest: plugin.manifest,
      }),
    ]);
    expect(result).toMatchObject({ generation: 2, unchanged: false, failed: [] });
    expect(host.list()[0]).toMatchObject({
      state: 'loaded',
      active: { generation: 2, digest: plugin.digest },
    });
    expect(await host.runner.run({ sessionId: 's' })[Symbol.asyncIterator]().next()).toEqual({
      done: false,
      value: 'hello',
    });
    expect((await host.reload()).unchanged).toBe(true);
    expect(h.calls.factories).toEqual(['hello']);
    await host.dispose();
  });

  it('refreshes a stale reviewed digest without appending or executing code', async () => {
    const h = await harness(['hello']);
    const host = await createPluginHost(h.options);
    await writeFileIn(
      path.join(h.directory, 'hello'),
      'index.js',
      'export default () => ({setup(){}}); // new',
    );
    await expect(host.trust('hello', h.ready[0]!.digest)).rejects.toMatchObject({
      code: 'plugin-digest-mismatch',
    });
    const candidate = host.list()[0]!.candidate;
    expect(candidate.status).toBe('ready');
    if (candidate.status === 'ready') expect(candidate.digest).not.toBe(h.ready[0]!.digest);
    expect(await h.trustStore.events()).toEqual([]);
    expect(h.calls.factories).toEqual([]);
    await host.dispose();
  });

  it('validates enabled and immediate without coercion and requires trusted, ready, unchanged code', async () => {
    const h = await harness(['hello']);
    const host = await createPluginHost(h.options);
    await expect(host.setEnabled('hello', true)).rejects.toMatchObject({
      code: 'plugin-not-trusted',
    });
    await expect(host.setEnabled('hello', 'false' as unknown as boolean)).rejects.toThrow();
    await expect(
      host.revoke('hello', { immediate: 'false' as unknown as boolean }),
    ).rejects.toThrow();
    await host.trust('hello', h.ready[0]!.digest);
    await host.setEnabled('hello', false);
    await writeFileIn(path.join(h.directory, 'hello'), 'index.js', 'changed');
    await expect(host.setEnabled('hello', true)).rejects.toMatchObject({
      code: 'plugin-digest-mismatch',
    });
    await writeFileIn(path.join(h.directory, 'hello'), 'weave-plugin.json', '{}');
    await expect(host.setEnabled('hello', true)).rejects.toMatchObject({
      code: 'plugin-not-loadable',
    });
    expect((await h.trustStore.events()).map((event) => event.kind)).toEqual([
      'trusted',
      'disabled',
    ]);
    await host.dispose();
  });

  it('can disable and revoke trusted identities whose directory disappeared', async () => {
    const h = await harness(['hello'], true);
    const host = await createPluginHost(h.options);
    await rm(path.join(h.directory, 'hello'), { recursive: true });
    await host.setEnabled('hello', false);
    expect(host.list()).toEqual([]);
    await host.revoke('hello');
    expect((await h.trustStore.events()).map((event) => event.kind)).toEqual([
      'trusted',
      'disabled',
      'revoked',
    ]);
    expect(host.snapshot().generation.plugins).toEqual([]);
    await expect(host.revoke('unknown')).rejects.toMatchObject({ code: 'plugin-not-found' });
    await host.dispose();
  });

  it('returns detached deeply frozen cached snapshots preserving duplicate directory rows', async () => {
    const h = await harness(['hello'], true);
    const host = await createPluginHost(h.options);
    const before = host.snapshot();
    expect(Object.isFrozen(before.plugins[0]!.candidate)).toBe(true);
    expect(Object.isFrozen(before.generation.plugins[0]!.manifest.capabilities)).toBe(true);
    expect(host.snapshot()).not.toBe(before);
    await writePlugin(h.directory, 'second', { manifest: { id: 'hello' } });
    expect(host.list()).toHaveLength(1);
    await host.reload();
    expect(
      host.list().map((row) => [row.id, path.basename(row.candidate.directory), row.state]),
    ).toEqual([
      ['hello', 'hello', 'invalid'],
      ['hello', 'second', 'invalid'],
    ]);
    expect(before.plugins[0]!.state).toBe('loaded');
    await host.dispose();
  });

  it('validates configuration before touching a missing directory or invoking the port', async () => {
    const h = await harness();
    for (const setupTimeoutMs of [0, -1, Infinity, NaN]) {
      await expect(createPluginHost({ ...h.options, setupTimeoutMs })).rejects.toThrow();
    }
    await expect(
      createPluginHost({ ...h.options, discovery: { directory: 3 as unknown as string } }),
    ).rejects.toThrow();
    expect(h.calls.blocks).toEqual([]);
    await h.controller.dispose();
  });
});
