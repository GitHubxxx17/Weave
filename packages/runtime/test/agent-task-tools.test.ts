import { randomUUID } from 'node:crypto';
import { agentTaskFactDigest, createInMemorySessionEventStore } from '@weave/session';
import { describe, expect, it, vi } from 'vitest';
import { createAgentRunner } from '../src/agent-runner.js';
import { boundAgentTaskEnvelope } from '../src/agent-task-result.js';
import { createAgentTaskTools } from '../src/agent-task-tools.js';
import { createAgentToolAuthority } from '../src/agent-tool-authority.js';
import { createToolPipeline } from '../src/tool-pipeline.js';
import { createToolRegistry } from '../src/tool-registry.js';

describe('Agent task tools', () => {
  it('executes bounded task envelopes through the real Pipeline with trusted parent identity', async () => {
    const taskId = randomUUID();
    const childSessionId = randomUUID();
    const root = 'root';
    const executionIdentity = {
      executionId: randomUUID(),
      turnId: randomUUID(),
      userMessageId: randomUUID(),
    };
    const childExecutionId = randomUUID();
    const childTurnId = randomUUID();
    const envelope = boundAgentTaskEnvelope({
      tasks: [
        {
          taskId,
          rootSessionId: root,
          parentSessionId: root,
          parentTurnId: executionIdentity.turnId,
          childSessionId,
          childExecutionId,
          childTurnId,
          title: 'Task',
          access: 'read-only',
          permissionMode: 'ask',
          acceptedAt: '2026-11-23T00:00:00.000Z',
          status: 'completed',
          resultKind: 'final-answer',
          preview: '\u0000'.repeat(4096),
          previewTruncated: false,
          pendingApprovalIds: [],
          pendingApprovalCount: 0,
          result: {
            sessionId: childSessionId,
            executionId: childExecutionId,
            turnId: childTurnId,
            messageId: 'answer',
            terminalSequence: 8,
          },
        },
      ],
      cursor: 'bounded',
    });
    expect(envelope.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeGreaterThan(20_000);
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(24_576);
    const service = {
      spawn: vi.fn(async () => ({
        taskId,
        childSessionId,
        status: 'preparing' as const,
        cursor: 'internal',
      })),
      requestCancel: vi.fn(async () => []),
    };
    const observer = { status: vi.fn(() => envelope), wait: vi.fn(async () => envelope) };
    const { spawn, status, wait, cancel } = createAgentTaskTools({ service, observer });
    expect([spawn.readOnly, status.readOnly, wait.readOnly, cancel.readOnly]).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(spawn.inputSchema.safeParse({ title: 'Task', prompt: 'Review' }).data?.access).toBe(
      'read-only',
    );
    expect(wait.inputSchema.safeParse({ taskIds: [taskId] }).data?.timeoutMs).toBe(30000);
    expect(cancel.inputSchema.safeParse({ taskIds: [taskId, taskId] }).success).toBe(false);
    expect(status.inputSchema.safeParse({ rootSessionId: 'forged' }).success).toBe(false);
    await expect(
      Promise.resolve().then(() =>
        status.execute(
          { taskIds: [taskId] },
          { sessionId: root, signal: new AbortController().signal },
        ),
      ),
    ).rejects.toMatchObject({ code: 'agent-task-not-permitted' });
    const registry = createToolRegistry();
    registry.register(spawn);
    registry.register(status);
    registry.register(wait);
    registry.register(cancel);
    const token = createAgentToolAuthority({
      identity: { sessionId: root, ...executionIdentity },
      registry,
      ownerOf: () => 'core',
    });
    const store = createInMemorySessionEventStore();
    await store.append(root, [{ type: 'session.created', payload: {} }]);
    let step = 0;
    const runner = createAgentRunner({
      sessionStore: store,
      toolRegistry: registry,
      toolPipeline: createToolPipeline({ registry }),
      llm: {
        async *stream() {
          if (step++ === 0) {
            for (const [id, name, args] of [
              ['spawn', 'agent_spawn', { title: 'Task', prompt: 'Review' }],
              ['status', 'agent_status', { taskIds: [taskId] }],
              ['wait', 'agent_wait', { taskIds: [taskId], after: 'bounded', timeoutMs: 0 }],
              ['cancel', 'agent_cancel', { taskIds: [taskId] }],
            ] as const) {
              yield { type: 'tool-call-start', id, name };
              yield { type: 'tool-call-delta', id, argumentsDelta: JSON.stringify(args) };
            }
            yield { type: 'finish', reason: 'tool-call' };
          } else {
            yield { type: 'text-delta', text: 'Done' };
            yield { type: 'finish', reason: 'stop' };
          }
        },
      },
    });
    try {
      const results = [];
      for await (const event of runner.run({
        sessionId: root,
        provider: 'mock',
        model: 'test',
        permissionMode: 'yolo',
        toolAuthority: token,
        executionIdentity,
        userMessage: { role: 'user', content: [{ type: 'text', text: 'Use the task tools.' }] },
      })) {
        if (event.type === 'tool-result') results.push(event.result);
      }
      expect(results).toHaveLength(4);
      for (const { content, truncated } of results) {
        expect(truncated).toBe(false);
        expect(JSON.parse(content)).toEqual(envelope);
      }
      expect(service.spawn).toHaveBeenCalledWith(
        { title: 'Task', prompt: 'Review', access: 'read-only' },
        expect.anything(),
      );
      expect(observer.status).toHaveBeenCalledTimes(3);
      expect(observer.status).toHaveBeenCalledWith(root, { taskIds: [taskId] });
      expect(observer.wait).toHaveBeenCalledWith(
        root,
        { taskIds: [taskId], after: 'bounded', timeoutMs: 0 },
        expect.any(AbortSignal),
      );
      expect(service.requestCancel).toHaveBeenCalledWith(
        root,
        [taskId],
        agentTaskFactDigest({
          parentSessionId: root,
          parentTurnId: executionIdentity.turnId,
          toolCallId: 'cancel',
        }),
        'task-cancelled',
      );
    } finally {
      await store.close();
    }
  });
});
