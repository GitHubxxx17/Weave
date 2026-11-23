import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';

const spawn = { title: 'Review', prompt: 'Review the changes.' };
const id = 'ca120f04-f884-4a45-841a-092e32990b15';
const preparation = {
  phase: 'preparation',
  status: 'failed',
  reason: 'preparation-failed',
  evidence: { stage: 'accepted', parentAcceptedSequence: 2 },
  resultKind: 'none',
};
const execution = {
  phase: 'execution',
  status: 'completed',
  executionStatus: 'completed',
  childExecutionId: id,
  childTerminalSequence: 8,
  resultKind: 'final-answer',
  messageId: 'message-1',
  preview: 'Answer',
  previewTruncated: false,
};

describe('Agent task protocol', () => {
  it('defaults to read-only, with explicit workspace access', () => {
    expect(protocol.agentTaskSpawnInputSchema?.safeParse(spawn)).toMatchObject({
      success: true,
      data: { ...spawn, access: 'read-only' },
    });
    expect(
      protocol.agentTaskSpawnInputSchema?.safeParse({ ...spawn, access: 'workspace' }),
    ).toMatchObject({
      success: true,
      data: { ...spawn, access: 'workspace' },
    });
  });

  it.each(['root', 'cwd', 'projectId', 'generationId', 'token', 'parentTurnId', 'files'])(
    'rejects model-supplied authority field %s',
    (key) =>
      expect(
        protocol.agentTaskSpawnInputSchema?.safeParse({ ...spawn, [key]: 'caller' }).success,
      ).toBe(false),
  );

  it.each([
    { title: '' },
    { title: '𐀀'.repeat(121) },
    { title: 'title\nsecond line' },
    { prompt: '' },
    { prompt: '𐀀'.repeat(4097) },
    { prompt: 'unpaired\ud800' },
    { prompt: 'unpaired\udc00' },
    { prompt: 'nul\0' },
    { prompt: 'control\u0085' },
  ])('rejects invalid task text %#', (fields) => {
    expect(protocol.agentTaskSpawnInputSchema?.safeParse({ ...spawn, ...fields }).success).toBe(
      false,
    );
  });

  it('counts UTF-8 and Unicode scalar values at the accepted bounds', () => {
    expect(
      protocol.agentTaskSpawnInputSchema?.safeParse({
        title: '𐀀'.repeat(120),
        prompt: '𐀀'.repeat(4096),
      }).success,
    ).toBe(true);
    expect(
      protocol.agentTaskSpawnInputSchema?.safeParse({ ...spawn, prompt: 'a\t\r\nb' }).success,
    ).toBe(true);
  });

  it('bounds target selection, wait timeout and both cursors', () => {
    expect(protocol.agentTaskWaitInputSchema?.safeParse({ taskIds: [id] })).toMatchObject({
      success: true,
      data: { taskIds: [id], timeoutMs: 30_000 },
    });
    expect(
      protocol.agentTaskWaitInputSchema?.safeParse({ taskIds: [id], timeoutMs: 0 }).success,
    ).toBe(true);
    for (const taskIds of [
      [],
      [id, id],
      ['bad:id'],
      Array.from({ length: 5 }, (_, index) => `task-${index}`),
    ]) {
      expect(protocol.agentTaskCancelInputSchema?.safeParse({ taskIds }).success).toBe(false);
    }
    for (const value of [-1, 60_001, 5.5]) {
      expect(
        protocol.agentTaskWaitInputSchema?.safeParse({ taskIds: [id], timeoutMs: value }).success,
      ).toBe(false);
    }
    expect(
      protocol.agentTaskWaitInputSchema?.safeParse({ taskIds: [id], after: 'a'.repeat(601) })
        .success,
    ).toBe(false);
    expect(protocol.agentTaskStatusInputSchema?.safeParse({ limit: 17 }).success).toBe(false);
    expect(protocol.agentTaskStatusInputSchema?.safeParse({ cursor: '🌀' }).success).toBe(false);
    expect(
      protocol.agentTaskStatusInputSchema?.safeParse({ taskIds: [id], cursor: 'xyz' }).success,
    ).toBe(false);
  });

  it('accepts closed preparation and execution terminal facts', () => {
    expect(protocol.taskSettlementSchema?.safeParse(preparation).success).toBe(true);
    expect(protocol.taskSettlementSchema?.safeParse(execution).success).toBe(true);
    expect(
      protocol.taskSettlementSchema?.safeParse({
        ...execution,
        status: 'failed',
        reason: 'agent-step-limit',
        resultKind: 'partial',
      }).success,
    ).toBe(true);
  });

  it.each([
    { ...preparation, childTerminalSequence: 4 },
    { ...preparation, evidence: { ...preparation.evidence, childOriginSequence: 2 } },
    { ...preparation, evidence: { ...preparation.evidence, stage: 'project-attached' } },
    { ...preparation, status: 'interrupted' },
    { ...preparation, reason: 'native provider text' },
    { ...execution, childTerminalSequence: undefined },
    { ...execution, childTerminalSequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...execution, messageId: undefined },
    { ...execution, status: 'cancelled', reason: 'parent-stop' },
    { ...execution, executionStatus: 'cancelled' },
    { ...execution, reason: 'shutdown' },
    { ...execution, executionStatus: 'failed', status: 'failed', reason: 'child-failed' },
    { ...execution, preview: '𐀀'.repeat(1025) },
  ])('rejects contradictory or malformed settlement %#', (settlement) => {
    expect(protocol.taskSettlementSchema?.safeParse(settlement).success).toBe(false);
  });
});
