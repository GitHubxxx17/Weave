// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionExecutions } from '../src/app/use-session-executions.js';
import type { SessionRunHandle, StudioProject } from '../src/app/app-types.js';
import type { SessionDetail } from '../src/features/workspace/workspace-types.js';

function setup(initialSessionId = 'session-a') {
  const conversationStore = {
    dispose: vi.fn(),
    detachLive: vi.fn(),
    hydrate: vi.fn(),
  };
  const fileReviewStore = { dispose: vi.fn() };
  const queueController = {
    states: {} as Record<string, { queued: readonly unknown[] }>,
    getState: vi.fn(() => undefined),
    open: vi.fn(async () => undefined),
  };
  const setProjects = vi.fn();
  const onNotice = vi.fn();
  const activeSessionIdRef = { current: initialSessionId };
  const hook = renderHook(
    ({ activeSessionId }) =>
      useSessionExecutions({
        conversationStore: conversationStore as never,
        fileReviewStore: fileReviewStore as never,
        queueController: queueController as never,
        setProjects,
        activeProjectId: 'project-a',
        activeSessionId,
        activeSessionIdRef,
        onNotice,
      }),
    { initialProps: { activeSessionId: initialSessionId } },
  );
  return { hook, conversationStore, fileReviewStore, queueController, setProjects, onNotice };
}

function handle(overrides: Partial<SessionRunHandle> = {}): SessionRunHandle {
  return {
    runId: 'run-1',
    observationEpoch: 1,
    controller: new AbortController(),
    assistantId: 'assistant-1',
    tools: [],
    ...overrides,
  };
}

function detail(id: string, lastSequence: number): SessionDetail {
  return { id, lastSequence, turns: [], messages: [] } as unknown as SessionDetail;
}

describe('useSessionExecutions', () => {
  it('aborts and clears every run handle on unmount, then disposes the stores', async () => {
    const { hook, conversationStore, fileReviewStore } = setup();
    const running = handle();
    hook.result.current.runHandles.current.set('session-a', running);
    hook.unmount();
    expect(running.controller.signal.aborted).toBe(true);
    expect(hook.result.current.runHandles.current.size).toBe(0);
    await Promise.resolve();
    expect(conversationStore.dispose).toHaveBeenCalledTimes(1);
    expect(fileReviewStore.dispose).toHaveBeenCalledTimes(1);
  });

  it('detaches observing handles of other sessions when the active session changes', () => {
    const { hook } = setup('session-a');
    const other = handle({ runId: 'other', sessionId: 'session-a', observing: true });
    const sameSession = handle({ runId: 'same', sessionId: 'session-b', observing: true });
    const sending = handle({ runId: 'sending', sessionId: 'session-a' });
    hook.result.current.runHandles.current.set('exec-a', other);
    hook.result.current.runHandles.current.set('exec-b', sameSession);
    hook.result.current.runHandles.current.set('session-a', sending);
    hook.rerender({ activeSessionId: 'session-b' });
    const keys = [...hook.result.current.runHandles.current.keys()];
    expect(keys.sort()).toEqual(['exec-b', 'session-a']);
    expect(other.controller.signal.aborted).toBe(true);
    expect(sameSession.controller.signal.aborted).toBe(false);
    expect(sending.controller.signal.aborted).toBe(false);
  });

  it('applies a session detail once, then ignores older sequences and deleted sessions', () => {
    const { hook, conversationStore, setProjects } = setup();
    let first = false;
    act(() => {
      first = hook.result.current.applySessionDetail('project-a', detail('session-a', 5));
    });
    expect(first).toBe(true);
    expect(conversationStore.hydrate).toHaveBeenCalledTimes(1);
    expect(setProjects).toHaveBeenCalledTimes(1);
    expect(hook.result.current.applySessionDetail('project-a', detail('session-a', 4))).toBe(false);
    expect(hook.result.current.applySessionDetail('project-a', detail('session-a', 5))).toBe(true);
    hook.result.current.deletedSessionIds.current.add('session-a');
    expect(hook.result.current.applySessionDetail('project-a', detail('session-a', 9))).toBe(false);
    expect(conversationStore.hydrate).toHaveBeenCalledTimes(2);
    const update = setProjects.mock.calls[0]?.[0] as (
      projects: readonly StudioProject[],
    ) => readonly StudioProject[];
    expect(update([])).toEqual([]);
  });

  it('reports a session as streaming for a running status, queued messages or admission', () => {
    const { hook, queueController } = setup();
    expect(hook.result.current.isSessionStreaming('session-a')).toBe(false);
    act(() =>
      hook.result.current.setSessionRunState('session-a', {
        status: 'streaming',
        errorMessage: null,
      }),
    );
    expect(hook.result.current.sessionRunStatus('session-a')).toBe('streaming');
    expect(hook.result.current.activeRunState.status).toBe('streaming');
    expect(hook.result.current.isSessionStreaming('session-a')).toBe(true);
    expect(hook.result.current.isSessionStreaming('session-b')).toBe(false);
    act(() => hook.result.current.setAdmitting({ 'session-b': true }));
    expect(hook.result.current.isSessionStreaming('session-b')).toBe(true);
    queueController.states['session-c'] = { queued: [{}] };
    hook.rerender({ activeSessionId: 'session-a' });
    expect(hook.result.current.isSessionStreaming('session-c')).toBe(true);
  });

  it('clears a settled active run state but never a streaming one', () => {
    const { hook } = setup();
    act(() =>
      hook.result.current.setSessionRunState('session-a', {
        status: 'completed',
        errorMessage: null,
      }),
    );
    act(() => hook.result.current.clearActiveRunState());
    expect(hook.result.current.activeRunState.status).toBe('idle');
    act(() =>
      hook.result.current.setSessionRunState('session-a', {
        status: 'streaming',
        errorMessage: null,
      }),
    );
    act(() => hook.result.current.clearActiveRunState());
    expect(hook.result.current.activeRunState.status).toBe('streaming');
  });

  it('ignores runtime events from a run that no longer owns the session handle', () => {
    const { hook, setProjects } = setup();
    hook.result.current.runHandles.current.set('session-a', handle({ runId: 'current' }));
    hook.result.current.handleEvent(
      { type: 'text-delta', text: 'x' } as never,
      'stale',
      'assistant-1',
      'project-a',
      'session-a',
    );
    expect(setProjects).not.toHaveBeenCalled();
    hook.result.current.handleEvent(
      { type: 'text-delta', text: 'x' } as never,
      'current',
      'assistant-1',
      'project-a',
      'session-a',
    );
    expect(setProjects).toHaveBeenCalledTimes(1);
  });
});
