import { createSqliteMemoryStore, MemoryStoreStartupError } from '@weave/memory';
import {
  createMemoryService,
  createMemoryTools,
  defaultAgentMaxToolResultTokens,
  defaultToolResultMaxBytes,
  type MemoryService,
  type MemoryTools,
  type MemoryServiceOptions,
  type MemoryStorePort,
  type RegisteredToolDefinition,
  type ToolRegistry,
} from '@weave/runtime';
import type { SessionEventStore } from '@weave/session';
import type { ProjectStore } from '@weave/workspace';
import { z } from 'zod';
import { createMemoryScopeResolver } from './memory-scope.js';
import { resolveMemoryDatabaseFile } from './persistence-path.js';

export interface ServerMemoryTools {
  install(registerHostTool: ToolRegistry['register']): void;
  rootOnlyTool(definition: RegisteredToolDefinition): boolean;
}

export interface ServerMemoryResource {
  closeSync(): void;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface ServerMemoryCompositionOptions {
  readonly registerResource?: (resource: ServerMemoryResource) => void;
  readonly databaseFile: string;
  readonly projectStore: ProjectStore;
  readonly sessionStore: SessionEventStore;
  readonly budgets?: MemoryServiceOptions['budgets'];
  readonly beforeMemoryCommit?: MemoryServiceOptions['beforeMemoryCommit'];
  readonly storeFactory?: (options: { readonly filename: string }) => MemoryStorePort;
}

const budgetsSchema = z.strictObject({
  maxBytes: z.number().int().positive().safe(),
  maxToolResultTokens: z.number().int().positive().safe(),
});

/** The same effective result limits feed Memory, the Pipeline and the Runner. */
export function resolveMemoryBudgets(budgets: MemoryServiceOptions['budgets'] = {}) {
  return Object.freeze(
    budgetsSchema.parse({
      maxBytes: budgets.maxBytes ?? defaultToolResultMaxBytes,
      maxToolResultTokens: budgets.maxToolResultTokens ?? defaultAgentMaxToolResultTokens,
    }),
  );
}

/** Owns the concrete sidecar, Runtime service and exact per-Generation host tools. */
export async function createServerMemoryComposition(
  options: ServerMemoryCompositionOptions,
): Promise<ServerMemoryComposition> {
  const budgets = resolveMemoryBudgets(options.budgets);
  const databaseFile = await resolveMemoryDatabaseFile(options.databaseFile);
  let store: MemoryStorePort;
  try {
    store = (options.storeFactory ?? createSqliteMemoryStore)({ filename: databaseFile });
  } catch (error) {
    if (error instanceof MemoryStoreStartupError) options.registerResource?.(error.cleanup);
    throw error;
  }
  const scopes = createMemoryScopeResolver(options);
  const controller = new AbortController();
  const state: { service?: ReturnType<typeof createMemoryService> } = {};
  let fenced = false;
  const resource: ServerMemoryResource = {
    closeSync() {
      if (fenced) return;
      fenced = true;
      if (state.service === undefined) store.closeSync();
      else state.service.closeSync();
      controller.abort();
    },
    drain: () => (state.service === undefined ? store.drain() : state.service.drain()),
    close: () => (state.service === undefined ? store.close() : state.service.close()),
  };
  // Register acquired ownership before any later construction can fail.
  options.registerResource?.(resource);
  const service = createMemoryService({
    store,
    resolveAgentScope: scopes.resolveAgentScope,
    resolveLocalScope: scopes.resolveLocalScope,
    beforeMemoryCommit: options.beforeMemoryCommit ?? (() => undefined),
    budgets,
  });
  state.service = service;
  const tools = createMemoryTools({ service, signal: controller.signal });
  const rootOnly = new WeakSet<object>([tools.saveMemory, tools.deleteMemory]);
  return {
    ...resource,
    databaseFile,
    budgets,
    service,
    scopes,
    tools,
    install(registerHostTool: ToolRegistry['register']) {
      registerHostTool(tools.searchMemory);
      registerHostTool(tools.readMemory);
      registerHostTool(tools.saveMemory);
      registerHostTool(tools.deleteMemory);
    },
    rootOnlyTool: (definition: RegisteredToolDefinition) => rootOnly.has(definition),
  };
}

export interface ServerMemoryComposition extends ServerMemoryResource, ServerMemoryTools {
  readonly databaseFile: string;
  readonly budgets: ReturnType<typeof resolveMemoryBudgets>;
  readonly service: MemoryService;
  readonly scopes: ReturnType<typeof createMemoryScopeResolver>;
  readonly tools: MemoryTools;
}
