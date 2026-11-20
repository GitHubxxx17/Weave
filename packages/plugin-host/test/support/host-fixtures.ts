import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPluginKernel, type KernelPlugin, type PluginModule } from '@weave/plugin';

import { discoverLocalPlugins, type ReadyLocalPlugin } from '../../src/discovery.js';
import { createGenerationRunner, type RunnerGeneration } from '../../src/generation-runner.js';
import type { CreatePluginHostOptions, PluginGenerationPort } from '../../src/host-types.js';
import { createMemoryTrustStore, type PluginTrustStore } from '../../src/trust.js';
import { makeTempDirectory, writePlugin } from './fixtures.js';

export interface Request {
  readonly sessionId: string;
  readonly signal?: AbortSignal | undefined;
}
export type TestGeneration = RunnerGeneration<Request, string, readonly string[]>;

export function gate<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Condition did not become true');
}

export async function harness(ids: readonly string[] = [], trusted = false) {
  const directory = await makeTempDirectory();
  for (const id of ids) await writePlugin(directory, id);
  const trustStore = createMemoryTrustStore();
  const ready = (await discoverLocalPlugins({ directory })).candidates.filter(
    (candidate): candidate is ReadyLocalPlugin => candidate.status === 'ready',
  );
  if (trusted) {
    for (const candidate of ready)
      await trustStore.append({
        kind: 'trusted',
        pluginId: candidate.id,
        digest: candidate.digest,
        manifest: candidate.manifest,
      });
  }
  const baseline: TestGeneration = {
    id: 1,
    resources: [],
    runner: {
      async *run() {
        yield 'baseline';
      },
    },
    dispose() {},
  };
  const controller = createGenerationRunner(baseline);
  const calls = {
    assemblies: [] as string[][],
    factories: [] as string[],
    disposed: [] as string[],
    blocks: [] as Error[],
    aborts: [] as unknown[],
  };
  const factories = new Map<string, () => PluginModule | Promise<PluginModule>>();
  let sequence = 1;
  const port: PluginGenerationPort<Request, string, readonly string[]> = {
    runner: controller.runner,
    current: controller.current,
    publish: (candidate, options) => controller.replace(candidate, options),
    blockNewRuns(error) {
      calls.blocks.push(error);
      controller.blockNewRuns(error);
    },
    abortActiveRuns(reason) {
      calls.aborts.push(reason);
      controller.abortActiveRuns(reason);
    },
    dispose: controller.dispose,
  };
  const options: CreatePluginHostOptions<Request, string, readonly string[]> = {
    discovery: { directory },
    trustStore,
    generations: port,
    importModule: async (specifier) => {
      const id = path.basename(path.dirname(fileURLToPath(specifier)));
      return {
        default: () => {
          calls.factories.push(id);
          return (
            factories.get(id)?.() ?? {
              setup() {},
              dispose() {
                calls.disposed.push(id);
              },
            }
          );
        },
      };
    },
    assemble: async (plugins: readonly KernelPlugin[]) => {
      calls.assemblies.push(plugins.map((plugin) => plugin.manifest.id));
      const kernel = createPluginKernel();
      try {
        for (const plugin of plugins) await kernel.register(plugin);
        await kernel.seal();
      } catch (error: unknown) {
        await kernel.dispose();
        throw error;
      }
      const resources = plugins.map((plugin) => plugin.manifest.id);
      return {
        id: ++sequence,
        resources,
        runner: {
          async *run() {
            yield resources.join(',');
          },
        },
        dispose: () => kernel.dispose(),
      };
    },
  };
  return {
    directory,
    trustStore: trustStore as PluginTrustStore,
    ready,
    baseline,
    controller,
    port,
    calls,
    factories,
    options,
  };
}
