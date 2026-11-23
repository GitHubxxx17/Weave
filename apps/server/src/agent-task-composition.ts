import type { AgentTaskAccepted, SessionEventStore } from '@weave/session';
import { agentTaskFactDigest, projectSession } from '@weave/session';
import type { ProjectStore } from '@weave/workspace';
import {
  adaptTaskRunnerLease,
  agentTaskOrigin,
  describeAgentToolAuthority,
  AgentTaskHostError,
  type AgentTaskHost,
  type AgentTaskReservation,
  type TaskProjectRelation,
} from '@weave/runtime';
import { retainAgentToolGeneration } from './runtime.js';
import { ManagedGenerationOwnershipError } from './extension-authority-errors.js';
import {
  ProjectFolderAuthorityError,
  type ProjectFolderAuthority,
  type ProjectFolderBinding,
} from './project-folder-authority.js';
import type { AgentTaskWorkspaceBindings } from './agent-task-workspace.js';

export interface AgentTaskHostOptions {
  readonly sessionStore: SessionEventStore;
  readonly projectStore: ProjectStore;
  readonly projectFolders: ProjectFolderAuthority;
  readonly workspace: AgentTaskWorkspaceBindings;
}

/** Adapts host capabilities; task behavior and cross-log reconciliation stay in Runtime. */
export function createAgentTaskHost(options: AgentTaskHostOptions): AgentTaskHost {
  const { sessionStore, projectStore, projectFolders, workspace } = options;
  async function memberships(sessionId: string): Promise<readonly string[]> {
    const projects = await projectStore.listProjects();
    const related = await Promise.all(
      projects.map(async ({ id }) =>
        (await projectStore.listSessionRefs(id)).some(
          (ref) => ref.sessionId === sessionId && ref.projectId === id,
        )
          ? id
          : undefined,
      ),
    );
    return related.filter((id): id is string => id !== undefined);
  }
  async function projectRelation(accepted: AgentTaskAccepted): Promise<TaskProjectRelation> {
    const [parents, children] = await Promise.all([
      memberships(accepted.parentSessionId),
      memberships(accepted.childSessionId),
    ]);
    if (parents.length !== 1 || parents[0] !== accepted.project.projectId) return 'conflict';
    if (children.length === 0) {
      const events = await sessionStore.read(accepted.childSessionId);
      if (events.length === 0) return 'unattached';
      const projection = projectSession(events);
      return projection.agentTasks?.origin?.taskId === accepted.taskId && events.length === 2
        ? 'unattached'
        : 'conflict';
    }
    if (children.length !== 1 || children[0] !== accepted.project.projectId) return 'conflict';
    const projection = projectSession(await sessionStore.read(accepted.childSessionId));
    return projection.deletedAt !== undefined ? 'tombstoned' : 'attached';
  }
  return {
    projectRelation,
    async reserve({ context, child, access, lifetime }) {
      const retained = retainAgentToolGeneration(context);
      let binding: ProjectFolderBinding | undefined;
      let released = false;
      let closed = false;
      const onFolderAbort = () => {
        if (!released) lifetime.requestStop('workspace-changed');
      };
      const onGenerationRevoked = () => {
        if (!released)
          lifetime.requestStop(
            retained.revocationSignal.reason instanceof ManagedGenerationOwnershipError
              ? 'ownership-lost'
              : 'generation-revoked',
          );
      };
      const onTaskAbort = () => retained.abort(lifetime.getStopReason() ?? 'task-cancelled');
      try {
        retained.revocationSignal.addEventListener('abort', onGenerationRevoked, { once: true });
        if (retained.revocationSignal.aborted) onGenerationRevoked();
        binding = await projectFolders.capture(context.sessionId!);
        const captured = binding;
        const assertCanStartSync = () => {
          if (
            released ||
            closed ||
            lifetime.getStopReason() !== undefined ||
            lifetime.signal.aborted
          )
            throw new AgentTaskHostError(lifetime.getStopReason() ?? 'generation-unavailable');
          try {
            projectFolders.assertEffectCurrentSync(captured);
          } catch (cause) {
            lifetime.requestStop('workspace-changed');
            throw new AgentTaskHostError('workspace-changed', { cause });
          }
          try {
            retained.assertCanStartSync();
          } catch (cause) {
            throw new AgentTaskHostError('generation-unavailable', { cause });
          }
          if (lifetime.getStopReason() !== undefined)
            throw new AgentTaskHostError(lifetime.getStopReason()!);
        };
        assertCanStartSync();
        const token = workspace.derive(context, {
          binding: captured,
          identity: child,
          access,
          isLive: () =>
            !released &&
            !closed &&
            !lifetime.signal.aborted &&
            lifetime.getStopReason() === undefined,
        });
        projectFolders.signal(captured).addEventListener('abort', onFolderAbort, { once: true });
        lifetime.signal.addEventListener('abort', onTaskAbort, { once: true });
        assertCanStartSync();
        const reservation: AgentTaskReservation = {
          project: projectFolders.snapshot(captured),
          tools: describeAgentToolAuthority(token).tools,
          assertCanStartSync,
          async checkpoint() {
            assertCanStartSync();
            try {
              // The parent relation is authoritative even before the child is attached.
              await projectFolders.checkpoint(captured, context.sessionId!);
            } catch (cause) {
              if (cause instanceof ProjectFolderAuthorityError) {
                lifetime.requestStop('workspace-changed');
                throw new AgentTaskHostError('workspace-changed', { cause });
              }
              throw cause;
            }
            assertCanStartSync();
          },
          async createExact(accepted, sequence) {
            const events = await sessionStore.read(child.sessionId);
            const origin = agentTaskOrigin(accepted, sequence);
            if (events.length > 0) {
              projectSession(events);
              if (
                events[0]?.type !== 'session.created' ||
                events[0].payload.title !== accepted.title ||
                events[1]?.type !== 'agent.task.origin' ||
                agentTaskFactDigest(events[1].payload) !== agentTaskFactDigest(origin)
              )
                throw new AgentTaskHostError('preparation-failed');
              return;
            }
            assertCanStartSync();
            await sessionStore.append(child.sessionId, [
              { type: 'session.created', payload: { title: accepted.title } },
              { type: 'agent.task.origin', payload: origin },
            ]);
          },
          async attachExact(accepted) {
            const relation = await projectRelation(accepted);
            if (relation === 'attached') return;
            if (relation !== 'unattached') throw new AgentTaskHostError('preparation-failed');
            assertCanStartSync();
            await projectStore.attachSession(accepted.project.projectId, child.sessionId);
          },
          withLaunchAuthority: (operation) =>
            projectFolders.withAuthority(captured, child.sessionId, async () => {
              assertCanStartSync();
              return operation();
            }),
          bindRunner(authority) {
            return adaptTaskRunnerLease(authority, {
              assertCanStartSync,
              closeStarts: (reason) => reservation.closeStarts(reason),
              runner: {
                run(request) {
                  assertCanStartSync();
                  return retained.run({
                    ...request,
                    toolAuthority: token,
                    signal: AbortSignal.any(
                      request.signal === undefined
                        ? [lifetime.signal]
                        : [lifetime.signal, request.signal],
                    ),
                  });
                },
              },
            });
          },
          closeStarts(reason) {
            if (closed) return;
            closed = true;
            retained.closeStarts(reason);
          },
          release() {
            if (released) return;
            released = true;
            projectFolders.signal(captured).removeEventListener('abort', onFolderAbort);
            lifetime.signal.removeEventListener('abort', onTaskAbort);
            retained.revocationSignal.removeEventListener('abort', onGenerationRevoked);
            projectFolders.release(captured);
            retained.release();
          },
        };
        return reservation;
      } catch (cause) {
        released = true;
        if (binding !== undefined) {
          projectFolders.signal(binding).removeEventListener('abort', onFolderAbort);
          projectFolders.release(binding);
        }
        lifetime.signal.removeEventListener('abort', onTaskAbort);
        retained.revocationSignal.removeEventListener('abort', onGenerationRevoked);
        retained.release();
        throw cause;
      }
    },
  };
}
