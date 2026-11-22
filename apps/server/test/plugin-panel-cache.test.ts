import { describe, expect, it } from 'vitest';
import { createPanelCache } from '../src/plugin-panel-cache.js';
import type { PanelProjection } from '../src/plugin-panel-projection.js';
function state(size = 0): PanelProjection {
  return {
    lastSequence: 1,
    archived: false,
    state: 'ready',
    sources: [],
    blocks: [{ id: 'text', type: 'text', cell: { state: 'ready', value: 'x'.repeat(size) } }],
  };
}
describe('bounded panel cache', () => {
  it('evicts Session buckets at129 and refreshes Session LRU', () => {
    const cache = createPanelCache();
    for (let i = 0; i < 128; i++) cache.put(String(i), String(i), state());
    cache.get('0');
    cache.put('128', '128', state());
    expect(cache.get('1')).toBeUndefined();
    expect(cache.get('0')).toBeDefined();
    expect(cache.get('128')).toBeDefined();
  });
  it('evicts entry17 per Session and257 globally', () => {
    const cache = createPanelCache();
    for (let i = 0; i < 16; i++) cache.put(String(i), 's', state());
    cache.get('0');
    cache.put('16', 's', state());
    expect(cache.get('1')).toBeUndefined();
    expect(cache.get('0')).toBeDefined();
    const global = createPanelCache();
    for (let i = 0; i < 256; i++) global.put(String(i), String(Math.floor(i / 16)), state());
    global.put('256', 'last', state());
    expect(global.get('0')).toBeUndefined();
    expect(global.get('255')).toBeDefined();
  });
  it('enforces512KiB per Session and8MiB globally using actual serialized bytes', () => {
    const cache = createPanelCache();
    for (let i = 0; i < 9; i++) cache.put(String(i), 's', state(60000));
    expect(cache.get('0')).toBeUndefined();
    expect(cache.get('8')).toBeDefined();
    const global = createPanelCache();
    for (let i = 0; i < 140; i++) global.put(String(i), String(Math.floor(i / 8)), state(60000));
    expect(global.get('0')).toBeUndefined();
    expect(global.get('139')).toBeDefined();
  });
  it('does not resurrect evicted/replaced bases or mutate on oversized commit', () => {
    const cache = createPanelCache();
    cache.put('a', 's', state());
    const base = cache.get('a')!;
    cache.clear();
    cache.put('a', 's', state(1));
    cache.put('a', 's', state(2), base);
    expect(cache.get('a')!.value).toEqual(state(1));
    cache.put('large', 's', state(65536));
    expect(cache.get('large')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
  });
});
