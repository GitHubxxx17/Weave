import path from 'node:path';

import { pluginManifestSchema, type PluginManifest } from '@weave/plugin';
import { z } from 'zod';

import { describeError, PluginHostError } from './errors.js';

/** The file in a plugin's directory that declares the plugin. */
export const descriptorFileName = 'weave-plugin.json';

/** The largest descriptor file the host reads. */
export const maxDescriptorBytes = 64 * 1024;

/** The checked content of a plugin's `weave-plugin.json`. */
export interface EntryPluginDescriptor {
  readonly schemaVersion: 1;
  /** The entry module, relative to the plugin directory: normalised and `/`-separated. */
  readonly entry: string;
  /** What the user is asked to trust. It comes from this file, never from running the plugin. */
  readonly manifest: PluginManifest;
}

export interface SkillsPluginDescriptor {
  readonly schemaVersion: 2;
  readonly kind: 'skills';
  readonly manifest: PluginManifest;
  readonly entry?: never;
}

export type PluginDescriptor = EntryPluginDescriptor | SkillsPluginDescriptor;

/** Why `entry` cannot name a module inside the plugin directory, or `undefined` when it can. */
function entryProblem(entry: string): string | undefined {
  if (entry.includes('\0')) {
    return 'must not contain a NUL character';
  }
  if (entry.includes('\\')) {
    return 'must use "/" as the path separator';
  }
  if (path.posix.isAbsolute(entry) || /^[A-Za-z]:/.test(entry)) {
    return 'must be relative to the plugin directory';
  }
  const segments = entry.split('/');
  if (segments.includes('..')) {
    return 'must not contain ".."';
  }
  if (segments.includes('')) {
    return 'must not contain an empty path segment';
  }
  if (!/^.+\.m?js$/.test(segments[segments.length - 1] ?? '')) {
    return 'must name a .js or .mjs file';
  }
  return undefined;
}

const entrySchema = z
  .string()
  .min(1)
  .max(255)
  .superRefine((entry, context) => {
    const problem = entryProblem(entry);
    if (problem !== undefined) {
      context.addIssue({ code: 'custom', message: `entry ${problem}` });
    }
  });

const entryDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    entry: entrySchema,
    manifest: pluginManifestSchema,
  })
  .strict();

const skillsDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal('skills'),
  manifest: pluginManifestSchema,
});

function summarize(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) => `${issue.path.length === 0 ? '(file)' : issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ');
}

/**
 * Parses the text of a `weave-plugin.json`.
 *
 * Beyond the manifest schema, a plugin loaded from disk must declare
 * `contributes` and `permissions` (either may be empty), because those
 * declarations are what the user is shown before trusting it. Throws
 * `plugin-invalid-descriptor` for anything that does not hold. `host` and
 * version compatibility are not checked here: an incompatible plugin is still
 * well formed, and discovery reports it as such.
 */
export function parseDescriptor(text: string): PluginDescriptor {
  // Editors on some platforms save a byte order mark that JSON.parse rejects.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error: unknown) {
    throw new PluginHostError(
      'plugin-invalid-descriptor',
      `${descriptorFileName} is not valid JSON: ${describeError(error)}`,
      { cause: error },
    );
  }

  // Keep legacy error paths and normalization byte-compatible.
  const parsed = (
    typeof json === 'object' && json !== null && 'schemaVersion' in json && json.schemaVersion === 2
      ? skillsDescriptorSchema
      : entryDescriptorSchema
  ).safeParse(json);
  if (!parsed.success) {
    throw new PluginHostError(
      'plugin-invalid-descriptor',
      `${descriptorFileName} is invalid: ${summarize(parsed.error)}`,
      { cause: parsed.error },
    );
  }

  const { manifest } = parsed.data;
  const undeclared = (['contributes', 'permissions'] as const).filter(
    (key) => manifest[key] === undefined,
  );
  if (undeclared.length > 0) {
    throw new PluginHostError(
      'plugin-invalid-descriptor',
      `Plugin "${manifest.id}" must declare ${undeclared.join(' and ')} in its manifest, even when empty: they are what the user is asked to trust`,
      { pluginId: manifest.id },
    );
  }

  if (parsed.data.schemaVersion === 2) {
    const names = manifest.contributes?.skills;
    if (
      manifest.host !== 'declarative' ||
      manifest.capabilities.length !== 1 ||
      manifest.capabilities[0] !== 'skill' ||
      manifest.permissions?.length !== 0 ||
      names === undefined ||
      names.length < 1 ||
      names.length > 16 ||
      Object.keys(manifest.contributes ?? {}).some((key) => key !== 'skills')
    ) {
      throw new PluginHostError(
        'plugin-invalid-descriptor',
        'Skill packages require declarative host, only skill capability/contributions, 1–16 Skills and empty permissions',
        { pluginId: manifest.id },
      );
    }
    return { schemaVersion: 2, kind: 'skills', manifest };
  }
  if (manifest.host === 'declarative') {
    throw new PluginHostError(
      'plugin-invalid-descriptor',
      'An executable descriptor cannot claim a declarative host',
      { pluginId: manifest.id },
    );
  }
  return { schemaVersion: 1, entry: path.posix.normalize(parsed.data.entry), manifest };
}
