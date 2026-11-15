import { describe, expect, it } from 'vitest';
import { createRuntime, type ApprovalBroker, type ApprovalDecision } from '@weave/runtime';
import { createApp } from '../src/app.js';
import { approvalBrokerService, createServerRuntime } from '../src/runtime.js';

async function createApprovalApp() {
  const runtime = createServerRuntime();
  await runtime.start();
  const broker = runtime.get(approvalBrokerService);
  return {
    app: createApp(runtime, { approvalBrokerService }),
    broker,
    stop: () => runtime.stop(),
  };
}

function createPendingApproval(broker: ApprovalBroker): {
  readonly approvalId: string;
  readonly decision: Promise<ApprovalDecision>;
} {
  const decision = broker.request({
    toolCallId: 'call-http-1',
    toolName: 'write_file',
    operation: 'workspace.write_file',
    summary: '写入 Workspace 文件 src/app.ts',
    risk: 'high',
    inputSummary: { path: 'src/app.ts', bytes: 12, overwrite: false },
  });
  const request = broker.list()[0];
  if (request === undefined) {
    throw new Error('Expected a pending Approval request');
  }
  return { approvalId: request.approvalId, decision };
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const result = await reader.read();
  if (result.done || result.value === undefined) {
    throw new Error('Expected an SSE chunk');
  }
  return new TextDecoder().decode(result.value);
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  let text = '';
  while (!text.includes(marker)) {
    text += await readStreamChunk(reader);
  }
  return text;
}

describe('Approval HTTP API', () => {
  it('lists pending and terminal Approval snapshots', async () => {
    const { app, broker, stop } = await createApprovalApp();
    try {
      const pending = createPendingApproval(broker);
      const response = await app.request('/approvals');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        approvals: [
          expect.objectContaining({
            approvalId: pending.approvalId,
            status: 'pending',
          }),
        ],
      });

      broker.approve(pending.approvalId, '预先批准');
      await expect(pending.decision).resolves.toMatchObject({ status: 'approved' });
      expect((await app.request('/approvals')).status).toBe(200);
    } finally {
      await stop();
    }
  });

  it('gets and approves one pending request through HTTP', async () => {
    const { app, broker, stop } = await createApprovalApp();
    try {
      const pending = createPendingApproval(broker);
      const getResponse = await app.request(`/approvals/${pending.approvalId}`);
      expect(getResponse.status).toBe(200);

      const approveResponse = await app.request(`/approvals/${pending.approvalId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: '用户确认' }),
      });
      expect(approveResponse.status).toBe(200);
      expect(await approveResponse.json()).toMatchObject({
        approvalId: pending.approvalId,
        status: 'approved',
        decisionReason: '用户确认',
      });
      await expect(pending.decision).resolves.toEqual({
        status: 'approved',
        reason: '用户确认',
      });
    } finally {
      await stop();
    }
  });

  it('maps rejected, unknown and repeated decisions', async () => {
    const { app, broker, stop } = await createApprovalApp();
    try {
      const pending = createPendingApproval(broker);
      const rejectResponse = await app.request(`/approvals/${pending.approvalId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: '需要复核' }),
        headers: { 'content-type': 'application/json' },
      });
      expect(rejectResponse.status).toBe(200);
      await expect(pending.decision).resolves.toMatchObject({ status: 'rejected' });

      const repeatedResponse = await app.request(`/approvals/${pending.approvalId}/approve`, {
        method: 'POST',
      });
      expect(repeatedResponse.status).toBe(409);
      expect(await repeatedResponse.json()).toEqual({
        error: {
          code: 'approval-already-resolved',
          message: 'Approval request is already rejected',
        },
      });

      const unknownResponse = await app.request('/approvals/missing');
      expect(unknownResponse.status).toBe(404);
      expect(await unknownResponse.json()).toEqual({
        error: {
          code: 'approval-not-found',
          message: 'Approval request was not found',
        },
      });
    } finally {
      await stop();
    }
  });

  it.each([
    ['', 200],
    ['{}', 200],
    ['{"reason":""}', 400],
    ['{"reason":"ok","extra":true}', 400],
    ['not-json', 400],
  ])('validates decision body %s with status %s', async (body, expectedStatus) => {
    const { app, broker, stop } = await createApprovalApp();
    try {
      const pending = createPendingApproval(broker);
      const response = await app.request(`/approvals/${pending.approvalId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 400) {
        expect(await response.json()).toMatchObject({
          error: { code: 'approval-invalid-input' },
        });
        broker.cancel(pending.approvalId);
        await expect(pending.decision).rejects.toMatchObject({ code: 'approval-cancelled' });
      } else {
        await expect(pending.decision).resolves.toMatchObject({ status: 'approved' });
      }
    } finally {
      await stop();
    }
  });

  it('returns 503 when the Approval service is not available', async () => {
    const runtime = createRuntime();
    await runtime.start();
    const response = await createApp(runtime).request('/approvals');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: 'approval-service-unavailable',
        message: 'Approval service is not available',
      },
    });
    await runtime.stop();
  });

  it('cancels a pending request through HTTP', async () => {
    const { app, broker, stop } = await createApprovalApp();
    try {
      const pending = createPendingApproval(broker);
      const response = await app.request(`/approvals/${pending.approvalId}/cancel`, {
        method: 'POST',
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        approvalId: pending.approvalId,
        status: 'cancelled',
      });
      await expect(pending.decision).rejects.toMatchObject({ code: 'approval-cancelled' });
    } finally {
      await stop();
    }
  });

  it('streams an approval snapshot and live lifecycle events', async () => {
    const { app, broker, stop } = await createApprovalApp();
    try {
      const response = await app.request('/approvals/stream');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('connection')).toBe('keep-alive');

      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error('Expected an SSE response body');
      }

      await expect(readStreamChunk(reader)).resolves.toContain(
        'event: approval.snapshot\ndata: {"approvals":[]}\n\n',
      );

      const pending = createPendingApproval(broker);
      await expect(
        readUntil(reader, `"approvalId":"${pending.approvalId}"`),
      ).resolves.toContain('event: approval.created');

      broker.approve(pending.approvalId, '实时批准');
      await expect(pending.decision).resolves.toMatchObject({ status: 'approved' });
      await expect(readUntil(reader, 'event: approval.resolved')).resolves.toContain(
        `"approvalId":"${pending.approvalId}"`,
      );

      await reader.cancel();
    } finally {
      await stop();
    }
  });

  it('includes existing approvals in the initial SSE snapshot', async () => {
    const { app, broker, stop } = await createApprovalApp();
    try {
      const pending = createPendingApproval(broker);
      const response = await app.request('/approvals/stream');
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error('Expected an SSE response body');
      }

      const chunk = await readStreamChunk(reader);
      expect(chunk).toContain('event: approval.snapshot');
      expect(chunk).toContain(`"approvalId":"${pending.approvalId}"`);
      expect(chunk).toContain('"status":"pending"');

      await reader.cancel();
      broker.cancel(pending.approvalId);
      await expect(pending.decision).rejects.toMatchObject({ code: 'approval-cancelled' });
    } finally {
      await stop();
    }
  });

  it('ends an SSE stream when its reader is cancelled', async () => {
    const { app, broker, stop } = await createApprovalApp();
    try {
      const response = await app.request('/approvals/stream');
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error('Expected an SSE response body');
      }

      await readStreamChunk(reader);
      await reader.cancel();
      const pending = broker.request({
        toolCallId: 'call-after-cancel',
        toolName: 'write_file',
        operation: 'workspace.write_file',
        summary: '写入 Workspace 文件 after-cancel.txt',
        risk: 'high',
        inputSummary: { path: 'after-cancel.txt' },
      });
      const result = await reader.read();

      expect(result.done).toBe(true);
      broker.cancel(broker.list()[0]!.approvalId);
      await expect(pending).rejects.toMatchObject({ code: 'approval-cancelled' });
    } finally {
      await stop();
    }
  });

  it('returns 503 when the Approval service is not available for SSE', async () => {
    const runtime = createRuntime();
    await runtime.start();
    const response = await createApp(runtime).request('/approvals/stream');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: 'approval-service-unavailable',
        message: 'Approval service is not available',
      },
    });
    await runtime.stop();
  });
});
