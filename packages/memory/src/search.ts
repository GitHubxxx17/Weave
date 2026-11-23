import { Worker, type WorkerOptions } from 'node:worker_threads';
import { z } from 'zod';
import { memoryScopeSchema, memorySummarySchema } from '@weave/protocol';
import { MemoryStoreError } from './errors.js';
import type { MemorySearchInput, MemorySearchPage } from './types.js';

const pageSchema = z
  .strictObject({
    entries: z.array(memorySummarySchema).max(50),
    keys: z
      .array(
        z.strictObject({
          titleHit: z.number().int().min(0).max(1),
          updatedAt: z.iso.datetime(),
          scopeRank: z.number().int().min(0).max(1),
          memoryId: z.string().uuid(),
        }),
      )
      .max(50),
    scopeHeads: z
      .array(
        z.strictObject({
          scope: memoryScopeSchema,
          sequence: z.number().int().nonnegative().safe(),
        }),
      )
      .max(2),
    hasMore: z.boolean(),
  })
  .refine((page) => page.entries.length === page.keys.length);
const resultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), page: pageSchema }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['memory-limit', 'memory-persistence-error']),
  }),
]);
export interface MemorySearchManager {
  search(input: MemorySearchInput, signal?: AbortSignal): Promise<MemorySearchPage>;
  closeSync(): void;
  drain(): Promise<void>;
}
export type MemorySearchWorker = Pick<Worker, 'once' | 'terminate'>;
export type MemorySearchWorkerFactory = (url: URL, options: WorkerOptions) => MemorySearchWorker;
let liveWorkerCount = 0;
export function createMemorySearchManager(
  filename: string,
  factory: MemorySearchWorkerFactory = (url, options) => new Worker(url, options),
): MemorySearchManager {
  const workers = new Set<{ worker: MemorySearchWorker; exited: Promise<void>; cancel(): void }>();
  let closed = false;
  return {
    async search(input, signal) {
      if (closed || signal?.aborted) throw new MemoryStoreError('memory-cancelled');
      if (liveWorkerCount >= 2) throw new MemoryStoreError('memory-busy');
      const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
      const worker = factory(new URL(`./search-worker${extension}`, import.meta.url), {
        workerData: { filename, input },
      });
      liveWorkerCount += 1;
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      let rejectResult!: (error: unknown) => void;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let termination: Promise<number> | undefined;
      const terminate = () => {
        termination ??= worker.terminate();
        void termination.catch(() => {});
      };
      const cancel = () => {
        if (!settled) {
          settled = true;
          rejectResult(new MemoryStoreError('memory-cancelled'));
        }
        terminate();
      };
      const entry = { worker, exited, cancel };
      workers.add(entry);
      worker.once('exit', () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        workers.delete(entry);
        liveWorkerCount -= 1;
        resolveExit();
        if (!settled) {
          settled = true;
          rejectResult(new MemoryStoreError('memory-persistence-error'));
        }
      });
      return new Promise<MemorySearchPage>((resolve, reject) => {
        rejectResult = reject;
        worker.once('message', (value: unknown) => {
          if (settled) return;
          const parsed = resultSchema.safeParse(value);
          settled = true;
          if (!parsed.success) reject(new MemoryStoreError('memory-persistence-error'));
          else if (!parsed.data.ok) reject(new MemoryStoreError(parsed.data.code));
          else resolve(parsed.data.page);
        });
        worker.once('error', () => {
          if (!settled) {
            settled = true;
            reject(new MemoryStoreError('memory-persistence-error'));
          }
          terminate();
        });
        timer = setTimeout(cancel, 5000);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      });
    },
    closeSync() {
      closed = true;
      for (const entry of workers) entry.cancel();
    },
    async drain() {
      const exits = [...workers].map((entry) => entry.exited);
      if (exits.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(exits),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new MemoryStoreError('memory-busy')), 5000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
