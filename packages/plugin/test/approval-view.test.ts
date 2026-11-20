import { describe, expect, it } from 'vitest';
import { createApprovalBroker, type CreateApprovalRequestInput } from '@weave/runtime';

import { createRestrictedApprovalBroker } from '../src/approval-view.js';

function input(over: Partial<CreateApprovalRequestInput> = {}): CreateApprovalRequestInput {
  return {
    toolCallId: 'call-1',
    toolName: 'run_command',
    operation: 'run',
    summary: 'Run a command',
    risk: 'high',
    inputSummary: { command: 'ls' },
    ...over,
  };
}

describe('createRestrictedApprovalBroker', () => {
  it('has request, get, list and subscribe, and nothing that decides a request', () => {
    const view = createRestrictedApprovalBroker(createApprovalBroker());

    expect(Object.keys(view).sort()).toEqual(['get', 'list', 'request', 'subscribe']);
    for (const name of ['approve', 'reject', 'cancel', 'expire']) {
      expect(view).not.toHaveProperty(name);
    }
  });

  it('is frozen and is not the broker', () => {
    const broker = createApprovalBroker();
    const view = createRestrictedApprovalBroker(broker);

    expect(view).not.toBe(broker);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Reflect.set(view, 'approve', () => undefined)).toBe(false);
    expect(Reflect.set(view, 'request', () => Promise.resolve({ status: 'approved' }))).toBe(false);
  });

  it('raises requests on the broker, which alone decides them', async () => {
    const broker = createApprovalBroker();
    const view = createRestrictedApprovalBroker(broker);

    const decision = view.request(input());
    const [created] = broker.list();
    expect(created).toMatchObject({ toolName: 'run_command', status: 'pending' });
    broker.approve(created?.approvalId ?? '', 'looks fine');

    await expect(decision).resolves.toEqual({ status: 'approved', reason: 'looks fine' });
  });

  it("reads the broker's requests", () => {
    const broker = createApprovalBroker();
    const view = createRestrictedApprovalBroker(broker);
    void view.request(input({ toolCallId: 'call-1' })).catch(() => undefined);
    void broker.request(input({ toolCallId: 'call-2' })).catch(() => undefined);

    const listed = view.list();

    expect(listed.map((request) => request.toolCallId)).toEqual(['call-1', 'call-2']);
    expect(view.get(listed[1]?.approvalId ?? '')).toEqual(listed[1]);
    expect(view.get('missing')).toBeUndefined();
  });

  it("delivers the broker's events to a subscriber until it unsubscribes", () => {
    const broker = createApprovalBroker();
    const view = createRestrictedApprovalBroker(broker);
    const seen: string[] = [];
    const unsubscribe = view.subscribe((event) => seen.push(event.type));

    void broker.request(input()).catch(() => undefined);
    const [created] = broker.list();
    broker.reject(created?.approvalId ?? '');
    unsubscribe();
    void broker.request(input({ toolCallId: 'call-2' })).catch(() => undefined);

    expect(seen).toEqual(['approval.created', 'approval.resolved']);
  });

  it('lets a plugin cancel a request it raised through the signal it passed', async () => {
    const broker = createApprovalBroker();
    const view = createRestrictedApprovalBroker(broker);
    const controller = new AbortController();

    const decision = view.request(input({ signal: controller.signal }));
    controller.abort();

    await expect(decision).rejects.toMatchObject({ code: 'approval-cancelled' });
    expect(broker.list()[0]?.status).toBe('cancelled');
  });

  it('lets a request it raised time out', async () => {
    const view = createRestrictedApprovalBroker(createApprovalBroker());

    await expect(view.request(input({ timeoutMs: 0 }))).rejects.toMatchObject({
      code: 'approval-expired',
    });
  });

  it('refuses a request the broker finds invalid, as the broker does', () => {
    const view = createRestrictedApprovalBroker(createApprovalBroker());

    expect(() => view.request(input({ toolName: '' }))).toThrowError(
      expect.objectContaining({ code: 'approval-invalid-input' }),
    );
  });
});
