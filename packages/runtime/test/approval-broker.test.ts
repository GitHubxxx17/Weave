import { describe, expect, it } from 'vitest';
import {
  ApprovalError,
  createApprovalBroker,
  type CreateApprovalRequestInput,
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
});
