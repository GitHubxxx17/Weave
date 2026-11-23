import { realpath } from 'node:fs/promises';
import { projectSchema, type Project, type ProjectStore } from '@weave/workspace';
import {
  createWorkspacePolicy,
  workspaceRootIdentity,
  workspaceRootIdentitySync,
  type WorkspacePolicy,
} from '@weave/runtime';

declare const bindingBrand: unique symbol;
/** In-process host capability. It contains no serializable authority fields. */
export interface ProjectFolderBinding {
  readonly [bindingBrand]: true;
}
export interface ProjectFolderSnapshot {
  readonly projectId: string;
  readonly folderRevision: number;
  readonly folderPath?: string;
  readonly rootDigest?: string;
}
export interface ProjectFolderAuthority {
  capture(sessionId: string): Promise<ProjectFolderBinding>;
  snapshot(binding: ProjectFolderBinding): ProjectFolderSnapshot;
  signal(binding: ProjectFolderBinding): AbortSignal;
  checkpoint(binding: ProjectFolderBinding, sessionId: string): Promise<void>;
  resolve(binding: ProjectFolderBinding, sessionId: string): Promise<WorkspacePolicy | undefined>;
  assertCapturedFor(binding: ProjectFolderBinding, sessionId: string): void;
  assertCurrentSync(binding: ProjectFolderBinding): void;
  assertEffectCurrentSync(binding: ProjectFolderBinding): void;
  withAuthority<T>(
    binding: ProjectFolderBinding,
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  updateFolder(projectId: string, folderPath: string | undefined): Promise<Project>;
  release(binding: ProjectFolderBinding): void;
  closeSync(): void;
}
export type ProjectFolderAuthorityErrorCode =
  | 'task-project-authority-invalid'
  | 'task-project-authority-closed'
  | 'task-project-folder-changed'
  | 'task-project-root-changed'
  | 'task-project-relation-changed'
  | 'task-project-authority-unavailable';
export class ProjectFolderAuthorityError extends Error {
  constructor(readonly code: ProjectFolderAuthorityErrorCode) {
    super(code);
    this.name = 'ProjectFolderAuthorityError';
  }
}

interface BindingState {
  readonly binding: ProjectFolderBinding;
  readonly capturedSessionId: string;
  readonly snapshot: ProjectFolderSnapshot;
  readonly workspace: WorkspacePolicy | undefined;
  readonly controller: AbortController;
  released: boolean;
  failure?: ProjectFolderAuthorityError;
}

/**
 * Owns the short Project admission gate. Operations passed to withAuthority
 * may enter the Execution gate, but must never await tools, approval or cleanup.
 */
export function createProjectFolderAuthority(
  store: ProjectStore,
  options: { readonly onRevoked?: (binding: ProjectFolderBinding) => void } = {},
): ProjectFolderAuthority {
  const states = new WeakMap<ProjectFolderBinding, BindingState>();
  const active = new Set<BindingState>();
  const notifications: ProjectFolderBinding[] = [];
  let tail = Promise.resolve();
  let entered = false;
  let closed = false;
  const failure = (code: ProjectFolderAuthorityErrorCode) => new ProjectFolderAuthorityError(code);
  const requireOpen = (): void => {
    if (closed) throw failure('task-project-authority-closed');
  };
  const stateOf = (binding: ProjectFolderBinding): BindingState => {
    const state = states.get(binding);
    if (state === undefined) throw failure('task-project-authority-invalid');
    return state;
  };
  const assertCurrentSync = (binding: ProjectFolderBinding): void => {
    const state = stateOf(binding);
    if (state.failure !== undefined) throw state.failure;
    requireOpen();
    if (state.released) throw failure('task-project-authority-invalid');
  };
  const notify = (): void => {
    if (entered) return;
    const errors: unknown[] = [];
    for (const binding of notifications.splice(0)) {
      try {
        options.onRevoked?.(binding);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'Project authority revocation notification failed');
  };
  const revokeMany = (
    candidates: readonly BindingState[],
    code: ProjectFolderAuthorityErrorCode,
  ): void => {
    const targets = candidates.filter((state) => !state.released && state.failure === undefined);
    // Abort listeners are synchronous and may inspect another binding in the batch.
    for (const state of targets) {
      state.failure = failure(code);
      notifications.push(state.binding);
    }
    for (const state of targets) state.controller.abort(state.failure);
  };
  function assertEffectCurrentSync(binding: ProjectFolderBinding): void {
    assertCurrentSync(binding);
    const state = stateOf(binding);
    if (state.snapshot.folderPath === undefined) return;
    let identity: string | undefined;
    try {
      identity = workspaceRootIdentitySync(state.snapshot.folderPath);
    } catch {
      // Missing and unreadable roots lose the permit.
    }
    if (identity === state.snapshot.rootDigest) return;
    revokeMany([state], 'task-project-root-changed');
    // Dispatch host cancellation after returning to the caller. The binding
    // and signal are already fenced even if a notification callback fails.
    void Promise.resolve()
      .then(notify)
      .catch(() => undefined);
    throw state.failure!;
  }
  const gate = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    entered = true;
    try {
      return await operation();
    } finally {
      entered = false;
      release();
      notify();
    }
  };
  const projectsForSession = async (sessionId: string): Promise<Project[]> => {
    if (typeof sessionId !== 'string' || sessionId.length === 0)
      throw failure('task-project-relation-changed');
    const projects = (await store.listProjects()).map((project) => projectSchema.parse(project));
    const matching = await Promise.all(
      projects.map(async (project) => {
        const refs = await store.listSessionRefs(project.id);
        return refs.some((ref) => ref.projectId === project.id && ref.sessionId === sessionId)
          ? project
          : undefined;
      }),
    );
    return matching.filter((project): project is Project => project !== undefined);
  };
  const validate = async (state: BindingState, sessionId: string): Promise<void> => {
    assertCurrentSync(state.binding);
    try {
      const projects = await projectsForSession(sessionId);
      if (projects.length !== 1 || projects[0]!.id !== state.snapshot.projectId)
        throw failure('task-project-relation-changed');
      const project = projects[0]!;
      if (
        project.folderRevision !== state.snapshot.folderRevision ||
        project.folderPath !== state.snapshot.folderPath
      )
        throw failure('task-project-folder-changed');
      if (project.folderPath !== undefined) {
        let identity: string;
        try {
          identity = await workspaceRootIdentity(project.folderPath);
        } catch {
          throw failure('task-project-root-changed');
        }
        if (identity !== state.snapshot.rootDigest) throw failure('task-project-root-changed');
      }
      assertCurrentSync(state.binding);
    } catch (error) {
      const code =
        error instanceof ProjectFolderAuthorityError
          ? error.code
          : 'task-project-authority-unavailable';
      revokeMany([state], code);
      throw state.failure ?? failure(code);
    }
  };
  return {
    capture: (sessionId) =>
      gate(async () => {
        requireOpen();
        const projects = await projectsForSession(sessionId);
        if (projects.length !== 1) throw failure('task-project-relation-changed');
        const project = projects[0]!;
        const canonical =
          project.folderPath === undefined ? undefined : await realpath(project.folderPath);
        const rootDigest =
          canonical === undefined ? undefined : await workspaceRootIdentity(canonical);
        requireOpen();
        const snapshot: ProjectFolderSnapshot = Object.freeze({
          projectId: project.id,
          folderRevision: project.folderRevision,
          ...(project.folderPath === undefined ? {} : { folderPath: project.folderPath }),
          ...(rootDigest === undefined ? {} : { rootDigest }),
        });
        const binding = Object.freeze({}) as ProjectFolderBinding;
        const state: BindingState = {
          binding,
          capturedSessionId: sessionId,
          snapshot,
          workspace:
            canonical === undefined ? undefined : createWorkspacePolicy({ root: canonical }),
          controller: new AbortController(),
          released: false,
        };
        states.set(binding, state);
        active.add(state);
        return binding;
      }),
    snapshot: (binding) => stateOf(binding).snapshot,
    signal: (binding) => stateOf(binding).controller.signal,
    checkpoint: (binding, sessionId) => gate(() => validate(stateOf(binding), sessionId)),
    resolve: (binding, sessionId) =>
      gate(async () => {
        const state = stateOf(binding);
        await validate(state, sessionId);
        return state.workspace;
      }),
    assertCapturedFor(binding, sessionId) {
      assertCurrentSync(binding);
      if (stateOf(binding).capturedSessionId !== sessionId)
        throw failure('task-project-authority-invalid');
    },
    assertCurrentSync,
    assertEffectCurrentSync,
    withAuthority: (binding, sessionId, operation) =>
      gate(async () => {
        await validate(stateOf(binding), sessionId);
        return operation();
      }),
    updateFolder: (projectId, folderPath) =>
      gate(async () => {
        requireOpen();
        revokeMany(
          [...active].filter((state) => state.snapshot.projectId === projectId),
          'task-project-folder-changed',
        );
        requireOpen();
        return store.updateProjectFolder(projectId, folderPath);
      }),
    release(binding) {
      const state = stateOf(binding);
      if (state.released) return;
      state.released = true;
      active.delete(state);
      state.controller.abort(failure('task-project-authority-invalid'));
    },
    closeSync() {
      if (closed) return;
      closed = true;
      revokeMany([...active], 'task-project-authority-closed');
      notify();
    },
  };
}
