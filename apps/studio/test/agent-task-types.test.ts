import { describe, expect, it } from 'vitest';
import {
  agentTaskViewSchema,
  agentTaskTreeSnapshotSchema,
} from '../src/features/tasks/task-types.js';

const view = {
  taskId: '00000000-0000-4000-8000-000000000001',
  rootSessionId: 'root',
  parentSessionId: 'root',
  parentTurnId: 'turn',
  childSessionId: '00000000-0000-4000-8000-000000000002',
  childExecutionId: '00000000-0000-4000-8000-000000000003',
  childTurnId: '00000000-0000-4000-8000-000000000004',
  title: 'Review',
  access: 'read-only',
  acceptedAt: '2026-11-23T00:00:00.000Z',
  status: 'preparing',
  resultKind: 'none',
  preview: '',
  previewTruncated: false,
  pendingApprovalIds: [],
  pendingApprovalCount: 0,
};

describe('Studio task transport contract', () => {
  it('accepts safe root tree metadata and exact immutable child pointers', () => {
    expect(
      agentTaskTreeSnapshotSchema.parse({
        epoch: 'epoch',
        rootSessionId: 'root',
        revision: 2,
        cursor: 'opaque',
        changed: true,
        tasks: [view],
        totalCount: 1,
        truncated: false,
      }).tasks[0]?.access,
    ).toBe('read-only');
    const result = {
      sessionId: view.childSessionId,
      executionId: view.childExecutionId,
      turnId: view.childTurnId,
      messageId: 'message',
      terminalSequence: 12,
    };
    expect(
      agentTaskViewSchema.parse({
        ...view,
        status: 'completed',
        resultKind: 'final-answer',
        preview: 'Done',
        result,
      }).result,
    ).toEqual(result);
  });
  it('rejects leaked host authority, impossible outcomes and mismatched pointers', () => {
    for (const patch of [
      { prompt: 'private' },
      { toolAuthority: {} },
      { settings: {} },
      { status: 'running', settledAt: '2026-11-23T01:00:00.000Z' },
      { status: 'completed', reason: 'native raw message' },
      {
        status: 'failed',
        reason: 'preparation-failed',
        resultKind: 'partial',
        preview: 'fake',
        result: {
          sessionId: view.childSessionId,
          executionId: view.childExecutionId,
          turnId: view.childTurnId,
          messageId: 'fake',
          terminalSequence: 1,
        },
      },
      {
        status: 'completed',
        resultKind: 'final-answer',
        preview: 'wrong',
        result: {
          sessionId: view.childSessionId,
          executionId: '00000000-0000-4000-8000-000000000009',
          turnId: view.childTurnId,
          messageId: 'wrong',
          terminalSequence: 1,
        },
      },
    ])
      expect(agentTaskViewSchema.safeParse({ ...view, ...patch }).success).toBe(false);
  });
});
