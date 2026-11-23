import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryClient } from '../src/features/memory/client.js';
import { memoryContentSchema } from '../src/features/memory/types.js';

const scope = { kind: 'project' as const, projectId: '11111111-1111-4111-8111-111111111111' };
const ref = {
  scope,
  memoryId: '22222222-2222-4222-8222-222222222222',
  revision: 1,
  sha256: 'a'.repeat(64),
};
const record = {
  ref,
  title: 'Preference',
  content: 'Use strict TS',
  tags: [],
  review: 'user-reviewed',
  provenance: { actor: 'local-user' },
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-23T00:00:00.000Z',
};
afterEach(() => vi.unstubAllGlobals());
describe('Memory browser client', () => {
  it('encodes scope and exact ref and forwards cancellation without caching', async () => {
    const fetch = vi.fn(async () => Response.json({ record }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    expect(await createMemoryClient().read(scope, ref.memoryId, ref, controller.signal)).toEqual(
      record,
    );
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain('scope=project&projectId=' + scope.projectId);
    expect(url).toContain('revision=1&sha256=' + ref.sha256);
    expect(init).toMatchObject({ signal: controller.signal, cache: 'no-store' });
  });
  it('validates response scopes and exact versions before rendering', async () => {
    const client = createMemoryClient();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ record: { ...record, ref: { ...ref, scope: { kind: 'user' } } } }),
      ),
    );
    await expect(client.read(scope, ref.memoryId)).rejects.toMatchObject({
      code: 'memory-api-protocol',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ record: { ...record, ref: { ...ref, revision: 2 } } })),
    );
    await expect(client.read(scope, ref.memoryId, ref)).rejects.toMatchObject({
      code: 'memory-api-protocol',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          records: [{ ...record, excerpt: 'body', content: undefined, extra: 'claim' }],
        }),
      ),
    );
    await expect(client.list(scope, {})).rejects.toMatchObject({ code: 'memory-api-protocol' });
  });
  it('rejects invalid input before fetch and preserves conflict codes for recovery', async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { code: 'memory-stale-revision', message: 'Changed' } },
        { status: 409 },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    expect(
      memoryContentSchema.safeParse({ title: 'x', content: '😀'.repeat(3000), tags: [] }).success,
    ).toBe(false);
    await expect(
      createMemoryClient().save(scope, {
        operation: 'create',
        requestId: 'not-a-uuid',
        expectedRevision: 0,
        title: 'x',
        content: 'x',
        tags: [],
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(createMemoryClient().list(scope, {})).rejects.toMatchObject({
      status: 409,
      code: 'memory-stale-revision',
    });
  });
  it('rejects a mutation receipt belonging to another request or review target', async () => {
    const client = createMemoryClient();
    const requestId = '33333333-3333-4333-8333-333333333333';
    const otherRequest = '44444444-4444-4444-8444-444444444444';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          receipt: {
            requestId: otherRequest,
            operation: 'setAccess',
            sequence: 1,
            subject: { kind: 'scope-access', scope, settingRevision: 1 },
            result: { scope, level: 'read-only', settingRevision: 1 },
          },
        }),
      ),
    );
    await expect(
      client.setAccess(scope, { requestId, level: 'read-only', expectedSettingRevision: 0 }),
    ).rejects.toMatchObject({ code: 'memory-api-protocol' });
    const wrongRef = { ...ref, memoryId: otherRequest, revision: 2 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          receipt: {
            requestId,
            operation: 'review',
            sequence: 2,
            subject: { kind: 'record', scope, memoryId: otherRequest, revision: 2 },
            result: wrongRef,
          },
        }),
      ),
    );
    await expect(client.review(scope, { requestId, targetRef: ref })).rejects.toMatchObject({
      code: 'memory-api-protocol',
    });
  });
});
