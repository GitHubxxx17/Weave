import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type PluginManifest } from '@weave/plugin';
import { computeDirectoryDigest } from '@weave/plugin-host';
import { startServer } from '../src/main.js';
import { createServerAgentRunner } from '../src/runtime.js';

const pluginId = 'around-spy';

function pluginSource(marker: string, note = ''): string {
  return `
    import { appendFileSync } from 'node:fs';
    // ${note}
    export default (sdk) => ({ setup(env) {
      env.contribute(sdk.toolsExtensionPoint, (api) => api.addTool({
        name: 'spy_echo', description: 'Echo', parameters: { type: 'object' },
        inputSchema: sdk.z.object({}), execute: () => 'echoed',
      }));
      env.onHook(sdk.toolAroundHook, async (input, next) => {
        appendFileSync(${JSON.stringify(marker)}, 'around;');
        return next(input);
      });
    } });
  `;
}

async function writePlugin(directory: string, marker: string, note = ''): Promise<string> {
  // `contributes.hooks` is absent: the hook subscription is undeclared.
  const manifest: PluginManifest = {
    id: pluginId,
    name: pluginId,
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['tool'],
    contributes: { tools: ['spy_echo'] },
    permissions: [],
  };
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'weave-plugin.json'),
    JSON.stringify({ schemaVersion: 1, entry: 'index.mjs', manifest }),
  );
  await writeFile(join(directory, 'index.mjs'), pluginSource(marker, note));
  return (await computeDirectoryDigest(directory)).digest;
}

type Server = Awaited<ReturnType<typeof startServer>>;

interface ResponseBody {
  readonly plugins: readonly { readonly id: string; readonly pendingHooks?: readonly string[] }[];
  readonly error: { readonly code: string };
}

async function request(server: Server, path: string, init?: RequestInit) {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, init);
  return { status: response.status, body: (await response.json()) as ResponseBody };
}

function post(server: Server, path: string, body: unknown) {
  return request(server, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function runTool(server: Server) {
  const runner = await createServerAgentRunner(server.runtime);
  for await (const event of runner.run({
    sessionId: `s-${randomUUID()}`,
    provider: 'mock',
    model: 'test-model',
    userMessage: { role: 'user', content: [{ type: 'text', text: '/tool spy_echo {}' }] },
  })) {
    void event;
  }
}

async function markerText(marker: string): Promise<string> {
  return readFile(marker, 'utf8').catch(() => '');
}

describe('undeclared high-risk hook confirmation', () => {
  it('holds the hook until confirmed, persists the decision, and asks again after the content changes', async () => {
    const root = join(tmpdir(), `weave-hook-confirmation-${randomUUID()}`);
    const marker = join(root, 'marker.txt');
    const directory = join(root, 'plugins', pluginId);
    await mkdir(root, { recursive: true });
    const digest = await writePlugin(directory, marker);
    const options = { dataDirectory: root };
    try {
      const server = await startServer(0, options);
      try {
        expect((await request(server, '/plugins/hook-confirmations')).body).toEqual({
          plugins: [],
        });
        const trusted = await post(server, `/plugins/${pluginId}/trust`, { digest });
        expect(trusted.status, JSON.stringify(trusted.body)).toBe(200);

        const pending = await request(server, '/plugins/hook-confirmations');
        expect(pending.body).toEqual({
          plugins: [
            {
              pluginId,
              digest,
              hooks: [
                {
                  id: 'weave.tools.around',
                  level: 'high',
                  description: '能改写工具调用的参数和结果',
                },
              ],
            },
          ],
        });
        const listed = (await request(server, '/plugins')).body.plugins.find(
          (item: { id: string; origin: string }) => item.id === pluginId && item.origin === 'local',
        );
        expect(listed).toMatchObject({ state: 'loaded', pendingHooks: ['weave.tools.around'] });

        await runTool(server);
        expect(await markerText(marker)).toBe('');

        const wrongDigest = await post(server, `/plugins/${pluginId}/hook-confirmations`, {
          digest: 'f'.repeat(64),
          hooks: ['weave.tools.around'],
        });
        expect(wrongDigest.status).toBe(409);
        expect(wrongDigest.body.error.code).toBe('plugin-hook-confirmation-not-pending');
        const wrongHook = await post(server, `/plugins/${pluginId}/hook-confirmations`, {
          digest,
          hooks: ['weave.llm.request'],
        });
        expect(wrongHook.status).toBe(409);
        const malformed = await post(server, `/plugins/${pluginId}/hook-confirmations`, {
          digest,
        });
        expect(malformed.status).toBe(400);
        const nonJson = await request(server, `/plugins/${pluginId}/hook-confirmations`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: '{}',
        });
        expect(nonJson.status).toBeGreaterThanOrEqual(400);
        expect(await markerText(marker)).toBe('');

        const confirmed = await post(server, `/plugins/${pluginId}/hook-confirmations`, {
          digest,
          hooks: ['weave.tools.around'],
        });
        expect(confirmed.status).toBe(200);
        expect((await request(server, '/plugins/hook-confirmations')).body).toEqual({
          plugins: [],
        });

        await runTool(server);
        expect(await markerText(marker)).toBe('around;');
      } finally {
        await server.stop();
      }

      const restarted = await startServer(0, options);
      try {
        expect((await request(restarted, '/plugins/hook-confirmations')).body).toEqual({
          plugins: [],
        });
        await runTool(restarted);
        expect(await markerText(marker)).toBe('around;around;');
      } finally {
        await restarted.stop();
      }

      const changedDigest = await writePlugin(directory, marker, 'changed content');
      expect(changedDigest).not.toBe(digest);
      const changed = await startServer(0, options);
      try {
        expect(
          (await post(changed, `/plugins/${pluginId}/trust`, { digest: changedDigest })).status,
        ).toBe(200);
        const again = await request(changed, '/plugins/hook-confirmations');
        expect(again.body.plugins).toMatchObject([
          { pluginId, digest: changedDigest, hooks: [{ id: 'weave.tools.around' }] },
        ]);
        await runTool(changed);
        expect(await markerText(marker)).toBe('around;around;');
      } finally {
        await changed.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
