// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceApi, WorkspaceApiError } from '../src/features/workspace/workspace-api.js';

const project = {
  id: 'project-1',
  name: 'Weave',
  folderName: 'weave',
  createdAt: '2026-11-16T00:00:00.000Z',
  updatedAt: '2026-11-16T00:00:00.000Z',
};

const session = {
  id: 'session-1',
  title: '第一次对话',
  lastSequence: 1,
  messages: [],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  delete window.weaveDesktop;
  vi.restoreAllMocks();
});

describe('Workspace API client', () => {
  it('parses the project list at the browser boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        projects: [
          {
            ...project,
            sessions: [
              {
                id: session.id,
                title: session.title,
                lastSequence: session.lastSequence,
              },
            ],
          },
        ],
        warnings: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createWorkspaceApi().listProjects({ includeArchived: true });

    expect(result.projects[0]?.sessions[0]?.title).toBe('第一次对话');
    expect(fetchMock).toHaveBeenCalledWith(
      '/projects?includeArchived=true',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('converts a non-JSON response into a protocol error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('service unavailable', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    );

    await expect(createWorkspaceApi().listProjects()).rejects.toMatchObject({
      name: 'WorkspaceApiError',
      code: 'workspace-api-protocol',
      status: 503,
    });
  });

  it.each([
    ['session-not-found', 404],
    ['session-archived', 409],
    ['workspace-api-failure', 500],
  ])('preserves API error code for %s responses', async (code, status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code,
              message: `错误：${code}`,
            },
          },
          status,
        ),
      ),
    );

    const error = await createWorkspaceApi()
      .getSession('session-1')
      .catch((reason: unknown) => {
        expect(reason).toBeInstanceOf(WorkspaceApiError);
        return reason as WorkspaceApiError;
      });

    expect(error).toMatchObject({ code, message: `错误：${code}`, status });
  });

  it('serializes project creation fields as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(project, 201));
    vi.stubGlobal('fetch', fetchMock);

    await createWorkspaceApi().createProject({
      name: 'Weave 项目',
      folderName: 'weave',
      folderPath: '/Users/mi/Projects/weave',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/projects',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Weave 项目',
          folderName: 'weave',
          folderPath: '/Users/mi/Projects/weave',
        }),
      }),
    );
  });

  it('uses the desktop Server URL for project requests', async () => {
    window.weaveDesktop = {
      isDesktop: true,
      serverUrl: 'http://127.0.0.1:46321/',
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(project, 201));
    vi.stubGlobal('fetch', fetchMock);

    await createWorkspaceApi().createProject({
      name: 'Weave 项目',
      folderName: 'weave',
      folderPath: '/Users/mi/Projects/weave',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:46321/projects',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('uses the desktop Server URL for project list queries', async () => {
    window.weaveDesktop = {
      isDesktop: true,
      serverUrl: 'http://127.0.0.1:46321/',
    };
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        projects: [],
        warnings: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createWorkspaceApi().listProjects({ includeArchived: true });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:46321/projects?includeArchived=true',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses the desktop Server URL for every Session lifecycle route', async () => {
    window.weaveDesktop = {
      isDesktop: true,
      serverUrl: 'http://127.0.0.1:46321/',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse(session, 201))
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse(session));
    vi.stubGlobal('fetch', fetchMock);
    const api = createWorkspaceApi();

    await api.getSession('session-1');
    await api.createSession('project-1', '新会话');
    await api.renameSession('session-1', '重命名会话');
    await api.archiveSession('session-1');
    await api.restoreSession('session-1');
    await api.deleteSession('session-1');

    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      'http://127.0.0.1:46321/sessions/session-1',
      'http://127.0.0.1:46321/projects/project-1/sessions',
      'http://127.0.0.1:46321/sessions/session-1',
      'http://127.0.0.1:46321/sessions/session-1/archive',
      'http://127.0.0.1:46321/sessions/session-1/restore',
      'http://127.0.0.1:46321/sessions/session-1',
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      'GET',
      'POST',
      'PATCH',
      'POST',
      'POST',
      'DELETE',
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ title: '新会话' }),
      }),
    );
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ title: '重命名会话' }),
      }),
    );
  });

  it('renames a Project with a PATCH that only carries the name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...project, name: 'Weave Studio' }));
    vi.stubGlobal('fetch', fetchMock);

    const renamed = await createWorkspaceApi().renameProject('project/1', 'Weave Studio');

    expect(renamed.name).toBe('Weave Studio');
    expect(fetchMock).toHaveBeenCalledWith(
      '/projects/project%2F1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: 'Weave Studio' }),
      }),
    );
  });

  it('encodes project and session identifiers in URL paths', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(session, 201))
      .mockResolvedValueOnce(jsonResponse(session));
    vi.stubGlobal('fetch', fetchMock);
    const api = createWorkspaceApi();

    await api.createSession('project/a b', '带空格的会话');
    await api.getSession('session/a b');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/projects/project%2Fa%20b/sessions');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/sessions/session%2Fa%20b');
  });
});
