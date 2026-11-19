import { describe, expect, it } from 'vitest';

import { collectFileUndo, fileUndoForTurn, type SessionEvent } from '../src/index.js';

function event(
  type: SessionEvent['type'],
  payload: Record<string, unknown>,
  sequence: number,
): SessionEvent {
  return {
    eventId: `e${sequence}`,
    sessionId: 's1',
    sequence,
    occurredAt: '2026-11-19T00:00:00.000Z',
    type,
    payload,
  } as SessionEvent;
}

describe('collectFileUndo', () => {
  const events: SessionEvent[] = [
    event('turn.started', { turnId: 't1' }, 1),
    event(
      'workspace.file-snapshot',
      { path: 'a.ts', existedBefore: true, previousContent: 'A0' },
      2,
    ),
    event(
      'workspace.file-snapshot',
      { path: 'a.ts', existedBefore: true, previousContent: 'A1' },
      3,
    ),
    event(
      'workspace.file-snapshot',
      { path: 'b.ts', existedBefore: false, previousContent: '' },
      4,
    ),
    event('turn.completed', { turnId: 't1', status: 'completed' }, 5),
    // Recorded outside any running turn; must be ignored.
    event(
      'workspace.file-snapshot',
      { path: 'c.ts', existedBefore: true, previousContent: 'C' },
      6,
    ),
    event('turn.started', { turnId: 't2' }, 7),
    event(
      'workspace.file-snapshot',
      { path: 'a.ts', existedBefore: true, previousContent: 'later' },
      8,
    ),
    event('turn.completed', { turnId: 't2', status: 'completed' }, 9),
  ];

  it('groups by running turn and keeps the first snapshot per path', () => {
    expect(collectFileUndo(events)).toEqual([
      {
        turnId: 't1',
        snapshots: [
          { path: 'a.ts', existedBefore: true, previousContent: 'A0' },
          { path: 'b.ts', existedBefore: false, previousContent: '' },
        ],
      },
      {
        turnId: 't2',
        snapshots: [{ path: 'a.ts', existedBefore: true, previousContent: 'later' }],
      },
    ]);
  });

  it('returns the snapshots for one turn or an empty list', () => {
    expect(fileUndoForTurn(events, 't1').map((snapshot) => snapshot.path)).toEqual([
      'a.ts',
      'b.ts',
    ]);
    expect(fileUndoForTurn(events, 'missing')).toEqual([]);
  });
});
