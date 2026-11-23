import {
  memoryAccessSchema,
  memoryContentSchema,
  memoryCurrentSchema,
  memoryErrorCodeSchema,
  memoryHistoryEntrySchema,
  memoryIdSchema,
  memoryQuerySchema,
  memoryReceiptSchema,
  memoryRecordInputSchema,
  memoryRefSchema,
  memoryScopeSchema,
  memorySummarySchema,
  normalizeMemoryText,
  type MemoryCurrent,
  type MemoryReceipt,
  type MemoryRecordInput,
  type MemoryRef,
  type MemoryScope,
  type MemorySummary,
} from '@weave/protocol';
import { z } from 'zod';
import {
  agentToolAuthorityParent,
  type AgentToolInvocationAuthority,
} from './agent-tool-authority.js';
import { defaultAgentMaxToolResultTokens } from './agent-runner.js';
import { estimateTokens } from './context/token-estimate.js';
import { createMemoryCursorCodec, memoryCanonicalJson, memoryDigest } from './memory-cursor.js';
import { MemoryError, isMemoryError } from './memory-errors.js';
import {
  memoryAccessInputSchema,
  memoryAgentDeleteSchema,
  memoryAgentReadSchema,
  memoryAgentSaveSchema,
  memoryAgentSearchSchema,
  memoryDeleteInputSchema,
  memoryHistoryQuerySchema,
  memoryReviewInputSchema,
  type MemoryAgentDeleteInput,
  type MemoryAgentReadInput,
  type MemoryAgentSaveInput,
  type MemoryAgentSearchInput,
} from './memory-input.js';
import { memoryCallerAuthority, type MemoryWriteOperation } from './memory-tool-attempt.js';
import type {
  MemoryInvalidation,
  MemoryLocalScopeEvidence,
  MemoryMutation,
  MemoryRequestKey,
  MemoryStoreWritePort,
  MemoryPage,
  MemoryScopeEvidence,
  MemoryScopeHead,
  MemorySearchInput,
  MemoryServiceOptions,
  ReviewedMemoryCapture,
  ReviewedMemorySource,
} from './memory-types.js';

const sortKeySchema = z.strictObject({
  titleHit: z.number().int().min(0).max(1),
  updatedAt: z.iso.datetime(),
  scopeRank: z.number().int().min(0).max(1),
  memoryId: memoryIdSchema,
});
const offsetSchema = z.strictObject({ offset: z.number().int().nonnegative().safe() });
const historyAfterSchema = z.strictObject({ revision: z.number().int().positive().safe() });
const selectionSchema = z.enum(['project', 'user']).optional();
const same = (left: unknown, right: unknown): boolean =>
  memoryCanonicalJson(left) === memoryCanonicalJson(right);
const scopeKey = (scope: MemoryScope) =>
  scope.kind === 'user' ? 'user' : `project:${scope.projectId}`;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function safeFailure(error: unknown): MemoryError {
  if (isMemoryError(error)) return error;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const parsed = memoryErrorCodeSchema.safeParse(error.code);
    if (parsed.success) return new MemoryError(parsed.data);
  }
  return new MemoryError('memory-persistence-error');
}

function agentRequestId(
  caller: AgentToolInvocationAuthority,
  operation: MemoryWriteOperation,
): string {
  const hex = memoryDigest([
    'weave.memory.request.v1',
    caller.identity.sessionId,
    caller.identity.executionId,
    caller.identity.turnId,
    caller.toolCallId,
    operation,
  ]);
  const variant = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface MemoryWriteIntent {
  readonly caller: AgentToolInvocationAuthority;
  readonly operation: MemoryWriteOperation;
  readonly scope: MemoryScope;
  readonly membership: MemoryScopeEvidence['membership'];
  readonly accessSettingRevision: number;
  readonly targetRef?: MemoryRef;
  readonly target?: Pick<MemoryCurrent, 'title' | 'review' | 'provenance'>;
  readonly replayReceipt?: MemoryReceipt;
  readonly normalizedInput: MemoryAgentSaveInput | MemoryAgentDeleteInput;
  readonly requestId: string;
  readonly digest: string;
}

export interface MemoryReadPage {
  readonly untrustedData: true;
  readonly ref: MemoryRef;
  readonly title: string;
  readonly tags: readonly string[];
  readonly review: MemoryCurrent['review'];
  readonly provenance: MemoryCurrent['provenance'];
  readonly offset: number;
  readonly text: string;
  readonly eof: boolean;
  readonly nextCursor?: string;
}

/** Runtime owns caller/scope authority; the injected leaf owns durable consistency. */
export function createMemoryService(options: MemoryServiceOptions) {
  const { store } = options;
  const cursor = createMemoryCursorCodec();
  const controller = new AbortController();
  const epochs = new Map<string, number>();
  const captures = new WeakMap<
    object,
    { scope: MemoryScope; settingRevision: number; epoch: number }
  >();
  const intents = new WeakMap<MemoryWriteIntent, { evidence: MemoryScopeEvidence }>();
  const active = new Set<Promise<unknown>>();
  const pendingWrites = new Map<string, MemoryRequestKey>();
  const toolMaxBytes = Math.min(24_576, options.budgets?.maxBytes ?? 32_000);
  const toolMaxTokens = options.budgets?.maxToolResultTokens ?? defaultAgentMaxToolResultTokens;
  if (
    !Number.isSafeInteger(toolMaxBytes) ||
    toolMaxBytes < 1 ||
    !Number.isSafeInteger(toolMaxTokens) ||
    toolMaxTokens < 1
  )
    throw new RangeError('Memory budgets must be positive integers');
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new MemoryError('memory-cancelled');
  };
  const epoch = (scope: MemoryScope) => epochs.get(scopeKey(scope)) ?? 0;
  const access = (scope: MemoryScope) => memoryAccessSchema.parse(store.getAccess(scope));
  const within = (value: unknown, tool: boolean): boolean => {
    const text = JSON.stringify(value);
    return (
      Buffer.byteLength(text) <= (tool ? toolMaxBytes : 65_536) &&
      (!tool || estimateTokens(text) <= toolMaxTokens)
    );
  };
  function track<T>(operation: () => Promise<T>): Promise<T> {
    const promise = (async () => {
      assertOpen();
      try {
        return await operation();
      } catch (error) {
        throw safeFailure(error);
      }
    })();
    active.add(promise);
    void promise.finally(() => active.delete(promise)).catch(() => undefined);
    return promise;
  }
  async function localEvidence(scopeInput: MemoryScope) {
    assertOpen();
    const scope = memoryScopeSchema.parse(scopeInput);
    const evidence = await options.resolveLocalScope(scope);
    assertOpen();
    evidence.assertCurrentSync();
    return { scope, evidence };
  }
  function beforeCommit(change: Omit<MemoryInvalidation, 'liveEpoch'>): undefined {
    const next = epoch(change.scope) + 1;
    epochs.set(scopeKey(change.scope), next);
    const result = options.beforeMemoryCommit?.({ ...change, liveEpoch: next });
    if (result !== undefined) throw new MemoryError('memory-persistence-error');
    return undefined;
  }
  function reconcileKnownPending(key: MemoryRequestKey): void {
    const pending = pendingWrites.get(scopeKey(key.scope));
    if (pending === undefined) return;
    if (!same(key, pending)) throw new MemoryError('memory-persistence-uncertain');
    // Only a host-retained exact key may enter reconciliation. The result remains
    // private until the ordinary guarded commit rechecks current authorization.
    store.lookupReceipt(pending);
    pendingWrites.delete(scopeKey(key.scope));
  }
  function guardedCommit(
    mutation: MemoryMutation,
    guard: Parameters<MemoryStoreWritePort['commit']>[1],
  ): MemoryReceipt {
    reconcileKnownPending(mutation.key);
    try {
      return store.commit(mutation, guard);
    } catch (error) {
      const failure = safeFailure(error);
      if (failure.code === 'memory-persistence-uncertain')
        pendingWrites.set(scopeKey(mutation.key.scope), mutation.key);
      throw failure;
    }
  }
  function localCommit(
    mutation: MemoryMutation,
    evidence: MemoryLocalScopeEvidence,
  ): MemoryReceipt {
    const check = () => {
      assertOpen();
      evidence.assertCurrentSync();
    };
    check();
    return memoryReceiptSchema.parse(
      guardedCommit(mutation, {
        assertAuthorized: check,
        assertNewMutation: check,
        beforeCommit(change) {
          check();
          return beforeCommit(change);
        },
      }),
    );
  }
  function localMutation(
    scope: MemoryScope,
    kind: MemoryMutation['kind'],
    requestId: string,
    payload: unknown,
  ) {
    return {
      key: {
        scope,
        requestId,
        callerKey: 'local-user',
        digest: memoryDigest({ version: 1, scope, kind, caller: 'local-user', payload }),
      },
      provenance: { actor: 'local-user' as const },
    };
  }
  function snapshot(
    scopes: readonly MemoryScope[],
    evidence: MemoryLocalScopeEvidence,
    agent = false,
  ) {
    assertOpen();
    evidence.assertCurrentSync();
    const values = scopes.map((scope) => ({
      scope,
      epoch: epoch(scope),
      access: access(scope),
      sequence: store.getScopeHead(scope),
    }));
    if (agent && values.some((item) => item.access.level === 'disabled'))
      throw new MemoryError('memory-disabled');
    return {
      heads: values.map(({ scope, sequence }) => ({ scope, sequence })),
      assertCurrentSync(returnedHeads?: readonly MemoryScopeHead[]) {
        assertOpen();
        evidence.assertCurrentSync();
        for (const item of values) {
          if (
            epoch(item.scope) !== item.epoch ||
            access(item.scope).settingRevision !== item.access.settingRevision ||
            store.getScopeHead(item.scope) !== item.sequence
          )
            throw new MemoryError('memory-stale-cursor');
        }
        if (
          returnedHeads !== undefined &&
          !same(
            returnedHeads,
            values.map(({ scope, sequence }) => ({ scope, sequence })),
          )
        )
          throw new MemoryError('memory-stale-cursor');
      },
    };
  }
  async function queryPage(
    scopes: readonly MemoryScope[],
    raw: z.input<typeof memoryQuerySchema>,
    evidence: MemoryLocalScopeEvidence,
    tool: boolean,
    search: boolean,
    signal?: AbortSignal,
  ): Promise<MemoryPage<MemorySummary>> {
    const input = memoryQuerySchema.parse(raw);
    const query = {
      scopes,
      query: normalizeMemoryText(input.query ?? ''),
      tag: input.tag === undefined ? undefined : normalizeMemoryText(input.tag),
      limit: input.limit,
      includeAgentAuthored: input.includeAgentAuthored ?? !tool,
    };
    const captured = snapshot(scopes, evidence, tool);
    const after =
      input.cursor === undefined
        ? undefined
        : sortKeySchema.parse(
            cursor.decode(input.cursor, search ? 'search' : 'list', query, captured.heads),
          );
    const request: MemorySearchInput = {
      scopes,
      limit: input.limit,
      query: query.query,
      includeAgentAuthored: query.includeAgentAuthored,
      ...(query.tag === undefined ? {} : { tag: query.tag }),
      ...(after === undefined ? {} : { after }),
    };
    const page = search
      ? await store.search(
          request,
          signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]),
        )
      : store.list(request);
    captured.assertCurrentSync(page.scopeHeads);
    const entries = page.entries.map((entry) => memorySummarySchema.parse(entry));
    const keys = page.keys;
    if (entries.length !== keys.length || entries.length > input.limit)
      throw new MemoryError('memory-persistence-error');
    for (let count = entries.length; count >= 0; count--) {
      const rows = entries.slice(0, count);
      const hasMore = page.hasMore || count < entries.length;
      if (hasMore && count === 0) throw new MemoryError('memory-limit');
      const result = {
        entries: rows,
        ...(hasMore
          ? {
              nextCursor: cursor.encode(
                search ? 'search' : 'list',
                query,
                page.scopeHeads,
                keys[count - 1],
              ),
            }
          : {}),
      };
      if (within(result, tool)) {
        captured.assertCurrentSync(page.scopeHeads);
        return result;
      }
      for (const row of rows) row.excerpt = '';
      if (within(result, tool)) {
        captured.assertCurrentSync(page.scopeHeads);
        return result;
      }
    }
    throw new MemoryError('memory-limit');
  }

  const local = {
    read(
      scope: MemoryScope,
      memoryId: string,
      input: { readonly ref?: MemoryRef } = {},
    ): Promise<MemoryCurrent> {
      return track(async () => {
        const { evidence } = await localEvidence(scope);
        memoryIdSchema.parse(memoryId);
        const captured = snapshot([scope], evidence);
        if (
          input.ref !== undefined &&
          (!same(input.ref.scope, scope) || input.ref.memoryId !== memoryId)
        )
          throw new MemoryError('memory-not-found');
        const record =
          input.ref === undefined
            ? store.read(scope, memoryId)
            : store.readRevision(memoryRefSchema.parse(input.ref));
        if (record === undefined) throw new MemoryError('memory-not-found');
        const result = memoryCurrentSchema.parse(record);
        if (!same(result.ref.scope, scope)) throw new MemoryError('memory-not-found');
        captured.assertCurrentSync();
        if (!within(result, false)) throw new MemoryError('memory-limit');
        return result;
      });
    },
    list(scope: MemoryScope, input: z.input<typeof memoryQuerySchema> = {}) {
      return track(async () => {
        const { evidence } = await localEvidence(scope);
        return queryPage([scope], input, evidence, false, false);
      });
    },
    search(
      scope: MemoryScope,
      input: z.input<typeof memoryQuerySchema> = {},
      signal?: AbortSignal,
    ) {
      return track(async () => {
        const { evidence } = await localEvidence(scope);
        return queryPage([scope], input, evidence, false, true, signal);
      });
    },
    create(scope: MemoryScope, raw: Extract<MemoryRecordInput, { operation: 'create' }>) {
      return track(async () => {
        const input = memoryRecordInputSchema.parse(raw);
        if (input.operation !== 'create') throw new MemoryError('memory-scope-forbidden');
        const { evidence } = await localEvidence(scope);
        const content = memoryContentSchema.parse({
          title: input.title,
          content: input.content,
          tags: input.tags,
        });
        return localCommit(
          {
            ...localMutation(scope, 'create', input.requestId, { expectedRevision: 0, content }),
            kind: 'create',
            content,
            expectedRevision: 0,
          },
          evidence,
        );
      });
    },
    revise(scope: MemoryScope, raw: Extract<MemoryRecordInput, { operation: 'revise' }>) {
      return track(async () => {
        const input = memoryRecordInputSchema.parse(raw);
        if (input.operation !== 'revise') throw new MemoryError('memory-scope-forbidden');
        const { evidence } = await localEvidence(scope);
        const content = memoryContentSchema.parse({
          title: input.title,
          content: input.content,
          tags: input.tags,
        });
        return localCommit(
          {
            ...localMutation(scope, 'revise', input.requestId, {
              memoryId: input.memoryId,
              expectedRevision: input.expectedRevision,
              content,
            }),
            kind: 'revise',
            memoryId: input.memoryId,
            expectedRevision: input.expectedRevision,
            content,
          },
          evidence,
        );
      });
    },
    review(scope: MemoryScope, raw: z.infer<typeof memoryReviewInputSchema>) {
      return track(async () => {
        const input = memoryReviewInputSchema.parse(raw);
        const { evidence } = await localEvidence(scope);
        if (!same(input.targetRef.scope, scope)) throw new MemoryError('memory-not-found');
        return localCommit(
          {
            ...localMutation(scope, 'review', input.requestId, { targetRef: input.targetRef }),
            kind: 'review',
            targetRef: input.targetRef,
          },
          evidence,
        );
      });
    },
    remove(scope: MemoryScope, raw: z.infer<typeof memoryDeleteInputSchema>) {
      return track(async () => {
        const input = memoryDeleteInputSchema.parse(raw);
        const { evidence } = await localEvidence(scope);
        const payload = {
          memoryId: input.memoryId,
          expectedRevision: input.expectedRevision,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        };
        return localCommit(
          {
            ...localMutation(scope, 'remove', input.requestId, payload),
            kind: 'remove',
            ...payload,
          },
          evidence,
        );
      });
    },
    getAccess(scope: MemoryScope) {
      return track(async () => {
        const { evidence } = await localEvidence(scope);
        evidence.assertCurrentSync();
        return access(scope);
      });
    },
    setAccess(scope: MemoryScope, raw: z.infer<typeof memoryAccessInputSchema>) {
      return track(async () => {
        const input = memoryAccessInputSchema.parse(raw);
        const { evidence } = await localEvidence(scope);
        const payload = {
          level: input.level,
          expectedSettingRevision: input.expectedSettingRevision,
        };
        return localCommit(
          {
            ...localMutation(scope, 'setAccess', input.requestId, payload),
            kind: 'setAccess',
            ...payload,
          },
          evidence,
        );
      });
    },
    history(
      scope: MemoryScope,
      memoryId: string,
      raw: z.input<typeof memoryHistoryQuerySchema> = {},
    ) {
      return track(async () => {
        const input = memoryHistoryQuerySchema.parse(raw);
        memoryIdSchema.parse(memoryId);
        const { evidence } = await localEvidence(scope);
        const captured = snapshot([scope], evidence);
        const query = { scope, memoryId, limit: input.limit };
        const after =
          input.cursor === undefined
            ? undefined
            : historyAfterSchema.parse(
                cursor.decode(input.cursor, 'history', query, captured.heads),
              );
        const entries = store
          .history(scope, memoryId, {
            limit: input.limit,
            ...(after === undefined ? {} : { afterRevision: after.revision }),
          })
          .map((item) => memoryHistoryEntrySchema.parse(item));
        const rows = entries;
        const last = rows.at(-1);
        const more =
          rows.length === input.limit &&
          last?.subject.kind === 'record' &&
          store.history(scope, memoryId, { limit: 1, afterRevision: last.subject.revision })
            .length > 0;
        const result = {
          entries: rows,
          ...(more && last?.subject.kind === 'record'
            ? {
                nextCursor: cursor.encode('history', query, captured.heads, {
                  revision: last.subject.revision,
                }),
              }
            : {}),
        };
        captured.assertCurrentSync();
        if (!within(result, false)) throw new MemoryError('memory-limit');
        return result;
      });
    },
  };

  async function agentScope(
    caller: AgentToolInvocationAuthority,
    requested?: 'project' | 'user',
    includeUser = false,
  ) {
    assertOpen();
    const token = memoryCallerAuthority(caller);
    const child = agentToolAuthorityParent(token) !== undefined;
    const evidence = await options.resolveAgentScope(caller);
    assertOpen();
    evidence.assertCurrentSync();
    memoryCallerAuthority(caller);
    if (evidence.membership.kind === 'ambiguous') throw new MemoryError('memory-project-ambiguous');
    if (child && (requested === 'user' || includeUser))
      throw new MemoryError('memory-scope-forbidden');
    if (requested === 'user') {
      if (includeUser) throw new MemoryError('memory-scope-forbidden');
      return {
        scope: { kind: 'user' } as const,
        scopes: [{ kind: 'user' } as const],
        evidence,
        child,
      };
    }
    if (evidence.membership.kind !== 'unique') throw new MemoryError('memory-scope-forbidden');
    const scope: MemoryScope = { kind: 'project', projectId: evidence.membership.projectId };
    return {
      scope,
      scopes: includeUser ? [scope, { kind: 'user' } as const] : [scope],
      evidence,
      child,
    };
  }
  function liveAgentEvidence(
    caller: AgentToolInvocationAuthority,
    evidence: MemoryScopeEvidence,
  ): MemoryLocalScopeEvidence {
    return {
      assertCurrentSync() {
        assertOpen();
        memoryCallerAuthority(caller);
        evidence.assertCurrentSync();
      },
    };
  }
  const agent = {
    search(
      caller: AgentToolInvocationAuthority,
      raw: MemoryAgentSearchInput,
      signal?: AbortSignal,
    ) {
      return track(async () => {
        const input = memoryAgentSearchSchema.parse(raw);
        const resolved = await agentScope(caller, input.scope, input.includeUser);
        const { scope: _scope, includeUser: _includeUser, ...query } = input;
        void _scope;
        void _includeUser;
        return queryPage(
          resolved.scopes,
          query,
          liveAgentEvidence(caller, resolved.evidence),
          true,
          true,
          signal,
        );
      });
    },
    read(caller: AgentToolInvocationAuthority, raw: MemoryAgentReadInput): Promise<MemoryReadPage> {
      return track(async () => {
        const input = memoryAgentReadSchema.parse(raw);
        const resolved = await agentScope(caller, input.scope);
        const captured = snapshot(
          [resolved.scope],
          liveAgentEvidence(caller, resolved.evidence),
          true,
        );
        const record = store.read(resolved.scope, input.memoryId);
        if (record === undefined || (input.ref !== undefined && !same(record.ref, input.ref)))
          throw new MemoryError('memory-not-found');
        const current = memoryCurrentSchema.parse(record);
        const query = { scope: resolved.scope, ref: current.ref };
        const offset =
          input.cursor === undefined
            ? 0
            : offsetSchema.parse(cursor.decode(input.cursor, 'read', query, captured.heads)).offset;
        const points = [...current.content];
        if (offset >= points.length) throw new MemoryError('memory-invalid-cursor');
        const make = (count: number): MemoryReadPage => ({
          untrustedData: true,
          ref: current.ref,
          title: current.title,
          tags: current.tags,
          review: current.review,
          provenance: current.provenance,
          offset,
          text: points.slice(offset, offset + count).join(''),
          eof: offset + count === points.length,
          ...(offset + count < points.length
            ? {
                nextCursor: cursor.encode('read', query, captured.heads, {
                  offset: offset + count,
                }),
              }
            : {}),
        });
        const full = make(points.length - offset);
        if (within(full, true)) {
          captured.assertCurrentSync();
          return full;
        }
        let low = 1;
        let high = points.length - offset - 1;
        let found: MemoryReadPage | undefined;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const page = make(middle);
          if (within(page, true)) {
            found = page;
            low = middle + 1;
          } else high = middle - 1;
        }
        if (found === undefined) throw new MemoryError('memory-limit');
        captured.assertCurrentSync();
        return found;
      });
    },
    prepareWrite(
      caller: AgentToolInvocationAuthority,
      operation: MemoryWriteOperation,
      raw: MemoryAgentSaveInput | MemoryAgentDeleteInput,
    ): Promise<MemoryWriteIntent> {
      return track(async () => {
        const input =
          operation === 'memory.save'
            ? memoryAgentSaveSchema.parse(raw)
            : memoryAgentDeleteSchema.parse(raw);
        const resolved = await agentScope(caller, selectionSchema.parse(input.scope));
        if (resolved.child) throw new MemoryError('memory-scope-forbidden');
        const requestId = agentRequestId(caller, operation);
        const placeholderId = '00000000-0000-4000-8000-000000000000';
        const placeholderRef = {
          scope: resolved.scope,
          memoryId: placeholderId,
          revision: Number.MAX_SAFE_INTEGER,
          sha256: '0'.repeat(64),
        };
        const placeholderReceipt = {
          requestId,
          operation:
            operation === 'memory.delete'
              ? 'remove'
              : input && 'operation' in input
                ? input.operation
                : 'create',
          sequence: Number.MAX_SAFE_INTEGER,
          subject: {
            kind: 'record',
            scope: resolved.scope,
            memoryId: placeholderId,
            revision: Number.MAX_SAFE_INTEGER,
          },
          result:
            operation === 'memory.delete'
              ? { memoryId: placeholderId, revision: Number.MAX_SAFE_INTEGER, deleted: true }
              : placeholderRef,
        };
        if (!within(placeholderReceipt, true)) throw new MemoryError('memory-limit');
        const digest = memoryDigest({
          version: 1,
          operation,
          scope: resolved.scope,
          caller: caller.identity,
          toolCallId: caller.toolCallId,
          input,
        });
        const callerKey = memoryCanonicalJson([
          'agent',
          caller.identity.sessionId,
          caller.identity.executionId,
          caller.identity.turnId,
          caller.toolCallId,
        ]);
        reconcileKnownPending({ scope: resolved.scope, requestId, callerKey, digest });
        const a = access(resolved.scope);
        if (a.level !== 'read-write')
          throw new MemoryError(a.level === 'disabled' ? 'memory-disabled' : 'memory-read-only');
        const receipt = store.lookupReceipt({
          scope: resolved.scope,
          requestId,
          callerKey,
          digest,
        });
        const target =
          'memoryId' in input && receipt === undefined
            ? store.read(resolved.scope, input.memoryId)
            : undefined;
        if ('memoryId' in input && receipt === undefined && target === undefined)
          throw new MemoryError('memory-not-found');
        if (target !== undefined && target.ref.revision !== input.expectedRevision)
          throw new MemoryError('memory-stale-revision');
        const intent: MemoryWriteIntent = Object.freeze({
          caller,
          operation,
          scope: deepFreeze(structuredClone(resolved.scope)),
          membership: deepFreeze(structuredClone(resolved.evidence.membership)),
          accessSettingRevision: a.settingRevision,
          ...(target === undefined ? {} : { targetRef: deepFreeze(structuredClone(target.ref)) }),
          ...(target === undefined
            ? {}
            : {
                target: deepFreeze({
                  title: target.title,
                  review: target.review,
                  provenance: structuredClone(target.provenance),
                }),
              }),
          ...(receipt === undefined ? {} : { replayReceipt: deepFreeze(structuredClone(receipt)) }),
          normalizedInput: deepFreeze(structuredClone(input)),
          requestId,
          digest,
        });
        liveAgentEvidence(caller, resolved.evidence).assertCurrentSync();
        intents.set(intent, { evidence: resolved.evidence });
        return intent;
      });
    },
    executeWrite(intent: MemoryWriteIntent, assertAttemptLive: () => void): Promise<MemoryReceipt> {
      return track(async () => {
        const known = intents.get(intent);
        if (known === undefined) throw new MemoryError('memory-scope-forbidden');
        const resolved = await agentScope(
          intent.caller,
          intent.scope.kind === 'user' ? 'user' : 'project',
        );
        if (resolved.child || !same(resolved.scope, intent.scope))
          throw new MemoryError('memory-scope-forbidden');
        const input = intent.normalizedInput;
        const base = {
          key: {
            scope: intent.scope,
            requestId: intent.requestId,
            callerKey: memoryCanonicalJson([
              'agent',
              intent.caller.identity.sessionId,
              intent.caller.identity.executionId,
              intent.caller.identity.turnId,
              intent.caller.toolCallId,
            ]),
            digest: intent.digest,
          },
          provenance: {
            actor: 'agent' as const,
            sessionId: intent.caller.identity.sessionId,
            executionId: intent.caller.identity.executionId,
            turnId: intent.caller.identity.turnId,
            toolCallId: intent.caller.toolCallId,
          },
        };
        const mutation: MemoryMutation =
          intent.operation === 'memory.delete'
            ? {
                ...base,
                kind: 'remove',
                memoryId: (input as MemoryAgentDeleteInput).memoryId,
                expectedRevision: input.expectedRevision,
                ...((input as MemoryAgentDeleteInput).reason === undefined
                  ? {}
                  : { reason: (input as MemoryAgentDeleteInput).reason! }),
              }
            : 'operation' in input && input.operation === 'revise'
              ? {
                  ...base,
                  kind: 'revise',
                  memoryId: input.memoryId,
                  expectedRevision: input.expectedRevision,
                  content: memoryContentSchema.parse({
                    title: input.title,
                    content: input.content,
                    tags: input.tags,
                  }),
                }
              : {
                  ...base,
                  kind: 'create',
                  expectedRevision: 0,
                  content: memoryContentSchema.parse({
                    title: (input as MemoryAgentSaveInput).title,
                    content: (input as MemoryAgentSaveInput).content,
                    tags: (input as MemoryAgentSaveInput).tags,
                  }),
                };
        const check = () => {
          assertOpen();
          assertAttemptLive();
          memoryCallerAuthority(intent.caller);
          resolved.evidence.assertCurrentSync();
        };
        const receipt = guardedCommit(mutation, {
          assertAuthorized(a) {
            check();
            if (a.level !== 'read-write')
              throw new MemoryError(
                a.level === 'disabled' ? 'memory-disabled' : 'memory-read-only',
              );
          },
          assertNewMutation(a, current) {
            check();
            known.evidence.assertCurrentSync();
            if (
              a.settingRevision !== intent.accessSettingRevision ||
              !same(resolved.evidence.membership, intent.membership)
            )
              throw new MemoryError('memory-stale-revision');
            if (
              intent.targetRef !== undefined &&
              (current === undefined || !same(current.ref, intent.targetRef))
            )
              throw new MemoryError('memory-stale-revision');
          },
          beforeCommit(change) {
            check();
            return beforeCommit(change);
          },
        });
        const result = memoryReceiptSchema.parse(receipt);
        if (!within(result, true)) throw new MemoryError('memory-limit');
        return result;
      });
    },
  };

  const reviewedSource: ReviewedMemorySource = {
    capture(input) {
      return track(async () => {
        const scope = memoryScopeSchema.parse({ kind: 'project', projectId: input.projectId });
        if (input.signal.aborted) throw new MemoryError('memory-cancelled');
        if (
          input.refs.length < 1 ||
          input.refs.length > 48 ||
          new Set(input.refs.map((ref) => ref.memoryId)).size !== input.refs.length
        )
          throw new MemoryError('memory-scope-forbidden');
        const refs = input.refs.map((ref) => memoryRefSchema.parse(ref));
        if (refs.some((ref) => !same(ref.scope, scope)))
          throw new MemoryError('memory-scope-forbidden');
        const { evidence } = await localEvidence(scope);
        const captured = snapshot([scope], evidence, true);
        const a = access(scope);
        const records = store.readSnapshot(refs).map((record) => memoryCurrentSchema.parse(record));
        if (
          records.length !== refs.length ||
          records.some(
            (record, index) => record.review !== 'user-reviewed' || !same(record.ref, refs[index]),
          )
        )
          throw new MemoryError('memory-not-found');
        captured.assertCurrentSync();
        if (input.signal.aborted) throw new MemoryError('memory-cancelled');
        const capture: ReviewedMemoryCapture = deepFreeze({
          projectId: input.projectId,
          settingRevision: a.settingRevision,
          liveEpoch: epoch(scope),
          records: records.map((record) => ({
            ref: record.ref,
            content: { title: record.title, content: record.content, tags: record.tags },
          })),
        });
        captures.set(capture, { scope, settingRevision: a.settingRevision, epoch: epoch(scope) });
        return capture;
      });
    },
    assertCurrentSync(capture) {
      assertOpen();
      const known = captures.get(capture);
      if (known === undefined) throw new MemoryError('memory-scope-forbidden');
      const a = access(known.scope);
      if (
        a.level === 'disabled' ||
        a.settingRevision !== known.settingRevision ||
        epoch(known.scope) !== known.epoch
      )
        throw new MemoryError('memory-stale-cursor');
    },
  };
  return {
    local,
    agent,
    reviewedSource,
    closeSync() {
      if (closed) return;
      closed = true;
      controller.abort();
      store.closeSync();
    },
    async drain() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await Promise.allSettled([...active]);
            await store.drain();
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new MemoryError('memory-busy')), 5000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    async close() {
      await store.close();
    },
  };
}
export type MemoryService = ReturnType<typeof createMemoryService>;
