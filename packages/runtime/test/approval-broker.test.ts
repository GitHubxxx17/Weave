import { describe, expect, it } from 'vitest';
import {
  ApprovalError,
  createApprovalBroker,
  type CreateApprovalRequestInput,
  type ApprovalEvent,
} from '../src/index.js';

function createRequestInput(
  overrides: Partial<CreateApprovalRequestInput> = {},
): CreateApprovalRequestInput {
  return {
    toolCallId: 'call-1',
    toolName: 'write_file',
    operation: 'workspace.write_file',
    summary: '写入 Workspace 文件 src/app.ts',
    risk: 'high',
    inputSummary: {
      path: 'src/app.ts',
      bytes: 12,
      overwrite: false,
    },
    ...overrides,
  };
}

describe('Approval Broker', () => {
  it('creates a pending request and resolves after approval', async () => {
    const broker = createApprovalBroker();
    const decisionPromise = broker.request(createRequestInput());

    const pending = broker.list()[0];
    expect(pending).toMatchObject({
      status: 'pending',
      toolCallId: 'call-1',
      toolName: 'write_file',
    });
    expect(pending?.approvalId).toBeTypeOf('string');

    broker.approve(pending!.approvalId, '用户确认');

    await expect(decisionPromise).resolves.toEqual({
      status: 'approved',
      reason: '用户确认',
    });
    expect(broker.get(pending!.approvalId)).toMatchObject({
      status: 'approved',
      decisionReason: '用户确认',
    });
  });

  it('resolves a rejected decision without executing anything', async () => {
    const broker = createApprovalBroker();
    const decisionPromise = broker.request(createRequestInput());
    const pending = broker.list()[0]!;

    broker.reject(pending.approvalId, '需要先查看 diff');

    await expect(decisionPromise).resolves.toEqual({
      status: 'rejected',
      reason: '需要先查看 diff',
    });
    expect(broker.get(pending.approvalId)).toMatchObject({
      status: 'rejected',
      decisionReason: '需要先查看 diff',
    });
  });

  it('rejects the waiting promise when cancelled', async () => {
    const broker = createApprovalBroker();
    const decisionPromise = broker.request(createRequestInput());
    const pending = broker.list()[0]!;

    broker.cancel(pending.approvalId, '调用方取消');

    await expect(decisionPromise).rejects.toMatchObject({
      name: 'ApprovalError',
      code: 'approval-cancelled',
    });
    expect(broker.get(pending.approvalId)).toMatchObject({
      status: 'cancelled',
      decisionReason: '调用方取消',
    });
  });

  it('rejects the waiting promise when the request expires', async () => {
    const broker = createApprovalBroker();
    const decisionPromise = broker.request(createRequestInput({ timeoutMs: 0 }));
    const pending = broker.list()[0]!;

    await expect(decisionPromise).rejects.toMatchObject({
      name: 'ApprovalError',
      code: 'approval-expired',
    });
    expect(broker.get(pending.approvalId)).toMatchObject({
      status: 'expired',
    });
  });

  it('cancels a pending request when its signal aborts', async () => {
    const broker = createApprovalBroker();
    const controller = new AbortController();
    const decisionPromise = broker.request(createRequestInput({ signal: controller.signal }));
    const pending = broker.list()[0]!;

    controller.abort();

    await expect(decisionPromise).rejects.toMatchObject({
      code: 'approval-cancelled',
    });
    expect(broker.get(pending.approvalId)).toMatchObject({
      status: 'cancelled',
    });
  });

  it('does not create a request for a pre-aborted signal', async () => {
    const broker = createApprovalBroker();
    const controller = new AbortController();
    controller.abort();

    await expect(
      broker.request(createRequestInput({ signal: controller.signal })),
    ).rejects.toMatchObject({
      code: 'approval-cancelled',
    });
    expect(broker.list()).toHaveLength(0);
  });

  it('rejects unknown and duplicate decisions with stable errors', async () => {
    const broker = createApprovalBroker();

    expect(() => broker.approve('missing')).toThrowError(
      expect.objectContaining({
        name: 'ApprovalError',
        code: 'approval-not-found',
      }),
    );

    const decisionPromise = broker.request(createRequestInput());
    const pending = broker.list()[0]!;
    broker.approve(pending.approvalId);
    await expect(decisionPromise).resolves.toMatchObject({ status: 'approved' });

    expect(() => broker.reject(pending.approvalId)).toThrowError(
      expect.objectContaining({
        name: 'ApprovalError',
        code: 'approval-already-resolved',
      }),
    );
  });

  it('returns immutable snapshots instead of live internal state', async () => {
    const broker = createApprovalBroker();
    const decisionPromise = broker.request(createRequestInput());
    const snapshot = broker.get(broker.list()[0]!.approvalId)!;

    expect(Object.isFrozen(snapshot)).toBe(true);
    broker.approve(snapshot.approvalId);
    await decisionPromise;

    expect(snapshot.status).toBe('pending');
    expect(broker.get(snapshot.approvalId)?.status).toBe('approved');
    expect(broker.list()).not.toBe(broker.list());
  });

  it('validates timeout and request fields', () => {
    const broker = createApprovalBroker();

    expect(() => broker.request(createRequestInput({ toolCallId: '' }))).toThrowError(
      ApprovalError,
    );
    expect(() => broker.request(createRequestInput({ timeoutMs: -1 }))).toThrowError(
      expect.objectContaining({
        code: 'approval-invalid-input',
      }),
    );
  });

  it('publishes created and resolved snapshots', async () => {
    const broker = createApprovalBroker();
    const events: ApprovalEvent[] = [];
    broker.subscribe((event) => events.push(event));

    const decisionPromise = broker.request(createRequestInput());
    const pending = broker.list()[0]!;
    broker.approve(pending.approvalId, '用户确认');

    await expect(decisionPromise).resolves.toEqual({
      status: 'approved',
      reason: '用户确认',
    });
    expect(events.map((event) => event.type)).toEqual([
      'approval.created',
      'approval.resolved',
    ]);
    expect(events[0]?.request.status).toBe('pending');
    expect(events[1]?.request.status).toBe('approved');
  });

  it('publishes resolved events for rejection, cancellation, and expiry', async () => {
    const broker = createApprovalBroker();
    const events: ApprovalEvent[] = [];
    broker.subscribe((event) => events.push(event));

    const rejected = broker.request(createRequestInput({ toolCallId: 'reject' }));
    broker.reject(broker.list()[0]!.approvalId);
    await expect(rejected).resolves.toMatchObject({ status: 'rejected' });

    const cancelled = broker.request(createRequestInput({ toolCallId: 'cancel' }));
    broker.cancel(broker.list()[1]!.approvalId);
    await expect(cancelled).rejects.toMatchObject({ code: 'approval-cancelled' });

    const expired = broker.request(createRequestInput({ toolCallId: 'expire' }));
    broker.expire(broker.list()[2]!.approvalId);
    await expect(expired).rejects.toMatchObject({ code: 'approval-expired' });

    expect(events.map((event) => event.request.status)).toEqual([
      'pending',
      'rejected',
      'pending',
      'cancelled',
      'pending',
      'expired',
    ]);
  });

  it('stops publishing after unsubscribe and tolerates repeated unsubscribe', () => {
    const broker = createApprovalBroker();
    const events: ApprovalEvent[] = [];
    const unsubscribe = broker.subscribe((event) => events.push(event));

    unsubscribe();
    unsubscribe();
    broker.request(createRequestInput());

    expect(events).toHaveLength(0);
  });

  it('isolates listener failures from other listeners and state transitions', async () => {
    const broker = createApprovalBroker();
    const events: ApprovalEvent[] = [];
    broker.subscribe(() => {
      throw new Error('listener failed');
    });
    broker.subscribe((event) => events.push(event));

    const decisionPromise = broker.request(createRequestInput());
    const pending = broker.list()[0]!;
    broker.approve(pending.approvalId);

    await expect(decisionPromise).resolves.toMatchObject({ status: 'approved' });
    expect(events.map((event) => event.type)).toEqual([
      'approval.created',
      'approval.resolved',
    ]);
  });

  it('publishes immutable snapshots and preserves event order for zero timeout', async () => {
    const broker = createApprovalBroker();
    const events: ApprovalEvent[] = [];

    broker.subscribe((event) => events.push(event));
    const decisionPromise = broker.request(createRequestInput({ timeoutMs: 0 }));

    await expect(decisionPromise).rejects.toMatchObject({ code: 'approval-expired' });
    expect(events.map((event) => event.request.status)).toEqual(['pending', 'expired']);
    expect(Object.isFrozen(events[0]?.request)).toBe(true);
    expect(events[0]?.request.status).toBe('pending');
  });

  it('does not publish an event for a pre-aborted request', async () => {
    const broker = createApprovalBroker();
    const controller = new AbortController();
    const events: ApprovalEvent[] = [];
    controller.abort();
    broker.subscribe((event) => events.push(event));

    await expect(
      broker.request(createRequestInput({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'approval-cancelled' });
    expect(events).toHaveLength(0);
  });
});
