import { PluginError } from '@weave/plugin';

import type { LocalPluginIssue, ReadyLocalPlugin } from './discovery.js';
import { describeError, PluginHostError } from './errors.js';
import type {
  ActiveLocalPlugin,
  LocalPluginIdentity,
  LocalPluginRecord,
  PluginHostSnapshot,
  ReloadResult,
} from './host-types.js';
import type {
  LocalPluginSourceSnapshot,
  LocalSourceProjectionOptions,
} from './local-source-types.js';

export function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return Buffer.compare(Buffer.from(left.id, 'utf8'), Buffer.from(right.id, 'utf8'));
}

export function identity(plugin: LocalPluginIdentity): string {
  return JSON.stringify([plugin.id, plugin.digest]);
}

export function attemptedKey(plugins: readonly LocalPluginIdentity[]): string {
  return JSON.stringify([...plugins].sort(compareIds).map((plugin) => [plugin.id, plugin.digest]));
}

/** Public data is copied before freezing, so neither callers nor external stores own our cache. */
export function immutable<T>(value: T): T {
  const cloned: T = structuredClone(value);
  function freeze(item: unknown): void {
    if (item === null || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  }
  freeze(cloned);
  return cloned;
}

export function issueOf(error: unknown): LocalPluginIssue {
  if (error instanceof PluginHostError || error instanceof PluginError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'plugin-reload-failed', message: describeError(error) };
}

export function ownerOf(error: unknown): string | undefined {
  return error instanceof PluginHostError || error instanceof PluginError
    ? error.pluginId
    : undefined;
}

export function eligibleLocalPlugins(snapshot: LocalPluginSourceSnapshot): ReadyLocalPlugin[] {
  return snapshot.plugins
    .flatMap((row) =>
      row.state === 'eligible' && row.candidate.status === 'ready' ? [row.candidate] : [],
    )
    .sort(compareIds);
}

export function projectLocalPluginSnapshot(
  snapshot: LocalPluginSourceSnapshot,
  { generation, active, failures, blocked, closed, error }: LocalSourceProjectionOptions,
): PluginHostSnapshot {
  const plugins: LocalPluginRecord[] = snapshot.plugins.map((row) => {
    const current = active.find((plugin) => plugin.id === row.id);
    const failure =
      row.candidate.status === 'ready'
        ? failures?.get(identity(row.candidate))
        : row.candidate.issue;
    return {
      ...row,
      state:
        row.state === 'eligible'
          ? failure === undefined &&
            row.candidate.status === 'ready' &&
            current?.digest === row.candidate.digest
            ? 'loaded'
            : 'failed'
          : row.state,
      ...(failure === undefined ? {} : { error: failure }),
      ...(current === undefined
        ? {}
        : { active: { generation, digest: current.digest, manifest: current.manifest } }),
    };
  });
  return immutable({
    directory: snapshot.discovery.directory,
    exists: snapshot.discovery.exists,
    truncated: snapshot.discovery.truncated,
    trustSequence: snapshot.stamp.trustSequence,
    plugins,
    generation: {
      id: generation,
      plugins: active,
      acceptingRuns: !closed && blocked === undefined,
      ...(blocked === undefined ? {} : { blocked }),
    },
    ...(error === undefined ? {} : { error }),
  });
}

/** Tracks only publication and the outcome of the latest assembly attempt. */
export class HostState {
  /** Includes retiring generations until their disposer settles. */
  readonly active = new Map<number, readonly ActiveLocalPlugin[]>();
  failures = new Map<string, LocalPluginIssue>();
  displayFailures = new Map<string, LocalPluginIssue>();
  error: LocalPluginIssue | undefined;
  blocked: LocalPluginIssue | undefined;
  publishing: number | undefined;
  cleanKey: string | undefined = attemptedKey([]);

  hasActive(id: string): boolean {
    for (const plugins of this.active.values()) {
      if (plugins.some((plugin) => plugin.id === id)) return true;
    }
    return false;
  }

  snapshot(
    source: LocalPluginSourceSnapshot,
    generation: number,
    closed: boolean,
  ): PluginHostSnapshot {
    return projectLocalPluginSnapshot(source, {
      generation,
      active: this.active.get(generation) ?? [],
      failures: this.displayFailures,
      blocked: !closed && this.publishing === generation ? undefined : this.blocked,
      closed,
      error: this.error,
    });
  }

  result(
    source: LocalPluginSourceSnapshot,
    generation: number,
    closed: boolean,
    unchanged: boolean,
  ): ReloadResult {
    const eligible = eligibleLocalPlugins(source);
    const failed = eligible.flatMap((plugin) => {
      const error = this.failures.get(identity(plugin));
      return error === undefined ? [] : [{ id: plugin.id, error }];
    });
    return immutable({
      generation,
      unchanged,
      failed,
      ...(this.error === undefined ? {} : { error: this.error }),
      snapshot: this.snapshot(source, generation, closed),
    });
  }
}
