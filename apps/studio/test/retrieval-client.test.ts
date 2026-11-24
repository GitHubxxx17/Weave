import { afterEach, expect, it, vi } from 'vitest';
import { createRetrievalClient } from '../src/features/retrieval/client.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';

afterEach(() => vi.unstubAllGlobals());

it('rejects malformed capabilities and cross-project status data', async () => {
  const fetch = vi.fn(async () => Response.json({ lexical: { available: true } }));
  vi.stubGlobal('fetch', fetch);
  const client = createRetrievalClient(projectId);
  await expect(client.capabilities()).rejects.toMatchObject({ code: 'retrieval-api-protocol' });
  fetch.mockResolvedValueOnce(
    Response.json({
      project: { projectId: requestId, folderRevision: 0, rootDigest: 'a'.repeat(64) },
      availability: 'not-built',
      needsRebuild: false,
    }),
  );
  await expect(client.status()).rejects.toMatchObject({ code: 'retrieval-api-protocol' });
});

it('submits exact Unicode query text and mode without trimming or normalizing it', async () => {
  const fetch = vi
    .fn<(_path: string, _options: RequestInit) => Promise<Response>>()
    .mockResolvedValue(
      Response.json(
        { error: { code: 'retrieval-semantic-unavailable', message: 'Unavailable' } },
        { status: 409 },
      ),
    );
  vi.stubGlobal('fetch', fetch);
  const client = createRetrievalClient(projectId);
  const input = {
    requestId,
    mode: 'hybrid' as const,
    intent: {
      query: ' ＨＴＴＰ 缓存 🚀 ',
      limit: 8,
      filters: { sources: ['workspace' as const], paths: { include: ['src'], exclude: [] } },
    },
  };
  await expect(client.query(input)).rejects.toMatchObject({
    code: 'retrieval-semantic-unavailable',
  });
  const [path, options] = fetch.mock.calls[0]!;
  expect(path).toBe(`/projects/${projectId}/retrieval/query`);
  expect(options.method).toBe('POST');
  expect(JSON.parse(String(options.body))).toEqual(input);
});
