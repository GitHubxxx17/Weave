import type { KernelPlugin, PluginManifest } from '@weave/plugin';

import type { LocalPluginCandidate, LocalPluginIssue } from './discovery.js';
import type { GenerationRequest, GenerationRunner, RunnerGeneration } from './generation-runner.js';
import type { LocalPluginSourceOptions } from './local-source-types.js';
import type { LocalPluginState, PluginTrustRecord } from './trust.js';

export interface LocalPluginIdentity {
  readonly id: string;
  readonly digest: string;
}

export interface ActiveLocalPlugin extends LocalPluginIdentity {
  readonly manifest: PluginManifest;
}

export type HostedLocalPluginState = Exclude<LocalPluginState, 'eligible'> | 'loaded' | 'failed';

export interface LocalPluginRecord {
  readonly id: string;
  readonly state: HostedLocalPluginState;
  readonly candidate: LocalPluginCandidate;
  readonly trusted: PluginTrustRecord | undefined;
  readonly error?: LocalPluginIssue | undefined;
  readonly active?:
    | {
        readonly generation: number;
        readonly digest: string;
        readonly manifest: PluginManifest;
      }
    | undefined;
}

export interface PluginHostSnapshot {
  readonly directory: string;
  readonly exists: boolean;
  readonly truncated: boolean;
  readonly trustSequence: number;
  readonly plugins: readonly LocalPluginRecord[];
  readonly generation: {
    readonly id: number;
    readonly plugins: readonly ActiveLocalPlugin[];
    readonly acceptingRuns: boolean;
    readonly blocked?: LocalPluginIssue | undefined;
  };
  readonly error?: LocalPluginIssue | undefined;
}

export interface PluginReloadFailure {
  readonly id: string;
  readonly error: LocalPluginIssue;
}

export interface ReloadResult {
  readonly generation: number;
  readonly unchanged: boolean;
  readonly failed: readonly PluginReloadFailure[];
  readonly error?: LocalPluginIssue | undefined;
  readonly snapshot: PluginHostSnapshot;
}

export interface PluginGenerationPort<R extends GenerationRequest, E, T> {
  readonly runner: GenerationRunner<R, E>;
  current(): RunnerGeneration<R, E, T>;
  /** Validate and commit the pointer synchronously; only retirement may await. */
  publish(
    candidate: RunnerGeneration<R, E, T>,
    options?: { readonly immediate?: boolean },
  ): Promise<void>;
  blockNewRuns(error: Error): void;
  abortActiveRuns(reason?: unknown): void;
  dispose(): Promise<void>;
}

export interface CreatePluginHostOptions<R extends GenerationRequest, E, T> extends Omit<
  LocalPluginSourceOptions,
  'onAuthorityChange' | 'explicitChecks'
> {
  readonly generations: PluginGenerationPort<R, E, T>;
  readonly assemble: (localPlugins: readonly KernelPlugin[]) => Promise<RunnerGeneration<R, E, T>>;
}

// T is the injected generation's resources; the host intentionally never exposes them.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface PluginHost<R extends GenerationRequest, E, T> {
  readonly runner: GenerationRunner<R, E>;
  list(): readonly LocalPluginRecord[];
  snapshot(): PluginHostSnapshot;
  reload(): Promise<ReloadResult>;
  trust(id: string, digest: string): Promise<ReloadResult>;
  revoke(id: string, options?: { readonly immediate?: boolean }): Promise<ReloadResult>;
  setEnabled(
    id: string,
    enabled: boolean,
    options?: { readonly immediate?: boolean },
  ): Promise<ReloadResult>;
  dispose(): Promise<void>;
}
