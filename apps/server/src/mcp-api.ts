import { ExplicitLocalAuthorityError } from '@weave/plugin-host';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { McpAuthorityError } from './mcp-errors.js';
import { mcpServerConfigSchema } from './mcp-environment.js';
import {
  mcpIssueSchema,
  mcpManagementSnapshotSchema,
  mcpMutationResultSchema,
  type McpMutationResult,
  type ServerMcpManager,
} from './mcp-management-types.js';
import { managementWriteGuard } from './plugin-write-guard.js';

export interface McpAppOptions {
  readonly mcpManager?: ServerMcpManager | undefined;
  readonly studioOrigin?: string | undefined;
  readonly trustedHost?: string | undefined;
}

const errorResponseSchema = z.object({ error: mcpIssueSchema });
const idSchema = z
  .string()
  .max(24)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sequenceBody = z.strictObject({ expectedSequence: sequenceSchema });
const configBody = sequenceBody.extend({ config: mcpServerConfigSchema });
const digestBody = sequenceBody.extend({ configDigest: z.string().regex(/^[0-9a-f]{64}$/) });
const immediateBody = sequenceBody.extend({ immediate: z.boolean().optional() });
const issues = {
  'mcp-invalid': { status: 400, message: 'The MCP management request is invalid.' },
  'mcp-not-found': { status: 404, message: 'The MCP server was not found.' },
  'mcp-conflict': { status: 409, message: 'The MCP configuration or authority has changed.' },
  'mcp-authority-protocol': {
    status: 500,
    message: 'MCP authority contains invalid persisted data.',
  },
  'mcp-authority-storage': { status: 500, message: 'MCP authority persistence is unavailable.' },
  'mcp-authority-busy': { status: 503, message: 'MCP authority is temporarily busy.' },
  'mcp-closed': { status: 500, message: 'MCP management is closed.' },
  'mcp-content-changed': { status: 409, message: '内容已变更，需要重新信任。' },
  'mcp-content-too-large': {
    status: 400,
    message: 'MCP 绑定内容超出上限（最多 1000 个文件、20 MB），请缩小 contentPaths 范围。',
  },
  'mcp-content-unreadable': {
    status: 400,
    message: 'MCP 绑定内容无法读取（含符号链接或特殊文件），请检查 command 与 contentPaths。',
  },
} as const;

function respondError(context: Context, error: unknown): Response {
  const authorityError = error instanceof ExplicitLocalAuthorityError ? error.cause : error;
  const code =
    authorityError instanceof McpAuthorityError ? authorityError.code : 'mcp-management-failed';
  const issue = code in issues ? issues[code as keyof typeof issues] : undefined;
  return context.json(
    errorResponseSchema.parse({
      error: {
        code,
        message: issue?.message ?? 'MCP management is unavailable.',
      },
    }),
    issue?.status ?? 500,
  );
}

function invalid(): never {
  throw new McpAuthorityError('mcp-invalid', issues['mcp-invalid'].message);
}

async function readBody<T>(context: Context, schema: z.ZodType<T>): Promise<T> {
  try {
    const parsed = schema.safeParse(await context.req.json());
    if (!parsed.success) return invalid();
    return parsed.data;
  } catch (error: unknown) {
    if (error instanceof McpAuthorityError) throw error;
    return invalid();
  }
}

function serverId(context: Context): string {
  const parsed = idSchema.safeParse(context.req.param('id'));
  return parsed.success ? parsed.data : invalid();
}

/** Cached reads and guarded writes delegate all authority and launch work to the manager. */
export function registerMcpRoutes(app: Hono, options: McpAppOptions): void {
  const guard = managementWriteGuard(options.studioOrigin, options.trustedHost);
  app.use('/mcp', guard);
  app.use('/mcp/*', guard);
  const manager = (context: Context): ServerMcpManager | Response => {
    if (options.mcpManager !== undefined) return options.mcpManager;
    return context.json(
      errorResponseSchema.parse({
        error: {
          code: 'mcp-management-disabled',
          message: 'MCP management is not enabled.',
        },
      }),
      404,
    );
  };
  app.get('/mcp', (context) => {
    try {
      const current = manager(context);
      return current instanceof Response
        ? current
        : context.json(mcpManagementSnapshotSchema.parse(current.snapshot()));
    } catch (error: unknown) {
      return respondError(context, error);
    }
  });
  const mutate = async (
    context: Context,
    operation: (manager: ServerMcpManager) => Promise<McpMutationResult>,
  ): Promise<Response> => {
    try {
      const current = manager(context);
      if (current instanceof Response) return current;
      return context.json(mcpMutationResultSchema.parse(await operation(current)));
    } catch (error: unknown) {
      return respondError(context, error);
    }
  };
  app.post('/mcp/servers', (context) =>
    mutate(context, async (current) => {
      const body = await readBody(context, configBody);
      return current.configure(body.expectedSequence, body.config);
    }),
  );
  app.put('/mcp/servers/:id', (context) =>
    mutate(context, async (current) => {
      const id = serverId(context);
      const body = await readBody(context, configBody);
      if (id !== body.config.id) return invalid();
      return current.update(id, body.expectedSequence, body.config);
    }),
  );
  for (const operation of ['trust', 'enable'] as const) {
    app.post(`/mcp/servers/:id/${operation}`, (context) =>
      mutate(context, async (current) => {
        const id = serverId(context);
        const body = await readBody(context, digestBody);
        return current[operation](id, body.expectedSequence, body.configDigest);
      }),
    );
  }
  for (const operation of ['disable', 'revoke', 'remove'] as const) {
    app.post(`/mcp/servers/:id/${operation}`, (context) =>
      mutate(context, async (current) => {
        const id = serverId(context);
        const body = await readBody(context, immediateBody);
        return current[operation](
          id,
          body.expectedSequence,
          body.immediate === undefined ? undefined : { immediate: body.immediate },
        );
      }),
    );
  }
  app.post('/mcp/reload', (context) =>
    mutate(context, async (current) => {
      const body = await readBody(context, sequenceBody);
      return current.reload(body.expectedSequence);
    }),
  );
}
