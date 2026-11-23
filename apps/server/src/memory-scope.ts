import type { MemoryScope } from '@weave/protocol';
import {
  MemoryError,
  agentTaskOrigin,
  agentToolAuthorityParent,
  describeAgentToolAuthority,
  memoryCallerAuthority,
  type AgentToolInvocationAuthority,
  type MemoryLocalScopeEvidence,
  type MemoryScopeEvidence,
} from '@weave/runtime';
import { agentTaskFactDigest, projectSession, type SessionEventStore } from '@weave/session';
import type { ProjectStore } from '@weave/workspace';

export type WithMemoryMembershipMutation = <T>(
  sessionId: string,
  operation: () => Promise<T>,
) => Promise<T>;

export interface MemoryScopeResolverOptions {
  readonly sessionStore: SessionEventStore;
  readonly projectStore: ProjectStore;
}

interface MembershipMarker {
  readonly generation: object;
  readonly inFlight: number;
}

function forbidden(cause?: unknown): MemoryError {
  void cause;
  return new MemoryError('memory-scope-forbidden');
}

/** Shared only by the Server's formal Session creation, attachment and deletion paths. */
export function createMemoryScopeResolver(options: MemoryScopeResolverOptions) {
  const markers = new Map<string, MembershipMarker>();
  const markerFor = (sessionId: string): MembershipMarker => {
    let marker = markers.get(sessionId);
    if (marker === undefined) {
      marker = { generation: Object.freeze({}), inFlight: 0 };
      markers.set(sessionId, marker);
    }
    return marker;
  };
  const withMemoryMembershipMutation: WithMemoryMembershipMutation = async (
    sessionId,
    operation,
  ) => {
    const previous = markerFor(sessionId);
    markers.set(sessionId, { generation: Object.freeze({}), inFlight: previous.inFlight + 1 });
    try {
      return await operation();
    } finally {
      const current = markerFor(sessionId);
      markers.set(sessionId, { generation: Object.freeze({}), inFlight: current.inFlight - 1 });
    }
  };

  async function captureMemorySessionScope(sessionId: string): Promise<MemoryScopeEvidence> {
    const captured = markerFor(sessionId);
    const assertCurrentSync = () => {
      const current = markerFor(sessionId);
      if (
        captured.inFlight !== 0 ||
        current.inFlight !== 0 ||
        current.generation !== captured.generation
      )
        throw forbidden();
    };
    assertCurrentSync();
    try {
      const [events, projects] = await Promise.all([
        options.sessionStore.read(sessionId),
        options.projectStore.listProjects(),
      ]);
      if (events.length === 0 || projectSession(events).deletedAt !== undefined) throw forbidden();
      const related = await Promise.all(
        projects.map(async ({ id }) =>
          (await options.projectStore.listSessionRefs(id)).some(
            (ref) => ref.sessionId === sessionId && ref.projectId === id,
          )
            ? id
            : undefined,
        ),
      );
      assertCurrentSync();
      const ids = [...new Set(related.filter((id): id is string => id !== undefined))];
      const membership: MemoryScopeEvidence['membership'] =
        ids.length === 0
          ? { kind: 'none' }
          : ids.length === 1
            ? { kind: 'unique', projectId: ids[0]! }
            : { kind: 'ambiguous' };
      return Object.freeze({ membership: Object.freeze(membership), assertCurrentSync });
    } catch (cause) {
      if (cause instanceof MemoryError) throw cause;
      throw forbidden(cause);
    }
  }

  async function resolveLocalScope(scope: MemoryScope): Promise<MemoryLocalScopeEvidence> {
    if (
      scope.kind === 'project' &&
      (await options.projectStore.getProject(scope.projectId)) === undefined
    )
      throw new MemoryError('memory-not-found');
    // Project removal is not an existing Store operation. Folder/name edits preserve the UUID.
    return Object.freeze({ assertCurrentSync() {} });
  }

  async function resolveAgentScope(
    caller: AgentToolInvocationAuthority,
  ): Promise<MemoryScopeEvidence> {
    try {
      const token = memoryCallerAuthority(caller);
      const identity = describeAgentToolAuthority(token).identity;
      const parentSessionId = agentToolAuthorityParent(token);
      if (identity !== caller.identity) throw forbidden();
      const evidence = await captureMemorySessionScope(identity.sessionId);
      const events = await options.sessionStore.read(identity.sessionId);
      const projection = projectSession(events);
      const acceptedExecution = events.find(
        (event) =>
          event.type === 'execution.accepted' &&
          event.payload.executionId === identity.executionId &&
          event.payload.turnId === identity.turnId &&
          event.payload.userMessageId === identity.userMessageId,
      );
      const started = events.find(
        (event) =>
          event.type === 'turn.started' &&
          event.payload.turnId === identity.turnId &&
          event.payload.executionId === identity.executionId &&
          event.payload.userMessageId === identity.userMessageId,
      );
      const turn = projection.turns.find((item) => item.turnId === identity.turnId);
      if (
        acceptedExecution === undefined ||
        started === undefined ||
        turn?.status !== 'running' ||
        !projection.messages.some(
          (item) => item.messageId === identity.userMessageId && item.message.role === 'user',
        ) ||
        !turn.toolCalls.some(
          (call) =>
            call.toolCall.id === caller.toolCallId && call.toolCall.name === caller.toolName,
        )
      )
        throw forbidden();
      const origin = projection.agentTasks?.origin;
      let parentEvidence: MemoryScopeEvidence | undefined;
      if (parentSessionId === undefined) {
        if (origin !== undefined) throw forbidden();
      } else {
        if (
          origin === undefined ||
          origin.parentSessionId !== parentSessionId ||
          origin.childSessionId !== identity.sessionId ||
          origin.childExecutionId !== identity.executionId ||
          origin.childTurnId !== identity.turnId ||
          origin.childUserMessageId !== identity.userMessageId
        )
          throw forbidden();
        parentEvidence = await captureMemorySessionScope(parentSessionId);
        const parentEvents = await options.sessionStore.read(parentSessionId);
        projectSession(parentEvents);
        const accepted = parentEvents.find(
          (event) => event.sequence === origin.parentAcceptedSequence,
        );
        const originPayload =
          events[1]?.type === 'agent.task.origin' ? events[1].payload : undefined;
        if (
          accepted?.type !== 'agent.task.accepted' ||
          agentTaskFactDigest(accepted.payload) !== origin.parentAcceptedDigest ||
          agentTaskFactDigest(agentTaskOrigin(accepted.payload, accepted.sequence)) !==
            agentTaskFactDigest(originPayload)
        )
          throw forbidden();
        if (evidence.membership.kind === 'ambiguous')
          throw new MemoryError('memory-project-ambiguous');
        if (
          evidence.membership.kind !== 'unique' ||
          evidence.membership.projectId !== accepted.payload.project.projectId ||
          parentEvidence.membership.kind !== 'unique' ||
          parentEvidence.membership.projectId !== accepted.payload.project.projectId
        )
          throw forbidden();
      }
      const assertCurrentSync = () => {
        if (memoryCallerAuthority(caller) !== token) throw forbidden();
        evidence.assertCurrentSync();
        parentEvidence?.assertCurrentSync();
      };
      assertCurrentSync();
      return Object.freeze({ membership: evidence.membership, assertCurrentSync });
    } catch (cause) {
      if (cause instanceof MemoryError) throw cause;
      throw forbidden();
    }
  }
  return {
    captureMemorySessionScope,
    withMemoryMembershipMutation,
    resolveLocalScope,
    resolveAgentScope,
  };
}
