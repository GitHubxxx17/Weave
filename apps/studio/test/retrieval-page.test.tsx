// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SearchPage } from '../src/features/retrieval/SearchPage.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const otherId = '33333333-3333-4333-8333-333333333333';
const jobId = '44444444-4444-4444-8444-444444444444';
const previewId = '55555555-5555-4555-8555-555555555555';
const hash = 'a'.repeat(64);
const date = '2026-11-24T00:00:00.000Z';
const vectorIdentity = {
  provider: 'openai',
  destination: 'api.openai.com',
  model: 'text-embedding-3-small',
  adapterVersion: 'weave.openai-embedding.v1',
  endpointId: 'openai.embeddings.v1',
  dimensions: 512,
};
const versions = {
  chunker: 'weave.line-chunks.v1',
  tokenizer: 'weave.identifier-han.v1',
  discovery: 'weave.discovery.v1',
  manifest: 'weave.retrieval-manifest.v1',
};
const counts = {
  files: 1,
  memories: 0,
  sources: 1,
  discovered: 1,
  selected: 1,
  skipped: 0,
  captureBytes: 4,
  chunkTextBytes: 4,
  chunks: 1,
};
type Send = { requestId: string; mode: string; intent: { query: string; filters: unknown } };

function setup(
  override: (
    path: string,
    input: Record<string, unknown>,
  ) => Response | Promise<Response> | undefined,
) {
  const fetch = vi.fn(async (raw: string, options?: RequestInit) => {
    const url = new URL(raw, 'http://localhost');
    const input = options?.body ? JSON.parse(String(options.body)) : {};
    const key = url.pathname.split('/retrieval/')[1] ?? '';
    const id = url.pathname.includes(otherId) ? otherId : projectId;
    const project = { projectId: id, folderRevision: 1, rootDigest: hash };
    const replacement = override(key, input);
    if (replacement !== undefined) return replacement;
    if (key === 'capabilities')
      return Response.json({
        lexical: { available: true },
        embedding: { configured: true, identity: vectorIdentity },
      });
    if (key === 'status')
      return Response.json({
        project,
        availability: 'ready',
        needsRebuild: false,
        active: {
          generationId: id,
          jobId,
          project,
          indexedAt: date,
          versions,
          manifestDigest: hash,
          counts,
          mode: 'hybrid',
          vectorIdentity,
        },
      });
    if (key === 'builds') return Response.json({ jobs: [] });
    throw new Error(`Unexpected request ${raw}`);
  });
  vi.stubGlobal('fetch', fetch);
  return render(<SearchPage selectedProjectId={projectId} projectName="项目 A" />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('only sends semantic text on explicit form submission and ignores results from the old project', async () => {
  const requests: Send[] = [];
  let resolve: (result: Response) => void = () => undefined;
  const page = setup((path, input) => {
    if (path !== 'query') return undefined;
    requests.push(input as unknown as Send);
    return new Promise((done) => {
      resolve = done;
    });
  });
  const mode = await screen.findByRole('radio', { name: '语义搜索' });
  await waitFor(() => expect(mode).toHaveProperty('disabled', false));
  fireEvent.click(mode);
  const query = screen.getByRole('searchbox', { name: '搜索查询' });
  fireEvent.change(query, { target: { value: ' ＨＴＴＰ 缓存 ' } });
  fireEvent.change(screen.getByRole('textbox', { name: '搜索路径前缀' }), {
    target: { value: 'src' },
  });
  fireEvent(window, new Event('online'));
  expect(screen.getByText(/本次查询将发送至 api\.openai\.com/)).toBeDefined();
  expect(requests).toHaveLength(0);
  fireEvent.submit(screen.getByRole('form', { name: '项目搜索' }));
  await waitFor(() => expect(requests).toHaveLength(1));
  fireEvent.change(query, { target: { value: 'new draft' } });
  expect(requests[0]).toMatchObject({
    mode: 'hybrid',
    intent: { query: ' ＨＴＴＰ 缓存 ', filters: { paths: { include: ['src'] } } },
  });
  page.rerender(<SearchPage selectedProjectId={otherId} projectName="项目 B" />);
  await act(async () =>
    resolve(
      Response.json(
        { error: { code: 'retrieval-embedding-failed', message: 'Failed' } },
        { status: 409 },
      ),
    ),
  );
  expect(screen.queryByText('向量服务请求失败。')).toBeNull();
  expect(screen.getByRole('searchbox', { name: '搜索查询' })).toHaveProperty('value', '');
  expect(requests).toHaveLength(1);
});

it('invalidates a frozen preview when the build selection changes and demands a fresh review', async () => {
  let previews = 0;
  let builds = 0;
  setup((path, input) => {
    if (path === 'preview') {
      previews++;
      return Response.json({
        previewId,
        requestId: input.requestId,
        project: { projectId, folderRevision: 1, rootDigest: hash },
        manifestDigest: hash,
        mode: 'lexical',
        versions,
        createdAt: date,
        expiresAt: '2099-11-24T00:05:00.000Z',
        counts,
        coverage: {
          discovery: 'walk',
          truncated: false,
          skippedDetailsTruncated: false,
          skipCounts: [],
        },
      });
    }
    if (path === `preview/${previewId}`)
      return Response.json({ previewId, manifestDigest: hash, sources: [], skipped: [] });
    if (path === 'builds' && input.previewId) {
      builds++;
    }
    return undefined;
  });
  const review = await screen.findByRole('button', { name: '生成构建预览' });
  await waitFor(() => expect(review).toHaveProperty('disabled', false));
  fireEvent.click(review);
  await screen.findByRole('button', { name: '构建本地索引' });
  fireEvent.change(screen.getByRole('textbox', { name: '纳入构建的路径前缀' }), {
    target: { value: 'src' },
  });
  expect(screen.queryByRole('button', { name: '构建本地索引' })).toBeNull();
  expect(previews).toBe(1);
  expect(builds).toBe(0);
});

it('shows local lexical mode when embeddings are unavailable', async () => {
  setup((path) => {
    if (path === 'capabilities')
      return Response.json({
        lexical: { available: true },
        embedding: { configured: false, reason: 'not-configured' },
      });
    return undefined;
  });
  await screen.findByRole('radio', { name: '语义搜索' });
  expect(screen.getByRole('radio', { name: '语义搜索' })).toHaveProperty('disabled', true);
  expect(screen.getByText('语义向量服务未配置。')).toBeDefined();
});
