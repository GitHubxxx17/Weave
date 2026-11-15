import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createRuntime } from '@weave/runtime';
import { createApp } from '../src/app.js';
import {
  approvalBrokerService,
  createServerRuntime,
  sessionEventStoreService,
} from '../src/runtime.js';
import { startServer } from '../src/main.js';

describe('GET /health', () => {
  it('returns running runtime health', async () => {
    const runtime = createRuntime();
    await runtime.start();

    const response = await createApp(runtime).request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      runtime: 'running',
    });

    await runtime.stop();
  });

  it('assembles a Session Event Store into the server Runtime', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    const store = runtime.get(sessionEventStoreService);
    await store.append('session-1', [{ type: 'session.created', payload: { title: 'Demo' } }]);

    expect((await store.read('session-1')).map((event) => event.sequence)).toEqual([1]);

    await runtime.stop();

    await expect(store.read('session-1')).rejects.toMatchObject({
      code: 'session-store-closed',
    });
  });

  it('creates an isolated Approval Broker for each server Runtime', async () => {
    const first = createServerRuntime();
    const second = createServerRuntime();
    await first.start();
    await second.start();

    const firstBroker = first.get(approvalBrokerService);
    const secondBroker = second.get(approvalBrokerService);
    const decision = firstBroker.request({
      toolCallId: 'call-1',
      toolName: 'write_file',
      operation: 'workspace.write_file',
      summary: '写入测试文件',
      risk: 'high',
      inputSummary: { path: 'test.txt', bytes: 1, overwrite: false },
    });

    expect(firstBroker).not.toBe(secondBroker);
    expect(firstBroker.list()).toHaveLength(1);
    expect(secondBroker.list()).toHaveLength(0);

    firstBroker.cancel(firstBroker.list()[0]!.approvalId);
    await expect(decision).rejects.toMatchObject({ code: 'approval-cancelled' });
    await first.stop();
    await second.stop();
  });

  it('returns an unavailable response before runtime starts', async () => {
    const runtime = createRuntime();
    const response = await createApp(runtime).request('/health');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      runtime: 'created',
    });
  });
});

describe('startServer', () => {
  it('waits for listening before resolving and stops its server and runtime', async () => {
    const reservation = createServer().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => {
      reservation.once('listening', resolve);
    });
    const address = reservation.address();
    if (address === null || typeof address === 'string') {
      reservation.close();
      throw new Error('Expected an address for the server test');
    }
    await new Promise<void>((resolve, reject) => {
      reservation.close((error) => (error === undefined ? resolve() : reject(error)));
    });

    const result = await startServer(address.port);

    expect(result.server.listening).toBe(true);
    expect(result.runtime.status).toBe('running');
    const approvalsResponse = await fetch(`http://127.0.0.1:${address.port}/approvals`);
    expect(approvalsResponse.status).toBe(200);
    expect(await approvalsResponse.json()).toEqual({ approvals: [] });

    await result.stop();

    expect(result.server.listening).toBe(false);
    expect(result.runtime.status).toBe('stopped');
  });

  it('rejects when the port is already occupied without leaving an unhandled error', async () => {
    const occupiedServer = createServer().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => {
      occupiedServer.once('listening', resolve);
    });
    const address = occupiedServer.address();
    if (address === null || typeof address === 'string') {
      occupiedServer.close();
      throw new Error('Expected an address for the occupied test server');
    }

    const uncaughtErrors: unknown[] = [];
    const onUncaughtException = (error: unknown): void => {
      uncaughtErrors.push(error);
    };
    process.once('uncaughtException', onUncaughtException);

    try {
      const outcome = await startServer(address.port).then(
        (result) => ({ kind: 'resolved' as const, result }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );

      if (outcome.kind === 'resolved') {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await outcome.result.stop();
      }

      expect(outcome.kind).toBe('rejected');
      expect(outcome.kind === 'rejected' ? outcome.error : undefined).toMatchObject({
        code: 'EADDRINUSE',
      });
      expect(uncaughtErrors).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaughtException);
      await new Promise<void>((resolve, reject) => {
        occupiedServer.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
