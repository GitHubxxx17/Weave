import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGenerationSkillCatalog,
  createSkillCatalogService,
  modelSkillCatalog,
} from '../src/skill-catalog.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function folder() {
  const root = await mkdtemp(join(tmpdir(), 'weave-skills-'));
  roots.push(root);
  return root;
}
async function skill(root: string, name: string, body: string) {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Test ${name}\n---\n${body}`,
  );
}

describe('generation Skill catalog', () => {
  it('qualifies all four sources and pins resource identity', async () => {
    const project = await folder();
    const user = await folder();
    await skill(join(project, '.weave/skills'), 'review', 'Project review');
    await skill(join(project, '.agents/skills'), 'review', 'Agent review');
    await skill(user, 'review', 'User review');
    const catalog = createGenerationSkillCatalog({
      generation: 2,
      resolveWorkspaceRoot: async () => project,
      userDirectory: user,
      pluginSkills: [
        {
          pluginId: 'example',
          name: 'review',
          description: 'Plugin review',
          instructions: 'Plugin body',
        },
      ],
    });
    const observed = await catalog.observe('session');
    expect(observed.catalog.entries.map((entry) => entry.source.kind)).toEqual([
      'project',
      'project',
      'user',
      'plugin',
      'builtin',
    ]);
    expect(new Set(observed.catalog.entries.map((entry) => entry.id)).size).toBe(5);
    expect(observed.catalog).toMatchObject({ generation: 2, complete: true, truncated: false });
    expect(JSON.stringify(observed.catalog)).not.toContain(project);
    const { id, instructionSha256, bundleSha256 } = observed.catalog.entries[0]!;
    const selected = { id, instructionSha256, bundleSha256 };
    expect((await catalog.pin(observed, selected)).instructions).toContain('Project review');
    await writeFile(join(project, '.weave/skills/review/reference.md'), 'changed resource');
    await expect(catalog.pin(observed, selected)).rejects.toMatchObject({
      code: 'skill-source-changed',
    });
  });

  it('reports invalid roots without paths and clips metadata with an explicit incomplete marker', async () => {
    const root = await folder();
    await mkdir(join(root, 'Invalid_Name'));
    const catalog = createGenerationSkillCatalog({
      generation: 1,
      userDirectory: root,
      pluginSkills: Array.from({ length: 140 }, (_, index) => ({
        pluginId: `owner-${index}`,
        name: 'large',
        description: 'description '.repeat(80),
        instructions: 'body',
      })),
    });
    const observed = await catalog.observe('session');
    expect(observed.catalog.complete).toBe(false);
    expect(observed.catalog.issues).toContainEqual({ source: 'User', code: 'unsafe-entry' });
    expect(observed.catalog.entries).toHaveLength(128);
    const model = modelSkillCatalog(observed.catalog);
    expect(Buffer.byteLength(JSON.stringify(model))).toBeLessThanOrEqual(32 * 1024);
    expect(model).toMatchObject({ complete: false, truncated: true });
  });

  it('rejects a catalog response if its generation changed during inert disk observation', async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const catalog = createGenerationSkillCatalog({
      generation: 1,
      pluginSkills: [],
      resolveWorkspaceRoot: async () => {
        entered.resolve();
        await gate.promise;
        return undefined;
      },
    });
    let current = { id: 1, resources: { skillCatalog: catalog } };
    const service = createSkillCatalogService({ current: () => current });
    const result = service.catalog('session');
    await entered.promise;
    current = {
      id: 2,
      resources: {
        skillCatalog: createGenerationSkillCatalog({ generation: 2, pluginSkills: [] }),
      },
    };
    gate.resolve();
    await expect(result).rejects.toMatchObject({ code: 'skill-catalog-stale' });
  });

  it('has inert builtins and returns complete empty for missing disk roots', async () => {
    const root = await folder();
    const catalog = createGenerationSkillCatalog({
      generation: 1,
      userDirectory: join(root, 'absent'),
      pluginSkills: [],
    });
    const observed = await catalog.observe('session');
    expect(observed.catalog.complete).toBe(true);
    const { id, instructionSha256, bundleSha256 } = observed.catalog.entries.find(
      (entry) => entry.id === 'builtin:weave-planning',
    )!;
    const builtin = { id, instructionSha256, bundleSha256 };
    const pinned = await catalog.pin(observed, builtin);
    expect(pinned.instructions).toContain('update_plan');
    expect(await pinned.readResource('references/planning.md')).toMatchObject({
      text: expect.stringContaining('completed'),
    });
  });
});
