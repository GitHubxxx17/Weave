import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  definePlugin,
  panelsExtensionPoint,
  commandsExtensionPoint,
  type AttributedPanel,
  type PluginInfo,
} from '@weave/plugin';
import {
  createServerRuntime,
  createServerAgentRunner,
  assembleServerGeneration,
  disposeServerPlugins,
} from '../src/runtime.js';
import { assertPanelCatalogLimits, bindPanelCatalog } from '../src/plugin-panel-catalog.js';
import { panelBytes, type BoundPanelDefinition } from '../src/plugin-panel-types.js';
const definition = {
  schemaVersion: 1,
  id: 'report',
  title: 'Report',
  icon: 'info',
  placement: 'right',
  sources: [{ id: 'report', eventType: 'quality/report', payloadVersion: 1 }],
  blocks: [
    {
      id: 'prepare',
      type: 'form',
      fields: [{ id: 'target', type: 'text', label: 'Target', required: true }],
      submit: { type: 'prepare-command', command: 'review', label: 'Prepare' },
    },
  ],
} as const;
function owner(events = ['quality/report'], commands = ['review']): PluginInfo {
  return {
    manifest: {
      id: 'quality',
      name: 'Quality',
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: ['panel', 'event', 'command'],
      contributes: { panels: ['report'], events: ['quality/report'], commands: ['review'] },
    },
    contributed: {
      tools: [],
      providers: [],
      promptSections: [],
      events,
      commands,
      skills: [],
      panels: ['report'],
      hooks: [],
      services: [],
    },
  } as PluginInfo;
}
const attributed = { ...definition, pluginId: 'quality' } satisfies AttributedPanel;
const command = {
  name: 'review',
  title: 'Review',
  prompt: 'Review $ARGUMENTS',
  pluginId: 'quality',
};
describe('immutable panel candidate binding', () => {
  it('requires actual same-owner accepted events and commands, and copies command strings', () => {
    const mutable = { ...command };
    const [bound] = bindPanelCatalog([attributed], [owner()], new Set(['quality/report']), [
      mutable,
    ]);
    mutable.prompt = 'changed';
    expect(bound!.commands.prepare!.prompt).toBe('Review $ARGUMENTS');
    expect(Object.isFrozen(bound!.definition.blocks)).toBe(true);
    for (const args of [
      [new Set<string>(), [command]],
      [new Set(['quality/report']), [{ ...command, pluginId: 'other' }]],
      [new Set(['quality/report']), []],
    ] as const)
      expect(() => bindPanelCatalog([attributed], [owner()], args[0], args[1])).toThrowError(
        expect.objectContaining({ pluginId: 'quality' }),
      );
    expect(() =>
      bindPanelCatalog([attributed], [owner([], [])], new Set(['quality/report']), [command]),
    ).toThrow();
  });
  it('rejects duplicate local IDs with owner attribution and global caps without attribution', () => {
    expect(() =>
      bindPanelCatalog([attributed, attributed], [owner()], new Set(['quality/report']), [command]),
    ).toThrowError(expect.objectContaining({ pluginId: 'quality' }));
    const [bound] = bindPanelCatalog([attributed], [owner()], new Set(['quality/report']), [
      command,
    ]);
    expect(() => assertPanelCatalogLimits(Array.from({ length: 129 }, () => bound!))).toThrowError(
      expect.objectContaining({ pluginId: undefined }),
    );
    expect(() =>
      assertPanelCatalogLimits(
        Array.from({ length: 128 }, () => ({
          ...bound!,
          definition: { ...bound!.definition, description: 'x'.repeat(10000) },
        })),
      ),
    ).toThrowError(expect.objectContaining({ pluginId: undefined }));
  });
  it('checks exact reserved complete catalog byte boundary with fixedtoken and max safe integer widths', () => {
    const [bound] = bindPanelCatalog([attributed], [owner()], new Set(['quality/report']), [
      command,
    ]);
    const panels: BoundPanelDefinition[] = [bound!];
    const reserved = {
      schemaVersion: 1,
      serverEpoch: 'A'.repeat(32),
      generation: Number.MAX_SAFE_INTEGER,
      authorityEpoch: Number.MAX_SAFE_INTEGER,
      acceptingRuns: false,
      panels: [
        {
          panelId: bound!.panelId,
          panelRef: 'A'.repeat(32),
          pluginId: bound!.pluginId,
          pluginName: bound!.pluginName,
          pluginVersion: bound!.pluginVersion,
          state: 'unavailable',
          definition: bound!.definition,
        },
      ],
    };
    const extra = 1048576 - panelBytes(reserved);
    const atLimit = {
      ...bound!,
      definition: { ...bound!.definition, title: bound!.definition.title + 'x'.repeat(extra) },
    };
    expect(() => assertPanelCatalogLimits([atLimit])).not.toThrow();
    expect(() =>
      assertPanelCatalogLimits([
        {
          ...atLimit,
          definition: { ...atLimit.definition, title: atLimit.definition.title + 'x' },
        },
      ]),
    ).toThrow();
    expect(panelBytes({ ...reserved, generation: 1, authorityEpoch: 1 })).toBeLessThan(
      panelBytes(reserved),
    );
    void panels;
  });
  it('binds real assembled accepted contributions and rejects declaration-only bindings', async () => {
    const runtime = createServerRuntime();
    await runtime.start();
    try {
      await createServerAgentRunner(runtime);
      const plugin = (defineEvent: boolean) =>
        definePlugin({
          manifest: owner().manifest,
          setup(env) {
            if (defineEvent)
              env.defineEvent('report', { schema: z.object({ schemaVersion: z.literal(1) }) });
            env.contribute(commandsExtensionPoint, (api) =>
              api.addCommand({ name: 'review', title: 'Review', prompt: 'Review $ARGUMENTS' }),
            );
            env.contribute(panelsExtensionPoint, (api) => api.addPanel(definition));
          },
        });
      const candidate = await assembleServerGeneration(runtime, { kernelPlugins: [plugin(true)] });
      expect(candidate.resources.panels[0]!.pluginId).toBe('quality');
      await candidate.dispose();
      await expect(
        assembleServerGeneration(runtime, { kernelPlugins: [plugin(false)] }),
      ).rejects.toMatchObject({ pluginId: 'quality' });
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
});
