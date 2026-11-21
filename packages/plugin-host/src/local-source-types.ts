import type { KernelPlugin, PluginSdk } from '@weave/plugin';

import type { DiscoverOptions, DiscoveryResult, LocalPluginIssue } from './discovery.js';
import type { ActiveLocalPlugin } from './host-types.js';
import type { PluginTrustRecord, PluginTrustStore, ResolvedLocalPlugin } from './trust.js';

export interface LocalSourceStamp {
  readonly revision: number;
  readonly trustSequence: number;
}

export interface LocalPluginSourceSnapshot {
  readonly discovery: DiscoveryResult;
  readonly plugins: readonly ResolvedLocalPlugin[];
  readonly trust: readonly PluginTrustRecord[];
  readonly stamp: LocalSourceStamp;
}

export type LocalPluginSourceMutation =
  | { readonly kind: 'trust'; readonly id: string; readonly digest: string }
  | { readonly kind: 'revoke'; readonly id: string; readonly immediate?: boolean | undefined }
  | {
      readonly kind: 'setEnabled';
      readonly id: string;
      readonly enabled: boolean;
      readonly immediate?: boolean | undefined;
    };

export interface LocalSourceMutationContext {
  readonly hasActive?: (id: string) => boolean;
  readonly onImmediateRetry?: () => void;
}

export type LocalSourceAuthorityReason =
  'trust-log' | 'discovery' | 'trusted' | 'enabled' | 'disabled' | 'revoked';

export interface LocalSourceAuthorityChange {
  readonly snapshot: LocalPluginSourceSnapshot;
  readonly reason: LocalSourceAuthorityReason;
  readonly affectedIds: readonly string[];
  readonly immediate: boolean;
}

export interface PreparedLocalPlugin {
  readonly id: string;
  readonly identity: string;
  readonly digest: string;
  readonly plugin: KernelPlugin;
  readonly normalize: (error: unknown) => unknown;
  readonly cleanupErrors: readonly unknown[];
  dispose(): Promise<void>;
}

export interface PreparedLocalPluginFailure {
  readonly id: string;
  readonly identity: string;
  readonly kind: 'load' | 'identity';
  readonly error: unknown;
}

export interface PreparedLocalPlugins {
  readonly stamp: LocalSourceStamp;
  readonly items: readonly PreparedLocalPlugin[];
  readonly failures: readonly PreparedLocalPluginFailure[];
  dispose(): Promise<void>;
}

export interface LocalSourceRecheck {
  readonly valid: boolean;
  readonly snapshot: LocalPluginSourceSnapshot;
}

export interface LocalPluginSourceOptions {
  readonly discovery: DiscoverOptions;
  readonly trustStore: PluginTrustStore;
  readonly sdk?: PluginSdk | undefined;
  readonly setupTimeoutMs?: number | undefined;
  readonly importModule?: ((specifier: string) => Promise<unknown>) | undefined;
  readonly onAuthorityChange?: ((change: LocalSourceAuthorityChange) => void) | undefined;
}

export interface LocalPluginSourceController {
  snapshot(): LocalPluginSourceSnapshot;
  refresh(): Promise<LocalPluginSourceSnapshot>;
  mutate(
    command: LocalPluginSourceMutation,
    context?: LocalSourceMutationContext,
  ): Promise<LocalPluginSourceSnapshot>;
  prepare(
    stamp: LocalSourceStamp,
    options: { readonly signal: AbortSignal; readonly excluded: ReadonlySet<string> },
  ): Promise<PreparedLocalPlugins>;
  recheck(prepared: PreparedLocalPlugins, signal: AbortSignal): Promise<LocalSourceRecheck>;
  close(): Promise<void>;
}

export interface LocalSourceProjectionOptions {
  readonly generation: number;
  readonly active: readonly ActiveLocalPlugin[];
  readonly failures?: ReadonlyMap<string, LocalPluginIssue> | undefined;
  readonly blocked?: LocalPluginIssue | undefined;
  readonly closed?: boolean | undefined;
  readonly error?: LocalPluginIssue | undefined;
}
