import rawFixture from './fixtures/plugin-panel-contract.json';
import { describe, expect, it } from 'vitest';
import {
  panelCatalogSchema,
  panelDataSchema,
  preparedCommandSchema,
  validatePanelData,
} from '../src/features/panel/plugin-panel-types.js';

describe('Studio independent mirror of actual Server panel DTOs', () => {
  it('consumes the actual neutral Server fixture with exact block correspondence', () => {
    const raw = structuredClone(rawFixture);
    const catalog = panelCatalogSchema.parse(raw.catalog);
    const data = panelDataSchema.parse(raw.data);
    const prepared = preparedCommandSchema.parse(raw.prepared);
    expect(catalog.panels).toHaveLength(1);
    const panel = catalog.panels[0]!;
    expect(validatePanelData(panel.definition, data)).toBe(true);
    expect(data.panelRef).toBe(panel.panelRef);
    expect(prepared.panelRef).toBe(panel.panelRef);
    expect(prepared.sessionId).toBe(data.sessionId);
    expect(prepared.requiresUserSend).toBe(true);
    expect(prepared.text).toContain('{"target":"src","include-tests":true}');
    expect(data.blocks).toContainEqual({
      id: 'summary',
      type: 'text',
      cell: { state: 'ready', value: '<img src=x onerror=alert(1)> remains text' },
    });
  });

  it('rejects protocol drift and structurally valid but wrong definition correspondence', () => {
    const raw = structuredClone(rawFixture);
    const catalog = panelCatalogSchema.parse(raw.catalog);
    const data = panelDataSchema.parse(raw.data);
    expect(panelCatalogSchema.safeParse({ ...catalog, schemaVersion: 2 }).success).toBe(false);
    expect(panelDataSchema.safeParse({ ...data, payload: { hidden: true } }).success).toBe(false);
    expect(
      preparedCommandSchema.safeParse({
        ...preparedCommandSchema.parse(raw.prepared),
        requiresUserSend: false,
      }).success,
    ).toBe(false);
    const wrong = {
      ...data,
      blocks: data.blocks.map((block, index) =>
        index === 0 ? { ...block, id: 'different-block' } : block,
      ),
    };
    expect(validatePanelData(catalog.panels[0]!.definition, panelDataSchema.parse(wrong))).toBe(
      false,
    );
    const wrongKind = {
      ...data,
      blocks: data.blocks.map((block, index) =>
        index === 0 ? { id: block.id, type: 'text', cell: { state: 'ready', value: 88 } } : block,
      ),
    };
    expect(validatePanelData(catalog.panels[0]!.definition, panelDataSchema.parse(wrongKind))).toBe(
      false,
    );
  });
});
