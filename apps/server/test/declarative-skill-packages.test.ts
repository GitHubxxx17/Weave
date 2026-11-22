import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as pluginHost from '@weave/plugin-host';
import type { SkillRef } from '@weave/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSkillCatalogService } from '../src/skill-catalog.js';
import { createServerAgentRunner, getServerSessionStore } from '../src/runtime.js';
import { createRealManagedCompositionFixture } from './support/managed-plugin-composition-fixture.js';
import { activateInput, decisionInput } from './support/plugin-authority-fixtures.js';
import { writeDeclarativeSkillFixture } from './support/declarative-skill-fixture.js';
import {
  createInstallerHttpFixture,
  importBody,
} from './support/managed-plugin-installer-http-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const close of cleanups.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
  }
});
async function fixture() {
  return createInstallerHttpFixture(cleanups, []);
}
function catalog(f: Awaited<ReturnType<typeof fixture>>, sessionId: string) {
  return createSkillCatalogService({
    current: () => f.server().runtime.serverHost.controller()?.current(),
  }).catalog(sessionId);
}
function ref(value: SkillRef): SkillRef {
  return {
    id: value.id,
    instructionSha256: value.instructionSha256,
    bundleSha256: value.bundleSha256,
  };
}
async function createSession(f: Awaited<ReturnType<typeof fixture>>, sessionId: string) {
  await getServerSessionStore(f.server().runtime).append(sessionId, [
    { type: 'session.created', payload: { title: sessionId } },
  ]);
}
async function runReads(
  f: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  skill: SkillRef,
) {
  const runner = await createServerAgentRunner(f.server().runtime);
  const events = [];
  for await (const event of runner.run({
    sessionId,
    provider: 'mock',
    model: 'fixture',
    userMessage: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            `/tool read_skill ${JSON.stringify({ skill })}`,
            `/tool read_skill_resource ${JSON.stringify({ skill, path: 'references/checklist.md' })}`,
          ].join('\n'),
        },
      ],
    },
  }))
    events.push(event);
  return events;
}

describe('declarative Skill packages through managed Server authority', () => {
  it('imports inert data, activates independently and restores real Agent/resource history after SQLite restart', async () => {
    const f = await fixture();
    const directory = join(f.root, 'text-only-source');
    await writeDeclarativeSkillFixture(directory);
    await f.startUnbound();
    const sessionId = 'declarative-history';
    await createSession(f, sessionId);
    const preview = await f.preview(directory);
    expect(preview.candidate.manifest.host).toBe('declarative');
    expect(await readFile(join(directory, 'weave-plugin.json'), 'utf8')).not.toContain('entry');
    const request = importBody('text-import', preview);
    expect(await f.import(request)).toMatchObject({
      kind: 'committed',
      application: { status: 'not-required' },
    });
    expect(
      (await catalog(f, sessionId)).entries.some((skill) => skill.id === 'plugin:notes/review'),
    ).toBe(false);
    expect(f.snapshot().trustEvents).toEqual([]);
    const activation = activateInput('text-activate', f.snapshot(), {
      ...preview.candidate,
      pluginId: preview.candidate.manifest.id,
    }).request;
    expect(await f.select(activation)).toMatchObject({
      kind: 'committed',
      application: { status: 'applied' },
    });
    const list = (await f.http('/plugins')) as { plugins: Array<{ id: string; host: string }> };
    expect(list.plugins.find(({ id }) => id === 'notes')?.host).toBe('declarative');
    const skill = ref(
      (await catalog(f, sessionId)).entries.find((item) => item.id === 'plugin:notes/review')!,
    );
    const events = await runReads(f, sessionId, skill);
    expect(JSON.stringify(events)).toContain('First-version review checklist.');
    const before = await f.http(`/sessions/${sessionId}`);
    expect(before).toMatchObject({
      turns: [
        {
          skills: {
            applications: [
              {
                skill: { id: 'plugin:notes/review' },
                invocation: 'model',
                delivery: 'delivered',
              },
            ],
          },
        },
      ],
    });
    await f.stop();
    await rm(directory, { recursive: true });
    await f.start();
    expect(await f.http(`/sessions/${sessionId}`)).toEqual(before);
    expect(
      (await catalog(f, sessionId)).entries.find((item) => item.id === skill.id),
    ).toMatchObject(skill);
    expect(await f.import(request)).toMatchObject({
      kind: 'replayed',
      application: { status: 'unknown' },
    });
    expect(await f.select(activation)).toMatchObject({
      kind: 'replayed',
      application: { status: 'unknown' },
    });
    expect(JSON.stringify(await runReads(f, sessionId, skill))).toContain(
      'First-version review checklist.',
    );
  });
  it('pins old immutable resources during update and uses fresh refs after rollback, disable and revoke', async () => {
    const f = await fixture();
    const directory = join(f.root, 'versioned-source');
    await writeDeclarativeSkillFixture(directory);
    await f.startUnbound();
    const sessionId = 'versioned-history';
    await createSession(f, sessionId);
    const first = await f.preview(directory);
    await f.import(importBody('v1-import', first));
    await f.select(
      activateInput('v1-activate', f.snapshot(), {
        ...first.candidate,
        pluginId: 'notes',
      }).request,
    );
    const old = ref(
      (await catalog(f, sessionId)).entries.find((entry) => entry.id === 'plugin:notes/review')!,
    );
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    f.server().runtime.serverHost.hostProviderRegistry.register({
      id: 'held',
      label: 'Held model',
      type: 'mock',
      client: {
        async *stream() {
          calls++;
          if (calls === 1) {
            yield { type: 'tool-call-start', id: 'old-instructions', name: 'read_skill' };
            yield {
              type: 'tool-call-delta',
              id: 'old-instructions',
              argumentsDelta: JSON.stringify({ skill: old }),
            };
            yield { type: 'finish', reason: 'tool-call' };
          } else if (calls === 2) {
            held.resolve();
            await release.promise;
            yield { type: 'tool-call-start', id: 'old-resource', name: 'read_skill_resource' };
            yield {
              type: 'tool-call-delta',
              id: 'old-resource',
              argumentsDelta: JSON.stringify({ skill: old, path: 'references/checklist.md' }),
            };
            yield { type: 'finish', reason: 'tool-call' };
          } else yield { type: 'finish', reason: 'stop' };
        },
      },
    });
    const runner = await createServerAgentRunner(f.server().runtime);
    const running = (async () => {
      const events = [];
      for await (const event of runner.run({
        sessionId,
        provider: 'held',
        model: 'fixture',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'Read old report' }] },
      }))
        events.push(event);
      return events;
    })();
    try {
      await held.promise;
      await writeDeclarativeSkillFixture(directory, {
        version: '2.0.0',
        instructions: 'Second-version instructions.',
        resource: 'Second-version checklist.',
      });
      const second = await f.preview(directory);
      await f.import(importBody('v2-import', second));
      await f.select(
        activateInput('v2-activate', f.snapshot(), { ...second.candidate, pluginId: 'notes' })
          .request,
      );
      const updated = ref(
        (await catalog(f, sessionId)).entries.find((entry) => entry.id === old.id)!,
      );
      expect(updated.bundleSha256).not.toBe(old.bundleSha256);
      release.resolve();
      expect(JSON.stringify(await running)).toContain('First-version review checklist.');
      expect(JSON.stringify(await runReads(f, sessionId, updated))).toContain(
        'Second-version checklist.',
      );
      await f.select(
        activateInput(
          'rollback-v1',
          f.snapshot(),
          { ...first.candidate, pluginId: 'notes' },
          'rollback',
        ).request,
      );
      expect(
        (await catalog(f, sessionId)).entries.find((entry) => entry.id === old.id),
      ).toMatchObject(old);
      await f.select(decisionInput('disable', 'disable-data', f.snapshot()).request);
      expect((await catalog(f, sessionId)).entries.some((entry) => entry.id === old.id)).toBe(
        false,
      );
      await f.select(decisionInput('enable', 'enable-data', f.snapshot()).request);
      expect((await catalog(f, sessionId)).entries.some((entry) => entry.id === old.id)).toBe(true);
      await f.select(decisionInput('revoke', 'revoke-data', f.snapshot()).request);
      expect((await catalog(f, sessionId)).entries.some((entry) => entry.id === old.id)).toBe(
        false,
      );
      const beforeCalls = calls;
      await expect(
        (async () => {
          for await (const event of runner.run({
            sessionId,
            provider: 'held',
            model: 'fixture',
            skills: [old],
            userMessage: {
              role: 'user',
              content: [{ type: 'text', text: 'stale selected Skill' }],
            },
          }))
            void event;
        })(),
      ).rejects.toMatchObject({ code: 'skill-not-found' });
      expect(calls).toBe(beforeCalls);
    } finally {
      release.resolve();
      await running.catch(() => undefined);
    }
  });

  it('acquires fixed GitHub data twice, imports without execution and replays saved import while offline', async () => {
    const f = await createRealManagedCompositionFixture();
    cleanups.push(f.close);
    const source = {
      repository: 'https://github.com/weave/notes',
      commit: 'a'.repeat(40),
      subdirectory: 'plugins/notes',
    };
    const original = join(f.root, 'github-fixed');
    await writeDeclarativeSkillFixture(original);
    let acquisitions = 0;
    let offline = false;
    const importModule = vi.fn(async () => {
      throw new Error('Data must never import');
    });
    const createSource = pluginHost.createLocalPluginSource;
    vi.spyOn(pluginHost, 'createLocalPluginSource').mockImplementation((options) =>
      createSource({ ...options, importModule }),
    );
    const host = f.compose({
      installer: true,
      githubAcquirer: {
        async withSource(selected, use, signal) {
          expect(selected).toEqual(source);
          if (offline) throw new Error('offline');
          const directory = join(f.root, `acquisition-${++acquisitions}`);
          await cp(original, directory, { recursive: true });
          try {
            return await use(directory, signal ?? new AbortController().signal);
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        },
      },
    });
    await host.coordinator.reload();
    const preview = await host.installer!.previewGithub(source);
    const request = {
      requestId: 'github-data-import',
      command: {
        kind: 'import' as const,
        previewId: preview.previewId,
        expectedInstallSequence: preview.expectedInstallSequence,
      },
    };
    const imported = await host.installer!.import(request);
    expect(imported).toMatchObject({ kind: 'committed', application: { status: 'not-required' } });
    expect(acquisitions).toBe(2);
    expect(f.authority.snapshotSync().installations[0]?.candidates[0]?.provenance).toEqual({
      kind: 'github',
      ...source,
    });
    expect(host.coordinator.snapshot().members).toEqual([]);
    await host.applyManagedSelection!(
      activateInput('github-data-activate', f.authority.snapshotSync(), {
        ...preview.candidate,
        pluginId: 'notes',
      }).request as Parameters<NonNullable<typeof host.applyManagedSelection>>[0],
    );
    expect(importModule).not.toHaveBeenCalled();
    expect(host.coordinator.snapshot().members).toMatchObject([
      { pluginId: 'notes', manifest: { host: 'declarative' } },
    ]);
    offline = true;
    await rm(original, { recursive: true });
    expect(await host.installer!.import(request, AbortSignal.abort())).toMatchObject({
      kind: 'replayed',
      operation: imported.operation,
    });
    expect(acquisitions).toBe(2);
    expect(importModule).not.toHaveBeenCalled();
  });

  it('loads a manually trusted text package without import and respects the shared MCP and managed namespace', async () => {
    const f = await createRealManagedCompositionFixture();
    cleanups.push(f.close);
    const directory = join(f.pluginsDirectory, 'manual-data');
    const manifest = await writeDeclarativeSkillFixture(directory, { id: 'manual-data' });
    const { digest } = await pluginHost.computeDirectoryDigest(directory);
    await f.authority.trust.append({ kind: 'trusted', pluginId: 'manual-data', digest, manifest });
    const load = vi.fn(async () => {
      throw new Error('No text package import');
    });
    const createSource = pluginHost.createLocalPluginSource;
    vi.spyOn(pluginHost, 'createLocalPluginSource').mockImplementation((options) =>
      createSource({ ...options, importModule: load }),
    );
    const host = f.compose({ installer: true });
    await host.coordinator.reload();
    expect(host.coordinator.snapshot().members).toMatchObject([
      { pluginId: 'manual-data', origin: 'manual' },
    ]);
    expect(load).not.toHaveBeenCalled();
    expect(f.runtime.serverHost.controller()!.current().resources.skills).toMatchObject([
      { pluginId: 'manual-data', name: 'review' },
    ]);
    const external = join(f.root, 'same-id');
    await writeDeclarativeSkillFixture(external, { id: 'manual-data' });
    const localPreview = await host.installer!.preview(external);
    await expect(
      host.installer!.import({
        requestId: 'local-collision',
        command: {
          kind: 'import',
          previewId: localPreview.previewId,
          expectedInstallSequence: localPreview.expectedInstallSequence,
        },
      }),
    ).rejects.toMatchObject({ code: 'plugin-managed-id-conflict' });
    const mcp = await f.seedMcp('data-collision', false);
    await writeDeclarativeSkillFixture(external, { id: `mcp-${mcp.id}` });
    const mcpPreview = await host.installer!.preview(external);
    await expect(
      host.installer!.import({
        requestId: 'mcp-collision',
        command: {
          kind: 'import',
          previewId: mcpPreview.previewId,
          expectedInstallSequence: mcpPreview.expectedInstallSequence,
        },
      }),
    ).rejects.toMatchObject({ code: 'plugin-managed-id-conflict' });
    expect(load).not.toHaveBeenCalled();
  });

  it('rejects changed reviewed bytes and incompatible engines before any managed import decision', async () => {
    const f = await fixture();
    const directory = join(f.root, 'changing-data');
    await writeDeclarativeSkillFixture(directory);
    await f.startUnbound();
    const preview = await f.preview(directory);
    await writeFile(
      join(directory, 'skills/review/references/checklist.md'),
      'changed after preview',
    );
    const request = importBody('changed-data-import', preview);
    const response = await f.http('/plugins/managed/import', request, 409);
    expect(response).toMatchObject({ error: { code: 'plugin-preview-stale' } });
    expect(f.snapshot().heads.operationSequence).toBe(0);
    await writeDeclarativeSkillFixture(directory, { engines: { weave: '>=999.0.0' } });
    expect(
      await f.http('/plugins/managed/preview', { sourceDirectory: directory }, 400),
    ).toMatchObject({ error: { code: 'plugin-artifact-invalid' } });
    expect(f.snapshot().heads.operationSequence).toBe(0);
  });

  it('rejects a mismatched entry/data artifact before saving activation authority', async () => {
    const f = await createRealManagedCompositionFixture();
    cleanups.push(f.close);
    const directory = join(f.root, 'data-identity');
    await writeDeclarativeSkillFixture(directory);
    const host = f.compose({ installer: true });
    const preview = await host.installer!.preview(directory);
    await host.installer!.import({
      requestId: 'identity-import',
      command: {
        kind: 'import',
        previewId: preview.previewId,
        expectedInstallSequence: preview.expectedInstallSequence,
      },
    });
    const actual = await f.owned.read(preview.candidate.digest);
    f.readOwned.mockResolvedValue({
      ...actual,
      kind: 'entry',
      entry: join(actual.directory, 'fake.mjs'),
    } as pluginHost.PluginArtifact);
    const request = activateInput('wrong-payload-activate', f.authority.snapshotSync(), {
      ...preview.candidate,
      pluginId: 'notes',
    }).request as Parameters<NonNullable<typeof host.applyManagedSelection>>[0];
    await expect(host.applyManagedSelection!(request)).rejects.toMatchObject({
      code: 'plugin-artifact-unavailable',
    });
    expect(f.authority.snapshotSync().heads.operationSequence).toBe(1);
    expect(f.authority.snapshotSync().trustEvents).toEqual([]);
  });
  it('replays legacy no-host ESM decisions offline without changing durable fields or fingerprints', async () => {
    const f = await fixture();
    await f.startUnbound();
    const source = await f.source('notes', 'legacy ESM result');
    const preview = await f.preview(source.directory);
    expect(preview.candidate.manifest.host).toBeUndefined();
    const imported = importBody('legacy-import', preview);
    const first = await f.import(imported);
    const activation = activateInput('legacy-activate', f.snapshot(), {
      ...preview.candidate,
      pluginId: 'notes',
    }).request;
    const activated = await f.select(activation);
    const legacy = f.snapshot();
    expect(legacy.operationEvents.every((event) => event.fingerprint.length === 64)).toBe(true);
    expect(JSON.stringify(legacy)).not.toContain('artifactType');
    expect(JSON.stringify(legacy.installations)).not.toContain('in-process');
    await f.stop();
    await rm(source.directory, { recursive: true });
    await writeFile(
      join(f.artifacts, preview.candidate.digest, 'payload/index.mjs'),
      'unavailable corrupt old object',
    );
    await f.start();
    expect(await f.import(imported)).toMatchObject({
      kind: 'replayed',
      decision: first.decision,
      application: { status: 'unknown' },
    });
    expect(await f.select(activation)).toMatchObject({
      kind: 'replayed',
      decision: activated.decision,
      application: { status: 'unknown' },
    });
    expect(f.snapshot()).toEqual(legacy);
  });
});
