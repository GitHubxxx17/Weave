import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AttributedSkillContribution, SkillContribution } from '@weave/plugin';
import {
  createSkillScanBudget,
  discoverSkillBundles,
  pinSkillBundle,
  readPinnedSkillResource,
  type DiskSkillHandle,
  type SkillRootInput,
} from '@weave/plugin-host';
import {
  skillCatalogSchema,
  skillRefSchema,
  type SkillCatalog,
  type SkillIssue,
  type SkillRef,
  type SkillSummary,
} from '@weave/protocol';
import { builtinSkills } from './skill-builtins.js';
import { SkillError, safeSkillError } from './skill-errors.js';

export const skillSha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
export const equalSkillRef = (a: SkillRef, b: SkillRef): boolean =>
  a.id === b.id && a.instructionSha256 === b.instructionSha256 && a.bundleSha256 === b.bundleSha256;
export interface PinnedServerSkill {
  readonly summary: SkillSummary;
  readonly instructions: string;
  readResource(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ readonly text: string; readonly sha256: string }>;
}
interface SkillDefinition {
  readonly summary: SkillSummary;
  pin(signal?: AbortSignal): Promise<PinnedServerSkill>;
}
export interface SkillObservation {
  readonly catalog: SkillCatalog;
  readonly definitions: ReadonlyMap<string, SkillDefinition>;
}
export interface GenerationSkillCatalog {
  observe(sessionId: string, signal?: AbortSignal): Promise<SkillObservation>;
  pin(
    observation: SkillObservation,
    ref: SkillRef,
    signal?: AbortSignal,
  ): Promise<PinnedServerSkill>;
}
export interface GenerationSkillCatalogOptions {
  readonly generation: number;
  readonly resolveWorkspaceRoot?: ((sessionId: string) => Promise<string | undefined>) | undefined;
  readonly userDirectory?: string | false | undefined;
  readonly pluginSkills:
    readonly AttributedSkillContribution[] | (() => readonly AttributedSkillContribution[]);
}
function canonicalCatalog(
  generation: number,
  entries: readonly SkillSummary[],
  issues: readonly SkillIssue[],
  complete: boolean,
  truncated: boolean,
): SkillCatalog {
  return Object.freeze(
    skillCatalogSchema.parse({
      schemaVersion: 1,
      generation,
      entries,
      issues,
      complete,
      truncated,
      fingerprint: skillSha256(JSON.stringify([entries, complete, truncated])),
    }),
  );
}
export function modelSkillCatalog(catalog: SkillCatalog): SkillCatalog {
  const entries = [...catalog.entries];
  const issues = [...catalog.issues];
  let clipped = catalog.truncated;
  let result = canonicalCatalog(catalog.generation, entries, issues, catalog.complete, clipped);
  while (
    Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 &&
    (entries.length > 0 || issues.length > 0)
  ) {
    if (entries.length > 0) entries.pop();
    else issues.pop();
    clipped = true;
    result = canonicalCatalog(catalog.generation, entries, issues, false, clipped);
  }
  return result;
}
function inlineDefinition(contribution: SkillContribution, owner?: string): SkillDefinition {
  const instructions = contribution.instructions.replace(/^\uFEFF/u, '').replace(/\r\n/g, '\n');
  const invocation = Object.freeze({
    user: contribution.invocation?.user ?? true,
    model: contribution.invocation?.model ?? true,
  });
  const resources = Object.entries(contribution.resources ?? {}).sort(([a], [b]) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  const instructionSha256 = skillSha256(instructions);
  const summary: SkillSummary = Object.freeze({
    id:
      owner === undefined ? `builtin:${contribution.name}` : `plugin:${owner}/${contribution.name}`,
    name: contribution.name,
    description: contribution.description,
    instructionSha256,
    bundleSha256: skillSha256(
      JSON.stringify([
        contribution.name,
        contribution.description,
        invocation.user,
        invocation.model,
        instructionSha256,
        resources.map(([path, text]) => [path, skillSha256(text), Buffer.byteLength(text)]),
      ]),
    ),
    invocation,
    source: Object.freeze(
      owner === undefined
        ? { kind: 'builtin', label: 'Weave' }
        : { kind: 'plugin', label: owner, pluginId: owner },
    ),
  });
  const contents = new Map(resources);
  return {
    summary,
    async pin(signal) {
      signal?.throwIfAborted();
      return Object.freeze({
        summary,
        instructions,
        async readResource(path: string, readSignal?: AbortSignal) {
          readSignal?.throwIfAborted();
          const text = contents.get(path);
          if (text === undefined)
            throw new SkillError('skill-not-found', 'The Skill resource does not exist');
          return { text, sha256: skillSha256(text) };
        },
      });
    },
  };
}
async function rootIdentity(directory: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(directory);
  } catch {
    canonical = resolve(directory);
  }
  return skillSha256(canonical).slice(0, 32);
}
/** A generation owns only enabled immutable inline contributions; disk reads remain inert. */
export function createGenerationSkillCatalog(
  options: GenerationSkillCatalogOptions,
): GenerationSkillCatalog {
  return {
    async observe(sessionId, signal) {
      signal?.throwIfAborted();
      const definitions = new Map<string, SkillDefinition>();
      const issues: SkillIssue[] = [];
      let complete = true;
      let truncated = false;
      const workspace = await options.resolveWorkspaceRoot?.(sessionId);
      const roots: { root: SkillRootInput; kind: 'project' | 'user'; prefix: string }[] = [];
      if (workspace !== undefined) {
        const hash = await rootIdentity(workspace);
        roots.push({
          root: {
            id: `project:${hash}/native`,
            directory: join(workspace, '.weave/skills'),
            label: 'Project .weave',
          },
          kind: 'project',
          prefix: `project:${hash}/native`,
        });
        roots.push({
          root: {
            id: `project:${hash}/agents`,
            directory: join(workspace, '.agents/skills'),
            label: 'Project .agents',
          },
          kind: 'project',
          prefix: `project:${hash}/agents`,
        });
      }
      if (typeof options.userDirectory === 'string') {
        const hash = await rootIdentity(options.userDirectory);
        roots.push({
          root: { id: `user:${hash}`, directory: options.userDirectory, label: 'User' },
          kind: 'user',
          prefix: `user:${hash}`,
        });
      }
      const budget = createSkillScanBudget();
      for (const { root, kind, prefix } of roots) {
        signal?.throwIfAborted();
        const discovered = await discoverSkillBundles({
          root,
          budget,
          ...(signal === undefined ? {} : { signal }),
        });
        complete &&= discovered.complete;
        truncated ||= discovered.truncated;
        for (const issue of discovered.issues) {
          const code = issue.code.includes('limit')
            ? 'limit-exceeded'
            : issue.code.includes('unsafe')
              ? 'unsafe-entry'
              : issue.code.includes('changed')
                ? 'source-changed'
                : issue.code.includes('invalid')
                  ? 'invalid-document'
                  : 'unreadable';
          issues.push({
            source: root.label,
            code,
            ...(issue.name === undefined ||
            issue.name.length > 64 ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(issue.name)
              ? {}
              : { skillId: `${prefix}/${issue.name}` }),
          });
        }
        for (const bundle of discovered.bundles) {
          const summary: SkillSummary = Object.freeze({
            id: `${prefix}/${bundle.name}`,
            name: bundle.name,
            description: bundle.description,
            instructionSha256: bundle.handle.instructionSha256,
            bundleSha256: bundle.handle.bundleSha256,
            source: Object.freeze({ kind, label: root.label }),
            invocation: bundle.invocation,
          });
          const handle: DiskSkillHandle = bundle.handle;
          definitions.set(summary.id, {
            summary,
            async pin(pinSignal) {
              try {
                const pinned = await pinSkillBundle({
                  root,
                  handle,
                  ...(pinSignal === undefined ? {} : { signal: pinSignal }),
                });
                return Object.freeze({
                  summary,
                  instructions: pinned.instructions,
                  async readResource(path: string, resourceSignal?: AbortSignal) {
                    try {
                      return await readPinnedSkillResource({
                        root,
                        bundle: pinned,
                        path,
                        ...(resourceSignal === undefined ? {} : { signal: resourceSignal }),
                      });
                    } catch (error: unknown) {
                      throw safeSkillError(error);
                    }
                  },
                });
              } catch (error: unknown) {
                throw safeSkillError(error);
              }
            },
          });
        }
      }
      const plugins =
        typeof options.pluginSkills === 'function' ? options.pluginSkills() : options.pluginSkills;
      if (plugins.length + builtinSkills.length > 128) {
        complete = false;
        truncated = true;
        issues.push({ source: 'Plugins', code: 'limit-exceeded' });
      }
      for (const contribution of plugins.slice(0, 128 - builtinSkills.length)) {
        const definition = inlineDefinition(contribution, contribution.pluginId);
        if (definitions.has(definition.summary.id))
          throw new SkillError('skill-unavailable', 'Duplicate Skill contribution');
        definitions.set(definition.summary.id, definition);
      }
      for (const contribution of builtinSkills) {
        const definition = inlineDefinition(contribution);
        definitions.set(definition.summary.id, definition);
      }
      const entries = [...definitions.values()].map(({ summary }) => summary);
      if (entries.length > 512 || issues.length > 64) {
        complete = false;
        truncated = true;
      }
      const retained = entries.slice(0, 512);
      return Object.freeze({
        catalog: canonicalCatalog(
          options.generation,
          retained,
          issues.slice(0, 64),
          complete,
          truncated,
        ),
        definitions: new Map(retained.map((summary) => [summary.id, definitions.get(summary.id)!])),
      });
    },
    async pin(observation, rawRef, signal) {
      const ref = skillRefSchema.parse(rawRef);
      const definition = observation.definitions.get(ref.id);
      if (definition === undefined)
        throw new SkillError('skill-not-found', 'The Skill does not exist in this catalog');
      if (!equalSkillRef(definition.summary, ref))
        throw new SkillError('skill-source-changed', 'The Skill changed; select it again');
      signal?.throwIfAborted();
      return definition.pin(signal);
    },
  };
}

export interface SkillCatalogService {
  catalog(sessionId: string, signal?: AbortSignal): Promise<SkillCatalog>;
  preview(
    sessionId: string,
    ref: SkillRef,
    signal?: AbortSignal,
  ): Promise<{ readonly skill: SkillSummary; readonly instructions: string }>;
}
/** Capture and recheck the exact current generation around asynchronous inert discovery. */
export function createSkillCatalogService(options: {
  readonly current: () =>
    | { readonly id: number; readonly resources: { readonly skillCatalog: GenerationSkillCatalog } }
    | undefined;
}): SkillCatalogService {
  return {
    async catalog(sessionId, signal) {
      const generation = options.current();
      if (generation === undefined)
        throw new SkillError('skill-unavailable', 'Skills are unavailable');
      const observed = await generation.resources.skillCatalog.observe(sessionId, signal);
      if (options.current() !== generation)
        throw new SkillError(
          'skill-catalog-stale',
          'The Skill catalog generation changed; refresh it',
        );
      return observed.catalog;
    },
    async preview(sessionId, ref, signal) {
      const generation = options.current();
      if (generation === undefined)
        throw new SkillError('skill-unavailable', 'Skills are unavailable');
      const observed = await generation.resources.skillCatalog.observe(sessionId, signal);
      const pinned = await generation.resources.skillCatalog.pin(observed, ref, signal);
      if (options.current() !== generation)
        throw new SkillError(
          'skill-catalog-stale',
          'The Skill catalog generation changed; refresh it',
        );
      return { skill: pinned.summary, instructions: pinned.instructions };
    },
  };
}
