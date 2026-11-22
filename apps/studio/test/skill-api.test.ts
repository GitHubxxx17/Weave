import { afterEach, expect, it, vi } from 'vitest';
import { fetchSessionSkills, previewSessionSkill } from '../src/features/skills/skill-api.js';
import { skillRefSchema, skillCatalogSchema } from '../src/features/skills/skill-types.js';
import { planningRef, planningSkill, skillCatalog } from './support/skill-fixtures.js';
afterEach(() => vi.unstubAllGlobals());
it('sends only exact refs to guarded preview and rejects substituted bundle identities', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      schemaVersion: 1,
      skill: { ...planningSkill, bundleSha256: 'f'.repeat(64) },
      instructions: 'new body',
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(previewSessionSkill('session/one', planningRef)).rejects.toMatchObject({
    code: 'skill-source-changed',
  });
  expect(fetcher).toHaveBeenCalledWith(
    '/sessions/session%2Fone/skills/preview',
    expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skill: planningRef }),
    }),
  );
});
it('rejects malformed identities and falsely complete clipped catalogs', async () => {
  expect(skillRefSchema.safeParse({ ...planningRef, id: '/private/skill' }).success).toBe(false);
  expect(
    skillCatalogSchema.safeParse({ ...skillCatalog(), complete: true, truncated: true }).success,
  ).toBe(false);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ ...skillCatalog(), entries: [{ ...planningSkill, id: 'wrong-id' }] }),
    ),
  );
  await expect(fetchSessionSkills('one')).rejects.toMatchObject({ code: 'skill-api-protocol' });
});
