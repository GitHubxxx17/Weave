import { randomUUID } from 'node:crypto';
import type { Message } from '@weave/protocol';
import {
  projectSession,
  SessionProjectionError,
  type SessionEventStore,
  type SessionProjection,
  type SessionMessage as ProjectedSessionMessage,
} from '@weave/session';
import {
  type Project,
  type ProjectSessionRef,
  type ProjectStore,
  WorkspaceStoreError,
} from '@weave/workspace';

/** Stable errors raised by the Server Session Service. */
export type SessionServiceErrorCode =
  'session-not-found' | 'session-archived' | 'session-deleted' | 'session-projection-invalid';

/** Error raised when a Session lifecycle operation cannot be completed. */
export class SessionServiceError extends Error {
  readonly code: SessionServiceErrorCode;

  constructor(code: SessionServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionServiceError';
    this.code = code;
  }
}

/** A compact Session representation used by Project and Session list APIs. */
export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly archivedAt: string | undefined;
  readonly deletedAt: string | undefined;
  readonly lastSequence: number;
  readonly lastMessage: Message | undefined;
}

/** A Session summary with its complete projected messages. */
export interface SessionDetail extends SessionSummary {
  readonly messages: readonly SessionMessage[];
}

/** A durable message with the metadata needed by Studio timelines. */
export type SessionMessage = ProjectedSessionMessage['message'] & {
  readonly messageId: string;
  readonly sequence: number;
  readonly occurredAt: string;
};

/** A recoverable warning for one damaged Session in a Project list. */
export interface ProjectListWarning {
  readonly code: 'session-projection-invalid';
  readonly sessionId: string;
}

/** Result of listing a Project's valid Session summaries. */
export interface SessionListResult {
  readonly sessions: readonly SessionSummary[];
  readonly warnings: readonly ProjectListWarning[];
}

/** Dependencies used by the Server Session Service. */
export interface SessionServiceOptions {
  readonly projectStore: ProjectStore;
  readonly sessionStore: SessionEventStore;
}

const defaultSessionTitle = '未命名会话';

function sessionNotFound(sessionId: string): SessionServiceError {
  return new SessionServiceError('session-not-found', `Session ${sessionId} does not exist`);
}

function projectionInvalid(sessionId: string, cause?: unknown): SessionServiceError {
  return new SessionServiceError(
    'session-projection-invalid',
    `Session ${sessionId} cannot be projected`,
    cause === undefined ? undefined : { cause },
  );
}

function titleFor(projection: SessionProjection): string {
  return projection.title ?? defaultSessionTitle;
}

function lastMessageFor(projection: SessionProjection): Message | undefined {
  return projection.messages.at(-1)?.message;
}

function summaryFor(sessionId: string, projection: SessionProjection): SessionSummary {
  return {
    id: sessionId,
    title: titleFor(projection),
    archivedAt: projection.archivedAt,
    deletedAt: projection.deletedAt,
    lastSequence: projection.lastSequence,
    lastMessage: lastMessageFor(projection),
  };
}

function detailFor(sessionId: string, projection: SessionProjection): SessionDetail {
  return {
    ...summaryFor(sessionId, projection),
    messages: projection.messages.map((item) => ({
      ...item.message,
      messageId: item.messageId,
      sequence: item.sequence,
      occurredAt: item.occurredAt,
    })),
  };
}

function rethrowProjectionError(sessionId: string, error: unknown): never {
  if (error instanceof SessionProjectionError) {
    throw projectionInvalid(sessionId, error);
  }
  throw error;
}

function assertProjectExists(project: Project | undefined, projectId: string): Project {
  if (project === undefined) {
    throw new WorkspaceStoreError(
      'workspace-project-not-found',
      `Project ${projectId} does not exist`,
    );
  }
  return project;
}

/**
 * Creates the Server-owned Session lifecycle service.
 *
 * The service reads and projects durable events before appending lifecycle
 * transitions, keeping HTTP handlers free of Session state-machine logic.
 */
export function createSessionService(options: SessionServiceOptions): SessionService {
  const { projectStore, sessionStore } = options;

  async function readProjection(sessionId: string): Promise<SessionProjection> {
    const events = await sessionStore.read(sessionId);
    if (events.length === 0) {
      throw sessionNotFound(sessionId);
    }

    try {
      return projectSession(events);
    } catch (error) {
      return rethrowProjectionError(sessionId, error);
    }
  }

  async function appendLifecycleEvent(
    sessionId: string,
    projection: SessionProjection,
    event:
      | { readonly type: 'session.renamed'; readonly payload: { readonly title: string } }
      | {
          readonly type: 'session.archived' | 'session.restored' | 'session.deleted';
          readonly payload: { readonly reason?: string };
        },
  ): Promise<SessionDetail> {
    await sessionStore.append(sessionId, [event]);
    return detailFor(sessionId, await readProjection(sessionId));
  }

  return {
    async create(projectId: string, title?: string): Promise<SessionDetail> {
      assertProjectExists(await projectStore.getProject(projectId), projectId);

      const sessionId = randomUUID();
      await sessionStore.append(sessionId, [
        {
          type: 'session.created',
          payload: title === undefined ? {} : { title },
        },
      ]);

      try {
        await projectStore.attachSession(projectId, sessionId);
      } catch (error) {
        try {
          await sessionStore.append(sessionId, [
            {
              type: 'session.deleted',
              payload: { reason: 'project-session-attach-failed' },
            },
          ]);
        } catch (compensationError) {
          throw new AggregateError(
            [error, compensationError],
            'Session creation and compensation failed',
            { cause: compensationError },
          );
        }
        throw error;
      }

      return detailFor(sessionId, await readProjection(sessionId));
    },

    async get(sessionId: string): Promise<SessionDetail> {
      return detailFor(sessionId, await readProjection(sessionId));
    },

    async listProjectSessions(
      projectId: string,
      listOptions?: { readonly includeArchived?: boolean },
    ): Promise<SessionListResult> {
      assertProjectExists(await projectStore.getProject(projectId), projectId);
      const refs: readonly ProjectSessionRef[] = await projectStore.listSessionRefs(projectId);
      const sessions: SessionSummary[] = [];
      const warnings: ProjectListWarning[] = [];
      const includeArchived = listOptions?.includeArchived ?? false;

      for (const ref of refs) {
        try {
          const projection = await readProjection(ref.sessionId);
          if (projection.deletedAt !== undefined) {
            continue;
          }
          if (!includeArchived && projection.archivedAt !== undefined) {
            continue;
          }
          sessions.push(summaryFor(ref.sessionId, projection));
        } catch (error) {
          if (error instanceof SessionServiceError && error.code === 'session-not-found') {
            warnings.push({ code: 'session-projection-invalid', sessionId: ref.sessionId });
            continue;
          }
          if (error instanceof SessionServiceError && error.code === 'session-projection-invalid') {
            warnings.push({ code: 'session-projection-invalid', sessionId: ref.sessionId });
            continue;
          }
          throw error;
        }
      }

      return { sessions, warnings };
    },

    async rename(sessionId: string, title: string): Promise<SessionDetail> {
      const projection = await readProjection(sessionId);
      if (projection.deletedAt !== undefined) {
        throw new SessionServiceError('session-deleted', `Session ${sessionId} is deleted`);
      }
      return appendLifecycleEvent(sessionId, projection, {
        type: 'session.renamed',
        payload: { title },
      });
    },

    async archive(sessionId: string): Promise<SessionDetail> {
      const projection = await readProjection(sessionId);
      if (projection.deletedAt !== undefined) {
        throw new SessionServiceError('session-deleted', `Session ${sessionId} is deleted`);
      }
      if (projection.archivedAt !== undefined) {
        return detailFor(sessionId, projection);
      }
      return appendLifecycleEvent(sessionId, projection, {
        type: 'session.archived',
        payload: {},
      });
    },

    async restore(sessionId: string): Promise<SessionDetail> {
      const projection = await readProjection(sessionId);
      if (projection.deletedAt !== undefined) {
        throw new SessionServiceError('session-deleted', `Session ${sessionId} is deleted`);
      }
      if (projection.archivedAt === undefined) {
        return detailFor(sessionId, projection);
      }
      return appendLifecycleEvent(sessionId, projection, {
        type: 'session.restored',
        payload: {},
      });
    },

    async delete(sessionId: string): Promise<SessionDetail> {
      const projection = await readProjection(sessionId);
      if (projection.deletedAt !== undefined) {
        return detailFor(sessionId, projection);
      }
      return appendLifecycleEvent(sessionId, projection, {
        type: 'session.deleted',
        payload: {},
      });
    },

    async assertRunnable(sessionId: string): Promise<void> {
      const projection = await readProjection(sessionId);
      if (projection.deletedAt !== undefined) {
        throw new SessionServiceError('session-deleted', `Session ${sessionId} is deleted`);
      }
      if (projection.archivedAt !== undefined) {
        throw new SessionServiceError('session-archived', `Session ${sessionId} is archived`);
      }
    },

    async close(): Promise<void> {
      await projectStore.close();
      await sessionStore.close();
    },
  };
}

export interface SessionService {
  create(projectId: string, title?: string): Promise<SessionDetail>;
  get(sessionId: string): Promise<SessionDetail>;
  listProjectSessions(
    projectId: string,
    options?: { readonly includeArchived?: boolean },
  ): Promise<SessionListResult>;
  rename(sessionId: string, title: string): Promise<SessionDetail>;
  archive(sessionId: string): Promise<SessionDetail>;
  restore(sessionId: string): Promise<SessionDetail>;
  delete(sessionId: string): Promise<SessionDetail>;
  assertRunnable(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export type { Project };
