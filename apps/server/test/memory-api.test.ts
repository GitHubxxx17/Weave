import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteMemoryStore } from '@weave/memory';
import { createMemoryService, createRuntime, MemoryError } from '@weave/runtime';
import { createInMemoryProjectStore } from '@weave/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'weave-memory-http-'));
  const filename = join(directory, 'memory.sqlite');
  const projects = createInMemoryProjectStore();
  const project = await projects.createProject({ name: 'Project A', folderName: 'a' });
  const other = await projects.createProject({ name: 'Project B', folderName: 'b' });
  const store = createSqliteMemoryStore({ filename });
  const service = createMemoryService({
    store,
    resolveLocalScope: async (scope) => {
      if (scope.kind === 'project' && (await projects.getProject(scope.projectId)) === undefined)
        throw new MemoryError('memory-not-found');
      return { assertCurrentSync() {} };
    },
    resolveAgentScope: async () => {
      throw new MemoryError('memory-scope-forbidden');
    },
  });
  const app = createApp(createRuntime(), {
    memoryService: service,
    projectStore: projects,
    studioOrigin: 'http://localhost:5173',
  });
  cleanups.push(async () => {
    await service.close();
    await projects.close();
    await rm(directory, { recursive: true, force: true });
  });
  const scope = { kind: 'project' as const, projectId: project.id };
  const query = `scope=project&projectId=${project.id}`;
  const get = (path: string, headers = {}) =>
    app.request(`http://localhost${path}`, { headers: { Host: 'localhost', ...headers } });
  const post = (path: string, body: unknown) =>
    app.request(`http://localhost${path}`, {
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, service, store, scope, project, other, projects, query, get, post, filename };
}
const input = () => ({
  operation: 'create',
  expectedRevision: 0,
  requestId: randomUUID(),
  title: 'Strict TypeScript',
  content: 'Preserve a useful fact',
  tags: ['coding'],
});

describe('guarded Memory HTTP management', () => {
  it('lists real scopes and manages disabled Memory with idempotent local-user provenance', async () => {
    const f = await fixture();
    const scopes = await f.get('/memory/scopes');
    expect(scopes.status).toBe(200);
    expect(await scopes.json()).toMatchObject({
      scopes: [{ name: 'Project A' }, { name: 'Project B' }, { scope: { kind: 'user' } }],
    });
    const access = await f.get(`/memory/access?${f.query}`);
    expect(await access.json()).toMatchObject({
      access: { level: 'disabled', settingRevision: 0 },
    });
    const body = { scope: f.scope, ...input() };
    const saved = await f.post('/memory/records', body);
    expect(saved.status).toBe(201);
    const { receipt } = await saved.json();
    expect(await (await f.post('/memory/records', body)).json()).toEqual({ receipt });
    const read = await f.get(`/memory/records/${receipt.result.memoryId}?${f.query}`);
    expect(read.headers.get('Cache-Control')).toBe('no-store');
    expect(await read.json()).toMatchObject({
      record: { title: body.title, review: 'user-reviewed', provenance: { actor: 'local-user' } },
    });
    const page = await f.get(`/memory/records?${f.query}`);
    expect(await page.json()).toMatchObject({ records: [{ title: body.title }] });
  });
  it('isolates scopes and returns safe conflicts without replacing the current version', async () => {
    const f = await fixture();
    const body = { scope: f.scope, ...input() };
    const { receipt } = await (await f.post('/memory/records', body)).json();
    expect(
      (
        await f.get(
          `/memory/records/${receipt.result.memoryId}?scope=project&projectId=${f.other.id}`,
        )
      ).status,
    ).toBe(404);
    expect(await (await f.get('/memory/records?scope=user')).json()).toEqual({ records: [] });
    const revise = {
      ...body,
      operation: 'revise',
      memoryId: receipt.result.memoryId,
      expectedRevision: 1,
      requestId: randomUUID(),
      content: 'Updated body',
    };
    expect((await f.post('/memory/records', revise)).status).toBe(200);
    const conflict = await f.post('/memory/records', {
      ...revise,
      requestId: randomUUID(),
      content: 'Draft to preserve',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).not.toContain('Updated body');
    expect((await f.post('/memory/records', { ...body, content: 'Changed retry' })).status).toBe(
      409,
    );
  });
  it('reviews an exact version and retains historical content after deletion', async () => {
    const f = await fixture();
    const { receipt } = await (
      await f.post('/memory/records', { scope: f.scope, ...input() })
    ).json();
    const id = receipt.result.memoryId;
    expect(
      (
        await f.post(`/memory/records/${id}/review`, {
          scope: f.scope,
          requestId: randomUUID(),
          targetRef: { ...receipt.result, sha256: 'b'.repeat(64) },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.post(`/memory/records/${id}/delete`, {
          scope: f.scope,
          requestId: randomUUID(),
          expectedRevision: 1,
        })
      ).status,
    ).toBe(200);
    expect((await f.get(`/memory/records/${id}?${f.query}`)).status).toBe(404);
    expect(await (await f.get(`/memory/records?${f.query}&query=useful`)).json()).toEqual({
      records: [],
    });
    const history = await f.get(`/memory/records/${id}/history?${f.query}`);
    expect(await history.json()).toMatchObject({
      entries: [{ kind: 'deleted' }, { kind: 'created' }],
    });
    expect(
      (await f.get(`/memory/records/${id}?${f.query}&revision=1&sha256=${receipt.result.sha256}`))
        .status,
    ).toBe(200);
  });
  it('rejects browser authority claims, unknown or duplicate query keys, and invalid exact refs', async () => {
    const f = await fixture();
    for (const extra of [
      { actor: 'agent' },
      { role: 'admin' },
      { provenance: { actor: 'agent', sessionId: 'missing' } },
      { sourceMessageId: 'missing' },
    ]) {
      expect(
        (await f.post('/memory/records', { scope: f.scope, ...input(), ...extra })).status,
      ).toBe(400);
    }
    for (const query of [
      'scope=user&actor=agent',
      'scope=user&__proto__=agent',
      'scope=user&scope=user',
      'scope=user&projectId=' + f.project.id,
      'scope=project',
      'scope=user&limit=999',
    ]) {
      expect((await f.get(`/memory/records?${query}`)).status).toBe(400);
    }
    expect((await f.get(`/memory/records/${randomUUID()}?scope=user&revision=1`)).status).toBe(400);
  });
  it('guards every sensitive read and preflight before CORS and bounds raw JSON without Content-Length', async () => {
    const f = await fixture();
    for (const headers of [
      { Host: 'evil.example' },
      { Origin: 'https://evil.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const response = await f.get('/memory/scopes', headers);
      expect(response.status).toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    expect(
      (
        await f.app.request('http://localhost/memory/records', {
          method: 'OPTIONS',
          headers: { Host: 'evil.example', Origin: 'http://localhost:5173' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.app.request('http://localhost/memory/records', {
          method: 'POST',
          headers: { Host: 'localhost' },
          body: '{}',
        })
      ).status,
    ).toBe(415);
    for (const [body, status] of [
      ['x'.repeat(65537), 413],
      [new Uint8Array([0xff, 0xfe]), 400],
      ['', 400],
    ] as const) {
      const response = await f.app.request('http://localhost/memory/records', {
        method: 'POST',
        headers: { Host: 'localhost', 'Content-Type': 'application/json' },
        body,
      });
      expect(response.status).toBe(status);
    }
  });
  it('rejects a scope listing whose complete JSON envelope exceeds the HTTP response budget', async () => {
    const f = await fixture();
    await f.projects.renameProject(f.project.id, 'P'.repeat(65536));
    const response = await f.get('/memory/scopes');
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: 'memory-limit', message: 'Memory request could not be completed.' },
    });
  });
});
