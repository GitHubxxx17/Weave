import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  retrievalJobEventSchema,
  retrievalJobSchema,
  retrievalLimits,
  sameRetrievalProject,
  type RetrievalAcceptMutation,
  type RetrievalGeneration,
  type RetrievalJob,
  type RetrievalJobEvent,
  type RetrievalJobOperationKey,
  type RetrievalJobOperationReceipt,
  type RetrievalReceipt,
  type RetrievalRequestKey,
} from '@weave/protocol';
import { persistence, RetrievalStoreError } from './errors.js';

type JobEntry = {
  readonly mutation: RetrievalAcceptMutation;
  job: RetrievalJob;
};

function requestIdentity(key: RetrievalRequestKey): string {
  return key.callerKey === 'local-user'
    ? JSON.stringify([key.callerKey, key.projectId, key.requestId])
    : JSON.stringify(['agent', key.callerKey]);
}

function invocationIdentity(mutation: RetrievalAcceptMutation): string | undefined {
  const { provenance } = mutation;
  if (provenance.actor === 'agent') {
    const { sessionId, executionId, turnId, toolCallId } = provenance;
    return JSON.stringify([sessionId, executionId, turnId, toolCallId]);
  }
}

export function createJobProjection(database: DatabaseSync) {
  let sequence = 0;
  const jobs = new Map<string, JobEntry>();
  const projectJobs = new Map<string, JobEntry[]>();
  const unfinished = new Map<string, JobEntry>();
  const publications = new Map<string, RetrievalGeneration[]>();
  const generationIds = new Set<string>();
  const requests = new Map<string, JobEntry>();
  const invocations = new Set<string>();
  const operations = new Map<string, RetrievalJobOperationReceipt>();

  function apply(event: RetrievalJobEvent): void {
    if (event.sequence !== sequence + 1) throw persistence();
    if (event.kind === 'accepted') {
      const { mutation, receipt } = event;
      const projectId = mutation.project.projectId;
      const request = requestIdentity(mutation.key);
      const invocation = invocationIdentity(mutation);
      if (
        jobs.has(receipt.jobId) ||
        requests.has(request) ||
        (invocation !== undefined && invocations.has(invocation)) ||
        unfinished.has(projectId) ||
        unfinished.size >= retrievalLimits.maxJobs
      )
        throw persistence();
      const entry = {
        mutation,
        job: {
          receipt,
          mode: mutation.mode,
          counts: mutation.counts,
          acceptedAt: event.occurredAt,
          provenance: mutation.provenance,
        },
      };
      const history = projectJobs.get(projectId) ?? [];
      history.push(entry);
      projectJobs.set(projectId, history);
      unfinished.set(projectId, entry);
      jobs.set(receipt.jobId, entry);
      requests.set(request, entry);
      if (invocation !== undefined) invocations.add(invocation);
    } else {
      const { key, terminal } = event.receipt;
      const entry = jobs.get(key.jobId);
      if (!entry || entry.job.terminal || operations.has(key.operationId)) throw persistence();
      if (event.kind === 'started') {
        if (entry.job.startedAt !== undefined) throw persistence();
        entry.job = { ...entry.job, startedAt: event.occurredAt };
      } else {
        if (terminal === undefined) throw persistence();
        if (terminal.status === 'completed') {
          const { generation } = terminal;
          if (
            entry.job.startedAt === undefined ||
            generation.indexedAt !== event.occurredAt ||
            generationIds.has(generation.generationId) ||
            !isDeepStrictEqual(generation.vectorIdentity, entry.mutation.vectorIdentity)
          )
            throw persistence();
          const projectId = generation.project.projectId;
          publications.set(
            projectId,
            [generation, ...(publications.get(projectId) ?? [])].slice(0, 2),
          );
          generationIds.add(generation.generationId);
        }
        entry.job = retrievalJobSchema.parse({
          ...entry.job,
          terminal,
          finishedAt: event.occurredAt,
        });
        unfinished.delete(entry.mutation.project.projectId);
      }
      operations.set(key.operationId, event.receipt);
    }
    sequence = event.sequence;
  }

  for (const row of database
    .prepare('SELECT sequence, id, body FROM retrieval_events ORDER BY sequence')
    .iterate()) {
    if (typeof row.body !== 'string') throw persistence();
    const event = retrievalJobEventSchema.parse(JSON.parse(row.body) as unknown);
    if (event.sequence !== row.sequence || event.eventId !== row.id) throw persistence();
    apply(event);
  }

  return {
    get sequence() {
      return sequence;
    },
    apply,
    mutation(jobId: string) {
      return jobs.get(jobId)?.mutation;
    },
    currentJob(projectId: string) {
      return unfinished.get(projectId)?.job;
    },
    unfinishedJobs() {
      return [...unfinished.values()].map(({ job }) => job);
    },
    publishedProjects() {
      return [...publications.keys()];
    },
    generations(projectId: string) {
      return publications.get(projectId) ?? [];
    },
    lookupAccepted(key: RetrievalRequestKey): RetrievalReceipt | undefined {
      const entry = requests.get(requestIdentity(key));
      if (!entry) return undefined;
      if (!isDeepStrictEqual(entry.mutation.key, key))
        throw new RetrievalStoreError('retrieval-request-conflict');
      return entry.job.receipt;
    },
    lookupOperation(key: RetrievalJobOperationKey): RetrievalJobOperationReceipt | undefined {
      const operation = operations.get(key.operationId);
      if (operation && !isDeepStrictEqual(operation.key, key))
        throw new RetrievalStoreError('retrieval-request-conflict');
      return operation;
    },
    assertAcceptable(mutation: RetrievalAcceptMutation) {
      const invocation = invocationIdentity(mutation);
      if (jobs.has(mutation.jobId) || (invocation !== undefined && invocations.has(invocation)))
        throw new RetrievalStoreError('retrieval-request-conflict');
      if (unfinished.has(mutation.project.projectId) || unfinished.size >= retrievalLimits.maxJobs)
        throw new RetrievalStoreError('retrieval-busy');
    },
    assertStartable(jobId: string) {
      const job = jobs.get(jobId)?.job;
      if (!job) throw new RetrievalStoreError('retrieval-not-found');
      if (job.startedAt !== undefined || job.terminal)
        throw new RetrievalStoreError('retrieval-request-conflict');
    },
    assertFinishable(jobId: string, requireStarted: boolean) {
      const job = jobs.get(jobId)?.job;
      if (!job) throw new RetrievalStoreError('retrieval-not-found');
      if (job.terminal || (requireStarted && job.startedAt === undefined))
        throw new RetrievalStoreError('retrieval-request-conflict');
    },
    hasGeneration(generationId: string) {
      return generationIds.has(generationId);
    },
    getJob(projectId: string, jobId: string) {
      const entry = jobs.get(jobId);
      return entry?.mutation.project.projectId === projectId ? entry.job : undefined;
    },
    listJobs(projectId: string, limit: number, beforeSequence?: number) {
      const entries = projectJobs.get(projectId) ?? [];
      let end = entries.length;
      if (beforeSequence !== undefined) {
        let start = 0;
        while (start < end) {
          const middle = Math.floor((start + end) / 2);
          if (entries[middle]!.job.receipt.acceptedSequence < beforeSequence) start = middle + 1;
          else end = middle;
        }
      }
      const start = Math.max(0, end - limit);
      return {
        jobs: entries
          .slice(start, end)
          .reverse()
          .map(({ job }) => job),
        hasMore: start > 0,
      };
    },
  };
}

export function sameGenerationBuild(
  generation: RetrievalGeneration,
  mutation: RetrievalAcceptMutation,
): boolean {
  return (
    generation.jobId === mutation.jobId &&
    sameRetrievalProject(generation.project, mutation.project) &&
    generation.mode === mutation.mode &&
    generation.manifestDigest === mutation.manifestDigest &&
    isDeepStrictEqual(generation.counts, mutation.counts) &&
    isDeepStrictEqual(generation.vectorIdentity, mutation.vectorIdentity)
  );
}
