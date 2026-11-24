import {
  createSqliteRetrievalIndex,
  RetrievalStoreError,
  RetrievalStoreStartupError,
  type RetrievalIndex,
} from '@weave/retrieval';
import {
  createRetrievalEgress,
  createRetrievalService,
  createRetrievalTools,
  createRetrievalWorkspaceCapture,
  RetrievalError,
  type EmbeddingClientPort,
  type RegisteredToolDefinition,
  type RetrievalBudgets,
  type RetrievalIndexPort,
  type RetrievalLifecycle,
  type RetrievalService,
  type ToolRegistry,
} from '@weave/runtime';
import type { AgentTaskWorkspaceBindings } from './agent-task-workspace.js';
import { createServerEmbeddingClient } from './embedding-config.js';
import type { ServerMemoryComposition } from './memory-composition.js';
import { resolveRetrievalDatabaseFile } from './persistence-path.js';
import type { ProjectFolderAuthority } from './project-folder-authority.js';
import { createRetrievalProjectResolver } from './retrieval-scope.js';

export interface ServerRetrievalCompositionOptions {
  readonly databaseFile: string;
  readonly projectFolders: ProjectFolderAuthority;
  readonly agentTaskWorkspace: AgentTaskWorkspaceBindings;
  readonly memory: ServerMemoryComposition;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly embeddingFetch?: typeof globalThis.fetch | undefined;
  readonly registerResource?: ((resource: RetrievalLifecycle) => void) | undefined;
  readonly indexFactory?: typeof createSqliteRetrievalIndex;
}

export interface ServerRetrievalTools {
  install(registerHostTool: ToolRegistry['register']): void;
  rootOnlyTool(definition: RegisteredToolDefinition): boolean;
}

export interface ServerRetrievalComposition extends RetrievalLifecycle, ServerRetrievalTools {
  readonly databaseFile: string;
  readonly budgets: RetrievalBudgets;
  readonly service: RetrievalService;
  readonly embedding?: EmbeddingClientPort;
}

function mapStoreError(error: unknown): never {
  if (error instanceof RetrievalStoreError) throw new RetrievalError(error.code);
  throw error;
}

function mapSync<Args extends unknown[], Result>(operation: (...args: Args) => Result) {
  return (...args: Args): Result => {
    try {
      return operation(...args);
    } catch (error) {
      return mapStoreError(error);
    }
  };
}

function mapAsync<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) {
  return async (...args: Args): Promise<Result> => {
    try {
      return await operation(...args);
    } catch (error) {
      return mapStoreError(error);
    }
  };
}

function runtimeIndex(index: RetrievalIndex): RetrievalIndexPort {
  return {
    capability: index.capability,
    prepareDocuments: mapSync(index.prepareDocuments),
    manifestDigest: mapSync(index.manifestDigest),
    accept: mapSync(index.accept),
    lookupAccepted: mapSync(index.lookupAccepted),
    lookupJobOperation: mapSync(index.lookupJobOperation),
    markStarted: mapSync(index.markStarted),
    beginStage: mapSync(index.beginStage),
    stageBatch: mapSync(index.stageBatch),
    publish: mapSync(index.publish),
    finish: mapSync(index.finish),
    getJob: mapSync(index.getJob),
    listJobs: mapSync(index.listJobs),
    status: mapSync(index.status),
    unfinishedJobs: mapSync(index.unfinishedJobs),
    leaseActive: mapSync(index.leaseActive),
    query: mapAsync(index.query),
    readChunk: mapSync(index.readChunk),
    releaseReadLease: mapSync(index.releaseReadLease),
    discardStage: mapSync(index.discardStage),
    collectGarbage: mapSync(index.collectGarbage),
    closeSync: mapSync(index.closeSync),
    drain: mapAsync(index.drain),
    close: mapAsync(() => index.close()),
  };
}

export async function createServerRetrievalComposition(
  options: ServerRetrievalCompositionOptions,
): Promise<ServerRetrievalComposition> {
  const databaseFile = await resolveRetrievalDatabaseFile(options.databaseFile);
  const { budgets, service: memory, scopes } = options.memory;
  let index: RetrievalIndex;
  try {
    index = (options.indexFactory ?? createSqliteRetrievalIndex)({ filename: databaseFile });
  } catch (error) {
    if (error instanceof RetrievalStoreStartupError) options.registerResource?.(error.cleanup);
    throw error;
  }
  // Assigned before service creation; startup cleanup also handles partial construction.
  // eslint-disable-next-line prefer-const
  let embedding: EmbeddingClientPort | undefined;
  // eslint-disable-next-line prefer-const
  let service: RetrievalService | undefined;
  const controller = new AbortController();
  const configEpoch = Object.freeze({});
  const resource: RetrievalLifecycle = {
    closeSync() {
      if (service === undefined) {
        index.closeSync();
        embedding?.closeSync();
      } else service.closeSync();
      controller.abort();
    },
    async drain() {
      if (service !== undefined) return service.drain();
      await embedding?.drain();
      await index.drain();
    },
    async close() {
      if (service !== undefined) return service.close();
      resource.closeSync();
      await resource.drain();
      await embedding?.close();
      await index.close();
    },
  };
  options.registerResource?.(resource);
  embedding = createServerEmbeddingClient(
    options.environment ?? process.env,
    options.embeddingFetch,
  );
  const projects = createRetrievalProjectResolver({
    projectFolders: options.projectFolders,
    agentTaskWorkspace: options.agentTaskWorkspace,
    scopes,
  });
  service = createRetrievalService({
    index: runtimeIndex(index),
    projects,
    capture: createRetrievalWorkspaceCapture(),
    memory: memory.reviewedSource,
    ...(embedding === undefined
      ? {}
      : {
          embedding,
          embeddingAuthority: {
            capture: () => configEpoch,
            assertCurrentSync(snapshot: object) {
              if (controller.signal.aborted || snapshot !== configEpoch)
                throw new RetrievalError('retrieval-semantic-unavailable');
            },
          },
        }),
    egress: createRetrievalEgress(),
    budgets,
  });
  const tools = createRetrievalTools({
    service,
    ...(embedding === undefined ? {} : { embedding }),
    signal: controller.signal,
  });
  const rootOnly = new WeakSet<object>([
    tools.buildProjectIndex,
    tools.cancelProjectIndex,
    tools.semanticSearchProject,
  ]);
  return {
    ...resource,
    databaseFile,
    budgets,
    service,
    ...(embedding === undefined ? {} : { embedding }),
    install(registerHostTool) {
      registerHostTool(tools.buildProjectIndex);
      registerHostTool(tools.indexStatus);
      registerHostTool(tools.cancelProjectIndex);
      registerHostTool(tools.searchProject);
      registerHostTool(tools.semanticSearchProject);
    },
    rootOnlyTool: (definition) => rootOnly.has(definition),
  };
}
