import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SessionServiceError, type SessionService } from '../src/session-service.js';
import { registerSkillRoutes } from '../src/skill-api.js';
const ref = {
  id: 'builtin:weave-planning',
  instructionSha256: 'a'.repeat(64),
  bundleSha256: 'b'.repeat(64),
};
const summary = {
  ...ref,
  name: 'weave-planning',
  description: 'Plan',
  invocation: { user: true, model: true },
  source: { kind: 'builtin', label: 'Weave' },
};
const catalog = {
  schemaVersion: 1,
  generation: 1,
  fingerprint: 'c'.repeat(64),
  complete: true,
  truncated: false,
  entries: [summary],
  issues: [],
};
function app() {
  const app = new Hono();
  registerSkillRoutes(app, {
    sessionService: { assertRunnable: async () => undefined } as unknown as SessionService,
    skillCatalogService: {
      catalog: async () => catalog,
      preview: async () => ({ skill: summary, instructions: 'safe body' }),
    },
  });
  return app;
}
describe('Skill HTTP', () => {
  it('returns the direct catalog and inert guarded preview', async () => {
    const server = app();
    expect(await (await server.request('http://localhost/sessions/s/skills')).json()).toEqual(
      catalog,
    );
    const response = await server.request('http://localhost/sessions/s/skills/preview', {
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill: ref }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      skill: summary,
      instructions: 'safe body',
    });
  });
  it('maps Session lifecycle failures and bounds preview streaming input', async () => {
    for (const [code, status] of [
      ['session-not-found', 404],
      ['session-archived', 409],
      ['session-deleted', 410],
    ] as const) {
      const server = new Hono();
      registerSkillRoutes(server, {
        sessionService: {
          assertRunnable: async () => {
            throw new SessionServiceError(code, 'Session unavailable');
          },
        } as unknown as SessionService,
        skillCatalogService: {
          catalog: async () => catalog,
          preview: async () => ({ skill: summary, instructions: 'body' }),
        },
      });
      expect((await server.request('http://localhost/sessions/s/skills')).status).toBe(status);
    }
    const response = await app().request('http://localhost/sessions/s/skills/preview', {
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': 'application/json' },
      body: 'x'.repeat(4097),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'skill-invalid-input' } });
  });
  it('rejects foreign origin, non-JSON and malformed exact references', async () => {
    const server = app();
    const request = (headers: Record<string, string>, body = JSON.stringify({ skill: ref })) =>
      server.request('http://localhost/sessions/s/skills/preview', {
        method: 'POST',
        headers,
        body,
      });
    expect((await request({ Host: 'localhost', 'Content-Type': 'text/plain' })).status).toBe(415);
    expect(
      (
        await request({
          Host: 'localhost',
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    expect(
      (await request({ Host: 'localhost', 'Content-Type': 'application/json' }, '{}')).status,
    ).toBe(400);
  });
});
