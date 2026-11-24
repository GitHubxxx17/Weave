import {
  MemoryError,
  RetrievalError,
  describeRetrievalCaller,
  isRetrievalError,
  retrievalCallerAuthority,
  type RetrievalCaller,
  type RetrievalProjectEvidence,
  type RetrievalProjectResolver,
} from '@weave/runtime';
import type { AgentTaskWorkspaceBindings } from './agent-task-workspace.js';
import type { createMemoryScopeResolver } from './memory-scope.js';
import {
  ProjectFolderAuthorityError,
  type ProjectFolderAuthority,
  type ProjectFolderBinding,
} from './project-folder-authority.js';

export interface RetrievalProjectResolverOptions {
  readonly projectFolders: ProjectFolderAuthority;
  readonly scopes: Pick<
    ReturnType<typeof createMemoryScopeResolver>,
    'captureAgentProjectMembership'
  >;
  readonly agentTaskWorkspace: Pick<AgentTaskWorkspaceBindings, 'pinnedChildBinding'>;
}

function safeError(error: unknown): RetrievalError {
  if (isRetrievalError(error)) return error;
  if (error instanceof ProjectFolderAuthorityError) {
    switch (error.code) {
      case 'task-project-folder-changed':
      case 'task-project-root-changed':
        return new RetrievalError('retrieval-root-changed');
      case 'task-project-authority-unavailable':
        return new RetrievalError('retrieval-unavailable');
      case 'task-project-authority-closed':
        return new RetrievalError('retrieval-cancelled');
    }
  }
  return new RetrievalError('retrieval-scope-forbidden');
}

export function createRetrievalProjectResolver(
  options: RetrievalProjectResolverOptions,
): RetrievalProjectResolver {
  const { projectFolders, scopes, agentTaskWorkspace } = options;
  const owned = new WeakMap<RetrievalProjectEvidence, 'project' | 'child'>();

  function bind(
    binding: ProjectFolderBinding,
    requestSignal?: AbortSignal,
    agent?: { readonly assertCurrent: () => void; readonly childSessionId?: string },
  ): RetrievalProjectEvidence {
    const childSessionId = agent?.childSessionId;
    const snapshot = projectFolders.snapshot(binding);
    if (snapshot.rootDigest === undefined) throw new RetrievalError('retrieval-unavailable');
    const workspaceRoot = projectFolders.projectRoot(binding);
    const controller = new AbortController();
    const folderSignal = projectFolders.signal(binding);
    const signal = AbortSignal.any([
      controller.signal,
      folderSignal,
      ...(requestSignal === undefined ? [] : [requestSignal]),
    ]);
    const checkpoint = () =>
      childSessionId === undefined
        ? projectFolders.checkpointProject(binding)
        : projectFolders.checkpoint(binding, childSessionId);
    function assertCurrentSync(): void {
      try {
        projectFolders.assertEffectCurrentSync(binding);
        if (signal.aborted) throw new RetrievalError('retrieval-cancelled');
        agent?.assertCurrent();
      } catch (error) {
        throw safeError(error);
      }
    }
    const evidence: RetrievalProjectEvidence = Object.freeze({
      project: Object.freeze({
        projectId: snapshot.projectId,
        folderRevision: snapshot.folderRevision,
        rootDigest: snapshot.rootDigest,
      }),
      signal,
      workspaceRoot,
      assertCurrentSync,
      async checkpoint() {
        try {
          assertCurrentSync();
          await checkpoint();
          assertCurrentSync();
        } catch (error) {
          throw safeError(error);
        }
      },
      async withAdmission<T>(operation: () => T): Promise<T> {
        const perform = () => {
          assertCurrentSync();
          const result = operation();
          if (
            ((typeof result === 'object' && result !== null) || typeof result === 'function') &&
            'then' in result &&
            typeof result.then === 'function'
          )
            throw new RetrievalError('retrieval-invalid-input');
          return result;
        };
        try {
          return await (childSessionId === undefined
            ? projectFolders.withProjectAuthority(binding, perform)
            : projectFolders.withAuthority(binding, childSessionId, async () => perform()));
        } catch (error) {
          if (error instanceof ProjectFolderAuthorityError) throw safeError(error);
          throw error;
        }
      },
      release() {
        if (!owned.delete(evidence)) return;
        controller.abort(new RetrievalError('retrieval-cancelled'));
        if (childSessionId === undefined) projectFolders.release(binding);
      },
    });
    assertCurrentSync();
    owned.set(evidence, childSessionId === undefined ? 'project' : 'child');
    return evidence;
  }

  async function acquire(
    projectId: string,
    signal?: AbortSignal,
    agent?: { readonly assertCurrent: () => void },
  ): Promise<RetrievalProjectEvidence> {
    let binding: ProjectFolderBinding | undefined;
    try {
      if (signal?.aborted) throw new RetrievalError('retrieval-cancelled');
      binding = await projectFolders.captureProject(projectId);
      return bind(binding, signal, agent);
    } catch (error) {
      if (binding !== undefined) projectFolders.release(binding);
      throw safeError(error);
    }
  }

  async function resolveAgent(caller: RetrievalCaller, signal: AbortSignal) {
    try {
      const invocation = describeRetrievalCaller(caller);
      const token = retrievalCallerAuthority(caller);
      const requireToken = () => retrievalCallerAuthority(caller);
      const scope = await scopes.captureAgentProjectMembership(invocation, requireToken);
      if (scope.membership.kind === 'ambiguous')
        throw new RetrievalError('retrieval-project-ambiguous');
      if (scope.membership.kind !== 'unique') throw new RetrievalError('retrieval-scope-forbidden');
      const { sessionId } = invocation.identity;
      const binding = agentTaskWorkspace.pinnedChildBinding(sessionId, token);
      const assertCurrent = () => {
        scope.assertCurrentSync();
        if (agentTaskWorkspace.pinnedChildBinding(sessionId, requireToken()) !== binding)
          throw new RetrievalError('retrieval-scope-forbidden');
      };
      if (binding === undefined)
        return await acquire(scope.membership.projectId, signal, { assertCurrent });
      if (projectFolders.snapshot(binding).projectId !== scope.membership.projectId)
        throw new RetrievalError('retrieval-scope-forbidden');
      return bind(binding, signal, { assertCurrent, childSessionId: sessionId });
    } catch (error) {
      if (error instanceof MemoryError && error.code === 'memory-project-ambiguous')
        throw new RetrievalError('retrieval-project-ambiguous');
      throw safeError(error);
    }
  }

  return {
    resolveLocal: acquire,
    resolveAgent,
    async retainForJob(evidence) {
      if (owned.get(evidence) !== 'project') throw new RetrievalError('retrieval-scope-forbidden');
      evidence.assertCurrentSync();
      const retained = await acquire(evidence.project.projectId);
      try {
        evidence.assertCurrentSync();
        if (
          retained.project.folderRevision !== evidence.project.folderRevision ||
          retained.project.rootDigest !== evidence.project.rootDigest ||
          retained.workspaceRoot !== evidence.workspaceRoot
        )
          throw new RetrievalError('retrieval-root-changed');
        return retained;
      } catch (error) {
        retained.release();
        throw error;
      }
    },
  };
}
