import { z } from 'zod';

export function freezeMcpJson<T>(value: T): T {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    for (const child of Object.values(current)) pending.push(child);
    Object.freeze(current);
  }
  return value;
}
function copyJson(input: unknown): unknown {
  const pending: { source: object; target: object }[] = [];
  const visited = new WeakSet<object>();
  function copyValue(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (
      typeof value !== 'object' ||
      ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value)) ||
      visited.has(value)
    )
      throw new Error();
    // response.json() supplies a tree. Reject non-JSON object graphs and accessors
    // without imposing a depth restriction on legal third-party annotations.
    visited.add(value);
    const target: object = Array.isArray(value) ? [] : {};
    pending.push({ source: value, target });
    return target;
  }
  const copy = copyValue(input);
  while (pending.length > 0) {
    const { source, target } = pending.pop()!;
    for (const key of Reflect.ownKeys(source)) {
      if (Array.isArray(source) && key === 'length') continue;
      if (typeof key !== 'string') throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error();
      Object.defineProperty(target, key, { value: copyValue(descriptor.value), enumerable: true });
    }
  }
  return copy;
}
export const mcpJsonObjectSchema = z
  .unknown()
  .transform((input, context): Readonly<Record<string, unknown>> => {
    try {
      const copy = copyJson(input);
      if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) throw new Error();
      return freezeMcpJson(copy as Record<string, unknown>);
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid JSON object' });
      return z.NEVER;
    }
  });
export const mcpIssueSchema = z.object({ code: z.string(), message: z.string() }).readonly();
export const extensionGenerationSchema = z
  .object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    acceptingRuns: z.boolean(),
    blocked: mcpIssueSchema.optional(),
  })
  .readonly();
export type ExtensionGeneration = z.infer<typeof extensionGenerationSchema>;
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const nameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine((value) => !/^WEAVE_/i.test(value));
const launchTextSchema = z.string().refine((value) => !value.includes('\0'));
const envSchema = mcpJsonObjectSchema.transform(
  (input, context): Readonly<Record<string, { readonly fromHostEnv: string }>> => {
    try {
      if (Object.keys(input).length > 32) throw new Error();
      const result: Record<string, { readonly fromHostEnv: string }> = {};
      for (const [target, value] of Object.entries(input)) {
        nameSchema.parse(target);
        const reference = z.strictObject({ fromHostEnv: nameSchema }).parse(value);
        Object.defineProperty(result, target, { value: reference, enumerable: true });
      }
      return freezeMcpJson(result);
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid environment references' });
      return z.NEVER;
    }
  },
);
export const mcpServerConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z
      .string()
      .max(24)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    label: z.string().min(1).max(80),
    transport: z.literal('stdio'),
    command: launchTextSchema.min(1),
    args: z
      .array(launchTextSchema.refine((value) => new TextEncoder().encode(value).length <= 4096))
      .max(64)
      .readonly(),
    cwd: launchTextSchema.min(1),
    env: envSchema,
    contentPaths: z.array(launchTextSchema.min(1)).max(16).readonly().optional(),
    callTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(10 * 60 * 1000)
      .optional(),
  })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 64 * 1024)
  .readonly();
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export const mcpGenerationBindingSchema = z
  .object({
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    configDigest: digestSchema,
  })
  .readonly();
export type McpGenerationBinding = z.infer<typeof mcpGenerationBindingSchema>;
export const mcpToolMetadataSchema = z
  .object({
    name: z.string(),
    toolName: z.string(),
    description: z.string(),
    inputSchema: mcpJsonObjectSchema,
    outputSchema: mcpJsonObjectSchema.optional(),
    annotations: mcpJsonObjectSchema.optional(),
  })
  .readonly();
export type McpToolMetadata = z.infer<typeof mcpToolMetadataSchema>;
export const mcpServerRecordSchema = z
  .object({
    config: mcpServerConfigSchema,
    configDigest: digestSchema,
    trustedDigest: digestSchema.optional(),
    reviewedConfig: mcpServerConfigSchema.optional(),
    enabled: z.boolean(),
    state: z.enum([
      'removed',
      'changed',
      'untrusted',
      'disabled',
      'connecting',
      'loaded',
      'failed',
    ]),
    stale: z.boolean(),
    active: mcpGenerationBindingSchema.optional(),
    drainingGenerations: z.array(mcpGenerationBindingSchema).max(32).readonly(),
    tools: z.array(mcpToolMetadataSchema).max(64).readonly(),
    issue: mcpIssueSchema.optional(),
  })
  .readonly();
export type McpServerRecord = z.infer<typeof mcpServerRecordSchema>;
export const mcpManagementSnapshotSchema = z
  .object({
    authoritySequence: sequenceSchema,
    generation: extensionGenerationSchema,
    servers: z.array(mcpServerRecordSchema).readonly(),
  })
  .readonly();
export type McpManagementSnapshot = z.infer<typeof mcpManagementSnapshotSchema>;
export const mcpMutationResultSchema = z
  .object({
    authoritySequence: sequenceSchema,
    generation: extensionGenerationSchema,
    servers: z.array(mcpServerRecordSchema).readonly(),
    result: z
      .object({
        decisionSequence: sequenceSchema,
        applied: z.boolean(),
        unchanged: z.boolean(),
        failed: z.array(z.object({ id: z.string(), error: mcpIssueSchema }).readonly()).readonly(),
        error: mcpIssueSchema.optional(),
      })
      .readonly(),
  })
  .readonly();
export type McpMutationResult = z.infer<typeof mcpMutationResultSchema>;
