import type { SessionEventStore } from '@weave/session';
import { projectSession } from '@weave/session';
import { z } from 'zod';
import type { ToolDefinition } from '../tool-types.js';

/**
 * One original tool result that the recall tool can return in full.
 *
 * These come from the durable Session event log, so they are never affected by
 * the deterministic compression applied to a model request's send window.
 */
export interface RecallToolResult {
  /** Provider tool-call id that produced the result. */
  readonly toolCallId: string;
  /** Registered tool name. */
  readonly name: string;
  /** Full (pipeline-capped) result content as originally stored. */
  readonly content: string;
  /** Whether the stored content was truncated by the Tool Pipeline byte cap. */
  readonly truncated: boolean;
  /** Completed or recoverable-failure outcome. */
  readonly status: 'completed' | 'failed';
  /** `path` argument of the originating tool call, when it had one. */
  readonly path?: string | undefined;
  /** Durable order index; a later result has a higher value. */
  readonly order: number;
}

/**
 * Resolves the recallable tool results of one Session, newest knowable last.
 *
 * Injected by the composition root so the Runtime does not bind to a specific
 * Store, mirroring how Workspace file tools receive a Workspace resolver.
 */
export type RecallResolver = (
  sessionId: string,
) => readonly RecallToolResult[] | Promise<readonly RecallToolResult[]>;

/** Input accepted by the `recall` tool. */
export interface RecallInput {
  /** Recall by the exact tool-call id shown in a compressed skeleton. */
  readonly toolCallId?: string | undefined;
  /** Recall the most recent result whose tool call read this path. */
  readonly path?: string | undefined;
}

/** Validates `recall` arguments; the handler reports when neither is given. */
export const recallInputSchema: z.ZodType<RecallInput> = z.object({
  toolCallId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
});

/** Reads a `path` string out of a tool call's JSON arguments, when present. */
function readPath(argumentsText: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'path' in parsed) {
      const value = (parsed as { path: unknown }).path;
      return typeof value === 'string' ? value : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Builds a {@link RecallResolver} from a Session Event Store.
 *
 * It projects the durable log and flattens tool results in durable order,
 * attaching each originating call's `path` argument so path recall can pick the
 * most recent read of a file.
 */
export function createSessionRecallResolver(sessionStore: SessionEventStore): RecallResolver {
  return async (sessionId) => {
    const events = await sessionStore.read(sessionId);
    if (events.length === 0) {
      return [];
    }
    const projection = projectSession(events);
    const results: RecallToolResult[] = [];
    let order = 0;
    for (const turn of projection.turns) {
      for (const result of turn.toolResults) {
        const call = turn.toolCalls.find(
          (candidate) => candidate.toolCall.id === result.toolCallId,
        );
        const path = call === undefined ? undefined : readPath(call.toolCall.arguments);
        results.push({
          toolCallId: result.toolCallId,
          name: result.name,
          content: result.content,
          truncated: result.truncated,
          status: result.status,
          ...(path === undefined ? {} : { path }),
          order: order,
        });
        order += 1;
      }
    }
    return results;
  };
}

/**
 * Creates the read-only `recall` tool.
 *
 * The model calls it to retrieve the full original content of a tool result
 * that deterministic compression replaced with a skeleton reference. It reads
 * only durable Session facts, so it needs no approval.
 */
export function createRecallTool(options: {
  readonly resolve: RecallResolver;
}): ToolDefinition<RecallInput, string> {
  return {
    name: 'recall',
    description:
      'Retrieve the full original content of an earlier tool result that was ' +
      'compressed out of the visible history. Pass the `toolCallId` shown in a ' +
      '"[recall id=...]" skeleton reference, or a `path` to get the most recent ' +
      'read of that file. Read-only; it never changes anything.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        toolCallId: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    inputSchema: recallInputSchema,
    execute: async (input, context) => {
      if (input.toolCallId === undefined && input.path === undefined) {
        return 'recall 需要 toolCallId 或 path 参数之一。';
      }
      const sessionId = context.sessionId;
      if (sessionId === undefined) {
        return 'recall 当前不可用：没有会话上下文。';
      }
      const results = await options.resolve(sessionId);

      if (input.toolCallId !== undefined) {
        const match = results.find((result) => result.toolCallId === input.toolCallId);
        return match === undefined
          ? `未找到 toolCallId=${input.toolCallId} 对应的工具结果。`
          : match.content;
      }

      const byPath = results.filter((result) => result.path === input.path);
      const latest = byPath.reduce<RecallToolResult | undefined>(
        (newest, candidate) =>
          newest === undefined || candidate.order > newest.order ? candidate : newest,
        undefined,
      );
      return latest === undefined ? `未找到读取过 path=${input.path} 的工具结果。` : latest.content;
    },
  };
}
