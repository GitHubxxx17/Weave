import { createHash, randomUUID, type Hash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  retrievalAcceptMutationSchema,
  retrievalCitationSchema,
  retrievalGenerationSchema,
  retrievalJobEventSchema,
  retrievalJobOperationKeySchema,
  retrievalLimits,
  retrievalManifestSchema,
  retrievalModeSchema,
  retrievalPreparedChunkSchema,
  retrievalProjectIdentitySchema,
  retrievalRequestKeySchema,
  retrievalQueryIntentSchema,
  retrievalTerminalSchema,
  retrievalUnitVectorSchema,
  sameRetrievalProject,
  type RetrievalGeneration,
  type RetrievalJobEvent,
  type RetrievalJobOperationKey,
  type RetrievalJobOperationReceipt,
  type RetrievalManifest,
  type RetrievalProjectIdentity,
  type RetrievalTerminal,
} from '@weave/protocol';
import { prepareDocuments } from './chunking.js';
import { persistence, RetrievalStoreError, RetrievalStoreStartupError } from './errors.js';
import {
  appendContent,
  digestStoredGeneration,
  ftsTable,
  hashBytes,
  rowCandidate,
  storedGeneration,
  uuid,
  vectorBytes,
} from './generation.js';
import { retrievalChunkId, retrievalManifestDigest, retrievalTextDigest } from './identity.js';
import { createRetrievalOwnership } from './ownership.js';
import { createJobProjection, sameGenerationBuild } from './projection.js';
import { createRetrievalQueryManager, type RetrievalQueryWorkerFactory } from './query.js';
import type { RetrievalIndex, RetrievalReadLease, RetrievalStageHandle } from './types.js';

const migration = `
CREATE TABLE retrieval_events (
  sequence INTEGER PRIMARY KEY CHECK(sequence > 0),
  id TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL
) STRICT;
CREATE TRIGGER retrieval_events_no_update BEFORE UPDATE ON retrieval_events
BEGIN SELECT RAISE(ABORT, 'retrieval events are append-only'); END;
CREATE TRIGGER retrieval_events_no_delete BEFORE DELETE ON retrieval_events
BEGIN SELECT RAISE(ABORT, 'retrieval events are append-only'); END;
PRAGMA user_version = 1;
`;

const derivedSchema = `
CREATE TABLE IF NOT EXISTS retrieval_generations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  folder_revision INTEGER NOT NULL,
  root_digest TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  published TEXT,
  content_digest TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS retrieval_generation_project ON retrieval_generations(project_id);
CREATE TABLE IF NOT EXISTS retrieval_documents (
  generation_id TEXT NOT NULL REFERENCES retrieval_generations(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('workspace', 'memory')),
  path TEXT,
  source TEXT NOT NULL,
  PRIMARY KEY(generation_id, source_key)
) STRICT;
CREATE TABLE IF NOT EXISTS retrieval_chunks (
  generation_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  chunk_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  chunk TEXT NOT NULL,
  vector BLOB,
  PRIMARY KEY(generation_id, position),
  UNIQUE(generation_id, chunk_id),
  FOREIGN KEY(generation_id, source_key) REFERENCES retrieval_documents(generation_id, source_key) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS retrieval_chunk_source ON retrieval_chunks(generation_id, source_key);
CREATE TABLE IF NOT EXISTS retrieval_active (
  project_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES retrieval_generations(id)
) STRICT;
`;

const stageInput = z.strictObject({
  jobId: uuid,
  generationId: uuid,
  manifest: retrievalManifestSchema,
});
const batchInput = z.strictObject({
  chunks: z.array(retrievalPreparedChunkSchema).min(1).max(128),
  vectors: z.array(retrievalUnitVectorSchema).min(1).max(128).optional(),
});
const jobPage = z.strictObject({
  projectId: uuid,
  limit: z.number().int().min(1).max(retrievalLimits.maxJobPage),
  beforeSequence: z.number().int().positive().safe().optional(),
});

type StageState = {
  readonly manifest: RetrievalManifest;
  readonly hash: Hash;
  readonly titles: ReadonlyMap<string, { title: string; path: string }>;
  written: number;
};

type LeaseState = {
  readonly generation: RetrievalGeneration;
  readers: number;
  released: boolean;
};

export interface SqliteRetrievalIndexOptions {
  readonly filename: string;
  readonly databaseFactory?: (filename: string) => DatabaseSync;
  readonly queryWorkerFactory?: RetrievalQueryWorkerFactory;
}

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new RetrievalStoreError('retrieval-invalid-input', { cause: result.error });
  return result.data;
}

function unavailable(cause?: unknown): RetrievalStoreError {
  return new RetrievalStoreError('retrieval-unavailable', { cause });
}

function probeFts(database: DatabaseSync): RetrievalIndex['capability'] {
  try {
    database.exec('CREATE VIRTUAL TABLE temp.retrieval_fts_probe USING fts5(terms)');
    database.exec('DROP TABLE temp.retrieval_fts_probe');
    return Object.freeze({ available: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'no such module: fts5')
      return Object.freeze({ available: false, reason: 'fts5-unavailable' });
    throw error;
  }
}

export function createSqliteRetrievalIndex(options: SqliteRetrievalIndexOptions): RetrievalIndex {
  const owner = (() => {
    try {
      return createRetrievalOwnership(options.filename);
    } catch (error) {
      throw persistence(error);
    }
  })();
  let database: DatabaseSync;
  let acquiredData: DatabaseSync | undefined;
  let journal: ReturnType<typeof createJobProjection>;
  let capability: RetrievalIndex['capability'];
  let pending: RetrievalJobEvent | undefined;
  let stopped = false;
  let closed = false;
  const leases = new Map<RetrievalReadLease, LeaseState>();
  const readers = createRetrievalQueryManager(owner.filename, options.queryWorkerFactory);
  const stages = new Map<RetrievalStageHandle, StageState>();
  const knownStageHandles = new WeakSet<RetrievalStageHandle>();
  const verified = new Set<string>();
  let lastCleanup: Promise<void> | undefined;

  function assertReadable() {
    if (closed || !database.isOpen) throw persistence();
    owner.assertHeldSync();
  }

  function assertRunning() {
    assertReadable();
    if (stopped) throw new RetrievalStoreError('retrieval-cancelled');
  }

  function reconcile(): boolean {
    if (!pending) return false;
    try {
      assertReadable();
      if (database.isTransaction) database.exec('ROLLBACK');
      if (database.isTransaction) throw persistence();
      const row = database
        .prepare('SELECT id, body FROM retrieval_events WHERE sequence = ?')
        .get(pending.sequence);
      if (!row) {
        pending = undefined;
        return false;
      }
      const known = pending;
      if (row.id !== known.eventId || row.body !== JSON.stringify(known)) throw persistence();
      journal.apply(known);
      if (known.kind === 'finished') {
        for (const stage of stages.keys()) {
          if (stage.jobId === known.receipt.key.jobId) stages.delete(stage);
        }
        if (known.receipt.terminal?.status === 'completed')
          verified.add(known.receipt.terminal.generation.generationId);
      }
      pending = undefined;
      return true;
    } catch (cause) {
      throw new RetrievalStoreError('retrieval-persistence-uncertain', { cause });
    }
  }

  function reconcileRead() {
    if (pending) reconcile();
    assertReadable();
    if (database.isTransaction) throw new RetrievalStoreError('retrieval-persistence-uncertain');
  }

  function transaction<T>(run: () => T, guardBeforeCommit?: () => void): T {
    if (pending || database.isTransaction)
      throw new RetrievalStoreError('retrieval-persistence-uncertain');
    owner.assertHeldSync();
    let result!: T;
    let committing = false;
    try {
      database.exec('BEGIN IMMEDIATE');
      result = run();
      owner.assertHeldSync();
      guardBeforeCommit?.();
      committing = true;
      database.exec('COMMIT');
      if (database.isTransaction) throw persistence();
      if (pending) reconcile();
      return result;
    } catch (error) {
      if (pending) {
        if (reconcile()) return result;
      } else if (database.isTransaction) {
        try {
          database.exec('ROLLBACK');
        } catch (rollbackFailure) {
          throw persistence(rollbackFailure);
        }
      }
      if (committing || (error instanceof Error && 'errcode' in error)) throw persistence(error);
      throw error;
    }
  }

  function append(raw: RetrievalJobEvent) {
    const event = retrievalJobEventSchema.parse(raw);
    pending = event;
    database
      .prepare('INSERT INTO retrieval_events (sequence, id, body) VALUES (?, ?, ?)')
      .run(event.sequence, event.eventId, JSON.stringify(event));
  }

  function nextEvent() {
    return {
      version: 1 as const,
      sequence: journal.sequence + 1,
      occurredAt: new Date().toISOString(),
      eventId: randomUUID(),
    };
  }

  function terminalEvent(
    key: RetrievalJobOperationKey,
    terminal: RetrievalTerminal,
    event: ReturnType<typeof nextEvent>,
  ): RetrievalJobOperationReceipt {
    const receipt = { key, sequence: event.sequence, occurredAt: event.occurredAt, terminal };
    append({ ...event, kind: 'finished', receipt });
    return receipt;
  }

  function removeGeneration(id: string) {
    database.exec(`DROP TABLE IF EXISTS ${ftsTable(id)}`);
    database.prepare('DELETE FROM retrieval_generations WHERE id = ?').run(id);
  }

  function activeStageIds() {
    return new Set([...stages.keys()].map(({ generationId }) => generationId));
  }

  function collect(projectId?: string) {
    if (!capability.available) return;
    const kept = activeStageIds();
    const candidates =
      projectId === undefined
        ? database.prepare('SELECT id, project_id FROM retrieval_generations').all()
        : database
            .prepare('SELECT id, project_id FROM retrieval_generations WHERE project_id = ?')
            .all(projectId);
    for (const state of leases.values()) kept.add(state.generation.generationId);
    for (const row of candidates) {
      const id = uuid.parse(row.id);
      const ownerProject = uuid.parse(row.project_id);
      if (
        !kept.has(id) &&
        !journal.generations(ownerProject).some(({ generationId }) => generationId === id)
      )
        removeGeneration(id);
    }
  }

  function validateGeneration(generation: RetrievalGeneration) {
    const id = generation.generationId;
    const row = database
      .prepare(
        `
      SELECT project_id, folder_revision, root_digest, job_id, content_digest
      FROM retrieval_generations WHERE id = ?
    `,
      )
      .get(id);
    if (
      !row ||
      row.project_id !== generation.project.projectId ||
      row.folder_revision !== generation.project.folderRevision ||
      row.root_digest !== generation.project.rootDigest ||
      row.job_id !== generation.jobId ||
      !isDeepStrictEqual(storedGeneration(database, id), generation) ||
      row.content_digest !== digestStoredGeneration(database, generation)
    )
      throw persistence();
    const fts = ftsTable(id);
    database.exec(`INSERT INTO ${fts}(${fts}) VALUES ('integrity-check')`);
  }

  function integrityError(error: unknown): boolean {
    if (
      error instanceof RetrievalStoreError ||
      error instanceof SyntaxError ||
      error instanceof z.ZodError
    )
      return true;
    if (!(error instanceof Error)) return false;
    if (error.message.startsWith('no such table: retrieval_fts_')) return true;
    return 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & 0xff) === 11;
  }

  function rebuildDerived() {
    database.exec(derivedSchema);
    database.exec('DELETE FROM retrieval_active');
    if (!capability.available) return;
    for (const projectId of journal.publishedProjects()) {
      const history = journal.generations(projectId);
      for (const [index, generation] of history.entries()) {
        try {
          validateGeneration(generation);
          if (index === 0)
            database
              .prepare('INSERT INTO retrieval_active VALUES (?, ?)')
              .run(projectId, generation.generationId);
          verified.add(generation.generationId);
        } catch (error) {
          if (!integrityError(error)) throw error;
        }
      }
    }
    collect();
  }

  const cleanup = {
    closeSync() {
      stopped = true;
      readers.closeSync();
      if (closed) return;
      if (readers.size !== 0 || leases.size !== 0) throw new RetrievalStoreError('retrieval-busy');
      if (pending) reconcile();
      if (acquiredData?.isOpen) acquiredData.close();
      if (owner.isOpen) owner.close();
      closed = true;
    },
    async drain() {
      await readers.drain();
      if (leases.size !== 0) throw new RetrievalStoreError('retrieval-busy');
      if (pending) reconcile();
    },
    close() {
      readers.closeSync();
      stopped = true;
      lastCleanup ??= cleanup
        .drain()
        .then(() => cleanup.closeSync())
        .finally(() => {
          lastCleanup = undefined;
        });
      return lastCleanup;
    },
  };

  try {
    owner.acquire();
    database = acquiredData =
      options.databaseFactory?.(owner.filename) ??
      new DatabaseSync(owner.filename, { open: false });
    if (!database.isOpen) database.open();
    database.exec(
      'PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON',
    );
    if (database.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode !== 'wal')
      throw persistence();
    database.exec('PRAGMA synchronous = FULL');
    const version = database.prepare('PRAGMA user_version').get()?.user_version;
    if (version === 0) transaction(() => database.exec(migration));
    else if (version !== 1) throw persistence();
    const triggers = database
      .prepare(
        `
      SELECT count(*) AS total FROM sqlite_schema
      WHERE type = 'trigger' AND tbl_name = 'retrieval_events'
      AND name IN ('retrieval_events_no_update', 'retrieval_events_no_delete')
    `,
      )
      .get()?.total;
    if (triggers !== 2) throw persistence();
    journal = createJobProjection(database);
    capability = probeFts(database);
    transaction(rebuildDerived);
  } catch (error) {
    try {
      cleanup.closeSync();
    } catch (cause) {
      if (acquiredData?.isOpen || owner.isOpen)
        throw new RetrievalStoreStartupError(cleanup, {
          cause: new AggregateError([error, cause]),
        });
    }
    throw persistence(error);
  }

  function exactStage(stage: RetrievalStageHandle): StageState {
    const state = stages.get(stage);
    if (!state) throw new RetrievalStoreError('retrieval-request-conflict');
    return state;
  }

  function exactLease(lease: RetrievalReadLease): LeaseState {
    const state = leases.get(lease);
    if (!state || state.released) throw unavailable();
    return state;
  }

  function status(project: RetrievalProjectIdentity) {
    const history = journal.generations(project.projectId);
    const [latest, prior] = history;
    const job = journal.currentJob(project.projectId);
    const flags = job ? { activeJob: { job: structuredClone(job) } } : {};
    if (!capability.available)
      return {
        project,
        availability: 'generation-unavailable' as const,
        needsRebuild: true,
        ...flags,
      };
    if (!latest)
      return { project, availability: 'not-built' as const, needsRebuild: true, ...flags };
    if (!sameRetrievalProject(latest.project, project))
      return { project, availability: 'root-changed' as const, needsRebuild: true, ...flags };
    const active = database
      .prepare('SELECT generation_id FROM retrieval_active WHERE project_id = ?')
      .get(project.projectId);
    if (!verified.has(latest.generationId) || active?.generation_id !== latest.generationId)
      return {
        project,
        availability: 'generation-unavailable' as const,
        needsRebuild: true,
        ...flags,
      };
    const previous =
      prior && sameRetrievalProject(prior.project, project) && verified.has(prior.generationId)
        ? { previous: structuredClone(prior) }
        : {};
    return {
      project,
      availability: 'ready' as const,
      needsRebuild: false,
      active: structuredClone(latest),
      ...previous,
      ...flags,
    };
  }

  const index: RetrievalIndex = {
    ...cleanup,
    capability,
    prepareDocuments,
    manifestDigest: retrievalManifestDigest,
    accept(raw, guard) {
      assertRunning();
      if (!capability.available) throw unavailable();
      const mutation = input(retrievalAcceptMutationSchema, raw);
      const receipt = transaction(() => {
        guard.assertAuthorizedSync();
        const replay = journal.lookupAccepted(mutation.key);
        if (replay) return replay;
        guard.assertNewMutationSync();
        journal.assertAcceptable(mutation);
        const event = nextEvent();
        const receipt = {
          operation: 'retrieval.index' as const,
          requestId: mutation.key.requestId,
          requestDigest: mutation.key.requestDigest,
          jobId: mutation.jobId,
          acceptedSequence: event.sequence,
          project: mutation.project,
          manifestDigest: mutation.manifestDigest,
        };
        append({ ...event, kind: 'accepted', mutation, receipt });
        return receipt;
      }, guard.assertAuthorizedSync);
      return structuredClone(receipt);
    },
    lookupAccepted(raw) {
      reconcileRead();
      return structuredClone(journal.lookupAccepted(input(retrievalRequestKeySchema, raw)));
    },
    lookupJobOperation(raw) {
      reconcileRead();
      return structuredClone(journal.lookupOperation(input(retrievalJobOperationKeySchema, raw)));
    },
    markStarted({ key: raw }, guard) {
      assertRunning();
      const key = input(retrievalJobOperationKeySchema, raw);
      if (key.operation !== 'started') throw new RetrievalStoreError('retrieval-invalid-input');
      return structuredClone(
        transaction(() => {
          guard.assertCurrentSync();
          const replay = journal.lookupOperation(key);
          if (replay) return replay;
          journal.assertStartable(key.jobId);
          const event = nextEvent();
          const receipt = { key, sequence: event.sequence, occurredAt: event.occurredAt };
          append({ ...event, kind: 'started', receipt });
          return receipt;
        }, guard.assertCurrentSync),
      );
    },
    beginStage(raw, guard) {
      assertRunning();
      if (!capability.available) throw unavailable();
      const { jobId, generationId, manifest } = input(stageInput, raw);
      const build = journal.mutation(jobId);
      const identity = {
        generationId,
        jobId,
        project: manifest.project,
        mode: manifest.mode,
        manifestDigest: manifest.manifestDigest,
        versions: manifest.versions,
        counts: manifest.counts,
        indexedAt: new Date().toISOString(),
        ...(manifest.embedding ? { vectorIdentity: manifest.embedding.identity } : {}),
      };
      if (
        !build ||
        !sameGenerationBuild(identity, build) ||
        journal.hasGeneration(generationId) ||
        retrievalManifestDigest(manifest) !== manifest.manifestDigest
      )
        throw new RetrievalStoreError('retrieval-request-conflict');
      const handle = Object.freeze({ jobId, generationId });
      const hash = createHash('sha256');
      const titles = new Map<string, { title: string; path: string }>();
      transaction(() => {
        guard.assertCurrentSync();
        journal.assertFinishable(jobId, true);
        collect(manifest.project.projectId);
        const count = database
          .prepare('SELECT count(*) AS total FROM retrieval_generations WHERE project_id = ?')
          .get(manifest.project.projectId)?.total;
        if (typeof count !== 'number') throw persistence();
        if (count >= retrievalLimits.maxGenerationsPerProject)
          throw new RetrievalStoreError('retrieval-busy');
        database
          .prepare(
            `
          INSERT INTO retrieval_generations(id, project_id, folder_revision, root_digest, job_id)
          VALUES (?, ?, ?, ?, ?)
        `,
          )
          .run(
            generationId,
            manifest.project.projectId,
            manifest.project.folderRevision,
            manifest.project.rootDigest,
            jobId,
          );
        database.exec(
          `CREATE VIRTUAL TABLE ${ftsTable(generationId)} USING fts5(title, path, body, terms, tokenize='unicode61 remove_diacritics 0')`,
        );
        const insert = database.prepare('INSERT INTO retrieval_documents VALUES (?, ?, ?, ?, ?)');
        for (const summary of manifest.sources) {
          const { source, title } = summary;
          const path = source.kind === 'workspace' ? source.path : null;
          const rawSource = JSON.stringify(summary);
          insert.run(generationId, source.sourceKey, source.kind, path, rawSource);
          appendContent(hash, [source.sourceKey, source.kind, path, rawSource]);
          titles.set(source.sourceKey, { title, path: path ?? '' });
        }
      }, guard.assertCurrentSync);
      stages.set(handle, { manifest, hash, titles, written: 0 });
      knownStageHandles.add(handle);
      return handle;
    },
    stageBatch(stage, raw, guard) {
      assertRunning();
      const state = exactStage(stage);
      const { chunks, vectors } = input(batchInput, raw);
      const matchVectors =
        state.manifest.mode === 'hybrid'
          ? vectors?.length === chunks.length
          : vectors === undefined;
      if (!matchVectors) throw new RetrievalStoreError('retrieval-invalid-input');
      const first = state.written;
      const entries = chunks.map((chunk, offset) => {
        const index = first + offset;
        const { identity, terms, text } = chunk;
        if (
          !isDeepStrictEqual(chunk, state.manifest.chunks[index]) ||
          retrievalChunkId(identity) !== identity.chunkId ||
          retrievalTextDigest(text) !== identity.textSha256
        )
          throw new RetrievalStoreError('retrieval-request-conflict');
        const summary = state.titles.get(identity.sourceKey);
        if (!summary) throw persistence();
        const vector = vectors?.[offset];
        const bytes = vector ? vectorBytes(vector.values) : null;
        if (vector && (vector.chunkId !== identity.chunkId || vector.sha256 !== hashBytes(bytes!)))
          throw new RetrievalStoreError('retrieval-invalid-input');
        return {
          position: index + 1,
          chunkId: identity.chunkId,
          sourceKey: identity.sourceKey,
          ordinal: identity.ordinal,
          data: JSON.stringify(chunk),
          bytes,
          title: summary.title,
          path: summary.path,
          text,
          terms,
        };
      });
      transaction(() => {
        guard.assertCurrentSync();
        journal.assertFinishable(stage.jobId, true);
        const insertChunk = database.prepare(
          'INSERT INTO retrieval_chunks VALUES (?, ?, ?, ?, ?, ?, ?)',
        );
        const insertFts = database.prepare(
          `INSERT INTO ${ftsTable(stage.generationId)} (rowid, title, path, body, terms) VALUES (?, ?, ?, ?, ?)`,
        );
        for (const row of entries) {
          insertChunk.run(
            stage.generationId,
            row.position,
            row.chunkId,
            row.sourceKey,
            row.ordinal,
            row.data,
            row.bytes,
          );
          insertFts.run(row.position, row.title, row.path, row.text, row.terms);
        }
      }, guard.assertCurrentSync);
      for (const row of entries) {
        appendContent(state.hash, [
          row.position,
          row.chunkId,
          row.sourceKey,
          row.ordinal,
          row.data,
          row.bytes,
          row.title,
          row.path,
          row.text,
          row.terms,
        ]);
      }
      state.written += chunks.length;
    },
    publish(stage, { key: raw }, guard) {
      assertRunning();
      const key = input(retrievalJobOperationKeySchema, raw);
      if (!knownStageHandles.has(stage))
        throw new RetrievalStoreError('retrieval-request-conflict');
      if (key.operation !== 'finished' || key.jobId !== stage.jobId)
        throw new RetrievalStoreError('retrieval-invalid-input');
      const receipt = transaction(() => {
        const replay = journal.lookupOperation(key);
        if (replay) {
          guard.assertPublishCurrentSync();
          if (
            replay.terminal?.status !== 'completed' ||
            replay.terminal.generation.generationId !== stage.generationId
          )
            throw new RetrievalStoreError('retrieval-request-conflict');
          return replay;
        }
        const state = exactStage(stage);
        const { manifest, written } = state;
        journal.assertFinishable(stage.jobId, true);
        if (written !== manifest.chunks.length) throw unavailable();
        const event = nextEvent();
        const generation = retrievalGenerationSchema.parse({
          generationId: stage.generationId,
          jobId: stage.jobId,
          project: manifest.project,
          mode: manifest.mode,
          counts: manifest.counts,
          versions: manifest.versions,
          manifestDigest: manifest.manifestDigest,
          indexedAt: event.occurredAt,
          ...(manifest.embedding ? { vectorIdentity: manifest.embedding.identity } : {}),
        });
        const digest = state.hash.copy().digest('hex');
        if (digestStoredGeneration(database, generation) !== digest) throw unavailable();
        guard.assertPublishCurrentSync();
        const updated = database
          .prepare(
            `
          UPDATE retrieval_generations SET published = ?, content_digest = ?
          WHERE id = ? AND job_id = ? AND project_id = ? AND folder_revision = ? AND root_digest = ? AND published IS NULL
        `,
          )
          .run(
            JSON.stringify(generation),
            digest,
            generation.generationId,
            generation.jobId,
            generation.project.projectId,
            generation.project.folderRevision,
            generation.project.rootDigest,
          );
        if (updated.changes !== 1) throw unavailable();
        const receipt = terminalEvent(key, { status: 'completed', generation }, event);
        database
          .prepare(
            `
          INSERT INTO retrieval_active VALUES (?, ?)
          ON CONFLICT(project_id) DO UPDATE SET generation_id = excluded.generation_id
        `,
          )
          .run(generation.project.projectId, generation.generationId);
        return receipt;
      }, guard.assertPublishCurrentSync);
      stages.delete(stage);
      return structuredClone(receipt);
    },
    finish({ key: raw, terminal: rawTerminal }, guard) {
      assertRunning();
      const key = input(retrievalJobOperationKeySchema, raw);
      const terminal = input(retrievalTerminalSchema, rawTerminal);
      if (key.operation !== 'finished' || terminal.status === 'completed')
        throw new RetrievalStoreError('retrieval-invalid-input');
      return structuredClone(
        transaction(() => {
          guard.assertCanFinishSync();
          const replay = journal.lookupOperation(key);
          if (replay) {
            if (!isDeepStrictEqual(replay.terminal, terminal))
              throw new RetrievalStoreError('retrieval-request-conflict');
            return replay;
          }
          journal.assertFinishable(key.jobId, false);
          return terminalEvent(key, terminal, nextEvent());
        }, guard.assertCanFinishSync),
      );
    },
    getJob(projectId, jobId) {
      reconcileRead();
      return structuredClone(journal.getJob(input(uuid, projectId), input(uuid, jobId)));
    },
    listJobs(raw) {
      reconcileRead();
      const { projectId, limit, beforeSequence } = input(jobPage, raw);
      return structuredClone(journal.listJobs(projectId, limit, beforeSequence));
    },
    status(project) {
      reconcileRead();
      return status(input(retrievalProjectIdentitySchema, project));
    },
    unfinishedJobs() {
      reconcileRead();
      return structuredClone(journal.unfinishedJobs());
    },
    leaseActive(raw, expectedGenerationId) {
      assertRunning();
      const project = input(retrievalProjectIdentitySchema, raw);
      if (expectedGenerationId !== undefined) input(uuid, expectedGenerationId);
      if (leases.size >= retrievalLimits.maxReaders)
        throw new RetrievalStoreError('retrieval-busy');
      const active = status(project);
      if (active.availability === 'root-changed')
        throw new RetrievalStoreError('retrieval-root-changed');
      if (
        active.availability !== 'ready' ||
        !active.active ||
        (expectedGenerationId !== undefined && active.active.generationId !== expectedGenerationId)
      )
        throw unavailable();
      const generation = active.active;
      const lease = Object.freeze({ generation: structuredClone(generation) });
      leases.set(lease, { generation, readers: 0, released: false });
      return lease;
    },
    async query({ lease, mode: rawMode, intent: rawIntent, memoryAllowed, vector }, options) {
      assertRunning();
      const state = exactLease(lease);
      if (state.readers !== 0) throw new RetrievalStoreError('retrieval-busy');
      const mode = input(retrievalModeSchema, rawMode);
      const intent = input(retrievalQueryIntentSchema, rawIntent);
      if (typeof memoryAllowed !== 'boolean' || !Number.isFinite(options.deadline))
        throw new RetrievalStoreError('retrieval-invalid-input');
      if (mode === 'hybrid' && (!vector || state.generation.mode !== 'hybrid'))
        throw new RetrievalStoreError('retrieval-semantic-unavailable');
      if (mode === 'lexical' && vector !== undefined)
        throw new RetrievalStoreError('retrieval-invalid-input');
      if (vector) vectorBytes(vector);
      state.readers++;
      let started = false;
      const onExit = () => {
        state.readers--;
        if (state.released) leases.delete(lease);
      };
      try {
        const result = readers.query(
          {
            generation: state.generation,
            mode,
            intent,
            memoryAllowed,
            ...(vector ? { vector: [...vector] } : {}),
          },
          options,
          onExit,
        );
        started = true;
        return await result;
      } finally {
        if (!started) onExit();
      }
    },
    readChunk(lease, raw) {
      assertRunning();
      const { generation } = exactLease(lease);
      const citation = input(retrievalCitationSchema, raw);
      if (
        citation.generationId !== generation.generationId ||
        !sameRetrievalProject(citation.project, generation.project)
      )
        return undefined;
      const row = database
        .prepare(
          `
        SELECT d.source, c.chunk FROM retrieval_chunks c
        JOIN retrieval_documents d USING(generation_id, source_key)
        WHERE c.generation_id = ? AND c.chunk_id = ?
      `,
        )
        .get(generation.generationId, citation.chunk.chunkId);
      if (!row) return undefined;
      const found = rowCandidate(row);
      return isDeepStrictEqual(found.chunk, citation.chunk) &&
        isDeepStrictEqual(found.source, citation.source)
        ? found
        : undefined;
    },
    releaseReadLease(lease) {
      const state = leases.get(lease);
      if (!state) return;
      state.released = true;
      if (state.readers === 0) leases.delete(lease);
    },
    discardStage(stage) {
      if (!stages.has(stage)) return;
      reconcileRead();
      if (journal.hasGeneration(stage.generationId)) {
        stages.delete(stage);
        return;
      }
      transaction(() => removeGeneration(stage.generationId));
      stages.delete(stage);
    },
    collectGarbage(projectId) {
      reconcileRead();
      const project = input(uuid, projectId);
      transaction(() => collect(project));
    },
  };
  return index;
}
