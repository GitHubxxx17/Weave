import { describe, expect, it } from 'vitest';

import { ExtensionRegistry, defineExtensionPoint } from '../src/extension-point.js';
import { PluginError } from '../src/plugin-errors.js';

interface ToolsApi {
  add(name: string): void;
}

describe('ExtensionRegistry', () => {
  it('runs contributions in registration order against the owner api', () => {
    const point = defineExtensionPoint<ToolsApi>({ id: 'tools' });
    const registry = new ExtensionRegistry();
    registry.contribute(point, (api) => api.add('a'), 'p1');
    registry.contribute(point, (api) => api.add('b'), 'p2');
    const collected: string[] = [];
    registry.collect(point, { add: (name) => collected.push(name) });
    expect(collected).toEqual(['a', 'b']);
  });

  it('rejects a second contribution to a single-slot point', () => {
    const point = defineExtensionPoint<ToolsApi>({ id: 'compaction', singleSlot: true });
    const registry = new ExtensionRegistry();
    registry.contribute(point, (api) => api.add('a'), 'p1');
    registry.contribute(point, (api) => api.add('b'), 'p2');
    try {
      registry.collect(point, { add: () => undefined });
      throw new Error('expected collect to throw');
    } catch (error) {
      expect((error as PluginError).code).toBe('plugin-extension-single-slot');
    }
  });

  it('removes a contribution through its disposer', () => {
    const point = defineExtensionPoint<ToolsApi>({ id: 'tools' });
    const registry = new ExtensionRegistry();
    const dispose = registry.contribute(point, (api) => api.add('a'), 'p1');
    registry.contribute(point, (api) => api.add('b'), 'p2');
    dispose();
    expect(registry.count(point)).toBe(1);
    const collected: string[] = [];
    registry.collect(point, { add: (name) => collected.push(name) });
    expect(collected).toEqual(['b']);
  });
});
