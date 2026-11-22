import { createHash } from 'node:crypto';
import {
  cloneDeclarativePanel,
  PluginError,
  type AttributedPanel,
  type PluginInfo,
} from '@weave/plugin';
import { freezePanel, panelBytes, type BoundPanelDefinition } from './plugin-panel-types.js';
import type { CommandListItem } from './plugin-catalog.js';
function invalid(pluginId: string) {
  return new PluginError('plugin-registration-conflict', 'Plugin panel contribution is invalid', {
    pluginId,
  });
}
export function bindPanelCatalog(
  panels: readonly AttributedPanel[],
  plugins: readonly PluginInfo[],
  acceptedEvents: ReadonlySet<string>,
  commands: readonly CommandListItem[],
): readonly BoundPanelDefinition[] {
  const result: BoundPanelDefinition[] = [];
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  for (const panel of panels) {
    const owner = panel.pluginId;
    try {
      const info = plugins.find((item) => item.manifest.id === owner);
      if (!info) throw invalid(owner);
      const { manifest, contributed } = info;
      if (
        !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(owner) ||
        owner.length > 64 ||
        manifest.name.length < 1 ||
        manifest.name.length > 120 ||
        manifest.version.length > 64
      )
        throw invalid(owner);
      const { pluginId: ignored, ...input } = panel;
      void ignored;
      const definition = cloneDeclarativePanel(input);
      const panelId = `plugin:${owner}/${definition.id}`;
      const count = (counts.get(owner) ?? 0) + 1;
      if (count > 8 || ids.has(panelId) || !contributed.panels.includes(definition.id))
        throw invalid(owner);
      counts.set(owner, count);
      ids.add(panelId);
      for (const source of definition.sources)
        if (
          !source.eventType.startsWith(`${owner}/`) ||
          !contributed.events.includes(source.eventType) ||
          !acceptedEvents.has(source.eventType)
        )
          throw invalid(owner);
      const frozenCommands: Record<string, { name: string; prompt: string }> = Object.create(
        null,
      ) as Record<string, { name: string; prompt: string }>;
      for (const block of definition.blocks) {
        if (block.type !== 'form') continue;
        const command = commands.find(
          (item) => item.name === block.submit.command && item.pluginId === owner,
        );
        if (!command || !contributed.commands.includes(command.name)) throw invalid(owner);
        Object.defineProperty(frozenCommands, block.id, {
          value: { name: command.name, prompt: command.prompt },
          enumerable: true,
        });
      }
      result.push(
        freezePanel({
          panelId,
          pluginId: owner,
          pluginName: manifest.name,
          pluginVersion: manifest.version,
          definitionHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
          definition,
          commands: frozenCommands,
        }),
      );
    } catch {
      throw invalid(owner);
    }
  }
  assertPanelCatalogLimits(result);
  return freezePanel(result);
}
/** Publication validation includes the complete worst-sized wire envelope, not private commands. */
export function assertPanelCatalogLimits(panels: readonly BoundPanelDefinition[]): void {
  const token = 'A'.repeat(32);
  const wire = {
    schemaVersion: 1,
    serverEpoch: token,
    generation: Number.MAX_SAFE_INTEGER,
    authorityEpoch: Number.MAX_SAFE_INTEGER,
    acceptingRuns: false,
    panels: panels.map((panel) => ({
      panelId: panel.panelId,
      panelRef: token,
      pluginId: panel.pluginId,
      pluginName: panel.pluginName,
      pluginVersion: panel.pluginVersion,
      state: 'unavailable',
      definition: panel.definition,
    })),
  };
  if (panels.length > 128 || panelBytes(wire) > 1048576)
    throw new PluginError(
      'plugin-registration-conflict',
      'Plugin panel catalog exceeds host limits',
    );
}
