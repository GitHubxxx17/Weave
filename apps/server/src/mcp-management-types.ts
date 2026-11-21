import { z } from 'zod';
import type { ExtensionGenerationSnapshot } from './extension-types.js';
import { mcpServerConfigSchema, type McpServerConfig } from './mcp-environment.js';
import { pluginGenerationSchema } from './plugin-management-types.js';

export const mcpIssueSchema = z.object({ code: z.string(), message: z.string() });
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const jsonObjectSchema = z.custom<Readonly<Record<string, unknown>>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
);

export const mcpGenerationBindingSchema = z.object({
  generation: z.number().int().positive(),
  configDigest: digestSchema,
});
export type McpGenerationBinding = z.infer<typeof mcpGenerationBindingSchema>;

export const mcpToolMetadataSchema = z.object({
  name: z.string(),
  toolName: z.string(),
  description: z.string(),
  inputSchema: jsonObjectSchema,
  outputSchema: jsonObjectSchema.optional(),
  annotations: jsonObjectSchema.optional(),
});
export type McpToolMetadata = z.infer<typeof mcpToolMetadataSchema>;

export const mcpServerRecordSchema = z.object({
  config: mcpServerConfigSchema,
  configDigest: digestSchema,
  trustedDigest: digestSchema.optional(),
  reviewedConfig: mcpServerConfigSchema.optional(),
  enabled: z.boolean(),
  state: z.enum(['removed', 'changed', 'untrusted', 'disabled', 'connecting', 'loaded', 'failed']),
  stale: z.boolean(),
  active: mcpGenerationBindingSchema.optional(),
  drainingGenerations: z.array(mcpGenerationBindingSchema).max(32),
  tools: z.array(mcpToolMetadataSchema).max(64),
  issue: mcpIssueSchema.optional(),
});
export type McpServerRecord = z.infer<typeof mcpServerRecordSchema>;

export const mcpManagementSnapshotSchema = z.object({
  authoritySequence: sequenceSchema,
  servers: z.array(mcpServerRecordSchema),
  generation: pluginGenerationSchema,
});
export interface McpManagementSnapshot {
  readonly authoritySequence: number;
  readonly servers: readonly McpServerRecord[];
  readonly generation: ExtensionGenerationSnapshot;
}

export const mcpMutationResultSchema = mcpManagementSnapshotSchema.extend({
  result: z.object({
    decisionSequence: sequenceSchema,
    applied: z.boolean(),
    unchanged: z.boolean(),
    failed: z.array(z.object({ id: z.string(), error: mcpIssueSchema })),
    error: mcpIssueSchema.optional(),
  }),
});
export interface McpMutationResult extends McpManagementSnapshot {
  readonly result: {
    readonly decisionSequence: number;
    readonly applied: boolean;
    readonly unchanged: boolean;
    readonly failed: readonly {
      readonly id: string;
      readonly error: { readonly code: string; readonly message: string };
    }[];
    readonly error?: { readonly code: string; readonly message: string };
  };
}

type Immediate = { readonly immediate?: boolean };

/** HTTP management receives only safe DTOs, never connections or launch authority. */
export interface ServerMcpManager {
  snapshot(): McpManagementSnapshot;
  configure(expectedSequence: number, config: McpServerConfig): Promise<McpMutationResult>;
  update(id: string, expectedSequence: number, config: McpServerConfig): Promise<McpMutationResult>;
  trust(id: string, expectedSequence: number, configDigest: string): Promise<McpMutationResult>;
  enable(id: string, expectedSequence: number, configDigest: string): Promise<McpMutationResult>;
  disable(id: string, expectedSequence: number, options?: Immediate): Promise<McpMutationResult>;
  revoke(id: string, expectedSequence: number, options?: Immediate): Promise<McpMutationResult>;
  remove(id: string, expectedSequence: number, options?: Immediate): Promise<McpMutationResult>;
  reload(expectedSequence: number): Promise<McpMutationResult>;
}
