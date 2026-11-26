import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentTaskViewSchema, type AgentTaskView } from '@weave/protocol';
import { boundAgentTaskEnvelope } from '../src/agent-task-result.js';

function task(preview: string): AgentTaskView {
  const childSessionId = randomUUID();
  const childExecutionId = randomUUID();
  const childTurnId = randomUUID();
  return {
    taskId: randomUUID(),
    rootSessionId: 'root',
    parentSessionId: 'root',
    parentTurnId: 'parent-turn',
    childSessionId,
    childExecutionId,
    childTurnId,
    title: 'Review 中文 😀',
    access: 'read-only',
    permissionMode: 'ask',
    acceptedAt: '2026-11-23T00:00:00.000Z',
    status: 'completed',
    resultKind: 'final-answer',
    preview,
    previewTruncated: false,
    pendingApprovalIds: [],
    pendingApprovalCount: 0,
    result: {
      sessionId: childSessionId,
      executionId: childExecutionId,
      turnId: childTurnId,
      messageId: 'answer',
      terminalSequence: 25,
    },
  };
}
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('bounded task JSON results', () => {
  it('preserves four complete result pointers and valid JSON under actual escaping costs', () => {
    const tasks = [
      task('"'.repeat(4096)),
      task('\\'.repeat(4096)),
      task('\u0000'.repeat(4096)),
      task('中文😀'.repeat(2000)),
    ];
    const input = { tasks, cursor: 'current', changed: true };
    const bounded = boundAgentTaskEnvelope(input);
    expect(byteLength(bounded)).toBeLessThanOrEqual(24_576);
    expect(bounded.truncated).toBe(true);
    expect(bounded.tasks.map((item) => item.taskId)).toEqual(tasks.map((item) => item.taskId));
    expect(bounded.tasks.map((item) => item.result)).toEqual(tasks.map((item) => item.result));
    expect(bounded.tasks.every((item) => agentTaskViewSchema.safeParse(item).success)).toBe(true);
    expect(bounded.tasks.some((item) => item.previewTruncated)).toBe(true);
    expect(JSON.parse(JSON.stringify(bounded))).toEqual(bounded);
    expect(tasks[0]!.preview.length).toBe(4096);
  });

  it('fits exact boundary envelopes and marks only actual text truncation', () => {
    const tasks = [task('a'.repeat(4096))];
    const original = boundAgentTaskEnvelope({ tasks, cursor: 'current' });
    const exactBytes = byteLength(original);
    const exact = boundAgentTaskEnvelope({ tasks, cursor: 'current' }, { maxBytes: exactBytes });
    expect(exact).toEqual(original);
    expect(exact.truncated).toBe(false);
    const smaller = boundAgentTaskEnvelope(
      { tasks, cursor: 'current' },
      { maxBytes: exactBytes - 1 },
    );
    expect(byteLength(smaller)).toBeLessThanOrEqual(exactBytes - 1);
    expect(smaller.tasks[0]!.previewTruncated).toBe(true);
    expect(smaller.truncated).toBe(true);
  });

  it('limits list previews to 256 UTF-8 bytes without breaking Unicode code points', () => {
    const input = Array.from({ length: 16 }, () => task('😀中文'.repeat(100)));
    const result = boundAgentTaskEnvelope({ tasks: input, cursor: 'page' }, { mode: 'list' });
    expect(result.tasks).toHaveLength(16);
    expect(result.tasks.every(({ preview }) => Buffer.byteLength(preview, 'utf8') <= 256)).toBe(
      true,
    );
    expect(result.tasks.every(({ preview }) => !/[\ud800-\udbff]$/.test(preview))).toBe(true);
    expect(result.tasks.every(({ previewTruncated }) => previewTruncated)).toBe(true);
    expect(byteLength(result)).toBeLessThanOrEqual(24_576);
  });

  it('retains consumed-terminal observation flags with an empty task body', () => {
    expect(
      boundAgentTaskEnvelope({ tasks: [], cursor: 'wait', allSettled: true, changed: false }),
    ).toEqual({ tasks: [], cursor: 'wait', allSettled: true, changed: false, truncated: false });
  });

  it('rejects over-budget required metadata instead of dropping identity or corrupting pointers', () => {
    const tasks = [task('answer')];
    expect(() =>
      boundAgentTaskEnvelope({ tasks, cursor: 'cursor' }, { maxBytes: 64 }),
    ).toThrowError(expect.objectContaining({ code: 'agent-task-result-too-large' }));
  });

  it('rejects arbitrary URLs, private fields and mismatched full-result identity', () => {
    const input = task('answer');
    expect(agentTaskViewSchema.safeParse({ ...input, prompt: 'private' }).success).toBe(false);
    expect(
      agentTaskViewSchema.safeParse({ ...input, result: { ...input.result, url: 'https://evil' } })
        .success,
    ).toBe(false);
    expect(
      agentTaskViewSchema.safeParse({
        ...input,
        result: { ...input.result, sessionId: randomUUID() },
      }).success,
    ).toBe(false);
    expect(() =>
      boundAgentTaskEnvelope({
        tasks: Array.from({ length: 5 }, () => task('answer')),
        cursor: 'x',
      }),
    ).toThrow();
  });

  it('rejects impossible public result status and approval combinations', () => {
    const final = task('answer');
    expect(agentTaskViewSchema.safeParse({ ...final, status: 'running' }).success).toBe(false);
    expect(
      agentTaskViewSchema.safeParse({ ...final, status: 'failed', reason: 'child-failed' }).success,
    ).toBe(false);
    expect(agentTaskViewSchema.safeParse({ ...final, reason: 'shutdown' }).success).toBe(false);
    expect(
      agentTaskViewSchema.safeParse({
        ...final,
        pendingApprovalCount: 1,
        pendingApprovalIds: ['a'],
      }).success,
    ).toBe(false);
    expect(
      agentTaskViewSchema.safeParse({
        ...final,
        resultKind: 'none',
        result: undefined,
        preview: '',
      }).success,
    ).toBe(true);
    expect(agentTaskViewSchema.safeParse({ ...final, result: undefined }).success).toBe(false);
  });

  it('rejects live and preparation views carrying execution results', () => {
    const final = task('answer');
    expect(
      agentTaskViewSchema.safeParse({
        ...final,
        status: 'failed',
        reason: 'preparation-failed',
        resultKind: 'partial',
      }).success,
    ).toBe(false);
    const live = { ...final, status: 'running', result: undefined, resultKind: 'none' };
    expect(agentTaskViewSchema.safeParse(live).success).toBe(false);
    expect(
      agentTaskViewSchema.safeParse({
        ...live,
        settledAt: final.acceptedAt,
        preview: '',
      }).success,
    ).toBe(false);
    expect(agentTaskViewSchema.safeParse({ ...live, preview: '' }).success).toBe(true);
  });

  it('requires the truncation marker when budget removes all result text', () => {
    const final = task('answer');
    expect(
      agentTaskViewSchema.safeParse({ ...final, preview: '', previewTruncated: false }).success,
    ).toBe(false);
    const display = { ...final, preview: '', previewTruncated: true };
    const expected = { tasks: [display], cursor: 'current', truncated: true };
    const actual = boundAgentTaskEnvelope(
      { tasks: [final], cursor: 'current' },
      { maxBytes: byteLength(expected) },
    );
    expect(actual).toEqual(expected);
    expect(agentTaskViewSchema.safeParse(actual.tasks[0]).success).toBe(true);
  });
});
