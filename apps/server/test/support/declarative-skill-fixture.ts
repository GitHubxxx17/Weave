import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginManifest } from '@weave/plugin';

/** A real no-entry payload: the only registration is the host's Skill adapter. */
export async function writeDeclarativeSkillFixture(
  directory: string,
  options: {
    readonly id?: string;
    readonly version?: string;
    readonly instructions?: string;
    readonly resource?: string;
    readonly engines?: { readonly weave: string };
  } = {},
): Promise<PluginManifest> {
  const manifest: PluginManifest = {
    id: options.id ?? 'notes',
    name: 'Notes Skills',
    version: options.version ?? '1.0.0',
    apiVersion: '1.0.0',
    host: 'declarative',
    capabilities: ['skill'],
    contributes: { skills: ['review'] },
    permissions: [],
    ...(options.engines === undefined ? {} : { engines: options.engines }),
  };
  await mkdir(join(directory, 'skills/review/references'), { recursive: true });
  await writeFile(
    join(directory, 'weave-plugin.json'),
    JSON.stringify({ schemaVersion: 2, kind: 'skills', manifest }),
  );
  await writeFile(
    join(directory, 'skills/review/SKILL.md'),
    `---\nname: review\ndescription: Review the current work\n---\n${options.instructions ?? 'Review immutable first-version instructions.'}\n`,
  );
  await writeFile(
    join(directory, 'skills/review/references/checklist.md'),
    options.resource ?? 'First-version review checklist.',
  );
  return manifest;
}
