import { rm, symlink } from 'node:fs/promises';
import path from 'node:path';

import { PluginError } from '@weave/plugin';
import { afterEach, describe, expect, it } from 'vitest';

import { computeDirectoryDigest, createPluginHost } from '../src/index.js';
import { removeTempDirectories, writeFileIn } from './support/fixtures.js';
import { gate, harness } from './support/host-fixtures.js';

afterEach(removeTempDirectories);

describe('PluginHost reload attempts', () => {
  it('isolates a setup failure and reloads every healthy factory for its survivor retry', async () => {
    const h = await harness(['a', 'b'], true);
    h.factories.set('a', () => ({
      setup() {
        throw new Error('broken A');
      },
      dispose() {
        h.calls.disposed.push('a');
      },
    }));
    const host = await createPluginHost(h.options);
    expect(h.calls.assemblies).toEqual([['a', 'b'], ['b']]);
    expect(h.calls.factories).toEqual(['a', 'b', 'b']);
    expect(h.calls.disposed).toEqual(['a', 'b']);
    expect(host.list().map((row) => [row.id, row.state])).toEqual([
      ['a', 'failed'],
      ['b', 'loaded'],
    ]);
    expect((await host.reload()).unchanged).toBe(false);
    expect(h.calls.factories).toEqual(['a', 'b', 'b', 'a', 'b', 'b']);
    await host.dispose();
  });

  it('isolates real local publication errors and bounds shrinking retries to N+1', async () => {
    const h = await harness(['a', 'b'], true);
    const publish = h.port.publish;
    h.port.publish = async (candidate) => {
      const id = candidate.resources[0];
      if (id) throw new PluginError('plugin-contribution-failed', `bad ${id}`, { pluginId: id });
      await publish(candidate);
    };
    const host = await createPluginHost(h.options);
    expect(h.calls.assemblies).toEqual([['a', 'b'], ['b'], []]);
    expect(host.list().map((row) => row.state)).toEqual(['failed', 'failed']);
    expect(host.snapshot().generation.plugins).toEqual([]);
    expect(h.calls.disposed.sort()).toEqual(['a', 'b', 'b']);
    await host.dispose();
  });

  it.each([
    new Error('host failure'),
    new PluginError('plugin-contribution-failed', 'builtin failed', { pluginId: 'builtin' }),
    { pluginId: 'a', code: 'plugin-contribution-failed', message: 'pretend attribution' },
  ])('retains baseline for unowned or nonlocal failures: %s', async (error) => {
    const h = await harness(['a'], true);
    let failed = true;
    const assemble = h.options.assemble;
    const host = await createPluginHost({
      ...h.options,
      assemble: async (plugins) => {
        if (failed) throw error;
        return assemble(plugins);
      },
    });
    expect(host.snapshot()).toMatchObject({
      generation: { id: 1, acceptingRuns: true },
      plugins: [{ state: 'failed' }],
      error: expect.any(Object),
    });
    expect(h.calls.disposed).toEqual(['a']);
    failed = false;
    const recovered = await host.reload();
    expect(recovered).toMatchObject({
      unchanged: false,
      failed: [],
      snapshot: { plugins: [{ state: 'loaded' }] },
    });
    expect(recovered.error).toBeUndefined();
    await host.dispose();
  });

  it('normalizes a setup deadline through real kernel attribution without awaiting the original setup', async () => {
    const h = await harness(['a', 'b'], true);
    h.factories.set('a', () => ({
      setup: () => new Promise(() => {}),
      dispose() {
        h.calls.disposed.push('a');
      },
    }));
    const host = await createPluginHost({ ...h.options, setupTimeoutMs: 10 });
    expect(host.list()).toMatchObject([
      { state: 'failed', error: { code: 'plugin-setup-timeout' } },
      { state: 'loaded' },
    ]);
    expect(h.calls.assemblies).toEqual([['a', 'b'], ['b']]);
    await host.dispose();
  });

  it('re-discovers the whole root after a load-time digest race and excludes the stale identity', async () => {
    const h = await harness(['a', 'b'], true);
    let changed = false;
    const importer = h.options.importModule!;
    const host = await createPluginHost({
      ...h.options,
      importModule: async (specifier) => {
        if (!changed) {
          changed = true;
          await writeFileIn(path.join(h.directory, 'b'), 'index.js', 'changed b');
        }
        return importer(specifier);
      },
    });
    expect(host.list().map((row) => [row.id, row.state])).toEqual([
      ['a', 'loaded'],
      ['b', 'changed'],
    ]);
    expect(h.calls.factories).toEqual(['a', 'a']);
    expect(h.calls.assemblies).toEqual([['a']]);
    await host.dispose();
  });

  it('bounds continuous disk races by the original eligible count and preserves baseline', async () => {
    const h = await harness(['a', 'b'], true);
    const events = h.trustStore.events;
    let scans = 0;
    let revision = 0;
    const directory = path.join(h.directory, 'b');
    h.trustStore.events = async () => {
      scans += 1;
      if (scans > 1) {
        const { digest } = await computeDirectoryDigest(directory);
        await h.trustStore.append({
          kind: 'trusted',
          pluginId: 'b',
          digest,
          manifest: h.ready[1]!.manifest,
        });
      }
      return events();
    };
    const importer = h.options.importModule!;
    const host = await createPluginHost({
      ...h.options,
      importModule: async (specifier) => {
        // Loading A mutates B after each discovery; refreshed trust admits a new B
        // identity, so the original eligible-count budget must stop the editor race.
        await writeFileIn(directory, 'index.js', `revision ${++revision}`);
        return importer(specifier);
      },
    });
    expect(scans).toBe(3);
    expect(h.calls.factories).toEqual(['a', 'a', 'a']);
    expect(h.calls.assemblies).toEqual([]);
    expect(host.snapshot()).toMatchObject({
      generation: { id: 1, acceptingRuns: true },
      error: { code: 'plugin-reload-failed' },
    });
    await host.dispose();
  });

  it('retains baseline when raced bytes return to the same trusted identity during cleanup', async () => {
    const h = await harness(['a', 'b'], true);
    const original = 'export default () => ({ setup() {} });';
    const directory = path.join(h.directory, 'b');
    await writeFileIn(directory, 'index.js', original);
    const { digest } = await computeDirectoryDigest(directory);
    await h.trustStore.append({
      kind: 'trusted',
      pluginId: 'b',
      digest,
      manifest: h.ready[1]!.manifest,
    });
    let changed = false;
    const importer = h.options.importModule!;
    h.factories.set('a', () => ({
      setup() {},
      dispose: () => writeFileIn(directory, 'index.js', original),
    }));
    const host = await createPluginHost({
      ...h.options,
      importModule: async (specifier) => {
        if (!changed) {
          changed = true;
          await writeFileIn(directory, 'index.js', 'raced');
        }
        return importer(specifier);
      },
    });
    expect(host.snapshot()).toMatchObject({
      generation: { id: 1 },
      error: { code: 'plugin-reload-failed' },
    });
    expect(h.calls.assemblies).toEqual([]);
    const recovered = await host.reload();
    expect(recovered.unchanged).toBe(false);
    expect(host.list().map((row) => row.state)).toEqual(['loaded', 'loaded']);
    await host.dispose();
  });

  it('keys failures by digest so a newly trusted version does not inherit an earlier load failure', async () => {
    const h = await harness(['a', 'b', 'c'], true);
    const importer = h.options.importModule!;
    const events = h.trustStore.events;
    let scans = 0;
    let aLoads = 0;
    let changed = false;
    h.trustStore.events = async () => {
      scans += 1;
      if (scans === 2) {
        const directory = path.join(h.directory, 'a');
        const { digest } = await computeDirectoryDigest(directory);
        await h.trustStore.append({
          kind: 'trusted',
          pluginId: 'a',
          digest,
          manifest: h.ready[0]!.manifest,
        });
      }
      return events();
    };
    const host = await createPluginHost({
      ...h.options,
      importModule: async (specifier) => {
        if (specifier.includes('/a/index.js')) {
          aLoads += 1;
          if (aLoads === 1) throw new Error('first a version fails');
        }
        if (!changed && specifier.includes('/b/index.js')) {
          changed = true;
          await writeFileIn(path.join(h.directory, 'a'), 'index.js', 'new version of a');
          await writeFileIn(path.join(h.directory, 'c'), 'index.js', 'new version of c');
        }
        return importer(specifier);
      },
    });
    expect(scans).toBe(2);
    expect(aLoads).toBe(2);
    expect(host.list().map((row) => [row.id, row.state])).toEqual([
      ['a', 'loaded'],
      ['b', 'loaded'],
      ['c', 'changed'],
    ]);
    expect(host.snapshot().plugins[0]!.error).toBeUndefined();
    await host.dispose();
  });

  it.each(['missing', 'invalid'] as const)(
    'refreshes %s state when a ready directory becomes unusable before loading',
    async (change) => {
      const h = await harness(['a', 'b'], true);
      let changed = false;
      const importer = h.options.importModule!;
      const host = await createPluginHost({
        ...h.options,
        importModule: async (specifier) => {
          if (!changed) {
            changed = true;
            const directory = path.join(h.directory, 'b');
            if (change === 'missing') await rm(directory, { recursive: true });
            else await symlink('index.js', path.join(directory, 'linked.js'));
          }
          return importer(specifier);
        },
      });
      expect(host.list().map((row) => [row.id, row.state])).toEqual(
        change === 'missing'
          ? [['a', 'loaded']]
          : [
              ['a', 'loaded'],
              ['b', 'invalid'],
            ],
      );
      expect(h.calls.assemblies).toEqual([['a']]);
      await host.dispose();
    },
  );

  it('reports changed or missing disk state separately from retained active metadata', async () => {
    const h = await harness(['a'], true);
    let reject = false;
    const assemble = h.options.assemble;
    const host = await createPluginHost({
      ...h.options,
      assemble: (plugins) =>
        reject ? Promise.reject(new Error('cannot rebuild')) : assemble(plugins),
    });
    reject = true;
    await writeFileIn(path.join(h.directory, 'a'), 'index.js', 'changed');
    const result = await host.reload();
    expect(result.unchanged).toBe(false);
    expect(host.list()[0]).toMatchObject({
      state: 'changed',
      active: { digest: h.ready[0]!.digest },
    });
    await rm(path.join(h.directory, 'a'), { recursive: true });
    await host.reload();
    expect(host.list()).toEqual([]);
    expect(host.snapshot().generation.plugins).toMatchObject([
      { id: 'a', digest: h.ready[0]!.digest },
    ]);
    await host.dispose();
  });

  it('aggregates abandoned module and publication-port cleanup errors only at final disposal', async () => {
    const h = await harness(['a'], true);
    const cleanup = new Error('module cleanup');
    const portError = new Error('port cleanup');
    h.factories.set('a', () => ({
      setup() {
        throw new Error('primary setup failure');
      },
      dispose() {
        throw cleanup;
      },
    }));
    const dispose = h.port.dispose;
    h.port.dispose = async () => {
      await dispose();
      throw portError;
    };
    const host = await createPluginHost(h.options);
    expect(host.list()[0]).toMatchObject({
      state: 'failed',
      error: { code: 'plugin-setup-failed' },
    });
    await expect(host.dispose()).rejects.toMatchObject({
      errors: expect.arrayContaining([cleanup, portError]),
    });
  });
});

describe('PluginHost administrative queue', () => {
  it('coalesces adjacent queued reloads into one trailing pass and keeps mutation barriers', async () => {
    const h = await harness(['a'], true);
    const assembling = gate();
    const release = gate();
    let gated = false;
    let scans = 0;
    const events = h.trustStore.events;
    h.trustStore.events = async () => {
      scans += 1;
      return events();
    };
    const assemble = h.options.assemble;
    const host = await createPluginHost({
      ...h.options,
      assemble: async (plugins) => {
        if (gated) {
          gated = false;
          assembling.resolve();
          await release.promise;
        }
        return assemble(plugins);
      },
    });
    await writeFileIn(path.join(h.directory, 'a'), 'index.js', 'changed');
    gated = true;
    const active = host.reload();
    await assembling.promise;
    const before = scans;
    const trailing1 = host.reload();
    const trailing2 = host.reload();
    expect(trailing1).toBe(trailing2);
    const mutation = host.revoke('a');
    const afterBarrier = host.reload();
    release.resolve();
    await Promise.all([active, trailing1, trailing2, mutation, afterBarrier]);
    expect(scans - before).toBe(3);
    expect((await events()).at(-1)?.kind).toBe('revoked');
    await host.dispose();
  });

  it('uses the actual generation pointer while successful publish is waiting for old retirement', async () => {
    const h = await harness(['a']);
    const retiring = gate();
    const release = gate();
    const publish = h.port.publish;
    h.port.publish = async (candidate) => {
      await publish(candidate);
      retiring.resolve();
      await release.promise;
    };
    const host = await createPluginHost(h.options);
    const trusting = host.trust('a', h.ready[0]!.digest);
    await retiring.promise;
    expect(host.snapshot()).toMatchObject({
      generation: { id: 2, plugins: [{ id: 'a' }] },
      plugins: [{ active: { generation: 2 } }],
    });
    release.resolve();
    await trusting;
    await host.dispose();
  });

  it('reports reopened admission at the committed pointer during slow recovery retirement', async () => {
    const h = await harness(['a'], true);
    const host = await createPluginHost(h.options);
    const committed = gate();
    const release = gate();
    const publish = h.port.publish;
    h.port.publish = async (candidate) => {
      await publish(candidate);
      committed.resolve();
      await release.promise;
    };
    const disabling = host.setEnabled('a', false);
    await committed.promise;
    expect(host.snapshot().generation).toMatchObject({ id: 3, acceptingRuns: true });
    expect(host.snapshot().generation.blocked).toBeUndefined();
    release.resolve();
    await disabling;
    await host.dispose();
  });

  it('retains the current active metadata when an assembler returns a nonmonotonic candidate id', async () => {
    const h = await harness(['a'], true);
    const assemble = h.options.assemble;
    let reuse = false;
    const host = await createPluginHost({
      ...h.options,
      assemble: async (plugins) => {
        const candidate = await assemble(plugins);
        return reuse ? { ...candidate, id: h.port.current().id } : candidate;
      },
    });
    reuse = true;
    const result = await host.setEnabled('a', false);
    expect(result.snapshot.generation).toMatchObject({
      id: 2,
      plugins: [{ id: 'a' }],
      acceptingRuns: false,
    });
    expect(result.snapshot.plugins[0]!.active).toMatchObject({
      generation: 2,
      digest: h.ready[0]!.digest,
    });
    await host.dispose();
  });

  it('closes synchronously, rejects queued calls, and disposes a candidate completing after close', async () => {
    const h = await harness(['a']);
    const assembling = gate();
    const release = gate();
    const assemble = h.options.assemble;
    const host = await createPluginHost({
      ...h.options,
      assemble: async (plugins) => {
        assembling.resolve();
        await release.promise;
        return assemble(plugins);
      },
    });
    const active = host.trust('a', h.ready[0]!.digest);
    await assembling.promise;
    const queued = host.reload();
    const queuedRejected = expect(queued).rejects.toMatchObject({ code: 'plugin-host-disposed' });
    const closing = host.dispose();
    expect(host.snapshot().generation.acceptingRuns).toBe(false);
    await expect(host.reload()).rejects.toMatchObject({ code: 'plugin-host-disposed' });
    release.resolve();
    await expect(active).rejects.toMatchObject({ code: 'plugin-host-disposed' });
    await queuedRejected;
    await closing;
    expect(h.port.current().id).toBe(1);
    expect(h.calls.disposed).toEqual(['a']);
  });

  it('rejects malformed trust-store events instead of using external unchecked facts', async () => {
    const h = await harness();
    const host = await createPluginHost(h.options);
    h.trustStore.events = async () => [{ kind: 'revoked', pluginId: 42 } as never];
    await expect(host.reload()).rejects.toThrow();
    await host.dispose();
  });
});
