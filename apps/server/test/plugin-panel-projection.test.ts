import { describe, expect, it } from 'vitest';
import { projectPanelPrefix } from '../src/plugin-panel-projection.js';
import type { BoundPanelDefinition } from '../src/plugin-panel-types.js';
import type { SessionEvent } from '@weave/session';
const panel = {
  panelId: 'plugin:quality/report',
  pluginId: 'quality',
  pluginName: 'Quality',
  pluginVersion: '1.0.0',
  definitionHash: '0'.repeat(64),
  commands: {},
  definition: {
    schemaVersion: 1,
    id: 'report',
    title: 'Report',
    icon: 'info',
    placement: 'right',
    sources: [{ id: 'report', eventType: 'quality/report', payloadVersion: 1 }],
    blocks: [
      {
        id: 'score',
        type: 'metric',
        label: 'Score',
        value: { binding: { source: 'report', path: ['score'] } },
      },
    ],
  },
} as const satisfies BoundPanelDefinition;
const event = (sequence: number, type: string, payload: unknown = {}): SessionEvent =>
  ({
    eventId: String(sequence),
    sessionId: 's',
    sequence,
    type,
    payload,
    occurredAt: '2026-11-22T00:00:00.000Z',
  }) as SessionEvent;
describe('panel prefix projection', () => {
  it('uses latest exact event including future versions and preserves empty tails', () => {
    const state = projectPanelPrefix('s', panel, undefined, [
      event(1, 'session.created'),
      event(2, 'quality/report', { schemaVersion: 1, score: 7 }),
      event(3, 'quality/report', { schemaVersion: 2, score: 9 }),
    ]);
    expect(state.sources[0]).toMatchObject({
      state: 'incompatible',
      latest: { sequence: 3, payloadVersion: 2 },
    });
    expect(state.blocks[0]).toMatchObject({ cell: { state: 'incompatible' } });
    expect(projectPanelPrefix('s', panel, state, [])).toEqual(state);
  });
  it('rejects missing creation, sequence gaps and cross-session envelopes', () => {
    for (const events of [
      [event(2, 'quality/report')],
      [event(1, 'session.created'), event(3, 'quality/report')],
      [{ ...event(1, 'session.created'), sessionId: 'other' }],
    ])
      expect(() => projectPanelPrefix('s', panel, undefined, events)).toThrowError(
        expect.objectContaining({ code: 'panel-session-invalid' }),
      );
    expect(() => projectPanelPrefix('s', panel, undefined, [])).toThrowError(
      expect.objectContaining({ code: 'session-not-found' }),
    );
  });
  it('folds archive restore delete lifecycle without changing prior state', () => {
    const base = projectPanelPrefix('s', panel, undefined, [
      event(1, 'session.created'),
      event(2, 'session.archived'),
    ]);
    expect(base.archived).toBe(true);
    expect(projectPanelPrefix('s', panel, base, [event(3, 'session.restored')]).archived).toBe(
      false,
    );
    expect(() => projectPanelPrefix('s', panel, base, [event(3, 'session.archived')])).toThrow();
    expect(() => projectPanelPrefix('s', panel, base, [event(3, 'session.deleted')])).toThrowError(
      expect.objectContaining({ code: 'session-deleted' }),
    );
    expect(base.lastSequence).toBe(2);
  });
});

describe('bounded selected panel projection', () => {
  const tablePanel = {
    ...panel,
    definition: {
      ...panel.definition,
      blocks: [
        {
          id: 'rows',
          type: 'table',
          rows: { source: 'report', path: ['rows'] },
          columns: [{ id: 'name', title: 'Name', path: ['name'] }],
        },
      ],
    },
  } as const satisfies BoundPanelDefinition;
  it('returns first100 rows with explicit counts and no unselected keys', () => {
    const rows = Array.from({ length: 103 }, (_, i) => ({
      name: String(i),
      secret: 'never expose',
    }));
    const state = projectPanelPrefix('s', tablePanel, undefined, [
      event(1, 'session.created'),
      event(2, 'quality/report', { schemaVersion: 1, rows }),
    ]);
    expect(state.blocks[0]).toMatchObject({ state: 'ready', totalRows: 103, truncatedRows: 3 });
    expect('rows' in state.blocks[0]! && state.blocks[0].rows).toHaveLength(100);
    expect(JSON.stringify(state)).not.toContain('secret');
  });
  it('marks wrong scalar/missing paths and oversized selected strings across the whole source', () => {
    for (const [score, expected] of [
      ['wrong', 'invalid-data'],
      [undefined, 'invalid-data'],
      [{}, 'invalid-data'],
    ]) {
      const state = projectPanelPrefix('s', panel, undefined, [
        event(1, 'session.created'),
        event(2, 'quality/report', { schemaVersion: 1, score }),
      ]);
      expect(state.sources[0]!.state).toBe(expected);
    }
    const state = projectPanelPrefix('s', tablePanel, undefined, [
      event(1, 'session.created'),
      event(2, 'quality/report', { schemaVersion: 1, rows: [{ name: 'x'.repeat(1025) }] }),
    ]);
    expect(state.sources[0]!.state).toBe('data-too-large');
    expect(state.blocks[0]).toMatchObject({ state: 'data-too-large', rows: [], totalRows: 0 });
  });
  it('never traverses inherited paths and retains source markers across unrelated tails', () => {
    const payload = Object.assign(Object.create({ score: 9 }), { schemaVersion: 1 });
    const invalid = projectPanelPrefix('s', panel, undefined, [
      event(1, 'session.created'),
      event(2, 'quality/report', payload),
    ]);
    expect(invalid.sources[0]!.state).toBe('invalid-data');
    const state = projectPanelPrefix('s', panel, invalid, [
      event(3, 'session.renamed', { title: 'Other' }),
    ]);
    expect(state.lastSequence).toBe(3);
    expect(state.sources).toEqual(invalid.sources);
    expect(state.blocks).toEqual(invalid.blocks);
  });
  it('compacts complete escapedUTF8 overflow and advances cursor beyond oversized event', () => {
    const dense = {
      ...tablePanel,
      definition: {
        ...tablePanel.definition,
        blocks: [
          {
            id: 'rows',
            type: 'table',
            rows: { source: 'report', path: ['rows'] },
            columns: Array.from({ length: 10 }, (_, i) => ({
              id: `c${i}`,
              title: 'Column',
              path: [`c${i}`],
            })),
          },
        ],
      },
    } satisfies BoundPanelDefinition;
    const rows = Array.from({ length: 100 }, () =>
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}`, '\0'.repeat(1024)])),
    );
    const state = projectPanelPrefix('s', dense, undefined, [
      event(1, 'session.created'),
      event(2, 'quality/report', { schemaVersion: 1, rows }),
    ]);
    expect(state.state).toBe('data-too-large');
    expect(state.lastSequence).toBe(2);
    expect(Buffer.byteLength(JSON.stringify(state), 'utf8')).toBeLessThan(65536);
    expect(projectPanelPrefix('s', dense, state, [])).toEqual(state);
  });
  it.each([
    'message.created',
    'turn.started',
    'step.started',
    'step.completed',
    'tool-call.created',
    'tool-result.created',
  ])('matches Session archive prohibition for %s', (type) => {
    expect(() =>
      projectPanelPrefix('s', panel, undefined, [
        event(1, 'session.created'),
        event(2, 'session.archived'),
        event(3, type),
      ]),
    ).toThrowError(expect.objectContaining({ code: 'panel-session-invalid' }));
  });
});
