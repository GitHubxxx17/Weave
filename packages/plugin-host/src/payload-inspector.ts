import path from 'node:path';
import fs from 'node:fs/promises';

import { assertHostVersion, skillContributionSchema, type SkillContribution } from '@weave/plugin';
import { z } from 'zod';

import { checkPayload, type CheckedPayload } from './artifact-copy.js';
import {
  artifactDirectorySchema,
  PluginArtifactError,
  type PluginArtifact,
} from './artifact-types.js';
import { descriptorFileName, parseDescriptor, type SkillsPluginDescriptor } from './descriptor.js';
import { type DigestLimits } from './digest.js';
import { incompatibility, resolveEntry } from './discovery.js';
import { PluginHostError } from './errors.js';
import { parseSkillDocument } from './skill-document.js';
import { SkillHostError } from './skill-types.js';

export interface InspectPluginPayloadOptions {
  /** Omitted: offline payload/API/host validation only; engine compatibility stays with admission. */
  readonly hostVersion?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly limits?: Partial<DigestLimits> | undefined;
}
const optionsSchema = z.strictObject({
  hostVersion: z.string().optional(),
  signal: z.instanceof(AbortSignal).optional(),
  limits: z
    .strictObject({
      maxFiles: z.number().int().nonnegative().optional(),
      maxBytes: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export function freezePayload<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freezePayload(child);
    Object.freeze(value);
  }
  return value;
}
const invalid = (message: string, cause?: unknown) =>
  new PluginArtifactError('plugin-artifact-invalid', message, { cause });

function decode(bytes: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('NUL');
    return text;
  } catch (cause: unknown) {
    throw invalid('Skill packages require strict UTF-8 text without NUL', cause);
  }
}

function skillData(
  checked: CheckedPayload,
  descriptor: SkillsPluginDescriptor,
): readonly SkillContribution[] {
  const names = descriptor.manifest.contributes!.skills!;
  const rootFiles = new Set([descriptorFileName, 'README.md', 'LICENSE', 'NOTICE']);
  const seen = new Set<string>();
  for (const relative of [...checked.directories.filter(Boolean), ...checked.paths]) {
    const portable = relative.normalize('NFC').toLowerCase();
    if (
      seen.has(portable) ||
      relative
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[<>:"\\|?*\p{Cc}]/u.test(part) ||
            /[ .]$/.test(part) ||
            /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
        )
    )
      throw invalid('Skill packages require portable, unique payload names');
    seen.add(portable);
    const [root, name] = relative.split('/');
    if (root !== 'skills') {
      if (!rootFiles.has(relative) || checked.directories.includes(relative))
        throw invalid('Skill package contains an undeclared payload root');
    } else if (name !== undefined && !names.includes(name)) {
      throw invalid('Skill package contains an undeclared Skill directory');
    }
  }
  let resources = 0;
  let resourceBytes = 0;
  const contributions = names.map((name): SkillContribution => {
    const base = `skills/${name}/`;
    const document = checked.contents!.get(`${base}SKILL.md`);
    if (document === undefined) throw invalid('A declared Skill document is missing');
    const parsed = parseSkillDocument(decode(document), name);
    const data: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [relative, bytes] of checked.contents!) {
      if (!relative.startsWith(base) || relative === `${base}SKILL.md`) continue;
      resources++;
      resourceBytes += bytes.length;
      if (resources > 64 || bytes.length > 256 * 1024 || resourceBytes > 2 * 1024 * 1024)
        throw invalid('Skill package resources exceed their file or byte limits');
      data[relative.slice(base.length)] = decode(bytes);
    }
    return skillContributionSchema.parse({
      name,
      description: parsed.description,
      instructions: parsed.instructions,
      invocation: parsed.invocation,
      resources: data,
    });
  });
  for (const [relative, bytes] of checked.contents!) {
    if (rootFiles.has(relative)) {
      if (bytes.length > 64 * 1024) throw invalid('Skill package root text exceeds 64 KiB');
      decode(bytes);
    }
  }
  return freezePayload(contributions);
}

/** Shared inert validator. It creates no managed store and runs no package code. */
export async function inspectPluginPayload(
  directory: string,
  options: InspectPluginPayloadOptions = {},
): Promise<PluginArtifact> {
  const parsedDirectory = artifactDirectorySchema.safeParse(directory);
  const parsedOptions = optionsSchema.safeParse(options);
  if (!parsedDirectory.success || !parsedOptions.success)
    throw invalid('Invalid payload inspection options');
  assertHostVersion(options.hostVersion);
  options.signal?.throwIfAborted();
  if (!(await fs.lstat(directory)).isDirectory())
    throw new PluginArtifactError(
      'plugin-artifact-unsupported-file',
      'The payload must be a real directory',
    );
  const normalized = await fs.realpath(path.resolve(directory));
  options.signal?.throwIfAborted();
  return inspectCheckedPluginPayload(
    normalized,
    await checkPayload(normalized, options.signal, {
      collectContents: true,
      limits: options.limits,
    }),
    options,
    options.hostVersion !== undefined,
  );
}

/** Artifact staging supplies the exact same checked bytes and digest recipe. */
export async function inspectCheckedPluginPayload(
  directory: string,
  checked: CheckedPayload,
  options: InspectPluginPayloadOptions,
  checkEngine = true,
): Promise<PluginArtifact> {
  const { digest, files, bytes, descriptorText, paths } = checked;
  if (descriptorText === undefined) throw invalid('The plugin descriptor is missing');
  try {
    const descriptor = parseDescriptor(descriptorText);
    const manifest = descriptor.manifest;
    const compatibleInput = checkEngine
      ? manifest
      : {
          ...manifest,
          engines: undefined,
        };
    const incompatible = incompatibility(compatibleInput, options.hostVersion);
    if (incompatible !== undefined)
      throw invalid(`The plugin is incompatible (${incompatible.code})`, incompatible);
    options.signal?.throwIfAborted();
    if (descriptor.schemaVersion === 2) {
      const skills = skillData(checked, descriptor);
      options.signal?.throwIfAborted();
      return freezePayload({ kind: 'skills', directory, descriptor, digest, files, bytes, skills });
    }
    const entry = await resolveEntry(directory, descriptor, descriptor.manifest.id);
    if (!paths.has(path.relative(directory, entry).split(path.sep).join('/')))
      throw invalid('The plugin entry is outside the digested files');
    options.signal?.throwIfAborted();
    return freezePayload({ kind: 'entry', directory, descriptor, digest, files, bytes, entry });
  } catch (error: unknown) {
    if (options.signal?.aborted) throw error;
    if (error instanceof PluginArtifactError) throw error;
    if (error instanceof PluginHostError)
      throw invalid(`The plugin descriptor or entry is invalid (${error.code})`, error);
    if (error instanceof SkillHostError || error instanceof z.ZodError)
      throw invalid('The Skill payload is invalid', error);
    throw error;
  }
}
