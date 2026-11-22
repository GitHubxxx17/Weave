import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { computeDirectoryDigest } from '@weave/plugin-host';
import { startServer } from '../src/main.js';
import { getServerSessionStore } from '../src/runtime.js';
import { runExecutionToLegacyResponse } from './execution-http-fixture.js';

const catalogShape = z.object({
  schemaVersion: z.literal(1),
  serverEpoch: z.string(),
  generation: z.number(),
  authorityEpoch: z.number(),
  panels: z.array(
    z.object({
      panelId: z.string(),
      panelRef: z.string(),
      pluginId: z.string(),
      state: z.enum(['available', 'unavailable']),
    }),
  ),
});
const dataShape = z.object({
  state: z.enum(['empty', 'ready', 'incompatible', 'invalid-data', 'data-too-large']),
  lastSequence: z.number(),
  sources: z.array(z.object({ state: z.string() })),
  blocks: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()),
});

describe('quality-report plugin through real loopback HTTP and SQLite', () => {
  it('reads, records through Pipeline, prepares without sending, restarts and withdraws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weave-panel-example-'));
    const pluginsDirectory = join(root, 'plugins');
    const exampleDirectory = join(pluginsDirectory, 'quality-report');
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    const options = {
      databaseFile: join(root, 'weave.sqlite'),
      pluginsDirectory,
      skillsDirectory: false as const,
      environment: {},
    };
    async function request(path: string, method = 'GET', body?: unknown) {
      return fetch(`http://127.0.0.1:${server!.port}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      });
    }
    async function json(path: string, method = 'GET', body?: unknown) {
      const response = await request(path, method, body);
      expect(response.ok, await response.clone().text()).toBe(true);
      return response.json() as Promise<unknown>;
    }
    async function catalog() {
      const response = await request('/plugins/panels');
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      return catalogShape.parse(await response.json());
    }
    try {
      await mkdir(pluginsDirectory, { recursive: true });
      await cp(
        fileURLToPath(new URL('../../../examples/plugins/quality-report/', import.meta.url)),
        exampleDirectory,
        { recursive: true },
      );
      server = await startServer(0, options);
      expect((await catalog()).panels).toEqual([]);
      const digest = (await computeDirectoryDigest(exampleDirectory)).digest;
      await json('/plugins/quality-report/trust', 'POST', { digest });
      const active = await catalog();
      expect(active.panels).toEqual([
        expect.objectContaining({
          panelId: 'plugin:quality-report/report',
          pluginId: 'quality-report',
          state: 'available',
        }),
      ]);
      let ref = active.panels[0]!.panelRef;
      const projectDirectory = join(root, 'project');
      await mkdir(projectDirectory);
      const project = z.object({ id: z.string() }).parse(
        await json('/projects', 'POST', {
          name: 'Panel acceptance',
          folderName: 'project',
          folderPath: projectDirectory,
        }),
      );
      const session = z
        .object({ id: z.string() })
        .parse(await json(`/projects/${project.id}/sessions`, 'POST', { title: 'Quality report' }));
      const dataPath = () => `/sessions/${session.id}/plugin-panels/${ref}`;
      const store = () => getServerSessionStore(server!.runtime);
      expect(dataShape.parse(await json(dataPath())).state).toBe('empty');
      const report = {
        schemaVersion: 1,
        score: 75,
        summary: 'Evidence from the acceptance fixture',
        checks: [
          { name: 'Fixture checked', status: 'pass' },
          { name: 'Live CI not run', status: 'warn' },
        ],
      };
      const run = await runExecutionToLegacyResponse(server, {
        sessionId: session.id,
        provider: 'mock',
        model: 'fixture',
        userMessage: {
          role: 'user',
          content: [{ type: 'text', text: `/tool quality_report ${JSON.stringify(report)}` }],
        },
      });
      expect(run.status).toBe(200);
      expect(await run.text()).toContain('已记录质量报告');
      expect(
        (await store().read(session.id)).filter((event) => event.type === 'quality-report/report'),
      ).toEqual([expect.objectContaining({ payload: report })]);
      let data = dataShape.parse(await json(dataPath()));
      expect(data.state).toBe('ready');
      expect(data.blocks).toContainEqual({
        id: 'score',
        type: 'metric',
        cell: { state: 'ready', value: 75 },
      });
      expect(data.blocks).toContainEqual(
        expect.objectContaining({ id: 'checks', totalRows: 2, truncatedRows: 0 }),
      );
      // An empty incremental tail preserves the previously projected report.
      expect(dataShape.parse(await json(dataPath()))).toEqual(data);
      const beforePrepare = (await store().read(session.id)).length;
      const prepared = z
        .object({
          text: z.string(),
          requiresUserSend: z.literal(true),
          command: z.literal('quality-report'),
        })
        .parse(
          await json(`${dataPath()}/prepare-command`, 'POST', {
            formId: 'prepare',
            values: { target: 'src', 'include-tests': true },
          }),
        );
      expect(prepared.text).toContain('{"target":"src","include-tests":true}');
      expect(prepared.text).not.toContain('$ARGUMENTS');
      expect((await store().read(session.id)).length).toBe(beforePrepare);
      // Restart uses persisted trust, actual ESM loading and the same durable report.
      const oldRef = ref;
      await server.stop();
      server = await startServer(0, options);
      const restarted = await catalog();
      expect(restarted.serverEpoch).not.toBe(active.serverEpoch);
      ref = restarted.panels[0]!.panelRef;
      expect(ref).not.toBe(oldRef);
      expect((await request(`/sessions/${session.id}/plugin-panels/${oldRef}`)).status).toBe(409);
      data = dataShape.parse(await json(dataPath()));
      expect(data.state).toBe('ready');
      expect(data.blocks).toContainEqual({
        id: 'score',
        type: 'metric',
        cell: { state: 'ready', value: 75 },
      });
      // Host appends a future persisted version; reads never fall back to older data.
      await store().append(session.id, [
        { type: 'quality-report/report', payload: { ...report, schemaVersion: 2 } },
      ]);
      expect(dataShape.parse(await json(dataPath())).state).toBe('incompatible');
      await store().append(session.id, [{ type: 'quality-report/report', payload: report }]);
      expect(dataShape.parse(await json(dataPath())).state).toBe('ready');
      await json(`/sessions/${session.id}/archive`, 'POST', {});
      expect(dataShape.parse(await json(dataPath())).state).toBe('ready');
      const archivedPrepare = await request(`${dataPath()}/prepare-command`, 'POST', {
        formId: 'prepare',
        values: { target: 'src' },
      });
      expect(archivedPrepare.status).toBe(409);
      expect(await archivedPrepare.json()).toMatchObject({ error: { code: 'session-archived' } });
      await json(`/sessions/${session.id}/restore`, 'POST', {});
      const beforeReloadRef = ref;
      await json('/plugins/reload', 'POST', {});
      ref = (await catalog()).panels[0]!.panelRef;
      expect(ref).not.toBe(beforeReloadRef);
      expect(
        (await request(`/sessions/${session.id}/plugin-panels/${beforeReloadRef}`)).status,
      ).toBe(409);
      const revokedRef = ref;
      await json('/plugins/quality-report/trust?immediate=false', 'DELETE', {});
      expect((await catalog()).panels.every((panel) => panel.state === 'unavailable')).toBe(true);
      expect((await request(`/sessions/${session.id}/plugin-panels/${revokedRef}`)).status).toBe(
        409,
      );
      expect(
        (await store().read(session.id)).filter((event) => event.type === 'quality-report/report'),
      ).toHaveLength(3);
      await json('/plugins/quality-report/trust', 'POST', { digest });
      ref = (await catalog()).panels[0]!.panelRef;
      await json(`/sessions/${session.id}`, 'DELETE');
      const deletedRead = await request(dataPath());
      expect(deletedRead.status).toBe(410);
      expect(await deletedRead.json()).toMatchObject({ error: { code: 'session-deleted' } });
    } finally {
      await server?.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
