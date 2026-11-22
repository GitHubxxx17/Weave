import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerPanelGuards, registerPanelRoutes } from '../src/plugin-panel-api.js';
import type { PanelService } from '../src/plugin-panel-types.js';
import { PanelError } from '../src/plugin-panel-errors.js';
const ref = 'A'.repeat(32);
function fixture() {
  const service = {
    catalog: vi.fn(() => ({ schemaVersion: 1 })),
    read: vi.fn(async () => ({ schemaVersion: 1 })),
    prepare: vi.fn(async () => ({ schemaVersion: 1 })),
    closeSync: vi.fn(),
    drain: vi.fn(),
  } as unknown as PanelService;
  const app = new Hono();
  registerPanelGuards(app, { panelService: service, studioOrigin: 'http://localhost:5173' });
  registerPanelRoutes(app, { panelService: service });
  return { app, service };
}
describe('panel HTTP boundary', () => {
  it.each([
    '/plugins/panels',
    `/sessions/s/plugin-panels/${ref}`,
    `/sessions/s/plugin-panels/${ref}/prepare-command`,
  ])('guards every path including GET %s', async (path) => {
    const { app } = fixture();
    for (const headers of [
      { Host: 'example.com' },
      { Host: 'localhost', 'Sec-Fetch-Site': 'cross-site' },
      { Host: 'localhost', Origin: 'http://localhost:9999' },
    ]) {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        error: {
          code: 'panel-request-forbidden',
          message: 'Panel request requires a trusted local origin and Host',
        },
      });
    }
  });
  it('allows no-Origin CLI GET and bodyless guarded HEAD/OPTIONS', async () => {
    const { app } = fixture();
    expect((await app.request('/plugins/panels', { headers: { Host: 'localhost' } })).status).toBe(
      200,
    );
    for (const method of ['HEAD', 'OPTIONS']) {
      const response = await app.request('/plugins/panels', {
        method,
        headers: { Host: 'localhost' },
      });
      expect(await response.text()).toBe('');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
  it('strictly validates JSON media, UTF-8, body envelope and actual streamed byte count', async () => {
    const { app, service } = fixture();
    const path = `/sessions/s/plugin-panels/${ref}/prepare-command`;
    for (const body of [
      '{"formId":"review","values":{},"extra":1}',
      '{',
      '{"formId":"review","values":{"a":3}}',
    ])
      expect(
        (
          await app.request(path, {
            method: 'POST',
            headers: { Host: 'localhost', 'Content-Type': 'application/json' },
            body,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await app.request(path, {
          method: 'POST',
          headers: { Host: 'localhost', 'Content-Type': 'text/plain' },
          body: '{}',
        })
      ).status,
    ).toBe(400);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16385));
        controller.close();
      },
    });
    expect(
      (
        await app.request(path, {
          method: 'POST',
          headers: { Host: 'localhost', 'Content-Type': 'application/json', 'Content-Length': '1' },
          body: stream,
          duplex: 'half',
        } as RequestInit)
      ).status,
    ).toBe(413);
    expect(
      (
        await app.request(path, {
          method: 'POST',
          headers: { Host: 'localhost', 'Content-Type': 'application/json' },
          body: new Uint8Array([0xff]),
        })
      ).status,
    ).toBe(400);
    expect(service.prepare).not.toHaveBeenCalled();
  });
  it('returns exact bounded host errors without native details', async () => {
    const { app, service } = fixture();
    vi.mocked(service.read)
      .mockRejectedValueOnce(new Error('/secret/plugin.js'))
      .mockRejectedValueOnce(new PanelError('session-deleted'));
    const first = await app.request(`/sessions/s/plugin-panels/${ref}`, {
      headers: { Host: 'localhost' },
    });
    expect(first.status).toBe(503);
    expect(await first.text()).not.toContain('secret');
    const second = await app.request(`/sessions/s/plugin-panels/${ref}`, {
      headers: { Host: 'localhost' },
    });
    expect(second.status).toBe(410);
    expect(await second.json()).toEqual({
      error: { code: 'session-deleted', message: 'Session was deleted' },
    });
  });
});

describe('bounded panel preflight', () => {
  it('returns configured CORS headers without reading catalog or exposing data', async () => {
    const { app, service } = fixture();
    const response = await app.request('/plugins/panels', {
      method: 'OPTIONS',
      headers: {
        Host: 'localhost',
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    expect(await response.text()).toBe('');
    expect(service.catalog).not.toHaveBeenCalled();
  });
});

describe('strict raw panel prepare keys', () => {
  it('rejects raw __proto__ before record parsing can silently discard the unknown field', async () => {
    const { app, service } = fixture();
    const response = await app.request(`/sessions/s/plugin-panels/${ref}/prepare-command`, {
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': 'application/json' },
      body: '{"formId":"review","values":{"__proto__":"unknown"}}',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'panel-invalid-input', message: 'Panel input is invalid' },
    });
    expect(service.prepare).not.toHaveBeenCalled();
  });
});
