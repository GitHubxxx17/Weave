import { PluginError } from '@weave/plugin';

import type { DiscoveryResult, LocalPluginIssue, ReadyLocalPlugin } from './discovery.js';
import { describeError, PluginHostError } from './errors.js';
import type {
  ActiveLocalPlugin,
  LocalPluginIdentity,
  LocalPluginRecord,
  PluginHostSnapshot,
  ReloadResult,
} from './host-types.js';
import {
  foldTrust,
  resolveLocalPlugins,
  type PluginTrustRecord,
  type RecordedPluginTrustEvent,
} from './trust.js';

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

/** Desired state and published membership have deliberately independent lifetimes. */
export class HostState {
  discovery: DiscoveryResult;
  events: readonly RecordedPluginTrustEvent[] = [];
  trust: ReadonlyMap<string, PluginTrustRecord> = new Map();
  readonly active = new Map<number, readonly ActiveLocalPlugin[]>();
  failures = new Map<string, LocalPluginIssue>();
  displayFailures = new Map<string, LocalPluginIssue>();
  error: LocalPluginIssue | undefined;
  blocked: LocalPluginIssue | undefined;
  publishing: number | undefined;
  cleanKey: string | undefined = attemptedKey([]);

  constructor(directory: string) {
    this.discovery = { directory, exists: false, truncated: false, candidates: [] };
  }

  setEvents(events: readonly RecordedPluginTrustEvent[]): void {
    this.events = immutable(events);
    this.trust = foldTrust(this.events);
  }

  eligible(): ReadyLocalPlugin[] {
    return resolveLocalPlugins(this.discovery.candidates, this.trust)
      .flatMap((row) =>
        row.state === 'eligible' && row.candidate.status === 'ready' ? [row.candidate] : [],
      )
      .sort(compareIds);
  }

  snapshot(generation: number, closed: boolean): PluginHostSnapshot {
    const active = this.active.get(generation) ?? [];
    const blocked = !closed && this.publishing === generation ? undefined : this.blocked;
    const plugins: LocalPluginRecord[] = resolveLocalPlugins(
      this.discovery.candidates,
      this.trust,
    ).map((row) => {
      const current = active.find((plugin) => plugin.id === row.id);
      const failure =
        row.candidate.status === 'ready'
          ? this.displayFailures.get(identity(row.candidate))
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
      directory: this.discovery.directory,
      exists: this.discovery.exists,
      truncated: this.discovery.truncated,
      trustSequence: Math.max(0, ...this.events.map((event) => event.sequence)),
      plugins,
      generation: {
        id: generation,
        plugins: active,
        acceptingRuns: !closed && blocked === undefined,
        ...(blocked === undefined ? {} : { blocked }),
      },
      ...(this.error === undefined ? {} : { error: this.error }),
    });
  }

  result(generation: number, closed: boolean, unchanged: boolean): ReloadResult {
    const eligible = this.eligible();
    const failed = eligible.flatMap((plugin) => {
      const error = this.failures.get(identity(plugin));
      return error === undefined ? [] : [{ id: plugin.id, error }];
    });
    return immutable({
      generation,
      unchanged,
      failed,
      ...(this.error === undefined ? {} : { error: this.error }),
      snapshot: this.snapshot(generation, closed),
    });
  }
}
