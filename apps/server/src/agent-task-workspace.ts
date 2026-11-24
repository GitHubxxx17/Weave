import {
  agentToolAuthorityParent,
  createWorkspacePolicy,
  deriveAgentToolAuthority,
  readAgentToolAuthority,
  type AgentToolAuthority,
  type AgentToolAuthorityLifetime,
  type DeriveAgentToolAuthorityOptions,
  type ToolExecutionContext,
  type WorkspacePolicy,
  type WorkspaceResolver,
} from '@weave/runtime';
import {
  ProjectFolderAuthorityError,
  type ProjectFolderAuthority,
  type ProjectFolderBinding,
} from './project-folder-authority.js';

interface ChildWorkspace extends Pick<AgentToolAuthorityLifetime, 'identity' | 'isLive'> {
  readonly binding: ProjectFolderBinding;
}

type DeriveOptions = Omit<DeriveAgentToolAuthorityOptions, 'checkpoint'> & {
  readonly binding: ProjectFolderBinding;
};

export interface AgentTaskWorkspaceBindings {
  derive(context: ToolExecutionContext, options: DeriveOptions): AgentToolAuthority;
  resolveWorkspace: WorkspaceResolver;
  resolveRoot(sessionId: string, toolAuthority?: AgentToolAuthority): Promise<string | undefined>;
  pinnedChildBinding(
    sessionId: string,
    toolAuthority: AgentToolAuthority,
  ): ProjectFolderBinding | undefined;
  assertRunCurrent(
    sessionId: string | undefined,
    toolAuthority: AgentToolAuthority | undefined,
  ): void;
  assertMutationCurrent(context: ToolExecutionContext): void;
}

/** One host-private registry shared by the Server's current and retained Generations. */
export function createAgentTaskWorkspaceBindings(
  projectFolders: ProjectFolderAuthority,
  resolveWorkspaceRoot?: (sessionId: string) => Promise<string | undefined>,
): AgentTaskWorkspaceBindings {
  const children = new WeakMap<AgentToolAuthority, ChildWorkspace>();
  function assertCurrent(child: ChildWorkspace, sessionId: string | undefined): void {
    if (sessionId !== child.identity.sessionId || child.isLive?.() === false)
      throw new ProjectFolderAuthorityError('task-project-authority-invalid');
    projectFolders.assertCurrentSync(child.binding);
  }
  function childFor(token: AgentToolAuthority | undefined): ChildWorkspace | undefined {
    if (token === undefined) return undefined;
    const parent = agentToolAuthorityParent(token);
    const child = children.get(token);
    if (child === undefined && parent !== undefined)
      throw new ProjectFolderAuthorityError('task-project-authority-invalid');
    return child;
  }
  async function resolve(
    sessionId: string | undefined,
    toolAuthority: AgentToolAuthority | undefined,
  ): Promise<WorkspacePolicy | undefined> {
    const child = childFor(toolAuthority);
    if (child !== undefined) {
      assertCurrent(child, sessionId);
      const policy = await projectFolders.resolve(child.binding, child.identity.sessionId);
      assertCurrent(childFor(toolAuthority)!, sessionId);
      return policy;
    }
    const root = sessionId === undefined ? undefined : await resolveWorkspaceRoot?.(sessionId);
    return root === undefined ? undefined : createWorkspacePolicy({ root });
  }
  function assertRunCurrent(
    sessionId: string | undefined,
    toolAuthority: AgentToolAuthority | undefined,
  ): void {
    const child = childFor(toolAuthority);
    if (child === undefined) return;
    assertCurrent(child, sessionId);
    projectFolders.assertEffectCurrentSync(child.binding);
  }
  return {
    derive(context, { binding, identity, access, isLive }) {
      const parent = readAgentToolAuthority(context);
      projectFolders.assertCapturedFor(binding, parent.identity.sessionId);
      const child = { binding, identity: Object.freeze({ ...identity }), isLive };
      const token = deriveAgentToolAuthority(context, {
        identity: child.identity,
        access,
        isLive,
        async checkpoint(toolContext) {
          assertCurrent(child, toolContext.sessionId);
          await projectFolders.checkpoint(binding, child.identity.sessionId);
          assertCurrent(child, toolContext.sessionId);
        },
      });
      children.set(token, child);
      return token;
    },
    resolveWorkspace: ({ sessionId, toolAuthority }) => resolve(sessionId, toolAuthority),
    resolveRoot: async (sessionId, toolAuthority) =>
      (await resolve(sessionId, toolAuthority))?.root,
    pinnedChildBinding(sessionId, toolAuthority) {
      const child = childFor(toolAuthority);
      if (child === undefined) return undefined;
      assertCurrent(child, sessionId);
      projectFolders.assertEffectCurrentSync(child.binding);
      return child.binding;
    },
    assertRunCurrent,
    assertMutationCurrent(context) {
      assertRunCurrent(context.sessionId, context.toolAuthority);
    },
  };
}
