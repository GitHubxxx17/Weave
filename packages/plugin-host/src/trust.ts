import { pluginManifestSchema, type PluginManifest } from '@weave/plugin';
import { z } from 'zod';

import type { LocalPluginCandidate } from './discovery.js';

/**
 * What the user decided about plugins on disk, and what a plugin's state is
 * once that decision meets what is on disk now.
 *
 * Decisions are facts and are only ever appended. The current trust is a fold
 * over them, so revoking a plugin does not erase that it was once trusted, and
 * no other file or setting can make a revoked plugin load again.
 */

/** One decision. Every one names the plugin by the id in its manifest. */
export type PluginTrustEvent =
  /** The user reviewed this exact content and its declarations, and trusts it. */
  | {
      readonly kind: 'trusted';
      readonly pluginId: string;
      /** The digest of the directory the user reviewed. */
      readonly digest: string;
      /** The declarations the user saw, kept to show what changed in a later version. */
      readonly manifest: PluginManifest;
    }
  | { readonly kind: 'revoked'; readonly pluginId: string }
  | { readonly kind: 'enabled'; readonly pluginId: string }
  | { readonly kind: 'disabled'; readonly pluginId: string };

/** A decision as a store holds it. */
export type RecordedPluginTrustEvent = PluginTrustEvent & {
  /** 1 for the first event, rising by one. */
  readonly sequence: number;
  readonly occurredAt: string;
  /** Always `user` for now; project-level trust will use another scope. */
  readonly scope: 'user';
};

const pluginIdSchema = z.string().min(1);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: 'A digest is 64 lowercase hexadecimal characters',
});

const trustedShape = {
  kind: z.literal('trusted'),
  pluginId: pluginIdSchema,
  digest: digestSchema,
  manifest: pluginManifestSchema,
};
const revokedShape = { kind: z.literal('revoked'), pluginId: pluginIdSchema };
const enabledShape = { kind: z.literal('enabled'), pluginId: pluginIdSchema };
const disabledShape = { kind: z.literal('disabled'), pluginId: pluginIdSchema };

const recordedShape = {
  sequence: z.number().int().positive(),
  occurredAt: z.string().min(1),
  scope: z.literal('user'),
};

/** Validates a decision before a store keeps it or after it reads one back. */
export const pluginTrustEventSchema: z.ZodType<PluginTrustEvent> = z.discriminatedUnion('kind', [
  z.object(trustedShape).strict(),
  z.object(revokedShape).strict(),
  z.object(enabledShape).strict(),
  z.object(disabledShape).strict(),
]);

/** Validates a decision together with the fields a store adds. */
export const recordedPluginTrustEventSchema: z.ZodType<RecordedPluginTrustEvent> =
  z.discriminatedUnion('kind', [
    z.object({ ...trustedShape, ...recordedShape }).strict(),
    z.object({ ...revokedShape, ...recordedShape }).strict(),
    z.object({ ...enabledShape, ...recordedShape }).strict(),
    z.object({ ...disabledShape, ...recordedShape }).strict(),
  ]);

/** An append-only log of trust decisions. */
export interface PluginTrustStore {
  /** Records a decision and returns it as stored. Rejects a decision that is not valid. */
  append(event: PluginTrustEvent): Promise<RecordedPluginTrustEvent>;
  /** Every decision, oldest first. */
  events(): Promise<readonly RecordedPluginTrustEvent[]>;
}

/** Options of {@link createMemoryTrustStore}. */
export interface MemoryTrustStoreOptions {
  /** The clock, for tests. */
  readonly now?: (() => Date) | undefined;
}

/** A trust store that lives as long as the process. */
export function createMemoryTrustStore(options: MemoryTrustStoreOptions = {}): PluginTrustStore {
  const now = options.now ?? (() => new Date());
  const log: RecordedPluginTrustEvent[] = [];

  return {
    append(event) {
      const parsed = pluginTrustEventSchema.safeParse(event);
      if (!parsed.success) {
        return Promise.reject(new TypeError(`Invalid trust event: ${parsed.error.message}`));
      }
      const recorded = Object.freeze({
        ...parsed.data,
        sequence: log.length + 1,
        occurredAt: now().toISOString(),
        scope: 'user',
      } as RecordedPluginTrustEvent);
      log.push(recorded);
      return Promise.resolve(recorded);
    },
    events: () => Promise.resolve(Object.freeze([...log])),
  };
}

/** What the trust decisions currently say about one plugin. */
export interface PluginTrustRecord {
  readonly pluginId: string;
  /** The digest of the content the user last trusted. */
  readonly digest: string;
  /** The declarations the user saw when they trusted it. */
  readonly manifest: PluginManifest;
  /** When that was. */
  readonly trustedAt: string;
  /** Whether the user has left it switched on since. A new trust switches it on. */
  readonly enabled: boolean;
}

/**
 * Folds decisions, oldest first, into what is trusted now.
 *
 * `trusted` sets the digest, the declarations and an enabled plugin, replacing
 * an earlier trust and any switch before it. `revoked` forgets the plugin.
 * `enabled` and `disabled` flip the switch of a plugin that is trusted, and
 * mean nothing for one that is not. Events are applied in `sequence` order.
 */
export function foldTrust(
  events: readonly RecordedPluginTrustEvent[],
): ReadonlyMap<string, PluginTrustRecord> {
  const records = new Map<string, PluginTrustRecord>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const current = records.get(event.pluginId);
    switch (event.kind) {
      case 'trusted':
        records.set(event.pluginId, {
          pluginId: event.pluginId,
          digest: event.digest,
          manifest: event.manifest,
          trustedAt: event.occurredAt,
          enabled: true,
        });
        break;
      case 'revoked':
        records.delete(event.pluginId);
        break;
      case 'enabled':
      case 'disabled':
        if (current !== undefined) {
          records.set(event.pluginId, { ...current, enabled: event.kind === 'enabled' });
        }
        break;
    }
  }
  return records;
}

/**
 * Where a plugin on disk stands. `loaded` and `failed` are not here: whether a
 * plugin that may load did load is the host's to say once it has tried, and
 * this module only says it may (`eligible`).
 */
export type LocalPluginState =
  /** The directory or its declaration is broken. */
  | 'invalid'
  /** Well formed, but not for this Weave version or this way of running. */
  | 'incompatible'
  /** Never trusted. */
  | 'pending-trust'
  /** Trusted once, but the content on disk is not what the user reviewed. */
  | 'changed'
  /** Trusted, and switched off by the user. */
  | 'disabled'
  /** Trusted, switched on, and unchanged: the host should load it. */
  | 'eligible';

/** A plugin on disk together with what the user decided about it. */
export interface ResolvedLocalPlugin {
  readonly id: string;
  readonly state: LocalPluginState;
  readonly candidate: LocalPluginCandidate;
  /** The latest trust of this id, when there is one, whatever the state. */
  readonly trusted: PluginTrustRecord | undefined;
}

/**
 * Puts what is on disk next to what the user decided.
 *
 * An invalid or incompatible plugin stays so whatever it was trusted for. A
 * plugin that is well formed is `pending-trust` without a trust, `changed` when
 * its digest is not the trusted one (even if it was switched off, since it must
 * be reviewed again), `disabled` when switched off, and `eligible` otherwise.
 */
export function resolveLocalPlugins(
  candidates: readonly LocalPluginCandidate[],
  records: ReadonlyMap<string, PluginTrustRecord>,
): readonly ResolvedLocalPlugin[] {
  return candidates.map((candidate): ResolvedLocalPlugin => {
    const trusted = records.get(candidate.id);
    const resolved = (state: LocalPluginState): ResolvedLocalPlugin => ({
      id: candidate.id,
      state,
      candidate,
      trusted,
    });
    if (candidate.status !== 'ready') {
      return resolved(candidate.status);
    }
    if (trusted === undefined) {
      return resolved('pending-trust');
    }
    if (trusted.digest !== candidate.digest) {
      return resolved('changed');
    }
    return resolved(trusted.enabled ? 'eligible' : 'disabled');
  });
}

/** The ids added to and removed from a list. */
export interface ListDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/** The `contributes` keys a diff reports. */
export const contributesKeys = [
  'skills',
  'tools',
  'providers',
  'promptSections',
  'events',
  'commands',
  'hooks',
  'services',
] as const;

export type ContributesKey = (typeof contributesKeys)[number];

/** How a plugin's declarations differ between two versions of its manifest. */
export interface ManifestDiff {
  /** Set when the version differs. */
  readonly version: { readonly from: string; readonly to: string } | undefined;
  readonly capabilities: ListDiff;
  readonly contributes: Readonly<Record<ContributesKey, ListDiff>>;
  readonly permissions: ListDiff;
  /**
   * Whether the version or any list differs. A change of name, description or
   * `engines` does not count: none of them changes what the plugin can do. When
   * this is false for a plugin whose digest changed, the code changed and the
   * declarations did not, which a review has to say outright.
   */
  readonly changed: boolean;
}

function diffList(
  previous: readonly string[] | undefined,
  next: readonly string[] | undefined,
): ListDiff {
  const before = new Set(previous ?? []);
  const after = new Set(next ?? []);
  return {
    added: [...after].filter((item) => !before.has(item)),
    removed: [...before].filter((item) => !after.has(item)),
  };
}

const isEmptyDiff = (diff: ListDiff): boolean =>
  diff.added.length === 0 && diff.removed.length === 0;

/** Compares the declarations of the version the user trusted with the one on disk now. */
export function diffManifests(previous: PluginManifest, next: PluginManifest): ManifestDiff {
  const capabilities = diffList(previous.capabilities, next.capabilities);
  const permissions = diffList(previous.permissions, next.permissions);
  const contributes = Object.fromEntries(
    contributesKeys.map((key) => [
      key,
      diffList(previous.contributes?.[key], next.contributes?.[key]),
    ]),
  ) as Record<ContributesKey, ListDiff>;
  const version =
    previous.version === next.version ? undefined : { from: previous.version, to: next.version };
  return {
    version,
    capabilities,
    contributes,
    permissions,
    changed:
      version !== undefined ||
      !isEmptyDiff(capabilities) ||
      !isEmptyDiff(permissions) ||
      Object.values(contributes).some((diff) => !isEmptyDiff(diff)),
  };
}
