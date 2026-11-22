import { describe, expect, it } from 'vitest';
import {
  declarativePanelSchema,
  panelCatalogSchema,
  panelDataSchema,
  validatePanelData,
} from '../src/features/panel/plugin-panel-types.js';
const definition = {
  schemaVersion: 1,
  id: 'report',
  title: 'Report',
  icon: 'info',
  placement: 'right',
  sources: [],
  blocks: [{ id: 'text', type: 'text', value: { literal: 'hello' } }],
};
const authority = { serverEpoch: 'a'.repeat(32), generation: 1, authorityEpoch: 1 };
const data = {
  ...authority,
  schemaVersion: 1,
  panelId: 'plugin:owner/report',
  panelRef: 'b'.repeat(32),
  sessionId: 's',
  lastSequence: 1,
  state: 'ready',
  sources: [],
  blocks: [{ id: 'text', type: 'text', cell: { state: 'ready', value: 'hello' } }],
};
describe('independent strict panel mirror', () => {
  it('accepts bounded empty descriptions and whitespace owner metadata from the exact contract', () => {
    expect(declarativePanelSchema.safeParse({ ...definition, description: '' }).success).toBe(true);
    expect(
      panelCatalogSchema.safeParse({
        ...authority,
        schemaVersion: 1,
        acceptingRuns: true,
        panels: [
          {
            panelId: 'plugin:owner/report',
            panelRef: 'b'.repeat(32),
            pluginId: 'owner',
            pluginName: ' ',
            pluginVersion: '1.0.0',
            state: 'available',
            definition: { ...definition, description: '' },
          },
        ],
      }).success,
    ).toBe(true);
  });
  it('rejects metric literals that are not numbers or null', () => {
    expect(
      declarativePanelSchema.safeParse({
        ...definition,
        blocks: [{ id: 'metric', type: 'metric', label: 'Metric', value: { literal: 'string' } }],
      }).success,
    ).toBe(false);
  });

  it('accepts closed host definitions and rejects unknown execution vocabulary', () => {
    expect(declarativePanelSchema.safeParse(definition).success).toBe(true);
    for (const patch of [
      { url: 'https://x' },
      { schemaVersion: 2 },
      { blocks: [{ id: 'x', type: 'html', text: 'x' }] },
    ])
      expect(declarativePanelSchema.safeParse({ ...definition, ...patch }).success).toBe(false);
  });
  it('rejects duplicate IDs, bad paths and select defaults', () => {
    for (const blocks of [
      [definition.blocks[0], definition.blocks[0]],
      [{ id: 'x', type: 'text', value: { binding: { source: 'missing', path: ['constructor'] } } }],
      [
        {
          id: 'f',
          type: 'form',
          fields: [
            {
              id: 'v',
              type: 'select',
              label: 'Value',
              required: true,
              options: [{ value: 'a', label: 'A' }],
              default: 'b',
            },
          ],
          submit: { type: 'prepare-command', command: 'report', label: 'Prepare' },
        },
      ],
    ])
      expect(declarativePanelSchema.safeParse({ ...definition, blocks }).success).toBe(false);
  });
  it('checks exact data correspondence rather than accepting only shape', () => {
    const panel = declarativePanelSchema.parse(definition);
    const parsed = panelDataSchema.parse(data);
    expect(validatePanelData(panel, parsed)).toBe(true);
    expect(validatePanelData(panel, panelDataSchema.parse({ ...data, blocks: [] }))).toBe(false);
    expect(
      validatePanelData(
        panel,
        panelDataSchema.parse({
          ...data,
          blocks: [{ id: 'wrong', type: 'text', cell: { state: 'ready', value: 'hello' } }],
        }),
      ),
    ).toBe(false);
  });
  it('rejects catalog stable identity and unknown keys', () => {
    const entry = {
      panelId: 'plugin:owner/report',
      panelRef: 'b'.repeat(32),
      pluginId: 'owner',
      pluginName: 'Owner',
      pluginVersion: '1.0.0',
      state: 'available',
      definition,
    };
    const catalog = { ...authority, schemaVersion: 1, acceptingRuns: true, panels: [entry] };
    expect(panelCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(
      panelCatalogSchema.safeParse({
        ...catalog,
        panels: [{ ...entry, panelId: 'plugin:other/report' }],
      }).success,
    ).toBe(false);
    expect(panelCatalogSchema.safeParse({ ...catalog, unknown: true }).success).toBe(false);
  });
});
