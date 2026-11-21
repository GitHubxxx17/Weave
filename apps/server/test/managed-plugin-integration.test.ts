import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createServerAgentRunner, listServerPlugins } from '../src/runtime.js';
import { createRealManagedCompositionFixture } from './support/managed-plugin-composition-fixture.js';

describe('joint managed, manual and MCP Generation', () => {
  it('runs all three tools on the stable runner and never reads the unselected digest', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      const managed = await f.seedManaged('managed-echo', 'managed result');
      const marker = join(f.root, 'unselected-imported');
      const unused = await f.seedManaged('managed-echo', 'unused result', false, marker);
      const manual = await f.seedManual('manual-echo', 'manual result');
      await f.seedMcp('remote');
      const controller = f.runtime.serverHost.controller()!;
      const before = controller.current();
      const commit = vi.spyOn(f.runtime.serverHost, 'commit');
      const host = f.compose();
      const result = await host.coordinator.reload();
      const activation = f.authority.snapshotSync().installations[0]!.selection!.activationSequence;
      const current = controller.current();

      expect(commit).toHaveBeenCalledOnce();
      expect(result.generation.id).toBeGreaterThan(before.id);
      expect(result.failed).toEqual([]);
      expect(result.members).toMatchObject([
        {
          sourceId: 'local-esm',
          pluginId: 'managed-echo',
          identity: JSON.stringify(['managed-echo', managed.digest, 'managed', activation]),
          origin: 'managed',
        },
        {
          sourceId: 'local-esm',
          pluginId: 'manual-echo',
          identity: JSON.stringify(['manual-echo', manual.digest]),
          origin: 'manual',
        },
        { sourceId: 'mcp', pluginId: 'mcp-remote' },
      ]);
      expect(host.coordinator.runner).toBe(f.runner);
      expect(host.pluginHost?.runner).toBe(f.runner);
      expect(await createServerAgentRunner(f.runtime)).toBe(f.runner);
      const mcpTool = listServerPlugins(f.runtime).find(({ id }) => id === 'mcp-remote')!
        .contributes!.tools![0]!;
      const turns = [
        ['managed_echo', 'managed result'],
        ['manual_echo', 'manual result'],
        [mcpTool, 'done'],
      ] as const;
      for (const [tool, resultText] of turns) {
        const events = await f.runTool(tool);
        const result = events.find((event) => event.type === 'tool-result');
        expect(result).toBeDefined();
        expect(JSON.stringify(result)).toContain(resultText);
        expect(controller.current()).toBe(current);
      }
      expect((await readFile(f.launchLog, 'utf8')).trim().split('\n')).toHaveLength(1);
      expect(f.readOwned.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(new Set(f.readOwned.mock.calls.map(([digest]) => digest))).toEqual(
        new Set([managed.digest]),
      );
      expect(f.readOwned.mock.calls.some(([digest]) => digest === unused.digest)).toBe(false);
      expect(await f.exists(marker)).toBe(false);
    } finally {
      await f.close();
    }
  });
});
