import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPluginPayload } from '@weave/plugin-host';
import { skillCatalogSchema, skillPageSchema, type SkillRef } from '@weave/protocol';
import { agentRuntimeEventSchema, type AgentRuntimeEvent } from '@weave/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getServerSessionStore } from '../src/runtime.js';
import type { ImportPreviewResponse } from '../src/managed-plugin-catalog.js';
import {
  createInstallerHttpFixture,
  importBody,
} from './support/managed-plugin-installer-http-fixture.js';
import { activateInput } from './support/plugin-authority-fixtures.js';
import { createSqliteProjectStore } from '@weave/workspace';
import { runExecutionToLegacyResponse } from './execution-http-fixture.js';

const payload = fileURLToPath(
  new URL('../../../plugins/official/weave-official-skills', import.meta.url),
);
const pluginId = 'weave-official-skills';
const names = ['weave-guide', 'weave-plugin-author', 'weave-skill-author', 'weave-mcp-guide'];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const exactRef = ({ id, instructionSha256, bundleSha256 }: SkillRef): SkillRef => ({
  id,
  instructionSha256,
  bundleSha256,
});
async function fixture() {
  const f = await createInstallerHttpFixture(cleanups, []);
  const source = join(f.root, 'official-source');
  await cp(payload, source, { recursive: true });
  await f.startUnbound({ skillsDirectory: false });
  await getServerSessionStore(f.server().runtime).append('official-session', [
    { type: 'session.created', payload: { title: 'Official Skills' } },
  ]);
  const projects = createSqliteProjectStore({ filename: f.databaseFile });
  const project = await projects.createProject({
    name: 'Official Skills',
    folderName: 'official',
    folderPath: f.root,
  });
  await projects.attachSession(project.id, 'official-session');
  await projects.close();
  return { f, source };
}
type Fixture = Awaited<ReturnType<typeof fixture>>['f'];
async function catalog(f: Fixture) {
  return skillCatalogSchema.parse(await f.http('/sessions/official-session/skills'));
}
async function activate(
  f: Fixture,
  candidate: ImportPreviewResponse['candidate'],
  requestId: string,
  intent: 'activate' | 'rollback' = 'activate',
) {
  return f.select(
    activateInput(requestId, f.snapshot(), { ...candidate, pluginId }, intent).request,
  );
}
async function decision(f: Fixture, kind: 'disable' | 'enable' | 'revoke', requestId: string) {
  const snapshot = f.snapshot();
  const record = snapshot.installations.find((row) => row.pluginId === pluginId)!;
  return f.select({
    requestId,
    command: {
      kind,
      pluginId,
      selectedDigest: record.selection?.digest ?? null,
      expectedInstallSequence: snapshot.heads.installSequence,
      expectedTrustSequence: snapshot.heads.trustSequence,
    },
  });
}
async function run(
  f: Fixture,
  skill: SkillRef,
  path: string,
  selected = true,
  provider = 'mock',
): Promise<AgentRuntimeEvent[]> {
  const response = await runExecutionToLegacyResponse(f.server(), {
    sessionId: 'official-session',
    provider,
    model: 'fixture',
    ...(selected ? { skills: [skill] } : {}),
    userMessage: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `/tool read_skill ${JSON.stringify({ skill })}\n/tool read_skill_resource ${JSON.stringify({ skill, path })}`,
        },
      ],
    },
  });
  const responseText = await response.text();
  expect(response.status, responseText).toBe(200);
  return responseText
    .split(/\r?\n\r?\n/)
    .filter((frame) => frame.startsWith('event: '))
    .map((frame) => {
      const line = frame.split(/\r?\n/).find((value) => value.startsWith('data: '));
      expect(line).toBeDefined();
      const data: unknown = JSON.parse(line!.slice(6));
      if (frame.startsWith('event: error')) {
        const parsed = z
          .object({ error: z.object({ code: z.string(), message: z.string() }) })
          .parse(data);
        throw new Error(parsed.error.code);
      }
      return agentRuntimeEventSchema.parse(data);
    });
}
function pages(events: readonly AgentRuntimeEvent[]) {
  return events
    .filter((event) => event.type === 'tool-result')
    .map((event) => {
      expect(event.status).not.toBe('failed');
      expect(event.errorCode).toBeUndefined();
      expect(event.result.truncated).toBe(false);
      return skillPageSchema.parse(JSON.parse(event.result.content));
    });
}

describe('actual Weave-maintained Skills content and delivery', () => {
  it('loads four self-contained real instruction/resource bundles with confined references', async () => {
    const artifact = await inspectPluginPayload(payload);
    expect(artifact.kind).toBe('skills');
    if (artifact.kind !== 'skills') throw new Error('Expected text payload');
    expect(artifact.descriptor.manifest).toMatchObject({
      id: pluginId,
      host: 'declarative',
      capabilities: ['skill'],
      permissions: [],
    });
    expect(artifact).not.toHaveProperty('entry');
    expect(artifact.skills.map((skill) => skill.name).sort()).toEqual([...names].sort());
    let references = 0;
    for (const skill of artifact.skills) {
      const base = join(payload, 'skills', skill.name);
      const documents = [
        { path: 'SKILL.md', text: skill.instructions },
        ...Object.entries(skill.resources ?? {}).map(([path, text]) => ({ path, text })),
      ];
      expect(skill.invocation).toEqual({ user: true, model: true });
      for (const document of documents) {
        for (const match of document.text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
          if (/^[a-z]+:/.test(match[1]!) || match[1]!.startsWith('#')) continue;
          const target = resolve(dirname(join(base, document.path)), match[1]!.split('#')[0]!);
          expect(target.startsWith(`${base}/`)).toBe(true);
          expect((await readFile(target, 'utf8')).trim()).not.toBe('');
          references++;
        }
      }
    }
    expect(references).toBeGreaterThanOrEqual(17);
  });

  it('imports inert data then delivers each exact real Skill and resource through HTTP/SSE, persisting after source deletion and restart', async () => {
    const { f, source } = await fixture();
    const artifact = await inspectPluginPayload(source);
    if (artifact.kind !== 'skills') throw new Error('Expected Skills');
    const preview = await f.preview(source);
    const request = importBody('official-import', preview);
    expect(await f.import(request)).toMatchObject({ application: { status: 'not-required' } });
    expect(
      (await catalog(f)).entries.some((entry) => entry.id.startsWith(`plugin:${pluginId}/`)),
    ).toBe(false);
    expect(f.snapshot().trustEvents).toEqual([]);
    expect(await activate(f, preview.candidate, 'official-activate')).toMatchObject({
      application: { status: 'applied' },
    });
    const active = (await catalog(f)).entries.filter((entry) =>
      entry.id.startsWith(`plugin:${pluginId}/`),
    );
    expect(active.map((entry) => entry.name).sort()).toEqual([...names].sort());
    for (const entry of active) {
      const ref = exactRef(entry);
      const content = artifact.skills.find((skill) => skill.name === entry.name)!;
      const [path, text] = Object.entries(content.resources!).find(([path]) =>
        path.startsWith('references/'),
      )!;
      const events = await run(f, ref, path);
      expect(events.filter((event) => event.type === 'failed')).toEqual([]);
      expect(events.filter((event) => event.type === 'completed')).toHaveLength(1);
      const output = pages(events);
      expect(output).toHaveLength(2);
      expect(output[0]).toMatchObject({
        skill: ref,
        kind: 'instructions',
        text: content.instructions,
        contentSha256: ref.instructionSha256,
        offset: 0,
        eof: true,
      });
      expect(output[1]).toMatchObject({
        skill: ref,
        kind: 'resource',
        path,
        text,
        contentSha256: sha(text),
        offset: 0,
        eof: true,
      });
      const detail = await f.http('/sessions/official-session');
      expect(detail).toMatchObject({
        turns: expect.arrayContaining([
          expect.objectContaining({
            skills: expect.objectContaining({
              requested: [ref],
              applications: expect.arrayContaining([
                expect.objectContaining({
                  skill: expect.objectContaining(ref),
                  invocation: 'user',
                  delivery: 'prepared',
                }),
              ]),
              failures: [],
            }),
          }),
        ]),
      });
    }
    const modelGuide = active.find((entry) => entry.name === 'weave-guide')!;
    pages(await run(f, exactRef(modelGuide), 'references/product-and-navigation.md', false));
    expect(await f.http('/sessions/official-session')).toMatchObject({
      turns: expect.arrayContaining([
        expect.objectContaining({
          skills: expect.objectContaining({
            requested: [],
            applications: expect.arrayContaining([
              expect.objectContaining({ invocation: 'model', delivery: 'delivered' }),
            ]),
          }),
        }),
      ]),
    });
    const history = await f.http('/sessions/official-session');
    const durable = await getServerSessionStore(f.server().runtime).read('official-session');
    expect(durable.filter((event) => event.type === 'skill.applied')).toHaveLength(5);
    await f.stop();
    await rm(source, { recursive: true });
    await f.start({ skillsDirectory: false });
    expect(await f.http('/sessions/official-session')).toEqual(history);
    expect(
      (await catalog(f)).entries
        .filter((entry) => entry.id.startsWith(`plugin:${pluginId}/`))
        .map(exactRef),
    ).toEqual(active.map(exactRef));
    const guide = active.find((entry) => entry.name === 'weave-guide')!;
    expect(
      pages(await run(f, exactRef(guide), 'references/product-and-navigation.md'))[1]?.text,
    ).toBe(
      artifact.skills.find((skill) => skill.name === guide.name)?.resources?.[
        'references/product-and-navigation.md'
      ],
    );
    expect(await f.import(request)).toMatchObject({ kind: 'replayed' });
    // 该用例要完成导入、四个真实 Skill 的 HTTP/SSE 投递、删除源目录和重启，单跑约 1 秒；
    // 与其他重 I/O 测试并行时会超过默认 5 秒，所以单独放宽。
  }, 30_000);

  it('retains admitted real resources while update makes old refs stale, with rollback/disable/revoke and same-name project isolation', async () => {
    const { f, source } = await fixture();
    const projectRoot = join(f.root, 'project');
    await mkdir(join(projectRoot, '.weave/skills/weave-guide'), { recursive: true });
    await writeFile(
      join(projectRoot, '.weave/skills/weave-guide/SKILL.md'),
      '---\nname: weave-guide\ndescription: Project-specific guide\n---\nProject instructions only.\n',
    );
    const project = (await f.http(
      '/projects',
      { name: 'Official isolation', folderName: 'project', folderPath: projectRoot },
      201,
    )) as { id: string };
    const session = (await f.http(
      `/projects/${project.id}/sessions`,
      { title: 'Same short name' },
      201,
    )) as { id: string };
    const first = await f.preview(source);
    await f.import(importBody('first', first));
    await activate(f, first.candidate, 'first-activate');
    const named = skillCatalogSchema
      .parse(await f.http(`/sessions/${session.id}/skills`))
      .entries.filter((entry) => entry.name === 'weave-guide');
    expect(named).toHaveLength(2);
    expect(new Set(named.map((entry) => entry.source.kind))).toEqual(
      new Set(['plugin', 'project']),
    );
    const old = exactRef(
      (await catalog(f)).entries.find((entry) => entry.id === `plugin:${pluginId}/weave-guide`)!,
    );
    const resourcePath = 'references/product-and-navigation.md';
    const resourceFile = join(source, 'skills/weave-guide', resourcePath);
    const original = await readFile(resourceFile, 'utf8');
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    f.server().runtime.serverHost.hostProviderRegistry.register({
      id: 'held-official',
      label: 'Held',
      type: 'mock',
      client: {
        async *stream() {
          calls++;
          if (calls === 2) {
            held.resolve();
            await release.promise;
          }
          if (calls <= 2) {
            const name = calls === 1 ? 'read_skill' : 'read_skill_resource';
            yield { type: 'tool-call-start', id: `held-${calls}`, name };
            yield {
              type: 'tool-call-delta',
              id: `held-${calls}`,
              argumentsDelta: JSON.stringify({
                skill: old,
                ...(calls === 2 ? { path: resourcePath } : {}),
              }),
            };
            yield { type: 'finish', reason: 'tool-call' };
          } else yield { type: 'finish', reason: 'stop' };
        },
      },
    });
    const running = run(f, old, resourcePath, false, 'held-official');
    try {
      await held.promise;
      await writeFile(resourceFile, `${original}\nUpdated resource snapshot.\n`);
      const descriptorPath = join(source, 'weave-plugin.json');
      const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
        manifest: { version: string };
      };
      descriptor.manifest.version = '1.0.1';
      await writeFile(descriptorPath, JSON.stringify(descriptor));
      const second = await f.preview(source);
      await f.import(importBody('second', second));
      await activate(f, second.candidate, 'second-activate');
      const updated = exactRef((await catalog(f)).entries.find((entry) => entry.id === old.id)!);
      expect(updated.instructionSha256).toBe(old.instructionSha256);
      expect(updated.bundleSha256).not.toBe(old.bundleSha256);
      release.resolve();
      expect(pages(await running)[1]?.text).toBe(original);
      await expect(run(f, old, resourcePath)).rejects.toThrow('skill-source-changed');
      expect(pages(await run(f, updated, resourcePath))[1]?.text).toBe(
        `${original}\nUpdated resource snapshot.\n`,
      );
      await activate(f, first.candidate, 'rollback', 'rollback');
      expect((await catalog(f)).entries.find((entry) => entry.id === old.id)).toMatchObject(old);
      await decision(f, 'disable', 'disable');
      expect((await catalog(f)).entries.some((entry) => entry.id === old.id)).toBe(false);
      await decision(f, 'enable', 'enable');
      expect((await catalog(f)).entries.find((entry) => entry.id === old.id)).toMatchObject(old);
      await decision(f, 'revoke', 'revoke');
      expect((await catalog(f)).entries.some((entry) => entry.id === old.id)).toBe(false);
    } finally {
      release.resolve();
      await running;
    }
  });
});
