import type { GithubPluginSource } from '@weave/plugin-host';
import type { PluginManifest } from '@weave/plugin';
import { serverHostVersion } from './host-version.js';
import type { ManagedUpdate } from './managed-plugin-catalog.js';
import { ManagedInstallerError } from './managed-plugin-installer-errors.js';
import type { ManagedPluginInstaller } from './managed-plugin-installer.js';
import type { ManagedSelectionResult } from './managed-selection-manager.js';
import { canonicalJson } from './plugin-authority-data.js';
import { PluginAuthorityError, type PluginAuthoritySnapshot } from './plugin-authority-types.js';
import {
  compareMarketplaceVersions,
  marketplaceCompatibility,
  type PluginMarketplaceCatalog,
} from './plugin-marketplace.js';

/** What the updater needs from the configured marketplace sources. */
export interface ManagedUpdateCatalogs {
  catalogs(): readonly PluginMarketplaceCatalog[];
}

export interface ManagedUpdatePreview {
  readonly pluginId: string;
  readonly previewId: string;
  readonly expiresAt: string;
  readonly expectedInstallSequence: number;
  readonly expectedTrustSequence: number;
  /** The selected digest the user reviewed the update against. */
  readonly previousSelection: string;
  readonly current: { readonly digest: string; readonly manifest: PluginManifest };
  readonly candidate: {
    readonly digest: string;
    readonly manifest: PluginManifest;
    readonly files: number;
    readonly bytes: number;
  };
  readonly update: ManagedUpdate;
  readonly github: GithubPluginSource;
}

export interface ManagedUpdateRequest {
  readonly requestId: string;
  readonly pluginId: string;
  readonly previewId: string;
  /** The candidate digest shown in the confirmation. */
  readonly candidateDigest: string;
  readonly previousSelection: string;
  readonly expectedInstallSequence: number;
  readonly expectedTrustSequence: number;
}

export interface ManagedPluginUpdater {
  updates(): ReadonlyMap<string, ManagedUpdate>;
  preview(pluginId: string, signal?: AbortSignal): Promise<ManagedUpdatePreview>;
  apply(request: ManagedUpdateRequest, signal?: AbortSignal): Promise<ManagedSelectionResult>;
}

export interface ManagedPluginUpdaterOptions {
  readonly installer: Pick<
    ManagedPluginInstaller,
    'previewGithub' | 'import' | 'applySelection' | 'snapshot'
  >;
  readonly marketplace: ManagedUpdateCatalogs | undefined;
  readonly hostVersion?: string;
  readonly monotonicNow?: () => number;
}

interface ReviewedUpdate {
  readonly pluginId: string;
  readonly candidateDigest: string;
  readonly previousSelection: string;
  readonly expectedInstallSequence: number;
  readonly expectedTrustSequence: number;
  readonly manifest: PluginManifest;
  readonly deadline: number;
}

const maxReviews = 64;
const reviewLifetimeMs = 10 * 60 * 1000;

function selectedInstallation(snapshot: PluginAuthoritySnapshot, pluginId: string) {
  const record = snapshot.installations.find((value) => value.pluginId === pluginId);
  const selection = record?.selection;
  if (record === undefined || selection === null || selection === undefined) return undefined;
  const candidate = record.candidates.find(
    ({ digest, firstImportSequence }) =>
      digest === selection.digest && firstImportSequence === selection.candidateImportSequence,
  );
  return candidate === undefined ? undefined : { selection, candidate };
}

/**
 * Finds the newest compatible release in the configured sources that is newer than
 * the selected version. Compatibility is the marketplace's own classification.
 */
export function findManagedUpdates(
  snapshot: PluginAuthoritySnapshot,
  catalogs: readonly PluginMarketplaceCatalog[],
  hostVersion: string,
): ReadonlyMap<string, ManagedUpdate & { readonly manifest: PluginManifest }> {
  const updates = new Map<string, ManagedUpdate & { readonly manifest: PluginManifest }>();
  for (const { pluginId } of snapshot.installations) {
    const installed = selectedInstallation(snapshot, pluginId);
    if (installed === undefined) continue;
    const installedVersion = installed.candidate.manifest.version;
    let best: (ManagedUpdate & { readonly manifest: PluginManifest }) | undefined;
    for (const catalog of catalogs) {
      for (const plugin of catalog.plugins) {
        if (plugin.id !== pluginId) continue;
        for (const release of plugin.releases) {
          const { manifest, source } = release;
          if (marketplaceCompatibility(manifest, hostVersion) !== 'compatible') continue;
          if (compareMarketplaceVersions(manifest.version, installedVersion) >= 0) continue;
          if (best !== undefined && compareMarketplaceVersions(manifest.version, best.version) >= 0)
            continue;
          best = { version: manifest.version, source, manifest };
        }
      }
    }
    if (best !== undefined) updates.set(pluginId, best);
  }
  return updates;
}

export function createManagedPluginUpdater(
  options: ManagedPluginUpdaterOptions,
): ManagedPluginUpdater {
  const { installer } = options;
  const hostVersion = options.hostVersion ?? serverHostVersion;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const reviews = new Map<string, ReviewedUpdate>();

  function detected(): ReadonlyMap<string, ManagedUpdate & { readonly manifest: PluginManifest }> {
    const catalogs = options.marketplace?.catalogs() ?? [];
    return findManagedUpdates(installer.snapshot().authority, catalogs, hostVersion);
  }

  function prune(): void {
    const now = monotonicNow();
    for (const [id, review] of reviews) if (now >= review.deadline) reviews.delete(id);
  }

  return {
    updates() {
      return new Map(
        [...detected()].map(([id, { version, source }]) => [id, { version, source }] as const),
      );
    },
    async preview(pluginId, signal) {
      const { authority } = installer.snapshot();
      const installed = selectedInstallation(authority, pluginId);
      const update = detected().get(pluginId);
      if (installed === undefined || update === undefined) {
        throw new PluginAuthorityError(
          'plugin-authority-not-found',
          'No compatible update is available for this plugin',
        );
      }
      prune();
      if (reviews.size >= maxReviews) throw new ManagedInstallerError('plugin-preview-capacity');
      const preview = await installer.previewGithub(update.source, signal);
      // The release listing is data from the source; the acquired content is authoritative.
      if (
        preview.candidate.manifest.id !== pluginId ||
        canonicalJson(preview.candidate.manifest) !== canonicalJson(update.manifest)
      ) {
        throw new ManagedInstallerError('plugin-artifact-unavailable');
      }
      const after = installer.snapshot().authority;
      const stillInstalled = selectedInstallation(after, pluginId);
      if (
        stillInstalled?.selection.digest !== installed.selection.digest ||
        after.heads.installSequence !== preview.expectedInstallSequence
      ) {
        throw new ManagedInstallerError('plugin-preview-stale');
      }
      const expectedTrustSequence = after.heads.trustSequence;
      reviews.set(preview.previewId, {
        pluginId,
        candidateDigest: preview.candidate.digest,
        previousSelection: installed.selection.digest,
        expectedInstallSequence: preview.expectedInstallSequence,
        expectedTrustSequence,
        manifest: preview.candidate.manifest,
        deadline: monotonicNow() + reviewLifetimeMs,
      });
      return {
        pluginId,
        previewId: preview.previewId,
        expiresAt: preview.expiresAt,
        expectedInstallSequence: preview.expectedInstallSequence,
        expectedTrustSequence,
        previousSelection: installed.selection.digest,
        current: { digest: installed.candidate.digest, manifest: installed.candidate.manifest },
        candidate: preview.candidate,
        update: { version: update.version, source: update.source },
        github: preview.github,
      };
    },
    async apply(request, signal) {
      prune();
      const review = reviews.get(request.previewId);
      // The confirmation must name exactly what was reviewed: plugin, candidate content,
      // selection it replaces and both revisions. Anything else is a stale review.
      if (
        review === undefined ||
        review.pluginId !== request.pluginId ||
        review.candidateDigest !== request.candidateDigest ||
        review.previousSelection !== request.previousSelection ||
        review.expectedInstallSequence !== request.expectedInstallSequence ||
        review.expectedTrustSequence !== request.expectedTrustSequence
      ) {
        throw new ManagedInstallerError('plugin-preview-stale');
      }
      const imported = await installer.import(
        {
          requestId: `${request.requestId}:import`,
          command: {
            kind: 'import',
            previewId: request.previewId,
            expectedInstallSequence: review.expectedInstallSequence,
          },
        },
        signal,
      );
      const { evidence } = imported.operation;
      if (
        evidence.kind !== 'import' ||
        evidence.artifact.pluginId !== request.pluginId ||
        evidence.artifact.digest !== review.candidateDigest
      ) {
        throw new PluginAuthorityError(
          'plugin-authority-conflict',
          'The imported content differs from the reviewed update',
        );
      }
      if (imported.kind === 'committed' && imported.application.status === 'failed') {
        throw new ManagedInstallerError('plugin-installer-unavailable', {
          cause: imported.application.cause,
        });
      }
      const { before, after } = imported.operation.decision;
      if (before.trustSequence !== review.expectedTrustSequence) {
        throw new PluginAuthorityError(
          'plugin-authority-conflict',
          'Plugin trust changed after the update was reviewed',
        );
      }
      const result = await installer.applySelection(
        {
          requestId: request.requestId,
          command: {
            kind: 'activate',
            pluginId: request.pluginId,
            digest: review.candidateDigest,
            manifest: review.manifest,
            previousSelection: review.previousSelection,
            expectedInstallSequence: after.installSequence,
            expectedTrustSequence: after.trustSequence,
            intent: 'activate',
          },
        },
        signal,
      );
      return result;
    },
  };
}
