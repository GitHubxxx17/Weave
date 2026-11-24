import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { describe, expect, it, vi } from 'vitest';
import type { RetrievalService } from '@weave/runtime';
import { registerRetrievalGuard } from '../src/retrieval-guard.js';
import { registerRetrievalRoutes } from '../src/retrieval-routes.js';

const project = '10000000-0000-4000-8000-000000000001';
const request = '10000000-0000-4000-8000-000000000002';
const origin = 'http://localhost:5173';
const base = `http://localhost/projects/${project}/retrieval`;

function fixture() {
  const app = new Hono();
  const local = {
    capabilities: vi.fn(() => ({ value: 'available' })),
    jobs: vi.fn(() => ({ jobs: [] })),
    build: vi.fn(async () => ({ accepted: true })),
    prepare: vi.fn(async () => ({ preview: true })),
  };
  registerRetrievalGuard(app, origin);
  app.use('*', cors({ origin }));
  registerRetrievalRoutes(app, { service: { local } as unknown as RetrievalService });
  const headers = { Host: 'localhost', Origin: origin, 'Content-Type': 'application/json' };
  return { app, local, headers };
}

describe('guarded Retrieval HTTP routes', () => {
  it('denies foreign and cross-site preflight before CORS and disables caching', async () => {
    const { app, local, headers } = fixture();
    for (const header of [
      { Host: 'foreign.example' },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const response = await app.request(`${base}/capabilities`, {
        method: 'OPTIONS',
        headers: { ...headers, ...header },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    const allowed = await app.request(`${base}/capabilities`, { headers });
    expect(await allowed.json()).toEqual({ value: 'available' });
    expect(allowed.headers.get('Cache-Control')).toBe('no-store');
    expect(local.capabilities).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate query parameters, path IDs, and unknown JSON authority fields', async () => {
    const { app, local, headers } = fixture();
    const duplicate = await app.request(`${base}/builds?cursor=one&cursor=two`, { headers });
    expect(duplicate.status).toBe(400);
    expect(local.jobs).not.toHaveBeenCalled();
    const badProject = await app.request(`${base.replace(project, 'bad')}/capabilities`, {
      headers,
    });
    expect(badProject.status).toBe(400);
    const unknown = await app.request(`${base}/builds`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: request,
        previewId: request,
        mode: 'hybrid',
        manifestDigest: 'a'.repeat(64),
        approved: true,
      }),
    });
    expect(unknown.status).toBe(400);
    expect(local.build).not.toHaveBeenCalled();
  });

  it('checks streamed body and actual serialized response byte limits', async () => {
    const { app, local, headers } = fixture();
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10_000));
        controller.enqueue(new Uint8Array(10_000));
        controller.close();
      },
    });
    const streamedInit: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers,
      body: streamed,
      duplex: 'half',
    };
    const oversized = await app.request(`${base}/preview`, streamedInit);
    expect(oversized.status).toBe(413);
    expect(local.prepare).not.toHaveBeenCalled();
    local.capabilities.mockReturnValueOnce({ value: '\\'.repeat(13_000) });
    const tooLarge = await app.request(`${base}/capabilities`, { headers });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ error: { code: 'retrieval-limit' } });
  });
});
