import type { KernelPlugin, PluginManifest } from '@weave/plugin';
import type { LocalPluginIssue, LocalSourceCandidate } from '@weave/plugin-host';

/** Candidate-wide resource failure; authority read errors must remain distinct. */
export class ExtensionPreparationError extends Error {
  readonly code = 'plugin-reload-failed';

  constructor() {
    super('Extension resources are unavailable for this generation');
    this.name = 'ExtensionPreparationError';
  }
}

export interface ExtensionSourceStamp {
  readonly revision: number;
  readonly trustSequence: number;
}

export function sameExtensionSourceStamp(left: ExtensionSourceStamp, right: ExtensionSourceStamp) {
  return left.revision === right.revision && left.trustSequence === right.trustSequence;
}

export interface ExtensionIdentity {
  readonly pluginId: string;
  /** Unique within the source. */
  readonly identity: string;
  readonly origin?: LocalSourceCandidate['origin'];
}

export interface ManagedGenerationAuthority {
  readonly ownershipLossSignal: AbortSignal;
  assertNotLostSync(): undefined;
  assertManagedPublicationSync(identities: readonly ExtensionIdentity[]): undefined;
  assertManagedStartSync(): undefined;
}

export interface ExtensionSourceSnapshot {
  readonly stamp: ExtensionSourceStamp;
  readonly eligible: readonly ExtensionIdentity[];
}

export interface ExtensionAuthorityChange {
  readonly snapshot: ExtensionSourceSnapshot;
  readonly affectedIds: readonly string[];
  readonly immediate: boolean;
}

export type ExtensionAuthorityObserver = (
  sourceId: string,
  change: ExtensionAuthorityChange,
) => void;

export interface PreparedExtensionItem extends ExtensionIdentity {
  /** Server-private identity of these exact preparation resources. */
  readonly instanceId?: string;
  readonly plugin: KernelPlugin;
  /** Pure synchronous liveness check, without plugin code or authority mutation. */
  isReady?(): boolean;
  normalizeError?(error: unknown): unknown;
  dispose(): Promise<void>;
}

export interface ExtensionPreparationFailure extends ExtensionIdentity {
  readonly kind: 'load' | 'identity';
  readonly error: unknown;
}

export interface PreparedExtensionSource {
  readonly stamp: ExtensionSourceStamp;
  readonly items: readonly PreparedExtensionItem[];
  readonly failures: readonly ExtensionPreparationFailure[];
  /** Rechecks the authority and identity associated with these exact resources. */
  recheck(signal: AbortSignal): Promise<boolean>;
  dispose(): Promise<void>;
}

/** The Server-only contract for sources of generation-owned kernel plugins. */
export interface ExtensionSource {
  readonly id: string;
  snapshot(): ExtensionSourceSnapshot;
  refresh(signal?: AbortSignal): Promise<void>;
  prepare(
    stamp: ExtensionSourceStamp,
    options: { readonly signal: AbortSignal; readonly excluded: ReadonlySet<string> },
  ): Promise<PreparedExtensionSource>;
  close(): Promise<void>;
}

export type ExtensionSourceFactory = (observe: ExtensionAuthorityObserver) => ExtensionSource;

export interface ExtensionMember extends ExtensionIdentity {
  readonly sourceId: string;
  readonly instanceId?: string;
  readonly manifest: PluginManifest;
}

export interface RetainedExtensionGeneration {
  readonly generationId: number;
  readonly current: boolean;
  readonly members: readonly ExtensionMember[];
}

export interface ExtensionFailure extends ExtensionIdentity {
  readonly sourceId: string;
  readonly error: LocalPluginIssue;
}

export interface ExtensionGenerationSnapshot {
  readonly id: number;
  readonly acceptingRuns: boolean;
  readonly blocked?: LocalPluginIssue;
}
