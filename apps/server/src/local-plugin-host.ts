import { createPluginHost, type PluginHost, type PluginTrustStore } from '@weave/plugin-host';
import type { KernelPlugin } from '@weave/plugin';
import type { AgentRunRequest, AgentRuntimeEvent } from '@weave/runtime';
import {
  assembleServerGeneration,
  replaceServerGeneration,
  type ServerAgentRunnerOptions,
  type ServerGenerationResources,
  type ServerRuntime,
} from './runtime.js';

/** Trust persistence remains open until administration and generation draining finish. */
export interface ClosablePluginTrustStore extends PluginTrustStore {
  close(): Promise<void>;
}

export type ServerLocalPluginHost = PluginHost<
  AgentRunRequest,
  AgentRuntimeEvent,
  ServerGenerationResources
>;

/** Attaches local administration to the already initialized Server Runner facade. */
export function createServerLocalPluginHost(
  runtime: ServerRuntime,
  options: {
    readonly directory: string;
    readonly trustStore: PluginTrustStore;
    readonly runnerOptions: Omit<ServerAgentRunnerOptions, 'kernelPlugins'> & {
      readonly hostVersion: string;
    };
    /** Allocate independent plugin resources for each candidate assembly, in baseline order. */
    readonly kernelPluginFactories?: readonly (() => KernelPlugin)[];
  },
): Promise<ServerLocalPluginHost> {
  const controller = runtime.serverHost.controller();
  if (controller === undefined) {
    throw new Error('Local plugins require an initialized Server generation');
  }
  const baseline = controller.current().resources.plugins;
  const reservedIds = baseline.map((plugin) => plugin.id);
  const configuredIds = baseline
    .filter((plugin) => plugin.origin === 'kernel')
    .map((plugin) => plugin.id);
  const factories = Object.freeze([...(options.kernelPluginFactories ?? [])]);
  if (configuredIds.length !== factories.length) {
    throw new Error('Configured kernel plugin factories must match the baseline plugin identities');
  }
  // Structural TypeScript assignment permits variables with extra properties.
  // Strip legacy instances at runtime too, so they can never enter a candidate.
  const { kernelPlugins: discardedInstances, ...runnerOptions } =
    options.runnerOptions as ServerAgentRunnerOptions;
  void discardedInstances;
  const baseOptions = Object.freeze(runnerOptions);

  async function assemble(localPlugins: readonly KernelPlugin[]) {
    const configured: KernelPlugin[] = [];
    try {
      for (const [index, factory] of factories.entries()) {
        const instance = factory();
        let disposal: Promise<void> | undefined;
        const owned: KernelPlugin = {
          manifest: instance.manifest,
          setup: (env) => instance.setup(env),
          dispose() {
            disposal ??= Promise.resolve().then(() => instance.dispose?.());
            return disposal;
          },
        };
        configured.push(owned);
        if (owned.manifest.id !== configuredIds[index]) {
          throw new Error('Configured kernel plugin factory changed its baseline plugin identity');
        }
      }
      return await assembleServerGeneration(runtime, {
        ...baseOptions,
        kernelPlugins: [...configured, ...localPlugins],
      });
    } catch (error: unknown) {
      // A factory or early registration may fail before later instances reach
      // the kernel. Shared memoized disposers also tolerate kernel rollback.
      await Promise.allSettled(configured.reverse().map((plugin) => plugin.dispose?.()));
      throw error;
    }
  }
  return createPluginHost({
    discovery: {
      directory: options.directory,
      hostVersion: baseOptions.hostVersion,
      reservedIds,
    },
    trustStore: options.trustStore,
    generations: {
      runner: controller.runner,
      current: () => controller.current(),
      // No asynchronous work may precede ServerHost's validation and pointer commit.
      publish: (candidate, publication) => replaceServerGeneration(runtime, candidate, publication),
      blockNewRuns: (error) => controller.blockNewRuns(error),
      abortActiveRuns: (reason) => controller.abortActiveRuns(reason),
      dispose: () => controller.dispose(),
    },
    assemble,
  });
}
