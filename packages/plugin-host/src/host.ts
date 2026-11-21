import { z } from 'zod';

import { PluginHostError } from './errors.js';
import type { GenerationRequest } from './generation-runner.js';
import { HostQueue } from './host-queue.js';
import { reloadHost } from './host-reload.js';
import { HostState } from './host-state.js';
import type { CreatePluginHostOptions, PluginHost, ReloadResult } from './host-types.js';
import {
  callable,
  createLocalPluginSource,
  localSourceConfiguration,
} from './local-plugin-source.js';
import type { LocalPluginSourceMutation } from './local-source-types.js';

const configuration = localSourceConfiguration
  .omit({ onAuthorityChange: true, explicitChecks: true })
  .extend({
    generations: z.object({
      runner: z.object({ run: callable }),
      current: callable,
      publish: callable,
      blockNewRuns: callable,
      abortActiveRuns: callable,
      dispose: callable,
    }),
    assemble: callable,
  });

const mutationOptions = z.strictObject({ immediate: z.boolean().optional() }).optional();

/** Coordinates local desired state through the injected, already published generation facade. */
export async function createPluginHost<R extends GenerationRequest, E, T>(
  options: CreatePluginHostOptions<R, E, T>,
): Promise<PluginHost<R, E, T>> {
  configuration.parse(options);
  const { generations: port, assemble, ...sourceOptions } = options;
  const state = new HostState();
  const queue = new HostQueue<ReloadResult>();
  const cleanupErrors: unknown[] = [];
  const stop = new AbortController();
  let closing: Promise<void> | undefined;

  const closed = () => stop.signal.aborted;
  const active = () => state.active.get(port.current().id) ?? [];

  function admissionError(): PluginHostError {
    return new PluginHostError(
      'plugin-generation-blocked',
      'Local plugin trust changed; new runs wait for a compliant generation',
    );
  }

  function block(immediate = false): void {
    if (closed()) return;
    const error = admissionError();
    state.blocked = { code: error.code, message: error.message };
    port.blockNewRuns(error);
    if (immediate) port.abortActiveRuns(error);
  }

  const source = createLocalPluginSource({
    ...sourceOptions,
    onAuthorityChange({ snapshot, reason, immediate }) {
      if (reason === 'revoked' || reason === 'disabled') {
        block(immediate);
      } else if (
        reason !== 'discovery' &&
        active().some(
          ({ id }) => !snapshot.trust.some((record) => record.pluginId === id && record.enabled),
        ) &&
        state.blocked === undefined
      ) {
        block();
      }
    },
  });

  const reloadCached = () =>
    reloadHost({
      port,
      assemble,
      source,
      state,
      signal: stop.signal,
      cleanupErrors,
    });
  const snapshot = () => state.snapshot(source.snapshot(), port.current().id, closed());

  async function reload(): Promise<ReloadResult> {
    await source.refresh();
    return reloadCached();
  }

  async function mutate(command: LocalPluginSourceMutation): Promise<ReloadResult> {
    await source.mutate(command, {
      hasActive: (id) => state.hasActive(id),
      onImmediateRetry: () => {
        if (!closed()) port.abortActiveRuns(admissionError());
      },
    });
    return reloadCached();
  }

  const host: PluginHost<R, E, T> = {
    runner: port.runner,
    list: () => snapshot().plugins,
    snapshot,
    reload: () => queue.enqueue(true, reload),
    trust: (id, digest) => queue.enqueue(false, () => mutate({ kind: 'trust', id, digest })),
    revoke: (id, options) =>
      queue.enqueue(false, () =>
        mutate({
          kind: 'revoke',
          id,
          immediate: mutationOptions.parse(options)?.immediate,
        }),
      ),
    setEnabled: (id, enabled, options) =>
      queue.enqueue(false, () =>
        mutate({
          kind: 'setEnabled',
          id,
          enabled,
          immediate: mutationOptions.parse(options)?.immediate,
        }),
      ),
    dispose() {
      if (closing === undefined) {
        const error = new PluginHostError('plugin-host-disposed', 'The plugin host is disposed');
        state.blocked = { code: error.code, message: error.message };
        const settled = queue.close(error);
        closing = settled.then(async () => {
          for (const close of [() => port.dispose(), () => source.close()]) {
            try {
              await close();
            } catch (error: unknown) {
              cleanupErrors.push(error);
            }
          }
          if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, 'Plugin host disposal failed', {
              cause: cleanupErrors[0],
            });
          }
        });
        port.blockNewRuns(error);
        port.abortActiveRuns(error);
        stop.abort(error);
      }
      return closing;
    },
  };
  await host.reload();
  return host;
}
