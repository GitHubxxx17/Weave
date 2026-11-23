import { createInMemorySessionEventStore, type NewSessionEvent } from '@weave/session';
import { describe, expect, it } from 'vitest';
import * as runtime from '../src/index.js';

const taskId = '00000000-0000-4000-8000-000000000001';
const childSessionId = '00000000-0000-4000-8000-000000000002';
const childExecutionId = '00000000-0000-4000-8000-000000000003';
const childTurnId = '00000000-0000-4000-8000-000000000004';
const childUserMessageId = '00000000-0000-4000-8000-000000000005';
const parentSessionId = 'root';
const request = { title: 'Review', prompt: 'Review the patch.', access: 'read-only' } as const;
const settings = {
  provider: 'fixture',
  model: 'fixture',
  permissionMode: 'ask',
  useProviderDefaults: false,
} as const;
const input = {
  ...settings,
  userMessage: { role: 'user', content: [{ type: 'text', text: request.prompt }] },
} as const;
const identity = {
  sessionId: childSessionId,
  requestId: `agent-task:${taskId}`,
  executionId: childExecutionId,
  turnId: childTurnId,
  userMessageId: childUserMessageId,
};
const report = { parentSessionId, rootSessionId: parentSessionId, taskId };
const parentExecution = {
  type: 'execution.accepted',
  payload: {
    executionId: 'parent-execution',
    requestId: 'human-request',
    requestDigest: 'a'.repeat(64),
    turnId: 'parent-turn',
    userMessageId: 'parent-user',
    input,
  },
} as const;
const created = { type: 'session.created', payload: {} } as const;
const parentHistory = [
  created,
  parentExecution,
  { type: 'message.created', payload: { messageId: 'parent-user', message: input.userMessage } },
  {
    type: 'turn.started',
    payload: {
      executionId: 'parent-execution',
      turnId: 'parent-turn',
      userMessageId: 'parent-user',
    },
  },
  { type: 'step.started', payload: { turnId: 'parent-turn', stepId: 'spawn', kind: 'tool' } },
  {
    type: 'tool-call.created',
    payload: {
      turnId: 'parent-turn',
      stepId: 'spawn',
      toolCall: { id: 'call', name: 'agent_spawn', arguments: JSON.stringify(request) },
    },
  },
] as const satisfies readonly NewSessionEvent[];
const cancel = {
  type: 'agent.task.cancel-requested',
  payload: { version: 1, taskId, operationId: 'parent-stop-1', reason: 'parent-stop' },
} as const;
const cleanupNone = {
  acceptance: 'none',
  identity,
  launchClosed: true,
  pendingLaunches: 0,
  exactAcceptanceAbsent: true,
  cleanupComplete: true,
} as const;

async function fixture() {
  expect(runtime.reconcileAgentTask).toBeTypeOf('function');
  const store = createInMemorySessionEventStore();
  const accepted = {
    version: 1,
    ...report,
    childSessionId,
    childExecutionId,
    childTurnId,
    childUserMessageId,
    depth: 1,
    parentExecutionId: 'parent-execution',
    parentTurnId: 'parent-turn',
    parentToolCallId: 'call',
    requestId: identity.requestId,
    requestDigest: runtime.agentTaskRequestDigest(request),
    ...request,
    settings,
    tools: [],
    project: { projectId: 'project', folderRevision: 0 },
  } as const;
  await store.append(parentSessionId, [
    ...parentHistory,
    { type: 'agent.task.accepted', payload: accepted },
  ]);
  const origin = {
    version: 1,
    ...report,
    childSessionId,
    childExecutionId,
    childTurnId,
    childUserMessageId,
    parentAcceptedSequence: 7,
    parentAcceptedDigest: runtime.agentTaskFactDigest(accepted),
    admissionClass: 'agent-task-once',
  } as const;
  const childAcceptance = {
    executionId: childExecutionId,
    requestId: identity.requestId,
    requestDigest: runtime.agentTaskFactDigest(input),
    turnId: childTurnId,
    userMessageId: childUserMessageId,
    input,
  } as const;
  return { store, accepted, origin, childAcceptance };
}

function textMessage(messageId: string, text: string, useTool = false): NewSessionEvent {
  return {
    type: 'message.created',
    payload: {
      messageId,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'internal reasoning' },
          { type: 'text', text },
        ],
        ...(useTool
          ? { toolCalls: [{ id: 'child-call', name: 'read_file', arguments: '{}' }] }
          : {}),
      },
    },
  };
}

describe('reconcileAgentTask', () => {
  it('blocks a preparation cancellation that contradicts the first durable intent', async () => {
    const { store } = await fixture();
    await store.append(parentSessionId, [
      cancel,
      {
        ...cancel,
        payload: { ...cancel.payload, operationId: 'shutdown-1', reason: 'shutdown' },
      },
    ]);
    const parent = {
      events: await store.read(parentSessionId),
      taskId,
      projectRelation: 'unattached' as const,
    };
    const preparation = {
      materializerClosed: true,
      pendingEffects: 0,
      cleanup: cleanupNone,
    } as const;
    expect(
      runtime.reconcileAgentTask(
        {
          ...parent,
          preparation: { ...preparation, reason: 'parent-stop' },
        },
        [],
      ),
    ).toMatchObject({ kind: 'ready', settlement: { status: 'cancelled', reason: 'parent-stop' } });
    expect(
      runtime.reconcileAgentTask(
        {
          ...parent,
          preparation: { ...preparation, reason: 'shutdown' },
        },
        [],
      ),
    ).toEqual({ kind: 'blocked', reason: 'cleanup-mismatch' });

    await store.append(parentSessionId, [
      {
        type: 'agent.task.settled',
        payload: {
          version: 1,
          taskId,
          settlement: {
            phase: 'preparation',
            status: 'cancelled',
            reason: 'shutdown',
            resultKind: 'none',
            evidence: { stage: 'accepted', parentAcceptedSequence: 7 },
          },
        },
      },
    ]);
    expect(
      runtime.reconcileAgentTask(
        {
          ...parent,
          events: await store.read(parentSessionId),
        },
        [],
      ),
    ).toEqual({ kind: 'blocked', reason: 'settlement-mismatch' });
  });

  it('blocks a gate-confirmed execution cancellation that contradicts the first durable intent', async () => {
    const { store, origin, childAcceptance } = await fixture();
    await store.append(childSessionId, [
      created,
      { type: 'agent.task.origin', payload: origin },
      {
        type: 'execution.accepted',
        payload: { ...childAcceptance, dispatch: 'queued', runInput: input },
      },
      {
        type: 'execution.finished',
        payload: { executionId: childExecutionId, status: 'cancelled' },
      },
    ]);
    await store.append(parentSessionId, [
      cancel,
      {
        ...cancel,
        payload: { ...cancel.payload, operationId: 'shutdown-1', reason: 'shutdown' },
      },
    ]);
    const parent = {
      events: await store.read(parentSessionId),
      taskId,
      projectRelation: 'attached' as const,
    };
    const child = await store.read(childSessionId);
    const executionCleanup = {
      acceptance: 'accepted',
      identity,
      launchClosed: true,
      pendingLaunches: 0,
      executionStatus: 'cancelled',
      terminalSequence: 4,
      cleanupComplete: true,
    } as const;
    const first = runtime.reconcileAgentTask(
      {
        ...parent,
        executionCleanup: { ...executionCleanup, reason: 'parent-stop' },
      },
      child,
    );
    expect(first).toMatchObject({
      kind: 'ready',
      settlement: { status: 'cancelled', reason: 'parent-stop' },
    });
    expect(
      runtime.reconcileAgentTask(
        {
          ...parent,
          executionCleanup,
        },
        child,
      ),
    ).toMatchObject({
      kind: 'ready',
      settlement: { status: 'cancelled', reason: 'task-cancelled' },
    });
    expect(
      runtime.reconcileAgentTask(
        {
          ...parent,
          executionCleanup: { ...executionCleanup, reason: 'shutdown' },
        },
        child,
      ),
    ).toEqual({ kind: 'blocked', reason: 'cleanup-mismatch' });

    if (first.kind !== 'ready' || first.missingDispatch === undefined)
      throw new Error('Missing dispatch');
    await store.append(parentSessionId, [
      { type: 'agent.task.dispatched', payload: first.missingDispatch },
      {
        type: 'agent.task.settled',
        payload: { version: 1, taskId, settlement: { ...first.settlement, reason: 'shutdown' } },
      },
    ]);
    expect(
      runtime.reconcileAgentTask(
        {
          ...parent,
          events: await store.read(parentSessionId),
        },
        child,
      ),
    ).toEqual({ kind: 'blocked', reason: 'settlement-mismatch' });
  });

  it.each([false, true])(
    'blocks a queued Turn that started before its claim (terminal %s)',
    async (terminal) => {
      const { store, origin, childAcceptance } = await fixture();
      await store.append(childSessionId, [
        created,
        { type: 'agent.task.origin', payload: origin },
        {
          type: 'execution.accepted',
          payload: { ...childAcceptance, dispatch: 'queued', runInput: input },
        },
        {
          type: 'message.created',
          payload: { messageId: childUserMessageId, message: input.userMessage },
        },
        {
          type: 'turn.started',
          payload: {
            turnId: childTurnId,
            executionId: childExecutionId,
            userMessageId: childUserMessageId,
          },
        },
        textMessage('answer', 'Pre-claim text'),
      ]);
      if (terminal)
        await store.append(childSessionId, [
          { type: 'execution.claimed', payload: { executionId: childExecutionId } },
          { type: 'turn.completed', payload: { turnId: childTurnId, status: 'completed' } },
          {
            type: 'execution.finished',
            payload: { executionId: childExecutionId, status: 'completed' },
          },
        ]);
      const result = runtime.reconcileAgentTask(
        {
          events: await store.read(parentSessionId),
          taskId,
          projectRelation: 'attached',
          ...(terminal
            ? {
                executionCleanup: {
                  acceptance: 'accepted',
                  identity,
                  launchClosed: true,
                  pendingLaunches: 0,
                  executionStatus: 'completed',
                  terminalSequence: 9,
                  cleanupComplete: true,
                },
              }
            : {}),
        },
        await store.read(childSessionId),
      );
      expect(result).toEqual({ kind: 'blocked', reason: 'child-prefix-invalid' });
    },
  );

  it.each([
    {
      example: 'accepted without child',
      child: false,
      attached: false,
      reason: 'preparation-interrupted',
      status: 'interrupted',
      stage: 'accepted',
    },
    {
      example: 'created before attach',
      child: true,
      attached: false,
      reason: 'preparation-failed',
      status: 'failed',
      stage: 'child-created',
    },
    {
      example: 'attached before launch',
      child: true,
      attached: true,
      reason: 'preparation-interrupted',
      status: 'interrupted',
      stage: 'project-attached',
    },
    {
      example: 'known launch rejection',
      child: true,
      attached: true,
      reason: 'generation-unavailable',
      status: 'failed',
      stage: 'project-attached',
    },
    {
      example: 'cancel before create',
      child: false,
      attached: false,
      reason: 'parent-stop',
      status: 'cancelled',
      stage: 'accepted',
    },
    {
      example: 'cancel before launch',
      child: true,
      attached: true,
      reason: 'parent-stop',
      status: 'cancelled',
      stage: 'project-attached',
    },
  ] as const)(
    'can settle preparation after $example',
    async ({ child, attached, reason, status, stage }) => {
      const { store, origin } = await fixture();
      if (child)
        await store.append(childSessionId, [
          created,
          { type: 'agent.task.origin', payload: origin },
        ]);
      if (status === 'cancelled') await store.append(parentSessionId, [cancel]);
      const result = runtime.reconcileAgentTask(
        {
          events: await store.read(parentSessionId),
          taskId,
          projectRelation: attached ? 'attached' : 'unattached',
          preparation: {
            reason,
            materializerClosed: true,
            pendingEffects: 0,
            cleanup: cleanupNone,
          },
        },
        await store.read(childSessionId),
      );
      expect(result).toMatchObject({
        kind: 'ready',
        settlement: {
          phase: 'preparation',
          status,
          reason,
          resultKind: 'none',
          evidence: {
            stage,
            parentAcceptedSequence: 7,
            ...(child ? { childOriginSequence: 2 } : {}),
          },
        },
      });
      if (!child && result.kind === 'ready' && result.settlement.phase === 'preparation')
        expect(result.settlement.evidence).not.toHaveProperty('childOriginSequence');
    },
  );

  it('blocks an unknown child prefix even when a caller claims preparation was fenced', async () => {
    const { store } = await fixture();
    expect(
      runtime.reconcileAgentTask({
        events: await store.read(parentSessionId),
        taskId,
        projectRelation: 'unattached',
        preparation: {
          reason: 'preparation-interrupted',
          materializerClosed: true,
          pendingEffects: 0,
          cleanup: cleanupNone,
        },
      }),
    ).toMatchObject({ kind: 'blocked', reason: 'child-prefix-unknown' });
  });

  it('rejects a forged origin backlink across local Stores', async () => {
    const { store, origin } = await fixture();
    await store.append(childSessionId, [
      created,
      {
        type: 'agent.task.origin',
        payload: { ...origin, parentAcceptedDigest: 'f'.repeat(64) },
      },
    ]);
    expect(
      runtime.reconcileAgentTask(
        {
          events: await store.read(parentSessionId),
          taskId,
          projectRelation: 'unattached',
        },
        await store.read(childSessionId),
      ),
    ).toMatchObject({ kind: 'blocked', reason: 'origin-mismatch' });
  });

  it.each([
    { status: 'completed', text: 'The answer', expectedStatus: 'completed', kind: 'final-answer' },
    { status: 'completed', text: '  ', expectedStatus: 'completed', kind: 'none' },
    {
      status: 'completed',
      text: 'a progress note',
      tool: true,
      expectedStatus: 'completed',
      kind: 'none',
    },
    {
      status: 'completed',
      text: 'Unfinished draft',
      reason: 'agent-step-limit',
      expectedStatus: 'failed',
      publicReason: 'agent-step-limit',
      kind: 'partial',
    },
    {
      status: 'failed',
      text: 'Unfinished draft',
      reason: 'native provider secret',
      expectedStatus: 'failed',
      publicReason: 'child-failed',
      kind: 'partial',
    },
    {
      status: 'cancelled',
      text: 'Unfinished draft',
      expectedStatus: 'cancelled',
      publicReason: 'task-cancelled',
      kind: 'partial',
    },
    {
      status: 'interrupted',
      text: 'Unfinished draft',
      reason: 'server-restarted',
      expectedStatus: 'interrupted',
      publicReason: 'child-interrupted',
      kind: 'partial',
    },
  ] as const)('maps $status with result $kind and public reason $publicReason', async (example) => {
    const { store, origin, childAcceptance } = await fixture();
    const { status, text, expectedStatus, kind } = example;
    const reason = 'reason' in example ? example.reason : undefined;
    await store.append(childSessionId, [
      created,
      { type: 'agent.task.origin', payload: origin },
      { type: 'execution.accepted', payload: childAcceptance },
      {
        type: 'message.created',
        payload: { messageId: childUserMessageId, message: input.userMessage },
      },
      {
        type: 'turn.started',
        payload: {
          turnId: childTurnId,
          executionId: childExecutionId,
          userMessageId: childUserMessageId,
        },
      },
      textMessage('answer', text, 'tool' in example && example.tool),
      {
        type: 'turn.completed',
        payload: {
          turnId: childTurnId,
          status: status === 'interrupted' ? 'failed' : status,
          ...(reason === undefined ? {} : { reason }),
        },
      },
      {
        type: 'execution.finished',
        payload: {
          executionId: childExecutionId,
          status,
          ...(reason === undefined ? {} : { reason }),
        },
      },
      textMessage('after-finished', 'Fake later answer'),
    ]);
    await store.append(parentSessionId, [cancel]);
    const parent = {
      events: await store.read(parentSessionId),
      taskId,
      projectRelation: 'attached' as const,
    };
    const child = await store.read(childSessionId);
    expect(runtime.reconcileAgentTask(parent, child)).toMatchObject({ kind: 'awaiting-cleanup' });
    const result = runtime.reconcileAgentTask(
      {
        ...parent,
        executionCleanup: {
          acceptance: 'accepted',
          identity,
          launchClosed: true,
          pendingLaunches: 0,
          executionStatus: status,
          terminalSequence: 8,
          cleanupComplete: true,
        },
      },
      child,
    );
    expect(result).toMatchObject({
      kind: 'ready',
      settlement: {
        phase: 'execution',
        status: expectedStatus,
        executionStatus: status,
        childTerminalSequence: 8,
        resultKind: kind,
        preview: kind === 'none' ? '' : text,
        previewTruncated: false,
        ...(kind === 'none' ? {} : { messageId: 'answer' }),
        ...('publicReason' in example ? { reason: example.publicReason } : {}),
      },
    });
    if (result.kind === 'ready' && !('publicReason' in example))
      expect(result.settlement).not.toHaveProperty('reason');
  });

  it('blocks an exact dispatch watermark or digest mismatch', async () => {
    const { store, origin, childAcceptance } = await fixture();
    await store.append(childSessionId, [
      created,
      { type: 'agent.task.origin', payload: origin },
      { type: 'execution.accepted', payload: childAcceptance },
    ]);
    await store.append(parentSessionId, [
      {
        type: 'agent.task.dispatched',
        payload: {
          version: 1,
          taskId,
          childExecutionAcceptedSequence: 3,
          childExecutionAcceptedDigest: 'a'.repeat(64),
        },
      },
    ]);
    expect(
      runtime.reconcileAgentTask(
        {
          events: await store.read(parentSessionId),
          taskId,
          projectRelation: 'attached',
        },
        await store.read(childSessionId),
      ),
    ).toMatchObject({ kind: 'blocked', reason: 'dispatch-mismatch' });
  });

  it('blocks terminal result pointers outside the exact Turn or evidence prefix', async () => {
    const { store, origin, childAcceptance } = await fixture();
    await store.append(childSessionId, [
      created,
      { type: 'agent.task.origin', payload: origin },
      { type: 'execution.accepted', payload: childAcceptance },
      textMessage('elsewhere', 'outside the turn'),
      {
        type: 'message.created',
        payload: { messageId: childUserMessageId, message: input.userMessage },
      },
      {
        type: 'turn.started',
        payload: {
          turnId: childTurnId,
          executionId: childExecutionId,
          userMessageId: childUserMessageId,
        },
      },
      textMessage('answer', 'the answer'),
      { type: 'turn.completed', payload: { turnId: childTurnId, status: 'completed' } },
      {
        type: 'execution.finished',
        payload: { executionId: childExecutionId, status: 'completed' },
      },
    ]);
    const child = await store.read(childSessionId);
    const parent = {
      events: await store.read(parentSessionId),
      taskId,
      projectRelation: 'attached' as const,
    };
    expect(
      runtime.reconcileAgentTask(
        {
          ...parent,
          executionCleanup: {
            acceptance: 'accepted',
            identity,
            launchClosed: true,
            pendingLaunches: 0,
            executionStatus: 'completed',
            terminalSequence: 9,
            cleanupComplete: true,
            resultCandidate: { messageId: 'elsewhere', messageSequence: 4 },
          },
        },
        child,
      ),
    ).toMatchObject({ kind: 'blocked', reason: 'cleanup-mismatch' });

    await store.append(parentSessionId, [
      {
        type: 'agent.task.dispatched',
        payload: {
          version: 1,
          taskId,
          childExecutionAcceptedSequence: 3,
          childExecutionAcceptedDigest: runtime.agentTaskFactDigest(childAcceptance),
        },
      },
      {
        type: 'agent.task.settled',
        payload: {
          version: 1,
          taskId,
          settlement: {
            phase: 'execution',
            status: 'completed',
            executionStatus: 'completed',
            childExecutionId,
            childTerminalSequence: 9,
            resultKind: 'final-answer',
            messageId: 'elsewhere',
            preview: 'outside the turn',
            previewTruncated: false,
          },
        },
      },
    ]);
    expect(
      runtime.reconcileAgentTask(
        {
          events: await store.read(parentSessionId),
          taskId,
          projectRelation: 'attached',
        },
        await store.read(childSessionId),
      ),
    ).toMatchObject({ kind: 'blocked', reason: 'settlement-mismatch' });
  });
});
