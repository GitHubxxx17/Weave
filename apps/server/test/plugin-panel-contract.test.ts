import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { computeDirectoryDigest } from '@weave/plugin-host';
import { startServer } from '../src/main.js';
import { getServerSessionStore } from '../src/runtime.js';

const tuple = z.object({
  serverEpoch: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  generation: z.number().int().positive(),
  authorityEpoch: z.number().int().positive(),
});
const catalogShape = tuple.extend({
  panels: z.array(z.object({ panelRef: z.string().regex(/^[A-Za-z0-9_-]{32}$/) })),
});
const dataShape = tuple.extend({
  panelRef: z.string(),
  sessionId: z.literal('panel-contract'),
  sources: z.array(
    z
      .object({ latest: z.object({ occurredAt: z.string() }).passthrough().nullable() })
      .passthrough(),
  ),
});
const preparedShape = tuple.extend({
  panelRef: z.string(),
  sessionId: z.literal('panel-contract'),
});

function neutralTuple(value: Record<string, unknown>) {
  return { ...value, serverEpoch: 'S'.repeat(32), generation: 1, authorityEpoch: 1 };
}

describe('actual Server panel HTTP contract', () => {
  it('matches the independently consumed neutral wire fixture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weave-panel-contract-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      const pluginsDirectory = join(root, 'plugins');
      const example = join(pluginsDirectory, 'quality-report');
      await cp(
        fileURLToPath(new URL('../../../examples/plugins/quality-report/', import.meta.url)),
        example,
        { recursive: true },
      );
      server = await startServer(0, {
        databaseFile: join(root, 'weave.sqlite'),
        pluginsDirectory,
        skillsDirectory: false,
        environment: {},
      });
      async function json(path: string, body?: unknown) {
        const response = await fetch(
          `http://127.0.0.1:${server!.port}${path}`,
          body === undefined
            ? {}
            : {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              },
        );
        expect(response.status, await response.clone().text()).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        return z.record(z.string(), z.unknown()).parse(await response.json());
      }
      const digest = (await computeDirectoryDigest(example)).digest;
      const activation = await fetch(
        `http://127.0.0.1:${server.port}/plugins/quality-report/trust`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ digest }),
        },
      );
      expect(activation.status, await activation.clone().text()).toBe(200);
      await getServerSessionStore(server.runtime).append('panel-contract', [
        { type: 'session.created', payload: { title: 'Panel wire fixture' } },
        {
          type: 'quality-report/report',
          payload: {
            schemaVersion: 1,
            score: 88,
            summary: '<img src=x onerror=alert(1)> remains text',
            checks: [{ name: 'Explicit fixture evidence', status: 'pass' }],
          },
        },
      ]);
      const catalog = await json('/plugins/panels');
      const captured = catalogShape.parse(catalog);
      expect(captured.panels).toHaveLength(1);
      const ref = captured.panels[0]!.panelRef;
      const data = await json(`/sessions/panel-contract/plugin-panels/${ref}`);
      const prepared = await json(`/sessions/panel-contract/plugin-panels/${ref}/prepare-command`, {
        formId: 'prepare',
        values: { target: 'src', 'include-tests': true },
      });
      for (const response of [dataShape.parse(data), preparedShape.parse(prepared)]) {
        expect(tuple.parse(response)).toEqual(tuple.parse(captured));
        expect(response.panelRef).toBe(ref);
      }
      const actual = {
        catalog: {
          ...neutralTuple(catalog),
          panels: z
            .array(z.record(z.string(), z.unknown()))
            .parse(catalog.panels)
            .map((panel) => ({ ...panel, panelRef: 'R'.repeat(32) })),
        },
        data: {
          ...neutralTuple(data),
          panelRef: 'R'.repeat(32),
          sources: dataShape.parse(data).sources.map((source) => ({
            ...source,
            latest:
              source.latest === null
                ? null
                : { ...source.latest, occurredAt: '2026-11-22T00:00:00.000Z' },
          })),
        },
        prepared: { ...neutralTuple(prepared), panelRef: 'R'.repeat(32) },
      };
      const fixture = JSON.parse(
        await readFile(new URL('./fixtures/plugin-panel-contract.json', import.meta.url), 'utf8'),
      ) as unknown;
      // Only random authority tokens/monotonic epochs and the persisted wall clock
      // are neutralized above, after asserting their real syntax and exact binding.
      expect(actual).toEqual(fixture);
    } finally {
      await server?.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
