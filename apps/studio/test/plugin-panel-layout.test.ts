import { describe, expect, it } from 'vitest';
import { normalizePanelLayout } from '../src/features/panel/panel-layout.js';
describe('v3 panel layout', () => {
  it('migrates every builtin instance without consulting a catalog', () => {
    const result = normalizePanelLayout(null, {
      tabs: [
        { id: 'preview:first', kind: 'preview' },
        { id: 'terminal:first', kind: 'terminal' },
        { id: 'plugins', kind: 'plugins' },
        { id: 'preview:second', kind: 'preview' },
        { id: 'terminal:second', kind: 'terminal' },
      ],
      pinned: ['preview:first', 'terminal:second'],
      active: 'terminal:second',
    });
    expect(result.tabs.map((t) => t.id)).toEqual([
      'preview:first',
      'terminal:first',
      'preview:second',
      'terminal:second',
    ]);
    expect(result.pinned).toEqual(['preview:first', 'terminal:second']);
    expect(result.active).toBe('terminal:second');
    expect(result.schemaVersion).toBe(3);
  });
  it('preserves unresolved plugin tabs and good siblings while repairing subsets', () => {
    const result = normalizePanelLayout(
      {
        schemaVersion: 3,
        tabs: [
          { id: 'plugin:p/report', kind: 'plugin', panelId: 'plugin:p/report' },
          { id: 'bad', kind: 'plugin', panelId: 'url' },
          { id: 'preview:one', kind: 'builtin', builtinKind: 'preview' },
          { id: 'plugin:p/report', kind: 'plugin', panelId: 'plugin:p/report' },
        ],
        pinned: ['plugin:p/report', 'missing', 'plugin:p/report'],
        active: 'plugin:p/report',
      },
      null,
    );
    expect(result.tabs.map((t) => t.id)).toEqual(['plugin:p/report', 'preview:one']);
    expect(result.pinned).toEqual(['plugin:p/report']);
    expect(result.active).toBe('plugin:p/report');
  });
});
