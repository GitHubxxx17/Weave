// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  archiveSession: vi.fn(),
  restoreSession: vi.fn(),
  deleteSession: vi.fn(),
  createSession: vi.fn(),
  createProject: vi.fn(),
}));

vi.mock('../src/features/workspace/workspace-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/features/workspace/workspace-api.js')>()),
  createWorkspaceApi: () => api,
}));

import { useSessionExecutions } from '../src/app/use-session-executions.js';
import { useSessionLifecycle } from '../src/app/use-session-lifecycle.js';
import type { StudioProject, StudioSession } from '../src/app/app-types.js';

function session(id: string, archivedAt: string | null = null): StudioSession {
  return {
    id,
    title: id,
    archivedAt,
    detailKnown: true,
    messages: [],
    turns: [],
  } as unknown as StudioSession;
}

function project(id: string, sessions: readonly StudioSession[]): StudioProject {
  return { id, name: id, folderPath: `/${id}`, sessions } as unknown as StudioProject;
}

function setup(options: {
  readonly projects: readonly StudioProject[];
  readonly activeSessionId: string;
  readonly runStatus?: (sessionId: string) => string;
}) {
  const executions = {
    appliedDurableSequences: { current: new Map<string, number>() },
    deletedSessionIds: { current: new Set<string>() },
    sessionRunStatus: vi.fn(options.runStatus ?? (() => 'idle')),
    applySessionDetail: vi.fn(() => true),
    loadSessionDetail: vi.fn(async () => undefined),
    resetTransientState: vi.fn(),
    releaseSessionRuntime: vi.fn(),
  };
  const setters = {
    setProjects: vi.fn(),
    setActiveProjectId: vi.fn(),
    setActiveSessionId: vi.fn(),
    setExpandedProjectIds: vi.fn(),
    setActiveView: vi.fn(),
    setOpenMenu: vi.fn(),
    setSearchQuery: vi.fn(),
    setTaskTranscriptTarget: vi.fn(),
    setSessionToDelete: vi.fn(),
    onNotice: vi.fn(),
  };
  const activeSessionIdRef = { current: options.activeSessionId };
  const sessionSkills = { forget: vi.fn() };
  const composerDraft = { migrateProvisional: vi.fn(() => null) };
  const navigationTicket = { current: 0 };
  const hook = renderHook(
    (props: { sessionToDelete: { projectId: string; sessionId: string; title: string } | null }) =>
      useSessionLifecycle({
        projects: options.projects,
        activeProjectId: 'project-a',
        activeSessionId: options.activeSessionId,
        activeSessionIdRef,
        navigationTicket,
        sessionToDelete: props.sessionToDelete,
        composerDraft: composerDraft as never,
        sessionSkills,
        executions,
        ...setters,
      }),
    { initialProps: { sessionToDelete: null } },
  );
  return { hook, executions, setters, activeSessionIdRef, sessionSkills, navigationTicket };
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
});

describe('useSessionLifecycle', () => {
  const projects = [
    project('project-a', [session('s1'), session('s2'), session('s3', 'archived')]),
  ];

  it('does not release runtime when the server rejects a permanent delete', async () => {
    api.deleteSession.mockRejectedValue(new Error('boom'));
    const { hook, executions, setters } = setup({ projects, activeSessionId: 's1' });
    hook.rerender({ sessionToDelete: { projectId: 'project-a', sessionId: 's3', title: 's3' } });
    await act(() => hook.result.current.permanentlyDeleteSession());
    expect(executions.releaseSessionRuntime).not.toHaveBeenCalled();
    expect(setters.setSessionToDelete).not.toHaveBeenCalled();
    expect(setters.onNotice).toHaveBeenCalledTimes(1);
  });

  it('releases the session runtime after a successful permanent delete', async () => {
    api.deleteSession.mockResolvedValue(undefined);
    const { hook, executions, setters, sessionSkills } = setup({
      projects,
      activeSessionId: 's1',
    });
    hook.rerender({ sessionToDelete: { projectId: 'project-a', sessionId: 's3', title: 's3' } });
    await act(() => hook.result.current.permanentlyDeleteSession());
    expect(executions.releaseSessionRuntime).toHaveBeenCalledWith('project-a', 's3');
    expect(sessionSkills.forget).toHaveBeenCalledWith('s3');
    expect(setters.setSessionToDelete).toHaveBeenCalledWith(null);
    expect(setters.setActiveSessionId).not.toHaveBeenCalled();
  });

  it('refuses to delete a session that is not archived or is still streaming', async () => {
    const { hook, executions } = setup({ projects, activeSessionId: 's1' });
    hook.rerender({ sessionToDelete: { projectId: 'project-a', sessionId: 's2', title: 's2' } });
    await act(() => hook.result.current.permanentlyDeleteSession());
    expect(api.deleteSession).not.toHaveBeenCalled();
    const streaming = setup({
      projects,
      activeSessionId: 's1',
      runStatus: () => 'streaming',
    });
    streaming.hook.rerender({
      sessionToDelete: { projectId: 'project-a', sessionId: 's3', title: 's3' },
    });
    await act(() => streaming.hook.result.current.permanentlyDeleteSession());
    expect(api.deleteSession).not.toHaveBeenCalled();
    expect(executions.releaseSessionRuntime).not.toHaveBeenCalled();
  });

  it('moves to the next runnable session after deleting the active one', async () => {
    api.deleteSession.mockResolvedValue(undefined);
    const archivedActive = [project('project-a', [session('s1', 'archived'), session('s2')])];
    const { hook, executions, setters, activeSessionIdRef } = setup({
      projects: archivedActive,
      activeSessionId: 's1',
    });
    hook.rerender({ sessionToDelete: { projectId: 'project-a', sessionId: 's1', title: 's1' } });
    await act(() => hook.result.current.permanentlyDeleteSession());
    expect(activeSessionIdRef.current).toBe('s2');
    expect(setters.setActiveSessionId).toHaveBeenCalledWith('s2');
    expect(executions.resetTransientState).toHaveBeenCalledTimes(1);
  });

  it('does not archive a streaming session', async () => {
    const { hook } = setup({ projects, activeSessionId: 's1', runStatus: () => 'streaming' });
    await act(() => hook.result.current.archiveSession('project-a', 's2'));
    expect(api.archiveSession).not.toHaveBeenCalled();
  });

  it('selects another session, resets transient state and reloads its detail', () => {
    const { hook, executions, setters, activeSessionIdRef, navigationTicket } = setup({
      projects,
      activeSessionId: 's1',
    });
    act(() => hook.result.current.selectProjectSession('project-a', 's1'));
    expect(executions.loadSessionDetail).not.toHaveBeenCalled();
    act(() => hook.result.current.selectProjectSession('project-a', 's2'));
    expect(activeSessionIdRef.current).toBe('s2');
    expect(navigationTicket.current).toBe(1);
    expect(setters.setActiveSessionId).toHaveBeenCalledWith('s2');
    expect(setters.setActiveView).toHaveBeenCalledWith('studio');
    expect(executions.resetTransientState).toHaveBeenCalledTimes(1);
    expect(executions.loadSessionDetail).toHaveBeenCalledWith('project-a', 's2');
  });

  it('never activates a deleted session', () => {
    const { hook, executions, setters } = setup({ projects, activeSessionId: 's1' });
    executions.deletedSessionIds.current.add('s2');
    act(() => hook.result.current.selectProjectSession('project-a', 's2'));
    expect(setters.setActiveSessionId).not.toHaveBeenCalled();
  });
});

describe('useSessionExecutions.releaseSessionRuntime', () => {
  it('aborts handles of the deleted session and clears its bookkeeping', () => {
    const conversationStore = { dispose: vi.fn(), removeSession: vi.fn() };
    const fileReviewStore = { dispose: vi.fn(), removeSession: vi.fn() };
    const { result } = renderHook(() =>
      useSessionExecutions({
        conversationStore: conversationStore as never,
        fileReviewStore: fileReviewStore as never,
        queueController: { states: {}, getState: vi.fn(), open: vi.fn() } as never,
        setProjects: vi.fn(),
        activeProjectId: 'project-a',
        activeSessionId: 's1',
        activeSessionIdRef: { current: 's1' },
        onNotice: vi.fn(),
      }),
    );
    const doomed = {
      runId: 'r1',
      observationEpoch: 1,
      controller: new AbortController(),
      assistantId: 'a',
      tools: [],
      sessionId: 's3',
    };
    const other = { ...doomed, runId: 'r2', controller: new AbortController(), sessionId: 's1' };
    result.current.runHandles.current.set('x', doomed);
    result.current.runHandles.current.set('y', other);
    result.current.appliedDurableSequences.current.set('s3', 4);
    act(() => result.current.releaseSessionRuntime('project-a', 's3'));
    expect(result.current.deletedSessionIds.current.has('s3')).toBe(true);
    expect(result.current.sessionActivityVersions.current.get('s3')).toBe(1);
    expect(doomed.controller.signal.aborted).toBe(true);
    expect(other.controller.signal.aborted).toBe(false);
    expect([...result.current.runHandles.current.keys()]).toEqual(['y']);
    expect(result.current.appliedDurableSequences.current.has('s3')).toBe(false);
    expect(conversationStore.removeSession).toHaveBeenCalledWith('s3');
    expect(fileReviewStore.removeSession).toHaveBeenCalledWith('project-a', 's3');
  });
});
