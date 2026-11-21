import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  commandsExtensionPoint,
  createPluginKernel,
  createPluginSdk,
  PluginError,
  type PluginCommand,
} from '@weave/plugin';
import { afterEach, expect, it, vi } from 'vitest';

import { createPluginArtifactStore } from '../src/artifact-store.js';
import type { ReadyLocalPlugin } from '../src/discovery.js';
import { ExplicitLocalAuthorityError } from '../src/errors.js';
import { loadLocalPlugin } from '../src/loader.js';
import { createPluginLifecycle } from '../src/plugin-lifecycle.js';
import { makeTempDirectory, removeTempDirectories, writePlugin } from './support/fixtures.js';

afterEach(removeTempDirectories);
afterEach(() => vi.useRealTimers());

const authorityFailure = {
  code: 'plugin-explicit-authority-failed',
  message: 'Explicit local plugin authority check failed',
};

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(source?: string) {
  const root = await makeTempDirectory();
  const marker = path.join(root, 'phases');
  await writeFile(marker, '');
  const sourceDirectory = await writePlugin(root, 'explicit', {
    entry: 'index.mjs',
    source:
      source ??
      `import { appendFileSync } from 'node:fs';
       const mark = (phase) => appendFileSync(${JSON.stringify(marker)}, phase + '\\n');
       mark('evaluate');
       export default (sdk) => {
         mark('factory');
         return {
           setup(env) {
             mark('setup');
             env.contribute(sdk.commandsExtensionPoint, (api) => {
               api.addCommand({ name: 'hello', title: 'Hello', prompt: 'Hi' });
             });
           },
         };
       };`,
  });
  const store = createPluginArtifactStore({ directory: path.join(root, '.weave-store') });
  const artifact = await store.stage({ sourceDirectory });
  const candidate: ReadyLocalPlugin = {
    status: 'ready',
    id: artifact.descriptor.manifest.id,
    manifest: artifact.descriptor.manifest,
    directory: artifact.directory,
    entry: artifact.entry,
    digest: artifact.digest,
  };
  const attempt = new AbortController();
  const verifiedSignals: AbortSignal[] = [];
  const options = {
    trustedDigest: artifact.digest,
    signal: attempt.signal,
    explicitChecks: {
      async verify(signal: AbortSignal) {
        verifiedSignals.push(signal);
        const { entry, digest } = await store.read(artifact.digest, { signal });
        return { entry, digest };
      },
      assertReadySync: () => undefined,
    },
  };
  const phases = async () => (await readFile(marker, 'utf8')).trim().split('\n').filter(Boolean);
  return { candidate, options, attempt, verifiedSignals, phases, marker };
}

it('uses bounded artifact verification and registers a real ESM plugin with the kernel', async () => {
  const { candidate, options, verifiedSignals, phases } = await fixture();
  const limits = { maxFiles: 1 };
  await expect(
    loadLocalPlugin(candidate, { trustedDigest: candidate.digest, limits }),
  ).rejects.toMatchObject({ code: 'plugin-too-large', pluginId: 'explicit' });
  expect(await phases()).toEqual([]);

  const loaded = await loadLocalPlugin(candidate, { ...options, limits });
  expect(verifiedSignals).toEqual([options.signal]);
  expect(await phases()).toEqual(['evaluate', 'factory']);
  const lifecycle = createPluginLifecycle(loaded, 1_000, options.signal, {
    drainSetupOnDispose: true,
  });
  const kernel = createPluginKernel();
  await kernel.register(lifecycle.plugin);
  await kernel.seal();
  const commands: PluginCommand[] = [];
  kernel.extensions.collect(commandsExtensionPoint, {
    addCommand: (command) => commands.push(command),
  });
  expect(commands).toEqual([{ name: 'hello', title: 'Hello', prompt: 'Hi' }]);
  expect(await phases()).toEqual(['evaluate', 'factory', 'setup']);
  await kernel.dispose();
});

it('requires the attempt signal before verifying or evaluating explicit bytes', async () => {
  const { candidate, options, verifiedSignals, phases } = await fixture();
  await expect(loadLocalPlugin(candidate, { ...options, signal: undefined })).rejects.toThrow();
  expect(verifiedSignals).toEqual([]);
  expect(await phases()).toEqual([]);
});

it.each([
  { label: 'relative entry', overrides: { entry: 'index.mjs' }, candidateEntry: 'index.mjs' },
  { label: 'different absolute entry', overrides: { entry: path.resolve('alternate.mjs') } },
  {
    label: 'noncanonical digest',
    overrides: { digest: 'A'.repeat(64) },
    trustedDigest: 'A'.repeat(64),
  },
  {
    label: 'malformed digest',
    overrides: { digest: 'a'.repeat(63) },
    trustedDigest: 'a'.repeat(63),
  },
  { label: 'different digest', overrides: { digest: '0'.repeat(64) } },
  { label: 'extra field', overrides: { extra: true } },
])(
  'rejects a verified result with $label before evaluation',
  async ({ overrides, candidateEntry, trustedDigest }) => {
    const { candidate, options, phases } = await fixture();
    await expect(
      loadLocalPlugin(
        { ...candidate, entry: candidateEntry ?? candidate.entry },
        {
          ...options,
          trustedDigest: trustedDigest ?? options.trustedDigest,
          explicitChecks: {
            ...options.explicitChecks,
            async verify(signal) {
              return { ...(await options.explicitChecks.verify(signal)), ...overrides };
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'plugin-digest-mismatch', pluginId: 'explicit' });
    expect(await phases()).toEqual([]);
  },
);

it('propagates the authority marker reported by the verifier after cancellation', async () => {
  const { candidate, options, attempt, phases } = await fixture();
  const marker = new ExplicitLocalAuthorityError(new Error('private verification details'));
  await expect(
    loadLocalPlugin(candidate, {
      ...options,
      explicitChecks: {
        ...options.explicitChecks,
        async verify(signal) {
          await options.explicitChecks.verify(signal);
          attempt.abort(new Error('attempt cancelled'));
          throw marker;
        },
      },
    }),
  ).rejects.toBe(marker);
  expect(await phases()).toEqual([]);
});

it('surfaces authority loss before import as a marker without plugin attribution', async () => {
  const { candidate, options, phases } = await fixture();
  const cause = new Error('private authority details');
  const load = loadLocalPlugin(candidate, {
    ...options,
    explicitChecks: {
      ...options.explicitChecks,
      assertReadySync() {
        throw cause;
      },
    },
  });
  await expect(load).rejects.toBeInstanceOf(ExplicitLocalAuthorityError);
  await expect(load).rejects.toMatchObject({ ...authorityFailure, cause });
  await expect(load).rejects.not.toHaveProperty('pluginId');
  expect(await phases()).toEqual([]);
});

it('rechecks authority after deferred import and before invoking the factory', async () => {
  const { candidate, options, phases } = await fixture();
  const imported = gate();
  const release = gate();
  let ready = true;
  const load = loadLocalPlugin(candidate, {
    ...options,
    async importModule(specifier) {
      const namespace: unknown = await import(specifier);
      imported.resolve();
      await release.promise;
      return namespace;
    },
    explicitChecks: {
      ...options.explicitChecks,
      assertReadySync() {
        if (!ready) throw new Error('lost during import');
        return undefined;
      },
    },
  });
  await Promise.race([imported.promise, load]);
  ready = false;
  release.resolve();
  await expect(load).rejects.toMatchObject(authorityFailure);
  expect(await phases()).toEqual(['evaluate']);
});

it('blocks the factory if resolving the supplied SDK cancels the attempt', async () => {
  const { candidate, options, attempt, verifiedSignals, marker, phases } = await fixture();
  const sdk = createPluginSdk();
  const cancelled = new Error('SDK resolution cancelled the attempt');
  const outcome: unknown = await loadLocalPlugin(candidate, {
    ...options,
    get sdk() {
      appendFileSync(marker, 'sdk\n');
      attempt.abort(cancelled);
      return sdk;
    },
  }).catch((error: unknown) => error);

  expect(verifiedSignals).toEqual([options.signal]);
  expect(await phases()).toEqual(['evaluate', 'sdk']);
  expect(outcome).toBe(cancelled);
});

it('attributes a supplied SDK getter failure to the plugin factory stage', async () => {
  const { candidate, options, phases } = await fixture();
  const cause = new Error('SDK resolution failed');
  await expect(
    loadLocalPlugin(candidate, {
      ...options,
      get sdk() {
        throw cause;
      },
    }),
  ).rejects.toMatchObject({
    code: 'plugin-load-failed',
    pluginId: 'explicit',
    message: 'Plugin "explicit" failed in its factory: SDK resolution failed',
    cause,
  });
  expect(await phases()).toEqual(['evaluate']);
});

it.each([false, true])(
  'passes the authority marker as the direct kernel setup cause (guard also aborts: %s)',
  async (alsoAborts) => {
    const { candidate, options, attempt, phases } = await fixture();
    const cause = new Error('lost before setup');
    let ready = true;
    const loaded = await loadLocalPlugin(candidate, {
      ...options,
      explicitChecks: {
        ...options.explicitChecks,
        assertReadySync() {
          if (ready) return undefined;
          if (alsoAborts) attempt.abort(new Error('attempt cancelled'));
          throw cause;
        },
      },
    });
    expect(await phases()).toEqual(['evaluate', 'factory']);
    const lifecycle = createPluginLifecycle(loaded, 1_000, options.signal, {
      drainSetupOnDispose: true,
    });
    const kernel = createPluginKernel();
    const registration = kernel.register(lifecycle.plugin);
    // Authority is lost after register schedules setup and before the plugin is invoked.
    ready = false;
    const failure = await registration.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PluginError);
    expect(failure).toMatchObject({
      code: 'plugin-setup-failed',
      cause: { ...authorityFailure, cause },
    });
    expect((failure as PluginError).cause).toBeInstanceOf(ExplicitLocalAuthorityError);
    expect(await phases()).toEqual(['evaluate', 'factory']);
    expect(kernel.plugins()).toEqual([]);
    await lifecycle.dispose();
    await kernel.dispose();
  },
);

it.each([
  { phase: 'import', check: 1, reached: [] },
  { phase: 'factory', check: 2, reached: ['evaluate'] },
  { phase: 'setup', check: 3, reached: ['evaluate', 'factory'] },
])(
  'honors a guard that aborts and returns successfully before $phase',
  async ({ phase, check, reached }) => {
    const { candidate, options, attempt, phases } = await fixture();
    const cancelled = new Error('attempt cancelled');
    let checks = 0;
    const load = loadLocalPlugin(candidate, {
      ...options,
      explicitChecks: {
        ...options.explicitChecks,
        assertReadySync() {
          if (++checks === check) attempt.abort(cancelled);
          return undefined;
        },
      },
    });
    if (phase === 'setup') {
      const lifecycle = createPluginLifecycle(await load, 1_000, options.signal, {
        drainSetupOnDispose: true,
      });
      const kernel = createPluginKernel();
      await expect(kernel.register(lifecycle.plugin)).rejects.toMatchObject({
        code: 'plugin-setup-failed',
        cause: cancelled,
      });
      await lifecycle.dispose();
      await kernel.dispose();
    } else {
      await expect(load).rejects.toBe(cancelled);
    }
    expect(await phases()).toEqual(reached);
  },
);

it.each(['Promise', 'thenable'] as const)(
  'rejects and observes an accidental %s result from a synchronous guard',
  async (kind) => {
    const { candidate, options, phases } = await fixture();
    const failure = new Error('async guard failure');
    let thenObserved = false;
    await expect(
      loadLocalPlugin(candidate, {
        ...options,
        explicitChecks: {
          ...options.explicitChecks,
          assertReadySync() {
            const invalid =
              kind === 'Promise'
                ? Promise.reject(failure)
                : {
                    then(_resolve: unknown, reject: (reason: unknown) => void) {
                      thenObserved = true;
                      reject(failure);
                    },
                  };
            return invalid as unknown as undefined;
          },
        },
      }),
    ).rejects.toMatchObject(authorityFailure);
    if (kind === 'thenable') expect(thenObserved).toBe(true);
    expect(await phases()).toEqual([]);
  },
);

it.each([
  { stage: 'module', source: `throw new Error('ordinary module error');` },
  {
    stage: 'factory',
    source: `export default () => { throw new Error('ordinary factory error'); };`,
  },
])('attributes an ordinary $stage error to the plugin', async ({ stage, source }) => {
  const { candidate, options } = await fixture(source);
  await expect(loadLocalPlugin(candidate, options)).rejects.toMatchObject({
    code: 'plugin-load-failed',
    pluginId: 'explicit',
    cause: { message: `ordinary ${stage} error` },
  });
});

it.each(['cancellation', 'timeout'] as const)(
  'starts plugin disposal and drains original managed setup after %s',
  async (failure) => {
    const { candidate, attempt, marker, phases } = await fixture();
    vi.useFakeTimers();
    const enteringSetup = gate();
    const releaseSetup = gate();
    let setupSignal: AbortSignal | undefined;
    const lifecycle = createPluginLifecycle(
      {
        manifest: candidate.manifest,
        async setup(env) {
          setupSignal = env.signal;
          enteringSetup.resolve();
          await releaseSetup.promise;
          appendFileSync(marker, 'setup settled\n');
          throw new Error('late setup rejection');
        },
        dispose() {
          appendFileSync(marker, 'dispose\n');
        },
      },
      50,
      attempt.signal,
      { drainSetupOnDispose: true },
    );
    const kernel = createPluginKernel();
    const registration = kernel.register(lifecycle.plugin).catch((error: unknown) => error);
    await enteringSetup.promise;
    if (failure === 'cancellation') attempt.abort(new Error('attempt cancelled'));
    else await vi.advanceTimersByTimeAsync(50);
    expect(await registration).toMatchObject({ code: 'plugin-setup-failed' });
    expect(setupSignal?.aborted).toBe(true);
    let disposed = false;
    const disposing = lifecycle.dispose().then(() => {
      disposed = true;
    });
    try {
      expect(await phases()).toEqual(['dispose']);
      expect(disposed).toBe(false);
    } finally {
      releaseSetup.resolve();
      await disposing;
      await kernel.dispose();
    }
    expect(await phases()).toEqual(['dispose', 'setup settled']);
    expect(lifecycle.cleanupErrors).toEqual([]);
  },
);

it('keeps manual lifecycle disposal independent of a timed-out setup', async () => {
  const { candidate } = await fixture();
  vi.useFakeTimers();
  const releaseSetup = gate();
  let disposals = 0;
  const lifecycle = createPluginLifecycle(
    {
      manifest: candidate.manifest,
      setup: () => releaseSetup.promise,
      dispose() {
        disposals += 1;
      },
    },
    50,
  );
  const kernel = createPluginKernel();
  const registration = kernel.register(lifecycle.plugin).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(50);
  const error = await registration;
  expect(lifecycle.normalize(error)).toMatchObject({ code: 'plugin-setup-timeout' });
  await lifecycle.dispose();
  expect(disposals).toBe(1);
  releaseSetup.resolve();
  await kernel.dispose();
});
