import {
  createLocalPluginSource,
  projectLocalPluginSnapshot,
  type LocalPluginSourceOptions,
  type LocalPluginSourceSnapshot,
  type LocalPluginSourceMutation,
  type LocalPluginSourceController,
  type ReloadResult,
} from '@weave/plugin-host';
import { z } from 'zod';
import type { ExtensionCoordinator } from './extension-coordinator.js';
import type { ExtensionSourceFactory, ExtensionSourceSnapshot } from './extension-types.js';
import type { ServerLocalPluginHost } from './local-plugin-host.js';

const sourceId = 'local-esm';
const mutationOptions = z.strictObject({ immediate: z.boolean().optional() }).optional();

function sourceSnapshot(snapshot: LocalPluginSourceSnapshot): ExtensionSourceSnapshot {
  return {
    stamp: snapshot.stamp,
    eligible: snapshot.plugins.flatMap(({ state, candidate }) => {
      if (state !== 'eligible' || candidate.status !== 'ready') return [];
      return [
        { pluginId: candidate.id, identity: JSON.stringify([candidate.id, candidate.digest]) },
      ];
    }),
  };
}

export function createLocalExtensionSource(options: LocalPluginSourceOptions): {
  register: ExtensionSourceFactory;
  facade(coordinator: ExtensionCoordinator): ServerLocalPluginHost;
  discoveredPluginIds(): Promise<readonly string[]>;
  close(): Promise<void>;
} {
  let source: LocalPluginSourceController;
  // The ESM lifecycle captures cleanup errors so plugin code cannot interrupt
  // rollback. Collect them after draining both rejected and published attempts.
  const cleanupErrors: unknown[] = [];

  async function close() {
    try {
      await source.close();
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Local plugin source disposal failed', {
        cause: cleanupErrors[0],
      });
    }
  }

  const register: ExtensionSourceFactory = (observe) => {
    source = createLocalPluginSource({
      ...options,
      onAuthorityChange(change) {
        observe(sourceId, { ...change, snapshot: sourceSnapshot(change.snapshot) });
      },
    });
    return {
      id: sourceId,
      snapshot: () => sourceSnapshot(source.snapshot()),
      async refresh() {
        await source.refresh();
      },
      async prepare(stamp, preparationOptions) {
        const prepared = await source.prepare(stamp, preparationOptions);
        let disposal: Promise<void> | undefined;
        return {
          stamp: prepared.stamp,
          items: prepared.items.map((item) => ({
            pluginId: item.id,
            identity: item.identity,
            plugin: item.plugin,
            normalizeError: item.normalize,
            dispose: item.dispose,
          })),
          failures: prepared.failures.map(({ id, identity, kind, error }) => ({
            pluginId: id,
            identity,
            kind,
            error,
          })),
          recheck: async (signal) => (await source.recheck(prepared, signal)).valid,
          dispose() {
            disposal ??= prepared.dispose().then(() => {
              for (const item of prepared.items) cleanupErrors.push(...item.cleanupErrors);
            });
            return disposal;
          },
        };
      },
      close,
    };
  };

  return {
    register,
    close,
    async discoveredPluginIds() {
      await source.refresh();
      return Object.freeze([
        ...new Set(
          source
            .snapshot()
            .discovery.candidates.flatMap((candidate) =>
              candidate.manifest === undefined ? [] : [candidate.manifest.id],
            ),
        ),
      ]);
    },
    facade(coordinator) {
      function project(state: ReturnType<ExtensionCoordinator['snapshot']>) {
        const current = source.snapshot();
        const failures = new Map(
          state.failed
            .filter((item) => item.sourceId === sourceId)
            .map((item) => [item.identity, item.error]),
        );
        if (state.error !== undefined) {
          for (const item of sourceSnapshot(current).eligible) {
            if (!failures.has(item.identity)) failures.set(item.identity, state.error);
          }
        }
        return projectLocalPluginSnapshot(current, {
          generation: state.generation.id,
          active: state.members
            .filter((member) => member.sourceId === sourceId)
            .map((member) => {
              const digest = (JSON.parse(member.identity) as [string, string])[1];
              return { id: member.pluginId, digest, manifest: member.manifest };
            }),
          failures,
          blocked: state.generation.blocked,
          error: state.error,
        });
      }

      function reloadResult(
        result: Awaited<ReturnType<ExtensionCoordinator['reload']>>,
      ): ReloadResult {
        const eligible = new Set(
          sourceSnapshot(source.snapshot()).eligible.map((item) => item.identity),
        );
        return {
          generation: result.generation.id,
          unchanged: result.unchanged,
          failed: result.failed.flatMap(({ sourceId: owner, pluginId, identity, error }) =>
            owner === sourceId && eligible.has(identity) ? [{ id: pluginId, error }] : [],
          ),
          ...(result.error === undefined ? {} : { error: result.error }),
          snapshot: project(result),
        };
      }

      function mutate(command: () => LocalPluginSourceMutation): Promise<ReloadResult> {
        return coordinator
          .mutate(
            sourceId,
            () => {
              const change = command();
              return source.mutate(change, {
                hasActive: (pluginId) => coordinator.hasActive(sourceId, pluginId),
                onImmediateRetry: () => coordinator.retryImmediateRevocation(sourceId, change.id),
              });
            },
            { force: true },
          )
          .then(reloadResult);
      }
      const snapshot = () => project(coordinator.snapshot());
      return {
        runner: coordinator.runner,
        list: () => snapshot().plugins,
        snapshot,
        reload: () => coordinator.reload({ force: true }).then(reloadResult),
        trust: (id, digest) => mutate(() => ({ kind: 'trust', id, digest })),
        revoke: (id, options) =>
          mutate(() => ({ kind: 'revoke', id, ...mutationOptions.parse(options) })),
        setEnabled: (id, enabled, options) =>
          mutate(() => ({ kind: 'setEnabled', id, enabled, ...mutationOptions.parse(options) })),
        dispose: coordinator.dispose,
      };
    },
  };
}
