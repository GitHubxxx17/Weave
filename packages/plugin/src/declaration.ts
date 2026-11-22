import {
  type ContributedNameKey,
  type PluginContributes,
  type PluginManifest,
} from './manifest.js';
import { PluginError } from './plugin-errors.js';
import { parseVersion, parseVersionRange } from './version-range.js';

/**
 * Enforcement of the declarative half of a manifest (`engines`, `contributes`,
 * `permissions`). A plugin that declares none of them is not checked; a plugin
 * that declares one is held to it exactly.
 */

/** Service ids a plugin provides and uses, and hook ids it listens to, recorded while its `setup` runs. */
export interface ServiceUsage {
  readonly provided: Set<string>;
  readonly used: Set<string>;
  readonly hooks: Set<string>;
  /**
   * Set by the kernel once `setup` has been checked. A `use` after that point
   * can no longer be deferred to the end of `setup`, so it is checked at once.
   */
  closed: boolean;
}

/** Creates an empty usage record for one plugin's `setup`. */
export function createServiceUsage(): ServiceUsage {
  return { provided: new Set(), used: new Set(), hooks: new Set(), closed: false };
}

const kindLabels: Record<ContributedNameKey | 'services' | 'hooks', string> = {
  tools: 'tool',
  providers: 'provider',
  promptSections: 'prompt section',
  events: 'event',
  commands: 'command',
  skills: 'skill',
  panels: 'panel',
  hooks: 'hook',
  services: 'service',
};

/** Throws unless `hostVersion` is absent or a full numeric `x.y.z`. */
export function assertHostVersion(hostVersion: string | undefined): void {
  if (hostVersion !== undefined && parseVersion(hostVersion) === undefined) {
    throw new TypeError(`hostVersion "${hostVersion}" must be a full x.y.z version`);
  }
}

/**
 * Rejects a plugin whose `engines.weave` the host does not satisfy. A host
 * that did not declare its version cannot be satisfied, so it rejects too.
 */
export function assertEngineSupported(
  manifest: PluginManifest,
  hostVersion: string | undefined,
): void {
  const range = manifest.engines?.weave;
  if (range === undefined) {
    return;
  }
  if (hostVersion === undefined) {
    throw new PluginError(
      'plugin-engine-unsupported',
      `Plugin "${manifest.id}" requires Weave "${range}" but the host did not declare its Weave version`,
      { pluginId: manifest.id },
    );
  }
  if (!parseVersionRange(range).test(hostVersion)) {
    throw new PluginError(
      'plugin-engine-unsupported',
      `Plugin "${manifest.id}" requires Weave "${range}", host is "${hostVersion}"`,
      { pluginId: manifest.id },
    );
  }
}

/** Throws when `contributes` is declared and does not list `name` under `key`. */
export function assertNameDeclared(
  pluginId: string,
  contributes: PluginContributes | undefined,
  key: ContributedNameKey | 'services' | 'hooks',
  name: string,
): void {
  if (
    (contributes === undefined && key !== 'panels') ||
    contributes?.[key]?.includes(name) === true
  ) {
    return;
  }
  throw new PluginError(
    'plugin-contributes-exceeds-manifest',
    `Plugin "${pluginId}" contributed ${kindLabels[key]} "${name}" but its manifest contributes.${key} does not list it`,
    { pluginId },
  );
}

function permissionDenied(manifest: PluginManifest, id: string): PluginError {
  return new PluginError(
    'plugin-permission-denied',
    `Plugin "${manifest.id}" uses service "${id}" but its manifest permissions do not include "service:${id}"`,
    { pluginId: manifest.id },
  );
}

function isServiceGranted(manifest: PluginManifest, usage: ServiceUsage, id: string): boolean {
  const permissions = manifest.permissions;
  return (
    permissions === undefined || usage.provided.has(id) || permissions.includes(`service:${id}`)
  );
}

/**
 * Throws when a plugin that declared `permissions` used a service they do not
 * grant as `service:<id>`. Services the plugin provides itself are exempt.
 * Called once `setup` has finished, so the order of `provide` and `use` calls
 * inside `setup` does not matter.
 */
export function assertServicePermissions(manifest: PluginManifest, usage: ServiceUsage): void {
  for (const id of usage.used) {
    if (!isServiceGranted(manifest, usage, id)) {
      throw permissionDenied(manifest, id);
    }
  }
}

/** Checks one `use` that happens after `setup` has been checked. */
export function assertServiceUse(manifest: PluginManifest, usage: ServiceUsage, id: string): void {
  if (!isServiceGranted(manifest, usage, id)) {
    throw permissionDenied(manifest, id);
  }
}
