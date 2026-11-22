import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { computeDirectoryDigest } from '@weave/plugin-host';
import { startServer } from '../src/main.js';
import { getServerSessionStore } from '../src/runtime.js';
import { runExecutionToLegacyResponse } from './execution-http-fixture.js';

describe('plugin ownership over loopback HTTP and SQLite', () => {
  it('persists only an own Pipeline report and retains history after unload and restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weave-owner-http-'));
    const pluginsDirectory = join(root, 'plugins');
    const databaseFile = join(root, 'weave.sqlite');
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    async function writePlugin(id: string, source: string, tool: string, events: string[]) {
      const directory = join(pluginsDirectory, id);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'weave-plugin.json'),
        JSON.stringify({
          schemaVersion: 1,
          entry: 'index.mjs',
          manifest: {
            id,
            name: id,
            version: '1.0.0',
            apiVersion: '1.0.0',
            capabilities: ['tool', 'event'],
            contributes: {
              tools: [tool],
              events,
              services: id === 'writer-b' ? ['writer-b.dependency'] : [],
            },
            permissions: [
              'service:weave.session.store',
              'service:weave.session.plugin-events',
              ...(id === 'writer-b' ? ['service:writer-b.dependency'] : []),
            ],
          },
        }),
      );
      await writeFile(join(directory, 'index.mjs'), source);
      return (await computeDirectoryDigest(directory)).digest;
    }
    async function post(path: string, body: unknown = {}) {
      const response = await fetch(`http://127.0.0.1:${server!.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.ok, await response.clone().text()).toBe(true);
      return response;
    }
    async function run(sessionId: string, text: string) {
      return (
        await runExecutionToLegacyResponse(server!, {
          sessionId,
          provider: 'mock',
          model: 'fixture',
          userMessage: { role: 'user', content: [{ type: 'text', text }] },
        })
      ).text();
    }
    try {
      const digestA = await writePlugin(
        'writer-a',
        `export default (sdk) => ({ setup(env) {
        const event = env.defineEvent('report', {schema:sdk.z.object({text:sdk.z.string()})});
        const writer = env.use(sdk.sessionStoreRef);
        env.contribute(sdk.toolsExtensionPoint, (api) => { api.addTool({
          name:'owner_report',description:'Record own report',parameters:{type:'object'},inputSchema:sdk.z.object({}),
          async execute(_,context) {
            await (await writer.get()).append(context.sessionId,[event.create({text:'pipeline report'})]);
            return 'own-report-recorded';
          }
        }); });
      }});`,
        'owner_report',
        ['writer-a/report'],
      );
      const digestB = await writePlugin(
        'writer-b',
        `export default (sdk) => ({ setup(env) {
        const direct = env.use(sdk.sessionStoreRef), events = env.use(sdk.pluginEventsRef);
        const ref = sdk.defineServiceRef({id:'writer-b.dependency'});
        env.provide(ref,{deps:{store:sdk.sessionStoreRef},factory:({store})=>store});
        const dependency = env.use(ref);
        env.contribute(sdk.toolsExtensionPoint,(api)=>{ api.addTool({
          name:'owner_probe',description:'Check owner boundary',parameters:{type:'object'},inputSchema:sdk.z.object({}),
          async execute(_,context) {
            const result = {};
            for (const [key,handle] of [['direct',direct],['dependency',dependency]]) {
              try { await (await handle.get()).append(context.sessionId,[{type:'writer-a/report',payload:{text:'forged'}}]); result[key]='FORGED'; }
              catch (error) { result[key]=error.code; }
            }
            const reader = await events.get();
            result.reader = {define:typeof reader.define,metadata:reader.get('writer-a/report')};
            return JSON.stringify(result);
          }
        }); });
      }});`,
        'owner_probe',
        [],
      );
      const options = {
        databaseFile,
        pluginsDirectory,
        skillsDirectory: false as const,
        environment: {},
      };
      server = await startServer(0, options);
      await post('/plugins/writer-a/trust', { digest: digestA });
      await post('/plugins/writer-b/trust', { digest: digestB });
      const projectDirectory = join(root, 'project');
      await mkdir(projectDirectory);
      const project = (await (
        await post('/projects', {
          name: 'Owner acceptance',
          folderName: 'project',
          folderPath: projectDirectory,
        })
      ).json()) as { id: string };
      const session = (await (
        await post(`/projects/${project.id}/sessions`, { title: 'Owner acceptance' })
      ).json()) as { id: string };
      expect(await run(session.id, '/tool owner_report {}')).toContain('own-report-recorded');
      const probe = await run(session.id, '/tool owner_probe {}');
      expect(probe).toContain('event: completed');
      const toolEvent = probe
        .split('\n\n')
        .find((event) => event.startsWith('event: tool-result\n'));
      expect(toolEvent).toBeDefined();
      const result = z
        .object({ result: z.object({ content: z.string() }) })
        .parse(JSON.parse(toolEvent!.split('\ndata: ')[1]!));
      expect(JSON.parse(result.result.content)).toEqual({
        direct: 'plugin-event-invalid',
        dependency: 'plugin-event-invalid',
        reader: {
          define: 'undefined',
          metadata: { type: 'writer-a/report', hasProjection: false },
        },
      });
      const reports = () =>
        getServerSessionStore(server!.runtime)
          .read(session.id)
          .then((events) => events.filter((event) => event.type === 'writer-a/report'));
      expect(await reports()).toEqual([
        expect.objectContaining({ payload: { text: 'pipeline report' } }),
      ]);
      await post('/plugins/writer-a/disable');
      await post('/plugins/writer-b/disable');
      expect(await reports()).toHaveLength(1);
      await server.stop();
      server = await startServer(0, options);
      expect(await reports()).toEqual([
        expect.objectContaining({ payload: { text: 'pipeline report' } }),
      ]);
      const sessionResponse = await fetch(`http://127.0.0.1:${server.port}/sessions/${session.id}`);
      expect(sessionResponse.status).toBe(200);
      expect(await sessionResponse.text()).toContain('Owner acceptance');
    } finally {
      await server?.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
