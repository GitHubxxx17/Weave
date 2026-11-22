// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchManagedCatalog,
  prepareManagedRequest,
  previewGithubManagedPlugin,
} from '../src/features/plugins/managed-plugin-api.js';
import {
  managedCatalog,
  managedPlugin,
  managedPreview,
} from './support/managed-plugin-fixtures.js';

const github = {
  repository: 'https://github.com/weave/plugins',
  commit: 'a'.repeat(40),
  subdirectory: 'packages/notes',
};
const preview = { ...managedPreview, github };
function respond(payload: unknown, status = 200) {
  const fetch = vi.fn(async () => Response.json(payload, { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe('GitHub managed preview', () => {
  it('normalizes repository case and omitted subdirectory before sending a strict source body', async () => {
    const canonical = { ...github, subdirectory: '' };
    const fetch = respond({ ...managedPreview, github: canonical });
    const signal = new AbortController().signal;
    await expect(
      previewGithubManagedPlugin(
        { repository: 'https://github.com/Weave/Plugins', commit: github.commit },
        signal,
      ),
    ).resolves.toEqual({ ...managedPreview, github: canonical });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/plugins/managed/github/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(canonical),
      signal,
    });
  });

  it.each([
    { repository: 'http://github.com/weave/plugins' },
    { repository: 'https://github.com/weave/plugins.git' },
    { repository: 'https://github.com/weave/plugins/' },
    { repository: 'https://user@github.com/weave/plugins' },
    { repository: 'https://github.com:443/weave/plugins' },
    { repository: 'https://github.com/weave/plugins?ref=main' },
    { repository: 'https://github.com/weave/plugins#readme' },
    { repository: 'https://example.com/weave/plugins' },
    { repository: 'https://GITHUB.com/weave/plugins' },
    { repository: 'https://github.com/-weave/plugins' },
    { repository: 'https://github.com/weave-/plugins' },
    { commit: 'main' },
    { commit: 'A'.repeat(40) },
    { subdirectory: '/notes' },
    { subdirectory: 'notes/' },
    { subdirectory: 'notes//plugin' },
    { subdirectory: 'notes/../plugin' },
    { subdirectory: './notes' },
    { subdirectory: 'notes\\plugin' },
    { subdirectory: 'notes\nplugin' },
    { subdirectory: 'a/b/c/d/e/f/g/h/i' },
    { subdirectory: 'plugin:source' },
    { subdirectory: 'NUL' },
    { subdirectory: 'notes/COM1.txt' },
    { subdirectory: 'notes.' },
    { subdirectory: 'notes ' },
    { subdirectory: 'notes\u0085plugin' },
    { subdirectory: 'notes\ud800' },
    { credentials: 'secret' },
  ])('rejects invalid source input without a request: %j', async (change) => {
    const fetch = respond(preview);
    await expect(previewGithubManagedPlugin({ ...github, ...change })).rejects.toMatchObject({
      code: 'plugin-github-invalid',
      status: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { ...github, repository: 'https://github.com/weave/other' },
    { ...github, repository: 'https://github.com/Weave/Plugins' },
    { ...github, commit: 'b'.repeat(40) },
    { ...github, commit: 'A'.repeat(40) },
    { ...github, subdirectory: '' },
    { ...github, privatePath: '/scratch' },
  ])('rejects missing, noncanonical or different echoed source: %j', async (echo) => {
    respond({ ...managedPreview, github: echo });
    await expect(previewGithubManagedPlugin(github)).rejects.toMatchObject({
      code: 'plugin-invalid-response',
      status: 200,
    });
  });

  it.each([
    [400, 'plugin-github-invalid'],
    [400, 'plugin-github-too-large'],
    [502, 'plugin-github-unavailable'],
    [429, 'plugin-github-rate-limited'],
    [504, 'plugin-github-timeout'],
  ])('recognizes the public GitHub error %s/%s', async (status, code) => {
    respond({ error: { code, message: 'Source unavailable' } }, status);
    await expect(previewGithubManagedPlugin(github)).rejects.toMatchObject({ code, status });
  });

  it('propagates caller cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(controller.signal.reason));
    await expect(previewGithubManagedPlugin(github, controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
  });

  it('preserves the existing reviewed import command without source fields', () => {
    const request = prepareManagedRequest({ kind: 'import', preview }, 'github-review');
    expect(JSON.parse(request.body)).toEqual({
      requestId: 'github-review',
      previewId: 'preview-1',
      expectedInstallSequence: 3,
    });
  });
});

describe('GitHub candidate history', () => {
  it('accepts canonical GitHub provenance alongside existing local candidates', async () => {
    const catalog = {
      ...managedCatalog,
      plugins: [
        {
          ...managedPlugin,
          candidates: [
            managedPlugin.candidates[0],
            { ...managedPlugin.candidates[1], provenance: 'github', github },
          ],
        },
      ],
    };
    respond(catalog);
    await expect(fetchManagedCatalog()).resolves.toEqual({ kind: 'enabled', catalog });
  });

  it.each([
    { provenance: 'github' },
    { provenance: 'github', github: { ...github, repository: 'https://github.com/Weave/Plugins' } },
    { provenance: 'local-directory', github },
  ])('rejects inconsistent candidate provenance: %j', async (provenance) => {
    respond({
      ...managedCatalog,
      plugins: [
        {
          ...managedPlugin,
          candidates: managedPlugin.candidates.map((candidate) => ({
            ...candidate,
            ...provenance,
          })),
        },
      ],
    });
    await expect(fetchManagedCatalog()).rejects.toMatchObject({ code: 'plugin-invalid-response' });
  });
});
