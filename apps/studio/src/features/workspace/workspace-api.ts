import { z } from 'zod';
import {
  projectListResponseSchema,
  projectSchema,
  sessionDetailSchema,
  type CreateProjectInput,
  type Project,
  type ProjectListResponse,
  type SessionDetail,
  type WorkspaceApiErrorPayload,
} from './workspace-types.js';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';

/** A typed failure returned by the Studio workspace API client. */
export class WorkspaceApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceApiError';
    this.code = code;
    this.status = status;
  }
}

const errorPayloadSchema: z.ZodType<WorkspaceApiErrorPayload> = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

const emptyResponseSchema = z.object({}).strict();

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    throw new WorkspaceApiError('workspace-api-network', '无法连接到本地服务', 0, {
      cause: error,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new WorkspaceApiError(
      'workspace-api-protocol',
      '本地服务返回了无效响应',
      response.status,
      { cause: error },
    );
  }

  if (!response.ok) {
    const parsedError = errorPayloadSchema.safeParse(payload);
    if (parsedError.success) {
      throw new WorkspaceApiError(
        parsedError.data.error.code,
        parsedError.data.error.message,
        response.status,
      );
    }
    throw new WorkspaceApiError(
      'workspace-api-protocol',
      '本地服务错误响应格式无效',
      response.status,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new WorkspaceApiError(
      'workspace-api-protocol',
      '本地服务返回的数据格式无效',
      response.status,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function sessionPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}

/** Browser client for Project and Session lifecycle APIs. */
export interface WorkspaceApi {
  listProjects(options?: { readonly includeArchived?: boolean }): Promise<ProjectListResponse>;
  getSession(sessionId: string): Promise<SessionDetail>;
  createProject(input: CreateProjectInput): Promise<Project>;
  createSession(projectId: string, title?: string): Promise<SessionDetail>;
  renameSession(sessionId: string, title: string): Promise<SessionDetail>;
  archiveSession(sessionId: string): Promise<SessionDetail>;
  restoreSession(sessionId: string): Promise<SessionDetail>;
  deleteSession(sessionId: string): Promise<SessionDetail>;
}

/** Creates the default HTTP-backed Workspace API client. */
export function createWorkspaceApi(): WorkspaceApi {
  return {
    listProjects(options) {
      const query =
        options?.includeArchived === true ? '?includeArchived=true' : '?includeArchived=false';
      return requestJson(
        runtimeApiUrl('/projects' + query),
        { method: 'GET' },
        projectListResponseSchema,
      );
    },

    getSession(sessionId) {
      return requestJson(
        runtimeApiUrl(sessionPath(sessionId)),
        { method: 'GET' },
        sessionDetailSchema,
      );
    },

    createProject(input) {
      return requestJson(runtimeApiUrl('/projects'), jsonRequest('POST', input), projectSchema);
    },

    createSession(projectId, title) {
      const body = title === undefined ? {} : { title };
      return requestJson(
        runtimeApiUrl(`/projects/${encodeURIComponent(projectId)}/sessions`),
        jsonRequest('POST', body),
        sessionDetailSchema,
      );
    },

    renameSession(sessionId, title) {
      return requestJson(
        runtimeApiUrl(sessionPath(sessionId)),
        jsonRequest('PATCH', { title }),
        sessionDetailSchema,
      );
    },

    archiveSession(sessionId) {
      return requestJson(
        runtimeApiUrl(`${sessionPath(sessionId)}/archive`),
        jsonRequest('POST'),
        sessionDetailSchema,
      );
    },

    restoreSession(sessionId) {
      return requestJson(
        runtimeApiUrl(`${sessionPath(sessionId)}/restore`),
        jsonRequest('POST'),
        sessionDetailSchema,
      );
    },

    deleteSession(sessionId) {
      return requestJson(
        runtimeApiUrl(sessionPath(sessionId)),
        jsonRequest('DELETE'),
        sessionDetailSchema,
      );
    },
  };
}

export { requestJson, emptyResponseSchema };
