import { Worker, type WorkerOptions } from 'node:worker_threads';
import {
  retrievalChunkIdentitySchema,
  retrievalGenerationSchema,
  retrievalLimits,
  retrievalModeSchema,
  retrievalQueryIntentSchema,
  retrievalSourceIdentitySchema,
  type RetrievalRankedCandidate,
} from '@weave/protocol';
import { z } from 'zod';
import { persistence, RetrievalStoreError } from './errors.js';

export const workerInput = z.strictObject({
  filename: z.string().min(1),
  generation: retrievalGenerationSchema,
  mode: retrievalModeSchema,
  intent: retrievalQueryIntentSchema,
  memoryAllowed: z.boolean(),
  vector: z.array(z.number()).length(retrievalLimits.embeddingDimensions).optional(),
});

const workerOutput = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    candidates: z
      .array(
        z.strictObject({
          source: retrievalSourceIdentitySchema,
          title: z.string().min(1).max(640),
          chunk: retrievalChunkIdentitySchema,
          text: z.string().min(1).max(retrievalLimits.maxChunkBytes),
          lexicalRank: z
            .number()
            .int()
            .positive()
            .max(retrievalLimits.maxRankerCandidates)
            .optional(),
          vectorRank: z
            .number()
            .int()
            .positive()
            .max(retrievalLimits.maxRankerCandidates)
            .optional(),
          rrfScore: z.number().positive().optional(),
        }),
      )
      .max(retrievalLimits.maxCandidates),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['retrieval-unavailable', 'retrieval-invalid-input']),
  }),
]);

type WorkerResult = z.infer<typeof workerOutput>;
type QueryInput = Omit<z.input<typeof workerInput>, 'filename'>;
type QueryOptions = { readonly deadline: number; readonly signal: AbortSignal };
export type RetrievalQueryWorker = Pick<Worker, 'once' | 'terminate'>;
export type RetrievalQueryWorkerFactory = (
  url: URL,
  options: WorkerOptions,
) => RetrievalQueryWorker;

// Node runs the source worker directly in repository tests. Resolve only this
// package's emitted-style relative specifiers while executing that source tree.
const sourceImports = `
import { registerHooks } from 'node:module';
const sourceDirectory = ${JSON.stringify(new URL('./', import.meta.url).href)};
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(sourceDirectory) && specifier.startsWith('./') && specifier.endsWith('.js')) {
    const source = new URL(specifier, context.parentURL);
    if (source.href.startsWith(sourceDirectory)) return next(source.href.slice(0, -3) + '.ts', context);
  }
  return next(specifier, context);
}});
`;
const sourcePreload = `data:text/javascript,${encodeURIComponent(sourceImports)}`;

export function createRetrievalQueryManager(
  filename: string,
  factory: RetrievalQueryWorkerFactory = (url, options) => new Worker(url, options),
) {
  const workers = new Set<{ exited: Promise<void>; cancel: () => void }>();
  let stopped = false;
  return {
    get size() {
      return workers.size;
    },
    query(input: QueryInput, options: QueryOptions, onExit: () => void) {
      const remaining = Math.min(options.deadline - Date.now(), retrievalLimits.maxLocalReadMs);
      if (remaining <= 0) throw new RetrievalStoreError('retrieval-timeout');
      if (stopped || options.signal.aborted) throw new RetrievalStoreError('retrieval-cancelled');
      if (workers.size >= retrievalLimits.maxReaders)
        throw new RetrievalStoreError('retrieval-busy');
      const source = import.meta.url.endsWith('.ts');
      const worker = factory(
        new URL(source ? './query-worker.ts' : './query-worker.js', import.meta.url),
        {
          workerData: { ...input, filename },
          ...(source ? { execArgv: ['--import', sourcePreload] } : {}),
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
        },
      );
      let finishExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        finishExit = resolve;
      });
      let resolveResult!: (candidates: RetrievalRankedCandidate[]) => void;
      let rejectResult!: (error: Error) => void;
      const result = new Promise<RetrievalRankedCandidate[]>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      let response: WorkerResult | undefined;
      let failure: Error | undefined;
      let terminated = false;
      function terminate() {
        if (terminated) return;
        terminated = true;
        try {
          void worker.terminate().catch(() => undefined);
        } catch {
          /* Capacity remains occupied until the exit event. */
        }
      }
      function stop(error: Error) {
        if (failure) return;
        failure = error;
        terminate();
      }
      const cancel = () => stop(new RetrievalStoreError('retrieval-cancelled'));
      const entry = { exited, cancel };
      workers.add(entry);
      const timer = setTimeout(() => stop(new RetrievalStoreError('retrieval-timeout')), remaining);
      options.signal.addEventListener('abort', cancel, { once: true });
      worker.once('message', (value: unknown) => {
        if (failure) return;
        const parsed = workerOutput.safeParse(value);
        if (!parsed.success) stop(persistence(parsed.error));
        else response = parsed.data;
      });
      worker.once('error', (error) => stop(persistence(error)));
      worker.once('exit', (code) => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', cancel);
        workers.delete(entry);
        onExit();
        finishExit();
        if (failure) rejectResult(failure);
        else if (code !== 0 || !response) rejectResult(persistence());
        else if (response.ok)
          resolveResult(
            response.candidates.map(({ lexicalRank, vectorRank, rrfScore, ...candidate }) => ({
              ...candidate,
              ...(lexicalRank !== undefined ? { lexicalRank } : {}),
              ...(vectorRank !== undefined ? { vectorRank } : {}),
              ...(rrfScore !== undefined ? { rrfScore } : {}),
            })),
          );
        else rejectResult(new RetrievalStoreError(response.code));
      });
      if (options.signal.aborted) cancel();
      return result;
    },
    closeSync() {
      stopped = true;
      for (const worker of workers) worker.cancel();
    },
    async drain() {
      if (workers.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([...workers].map(({ exited }) => exited)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new RetrievalStoreError('retrieval-busy')),
              retrievalLimits.maxLocalReadMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
