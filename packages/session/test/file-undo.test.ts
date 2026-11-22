import { describe, expect, it } from 'vitest';

import {
  collectFileUndo,
  collectSafeFileUndo,
  fileUndoForTurn,
  type SessionEvent,
} from '../src/index.js';

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

describe('safe file undo evidence', () => {
  const identity = {
    snapshotId: 'snap',
    turnId: 't1',
    toolCallId: 'call',
    rootIdentity: 'root',
    beforeDigest: 'a'.repeat(64),
  };
  it('retains legacy snapshots with an explicit unavailable reason', () => {
    const result = collectSafeFileUndo(
      [
        event('turn.started', { turnId: 't1' }, 1),
        event(
          'workspace.file-snapshot',
          { path: 'a', existedBefore: true, previousContent: 'old' },
          2,
        ),
        event('turn.completed', { turnId: 't1', status: 'completed' }, 3),
      ],
      't1',
    );
    expect(result).toMatchObject([{ path: 'a', unavailableReason: 'legacy-snapshot' }]);
  });
  it('requires successful write evidence and combines a complete repeated-write chain', () => {
    const before = { ...identity, path: 'a', existedBefore: true, previousContent: 'old' };
    const events = [
      event('turn.started', { turnId: 't1' }, 1),
      event('workspace.file-write-intent', { ...identity, path: 'a' }, 2),
      event('workspace.file-snapshot', before, 3),
    ];
    expect(collectSafeFileUndo(events, 't1')[0]?.unavailableReason).toBe('missing-write-outcome');
    events.push(
      event(
        'workspace.file-write',
        {
          ...identity,
          path: 'a',
          status: 'succeeded',
          captureStatus: 'captured',
          fileIdentity: 'file',
          afterContent: 'new',
          afterDigest: 'b'.repeat(64),
        },
        4,
      ),
    );
    expect(collectSafeFileUndo(events, 't1')[0]).toMatchObject({
      previousContent: 'old',
      afterContent: 'new',
      afterDigest: 'b'.repeat(64),
    });
    events.push(
      event(
        'workspace.file-write-intent',
        { ...identity, snapshotId: 'snap2', toolCallId: 'call2', path: 'a' },
        5,
      ),
    );
    events.push(
      event(
        'workspace.file-snapshot',
        {
          ...before,
          snapshotId: 'snap2',
          toolCallId: 'call2',
          previousContent: 'new',
          beforeDigest: 'b'.repeat(64),
        },
        6,
      ),
    );
    events.push(
      event(
        'workspace.file-write',
        {
          ...identity,
          snapshotId: 'snap2',
          toolCallId: 'call2',
          path: 'a',
          status: 'succeeded',
          captureStatus: 'captured',
          fileIdentity: 'file',
          afterContent: 'final',
          afterDigest: 'c'.repeat(64),
        },
        7,
      ),
    );
    expect(collectSafeFileUndo(events, 't1')[0]).toMatchObject({
      previousContent: 'old',
      afterContent: 'final',
      afterDigest: 'c'.repeat(64),
    });
  });
});

it('keeps a path unavailable when its first intent lost both capture and outcome', () => {
  const identity = {
    snapshotId: 'lost',
    turnId: 't',
    toolCallId: 'first',
    rootIdentity: 'root',
    path: 'a',
  };
  const events = [
    event('turn.started', { turnId: 't' }, 1),
    event('workspace.file-write-intent', identity, 2),
    event(
      'workspace.file-write-intent',
      { ...identity, snapshotId: 'later', toolCallId: 'second' },
      3,
    ),
    event(
      'workspace.file-snapshot',
      {
        ...identity,
        snapshotId: 'later',
        toolCallId: 'second',
        existedBefore: true,
        previousContent: 'B',
        beforeDigest: 'b'.repeat(64),
      },
      4,
    ),
    event(
      'workspace.file-write',
      {
        ...identity,
        snapshotId: 'later',
        toolCallId: 'second',
        status: 'succeeded',
        captureStatus: 'captured',
        fileIdentity: 'file',
        afterContent: 'C',
        afterDigest: 'c'.repeat(64),
      },
      5,
    ),
  ];
  expect(collectSafeFileUndo(events, 't')[0]?.unavailableReason).toBe('missing-write-outcome');
});
it('rejects duplicate and out-of-order capture identities', () => {
  const identity = {
    snapshotId: 'snap',
    turnId: 't',
    toolCallId: 'call',
    rootIdentity: 'root',
    path: 'a',
  };
  const snapshot = {
    ...identity,
    existedBefore: true,
    previousContent: 'A',
    beforeDigest: 'a'.repeat(64),
  };
  const outcome = {
    ...identity,
    status: 'succeeded',
    captureStatus: 'captured',
    fileIdentity: 'file',
    afterContent: 'B',
    afterDigest: 'b'.repeat(64),
  };
  const ordered = [
    event('turn.started', { turnId: 't' }, 1),
    event('workspace.file-write-intent', identity, 2),
    event('workspace.file-snapshot', snapshot, 3),
    event('workspace.file-write', outcome, 4),
  ];
  expect(
    collectSafeFileUndo([...ordered, event('workspace.file-snapshot', snapshot, 5)], 't')[0]
      ?.unavailableReason,
  ).toBe('incomplete-write-evidence');
  expect(
    collectSafeFileUndo(
      [
        ordered[0]!,
        ordered[1]!,
        event('workspace.file-write', outcome, 3),
        event('workspace.file-snapshot', snapshot, 4),
      ],
      't',
    )[0]?.unavailableReason,
  ).toBe('incomplete-write-evidence');
  expect(
    collectSafeFileUndo([ordered[0]!, ordered[2]!, ordered[3]!], 't')[0]?.unavailableReason,
  ).toBe('missing-write-intent');
});

it('fails closed when two lexical paths identify the same file', () => {
  const base = { turnId: 't', rootIdentity: 'root' };
  const events: SessionEvent[] = [event('turn.started', { turnId: 't' }, 1)];
  for (const [index, path] of ['Case', 'case'].entries()) {
    const identity = { ...base, path, snapshotId: `s${index}`, toolCallId: `c${index}` };
    events.push(
      event('workspace.file-write-intent', identity, 2 + index * 3),
      event(
        'workspace.file-snapshot',
        {
          ...identity,
          existedBefore: true,
          previousContent: index === 0 ? 'A' : 'B',
          beforeDigest: (index === 0 ? 'a' : 'b').repeat(64),
        },
        3 + index * 3,
      ),
      event(
        'workspace.file-write',
        {
          ...identity,
          status: 'succeeded',
          captureStatus: 'captured',
          afterContent: index === 0 ? 'B' : 'C',
          afterDigest: (index === 0 ? 'b' : 'c').repeat(64),
          fileIdentity: 'same',
        },
        4 + index * 3,
      ),
    );
  }
  expect(collectSafeFileUndo(events, 't').map((file) => file.unavailableReason)).toEqual([
    'path-alias-conflict',
    'path-alias-conflict',
  ]);
});
