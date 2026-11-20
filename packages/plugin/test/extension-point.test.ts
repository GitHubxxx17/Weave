import { describe, expect, it } from 'vitest';

import {
  ExtensionRegistry,
  defineExtensionPoint,
  type PluginDeclaration,
} from '../src/extension-point.js';
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

describe('governed extension points', () => {
  const governedPoint = defineExtensionPoint<ToolsApi>({
    id: 'tools',
    governed: {
      capability: 'tool',
      key: 'tools',
      guard: (api, check) => ({
        add(name) {
          check(name);
          api.add(name);
        },
      }),
    },
  });

  function declaration(over: Partial<PluginDeclaration> = {}): PluginDeclaration {
    return { capabilities: ['tool'], ...over };
  }

  function collectInto(registry: ExtensionRegistry, point = governedPoint): string[] {
    const collected: string[] = [];
    registry.collect(point, { add: (name) => collected.push(name) });
    return collected;
  }

  it('rejects a contributor that did not declare the capability', () => {
    const registry = new ExtensionRegistry();

    expect(() =>
      registry.contribute(
        governedPoint,
        (api) => api.add('a'),
        'p1',
        declaration({ capabilities: ['prompt'] }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'plugin-capability-not-declared' }));
    expect(registry.count(governedPoint)).toBe(0);
  });

  it('leaves a contributor that declared no contributes unrestricted', () => {
    const registry = new ExtensionRegistry();
    registry.contribute(
      governedPoint,
      (api) => {
        api.add('a');
        api.add('b');
      },
      'p1',
      declaration(),
    );

    expect(collectInto(registry)).toEqual(['a', 'b']);
  });

  it('lets a contributor add the names it lists and stops at the first it does not', () => {
    const registry = new ExtensionRegistry();
    registry.contribute(
      governedPoint,
      (api) => {
        api.add('a');
        api.add('b');
        api.add('c');
      },
      'p1',
      declaration({ contributes: { tools: ['a', 'c'] } }),
    );
    const collected: string[] = [];

    expect(() => registry.collect(governedPoint, { add: (name) => collected.push(name) })).toThrow(
      /Plugin "p1" contributed tool "b" but its manifest contributes\.tools does not list it/,
    );
    expect(collected).toEqual(['a']);
  });

  it('reports the exceeded declaration with its error code', () => {
    const registry = new ExtensionRegistry();
    registry.contribute(
      governedPoint,
      (api) => api.add('a'),
      'p1',
      declaration({ contributes: { tools: ['other'] } }),
    );

    expect(() => collectInto(registry)).toThrowError(
      expect.objectContaining({ code: 'plugin-contributes-exceeds-manifest' }),
    );
  });

  it('treats a contributes list that omits the key as empty', () => {
    const registry = new ExtensionRegistry();
    registry.contribute(
      governedPoint,
      (api) => api.add('a'),
      'p1',
      declaration({ contributes: {} }),
    );

    expect(() => collectInto(registry)).toThrowError(
      expect.objectContaining({ code: 'plugin-contributes-exceeds-manifest' }),
    );
  });

  it('holds each contributor to its own declaration', () => {
    const registry = new ExtensionRegistry();
    registry.contribute(
      governedPoint,
      (api) => api.add('a'),
      'p1',
      declaration({ contributes: { tools: ['a'] } }),
    );
    registry.contribute(governedPoint, (api) => api.add('free'), 'p2', declaration());
    registry.contribute(
      governedPoint,
      (api) => api.add('a'),
      'p3',
      declaration({ contributes: { tools: ['c'] } }),
    );
    const collected: string[] = [];

    expect(() => registry.collect(governedPoint, { add: (name) => collected.push(name) })).toThrow(
      /Plugin "p3"/,
    );
    expect(collected).toEqual(['a', 'free']);
  });

  it('does not govern a contribution recorded without a declaration', () => {
    const registry = new ExtensionRegistry();
    registry.contribute(governedPoint, (api) => api.add('anything'), 'p1');

    expect(collectInto(registry)).toEqual(['anything']);
  });

  it('does not govern a point that has no governed spec', () => {
    const plain = defineExtensionPoint<ToolsApi>({ id: 'plain' });
    const registry = new ExtensionRegistry();
    registry.contribute(
      plain,
      (api) => api.add('x'),
      'p1',
      declaration({ capabilities: ['prompt'], contributes: {} }),
    );

    expect(collectInto(registry, plain)).toEqual(['x']);
  });
});
