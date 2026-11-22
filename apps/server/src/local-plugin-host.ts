import type { PluginHost, PluginTrustStore } from '@weave/plugin-host';
import type { KernelPlugin } from '@weave/plugin';
import type { AgentRunRequest, AgentRuntimeEvent } from '@weave/runtime';
import {
  assembleServerGeneration,
  type ServerAgentRunnerOptions,
  type ServerGenerationResources,
  type ServerRuntime,
} from './runtime.js';
import { createExtensionCoordinator } from './extension-coordinator.js';
import { assertManualPluginIdSync, createLocalExtensionSource } from './local-extension-source.js';
import { createMcpExtensionSource } from './mcp-source.js';
import type { McpAuthorityStore } from './mcp-authority-store.js';
import type { connectMcp } from '@weave/mcp-client';
import type { ExtensionSourceFactory } from './extension-types.js';
import {
  createManagedAuthorityObserverBuffer,
  createManagedPluginComposition,
  type ManagedPluginCompositionOptions,
} from './managed-plugin-composition.js';
import { createManagedSelectionManager } from './managed-selection-manager.js';
import { createManagedPluginInstaller } from './managed-plugin-installer.js';
import type { OwnedPluginArtifactStore } from './owned-plugin-artifact-store.js';

/** Trust persistence remains open until administration and generation draining finish. */
export interface ClosablePluginTrustStore extends PluginTrustStore {
  close(): Promise<void>;
}

export type ServerLocalPluginHost = PluginHost<
  AgentRunRequest,
  AgentRuntimeEvent,
  ServerGenerationResources
>;

interface ServerExtensionOptions {
  readonly local?: {
    readonly directory: string;
    readonly trustStore: PluginTrustStore;
    readonly dispose?: () => Promise<void>;
  };
  readonly mcp?: {
    readonly store: McpAuthorityStore;
    readonly readHostVariable?: (name: string) => string | undefined;
    readonly connect?: typeof connectMcp;
  };
  readonly managed?: ManagedPluginCompositionOptions;
  readonly installerStore?: Pick<OwnedPluginArtifactStore, 'preview' | 'stage'>;
  readonly runnerOptions: Omit<ServerAgentRunnerOptions, 'kernelPlugins'> & {
    readonly hostVersion: string;
  };
  /** Allocate independent plugin resources for each candidate assembly, in baseline order. */
  readonly kernelPluginFactories?: readonly (() => KernelPlugin)[];
}

const coordinatedHosts = new WeakSet<ServerRuntime['serverHost']>();

/** Attaches the sole coordinator to the already initialized Server Runner facade. */
export function createServerExtensionCoordinator(
  runtime: ServerRuntime,
  options: ServerExtensionOptions,
) {
  if (coordinatedHosts.has(runtime.serverHost)) {
    throw new Error('Server already has an extension coordinator');
  }
  const controller = runtime.serverHost.controller();
  if (controller === undefined) {
    throw new Error('Extensions require an initialized Server generation');
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
  const buffer = createManagedAuthorityObserverBuffer((changes) =>
    coordinator.observeAuthorityBatchSync(changes),
  );
  const managedOptions = options.managed;
  const managed =
    managedOptions === undefined
      ? undefined
      : createManagedPluginComposition(
          managedOptions,
          buffer,
          () => ({ local, mcp }),
          () => coordinator.blockManagedOwnershipLossSync(),
        );
  const local: ReturnType<typeof createLocalExtensionSource> | undefined =
    options.local === undefined
      ? undefined
      : createLocalExtensionSource(
          {
            discovery: {
              directory: options.local.directory,
              hostVersion: baseOptions.hostVersion,
              reservedIds,
            },
            trustStore: options.local.trustStore,
            ...(options.managed?.executionStore === undefined
              ? {}
              : { explicitChecks: managed!.explicitChecks }),
          },
          managed === undefined || managedOptions === undefined
            ? undefined
            : {
                refreshSelectedEvidence: managed.refreshSelectedEvidence,
                invalidateAuthoritySync: managed.invalidateAuthoritySync,
                assertManualIdSync: (id) =>
                  assertManualPluginIdSync(managedOptions.readAuthoritySync, id),
                usesUnifiedTrust: managedOptions.readLocalTrustEventsSync === undefined,
              },
        );
  const mcp: ReturnType<typeof createMcpExtensionSource> | undefined =
    options.mcp === undefined
      ? undefined
      : createMcpExtensionSource({
          ...options.mcp,
          ...(managed === undefined
            ? {}
            : {
                installAuthoritySync: managed.installAuthoritySync,
                assertCreateAllowedSync: managed.assertCreateAllowedSync,
                onAuthorityFailureSync: managed.invalidateAuthoritySync,
              }),
          async reservedPluginIds() {
            const discovered = (await local?.discoveredPluginIds()) ?? [];
            const current = runtime.serverHost.controller()?.current().resources.plugins ?? [];
            const retained = coordinator
              .retainedGenerations()
              .flatMap((generation) =>
                generation.members
                  .filter((member) => member.sourceId !== 'mcp')
                  .map((member) => member.pluginId),
              );
            return Object.freeze([
              ...new Set([
                ...reservedIds,
                ...current.filter((plugin) => plugin.host !== 'mcp').map((plugin) => plugin.id),
                ...retained,
                ...discovered,
              ]),
            ]);
          },
        });
  function registerSource(register: ExtensionSourceFactory): ExtensionSourceFactory {
    return managed === undefined ? register : buffer.wrapSource(register);
  }
  const coordinator = createExtensionCoordinator({
    host: runtime.serverHost,
    sources: [
      ...(local === undefined ? [] : [registerSource(local.register)]),
      ...(mcp === undefined ? [] : [registerSource(mcp.register)]),
    ],
    assemble,
    mcpFirstAuthority: managed !== undefined,
    ...(options.managed?.executionStore === undefined
      ? {}
      : { managedAuthority: managed!.managedAuthority }),
  });
  const applyManagedSelection =
    local !== undefined &&
    managed !== undefined &&
    options.managed?.executionStore !== undefined &&
    options.managed.selectionAuthority !== undefined
      ? createManagedSelectionManager(coordinator, options.managed.selectionAuthority, managed)
      : undefined;
  const installer =
    local !== undefined &&
    managed !== undefined &&
    options.installerStore !== undefined &&
    options.managed?.selectionAuthority !== undefined &&
    applyManagedSelection !== undefined
      ? createManagedPluginInstaller({
          coordinator,
          authority: options.managed.selectionAuthority,
          store: options.installerStore,
          composition: managed,
          inspectLocalClaims: local.inspectDeclarationClaims,
          ...(mcp === undefined ? {} : { inspectMcpIds: mcp.inspectDeclaredPluginIds }),
          reservedIds: new Set(reservedIds),
          applySelection: applyManagedSelection,
        })
      : undefined;
  coordinatedHosts.add(runtime.serverHost);
  return {
    coordinator,
    managed,
    applyManagedSelection,
    installer,
    localSource: local,
    adoptInitialAuthoritySync: managed?.adoptInitialAuthoritySync,
    pluginHost: local?.facade(coordinator, options.local?.dispose),
    mcpManager: mcp?.facade(coordinator),
    async closeUnpublished() {
      installer?.closeSync();
      try {
        const outcomes = await Promise.allSettled([local?.close(), mcp?.close()]);
        const failures = outcomes.flatMap((outcome) =>
          outcome.status === 'rejected' ? [outcome.reason] : [],
        );
        if (failures.length > 0)
          throw new AggregateError(failures, 'Extension sources could not close');
      } finally {
        coordinatedHosts.delete(runtime.serverHost);
      }
    },
  };
}

/** Compatibility entry point for embedded Servers that enable local administration. */
export function createServerLocalPluginHost(
  runtime: ServerRuntime,
  {
    directory,
    trustStore,
    ...options
  }: Omit<ServerExtensionOptions, 'local'> & {
    readonly directory: string;
    readonly trustStore: PluginTrustStore;
  },
): Promise<ServerLocalPluginHost> {
  const { coordinator, pluginHost, closeUnpublished } = createServerExtensionCoordinator(runtime, {
    ...options,
    local: { directory, trustStore },
  });
  return coordinator.reload().then(
    () => pluginHost!,
    async (error: unknown) => {
      await closeUnpublished().catch(() => undefined);
      throw error;
    },
  );
}
