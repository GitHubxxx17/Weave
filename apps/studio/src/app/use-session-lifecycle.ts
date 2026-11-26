import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type {
  DraftCapture,
  DraftMigrationTicket,
  useComposerDraft,
} from '../features/composer/use-composer-draft.js';
import { createWorkspaceApi } from '../features/workspace/workspace-api.js';
import { toStudioProject, toStudioSession, workspaceErrorMessage } from './app-helpers.js';
import type {
  OpenMenu,
  ProductView,
  StudioProject,
  StudioSession,
  TaskTranscriptTarget,
} from './app-types.js';
import type { useSessionExecutions } from './use-session-executions.js';

const workspaceApi = createWorkspaceApi();

export type ActiveSessionContext = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly session: StudioSession;
  readonly migrationTicket?: DraftMigrationTicket | null;
};

export type SessionToDelete = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly title: string;
};

export type UseSessionLifecycleOptions = {
  readonly projects: readonly StudioProject[];
  readonly setProjects: Dispatch<SetStateAction<readonly StudioProject[]>>;
  readonly activeProjectId: string;
  readonly setActiveProjectId: Dispatch<SetStateAction<string>>;
  readonly activeSessionId: string;
  readonly setActiveSessionId: Dispatch<SetStateAction<string>>;
  /** Mirrors `activeSessionId` synchronously for async callbacks. */
  readonly activeSessionIdRef: MutableRefObject<string>;
  /** Invalidates in-flight navigations (for example task transcript opens). */
  readonly navigationTicket: MutableRefObject<number>;
  readonly setExpandedProjectIds: Dispatch<SetStateAction<readonly string[]>>;
  readonly setActiveView: Dispatch<SetStateAction<ProductView>>;
  readonly setOpenMenu: Dispatch<SetStateAction<OpenMenu>>;
  readonly setSearchQuery: Dispatch<SetStateAction<string>>;
  readonly setTaskTranscriptTarget: Dispatch<SetStateAction<TaskTranscriptTarget | undefined>>;
  readonly sessionToDelete: SessionToDelete | null;
  readonly setSessionToDelete: Dispatch<SetStateAction<SessionToDelete | null>>;
  readonly composerDraft: Pick<ReturnType<typeof useComposerDraft>, 'migrateProvisional'>;
  readonly sessionSkills: { readonly forget: (sessionId: string) => void };
  readonly executions: Pick<
    ReturnType<typeof useSessionExecutions>,
    | 'appliedDurableSequences'
    | 'deletedSessionIds'
    | 'sessionRunStatus'
    | 'applySessionDetail'
    | 'loadSessionDetail'
    | 'resetTransientState'
    | 'releaseSessionRuntime'
  >;
  /** Shows (or clears with `null`) the App-level notice banner. */
  readonly onNotice: (message: string | null) => void;
};

/**
 * Project and session lifecycle: activate, select, create, archive, restore and
 * permanently delete. Running state is only touched through `executions`.
 */
export function useSessionLifecycle({
  projects,
  setProjects,
  activeProjectId,
  setActiveProjectId,
  activeSessionId,
  setActiveSessionId,
  activeSessionIdRef,
  navigationTicket,
  setExpandedProjectIds,
  setActiveView,
  setOpenMenu,
  setSearchQuery,
  setTaskTranscriptTarget,
  sessionToDelete,
  setSessionToDelete,
  composerDraft,
  sessionSkills,
  executions,
  onNotice: setNotice,
}: UseSessionLifecycleOptions) {
  const {
    appliedDurableSequences,
    deletedSessionIds,
    sessionRunStatus,
    applySessionDetail,
    loadSessionDetail,
    resetTransientState,
    releaseSessionRuntime,
  } = executions;

  function findNextRunnableSession(
    projectId: string,
    excludedSessionId: string,
  ): StudioSession | undefined {
    return projects
      .find((project) => project.id === projectId)
      ?.sessions.find((session) => session.id !== excludedSessionId && session.archivedAt === null);
  }

  function activateSession(projectId: string, session: StudioSession, expandProject = true): void {
    if (deletedSessionIds.current.has(session.id)) return;
    navigationTicket.current += 1;
    setTaskTranscriptTarget(undefined);
    setActiveProjectId(projectId);
    activeSessionIdRef.current = session.id;
    setActiveSessionId(session.id);
    setActiveView('studio');
    if (expandProject)
      setExpandedProjectIds((current) =>
        current.includes(projectId) ? current : [...current, projectId],
      );
  }

  async function createSessionForProject(
    projectId: string,
    projectIfMissing?: StudioProject,
    submissionDraft?: DraftCapture,
  ): Promise<ActiveSessionContext | null> {
    try {
      const detail = await workspaceApi.createSession(projectId);
      appliedDurableSequences.current.set(detail.id, detail.lastSequence);
      const newSession = toStudioSession(detail);
      setProjects((current) => {
        const project = current.find((candidate) => candidate.id === projectId);
        if (project === undefined) {
          return projectIfMissing === undefined
            ? current
            : [...current, { ...projectIfMissing, sessions: [newSession] }];
        }

        return current.map((candidate) =>
          candidate.id === projectId
            ? { ...candidate, sessions: [newSession, ...candidate.sessions] }
            : candidate,
        );
      });
      const migrationTicket =
        submissionDraft === undefined
          ? null
          : composerDraft.migrateProvisional(
              submissionDraft,
              newSession.id,
              projectId,
              projectIfMissing?.folderPath ??
                projects.find((p) => p.id === projectId)?.folderPath ??
                '',
            );
      if (submissionDraft === undefined || migrationTicket !== null) {
        activateSession(projectId, newSession);
        resetTransientState();
      }
      return { projectId, sessionId: newSession.id, session: newSession, migrationTicket };
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
      return null;
    }
  }

  function getActiveSessionContext(): ActiveSessionContext | null {
    const project = projects.find((candidate) => candidate.id === activeProjectId);
    const session = project?.sessions.find(
      (candidate) => candidate.id === activeSessionIdRef.current && candidate.archivedAt === null,
    );
    return project === undefined || session === undefined
      ? null
      : { projectId: project.id, sessionId: session.id, session };
  }

  /**
   * Returns the active session, creating the initial local project/session when needed.
   * The returned IDs are used immediately so a first message does not depend on React state timing.
   */
  async function ensureSessionForMessage(
    submissionDraft: DraftCapture,
  ): Promise<ActiveSessionContext | null> {
    const activeContext = getActiveSessionContext();
    if (activeContext !== null) {
      return activeContext;
    }

    const project = projects.find((candidate) => candidate.id === activeProjectId);
    if (project !== undefined) {
      return createSessionForProject(project.id, undefined, submissionDraft);
    }

    try {
      const createdProject = await workspaceApi.createProject({
        name: 'Weave',
        folderName: 'weave',
      });
      const project: StudioProject = {
        ...toStudioProject({ ...createdProject, sessions: [] }),
        sessions: [],
      };
      return createSessionForProject(project.id, project, submissionDraft);
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
      return null;
    }
  }

  /** Selects a session from any project and keeps the project/session context aligned. */
  function selectProjectSession(projectId: string, sessionId: string): void {
    if (projectId === activeProjectId && sessionId === activeSessionId) {
      return;
    }

    const session = projects
      .find((project) => project.id === projectId)
      ?.sessions.find((entry) => entry.id === sessionId);
    if (session === undefined) return;
    activateSession(projectId, session);
    resetTransientState();
    void loadSessionDetail(projectId, sessionId);
  }

  /** Expands or collapses one project node without changing the active project. */
  function toggleProjectExpanded(projectId: string): void {
    setExpandedProjectIds((current) =>
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId],
    );
  }

  async function archiveSession(projectId: string, sessionId: string): Promise<void> {
    if (sessionRunStatus(sessionId) === 'streaming') {
      return;
    }

    try {
      const detail = await workspaceApi.archiveSession(sessionId);
      sessionSkills.forget(sessionId);
      applySessionDetail(projectId, detail);

      if (projectId === activeProjectId && sessionId === activeSessionId) {
        const nextSession = findNextRunnableSession(projectId, sessionId);
        if (nextSession !== undefined) {
          activeSessionIdRef.current = nextSession.id;
          setActiveSessionId(nextSession.id);
        } else {
          activeSessionIdRef.current = '';
          setActiveSessionId('');
        }
        resetTransientState();
      }
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
    }
  }

  async function restoreSession(projectId: string, sessionId: string): Promise<void> {
    try {
      const detail = await workspaceApi.restoreSession(sessionId);
      if (!applySessionDetail(projectId, detail)) return;
      activeSessionIdRef.current = sessionId;
      setActiveProjectId(projectId);
      setActiveSessionId(sessionId);
      setActiveView('studio');
      setExpandedProjectIds((current) =>
        current.includes(projectId) ? current : [...current, projectId],
      );
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
    }
  }

  async function permanentlyDeleteSession(): Promise<void> {
    const session = sessionToDelete;
    if (session === null || sessionRunStatus(session.sessionId) === 'streaming') {
      return;
    }

    const storedSession = projects
      .find((project) => project.id === session.projectId)
      ?.sessions.find((candidate) => candidate.id === session.sessionId);
    if (storedSession?.archivedAt === null || storedSession === undefined) {
      return;
    }

    try {
      await workspaceApi.deleteSession(session.sessionId);
      releaseSessionRuntime(session.projectId, session.sessionId);
      setTaskTranscriptTarget((target) =>
        target?.sessionId === session.sessionId ? undefined : target,
      );
      sessionSkills.forget(session.sessionId);
      setProjects((current) =>
        current.map((project) =>
          project.id !== session.projectId
            ? project
            : {
                ...project,
                sessions: project.sessions.filter(
                  (candidate) => candidate.id !== session.sessionId,
                ),
              },
        ),
      );
      if (session.projectId === activeProjectId && session.sessionId === activeSessionId) {
        const nextSession = findNextRunnableSession(session.projectId, session.sessionId);
        if (nextSession !== undefined) {
          activeSessionIdRef.current = nextSession.id;
          setActiveSessionId(nextSession.id);
        } else {
          activeSessionIdRef.current = '';
          setActiveSessionId('');
        }
        resetTransientState();
      }
      setSessionToDelete(null);
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
    }
  }

  /** Creates an empty local session and focuses it in the session rail. */
  async function createSession(): Promise<void> {
    try {
      let project = projects.find((candidate) => candidate.id === activeProjectId);
      if (project === undefined) {
        const createdProject = await workspaceApi.createProject({
          name: 'Weave',
          folderName: 'weave',
        });
        project = {
          ...toStudioProject({ ...createdProject, sessions: [] }),
          sessions: [],
        };
      }
      await createSessionForProject(project.id, project);
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
    }
  }

  /** Switches the Studio to another local project and its most recent session. */
  function selectProject(projectId: string): void {
    if (projectId === activeProjectId) {
      setOpenMenu(null);
      return;
    }

    const project = projects.find((candidate) => candidate.id === projectId);
    const session = project?.sessions.find((candidate) => candidate.archivedAt === null);
    if (project === undefined || session === undefined) {
      return;
    }

    activateSession(project.id, session, false);
    setOpenMenu(null);
    setSearchQuery('');
    resetTransientState();
    void loadSessionDetail(project.id, session.id);
  }

  /**
   * Opens a project from the projects page. A project without sessions gets a
   * blank workbench; the first message there creates its session.
   */
  function openProject(projectId: string): void {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) {
      return;
    }
    if (projectId === activeProjectId) {
      setActiveView('studio');
      return;
    }
    if (project.sessions.some((candidate) => candidate.archivedAt === null)) {
      selectProject(projectId);
      return;
    }

    activeSessionIdRef.current = '';
    setActiveProjectId(projectId);
    setActiveSessionId('');
    setActiveView('studio');
    setExpandedProjectIds((current) =>
      current.includes(projectId) ? current : [...current, projectId],
    );
    resetTransientState();
  }

  return {
    activateSession,
    createSessionForProject,
    getActiveSessionContext,
    ensureSessionForMessage,
    selectProjectSession,
    toggleProjectExpanded,
    archiveSession,
    restoreSession,
    permanentlyDeleteSession,
    createSession,
    selectProject,
    openProject,
  };
}
