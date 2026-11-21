# Plugin Authority Database Implementation Plan — Stage 6.2a

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Add Server-private append-only plugin authority persistence with atomic managed decisions, complete validated readback and durable request replay, preserving the existing trust API.

**Architecture:** One SQLite owner supplies a borrowed manual trust facade and synchronous combined managed commits. Install, unchanged trust and operation facts commit together; every successful fresh managed request, including no-op, has exactly one operation. New managed snapshots/results are constructed, validated and frozen before COMMIT; the old trust facade continues returning mutable detached copies.

**Tech Stack:** Existing strict TypeScript ESM, Node SQLite/crypto, Zod and Vitest; no new dependency.

**Spec:** `docs/superpowers/specs/2026-11-21-plugin-authority-design.md`; ADR 0005 and installation design §5.

## Global constraints

- Existing strict TypeScript ESM, Node `>=24.4.0`, pnpm `>=10.13.1`, Zod and Vitest.
- No new package, dependency, `@weave/plugin-host` API or cross-package source change.
- Every external option, request, prepared evidence and persisted row is validated with Zod before use. SQL integers are read as bigint before safe-number checks.
- Facts use INSERT/SELECT only; no UPDATE/DELETE, mutable authority projection, database-wide `user_version`, async transaction callback or raw connection escape.
- All tests live in `apps/server/test/`; use disposable SQLite files, never user data.
- New authority snapshots/results are deeply frozen detached plain data. Existing trust facade results remain detached **mutable** copies for compatibility.
- All fallible managed result construction occurs before successful COMMIT.
- No managed artifact/startup/root lease/source/Generation/coordinator/HTTP/Studio exposure. Do not edit `main.ts`, `plugin-api.ts` or package dependency/export files.
- Root owns branch/commit/push/PR/CI/squash workflow. Task agents do not commit or push. Each task receives a fresh spec and quality review before the next dependent task.

## File map and dependency order

| Action   | Exact path                                                        | Responsibility                                                                                       |
| -------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Create   | `apps/server/src/plugin-authority-types.ts`                       | Spec types, strict schemas and authority errors.                                                     |
| Create   | `apps/server/src/plugin-authority-data.ts`                        | Static canonical JSON/fingerprint and detached deep-freeze.                                          |
| Create   | `apps/server/src/plugin-trust-sqlite.ts`                          | Extracted trust SQL primitives/error class; no owner/transaction creation.                           |
| Create   | `apps/server/src/plugin-authority-log.ts`                         | Additive schema/identity, full validated log read/fold, deterministic transitions and append helper. |
| Create   | `apps/server/src/plugin-authority-store.ts`                       | Sole connection owner, read/commit transactions, borrowed trust facade, close.                       |
| Modify   | `apps/server/src/plugin-trust-store.ts`                           | Keep old constructor/import path; delegate to private owner and re-export same trust error class.    |
| Create   | `apps/server/test/support/plugin-authority-fixtures.ts`           | Pure input/record fixtures; no production schema oracle.                                             |
| Create   | `apps/server/test/plugin-authority-input.test.ts`                 | Zod, canonical command equality/fingerprint, detached freeze.                                        |
| Create   | `apps/server/test/plugin-authority-log.test.ts`                   | Real DB readback plus exact pure transitions.                                                        |
| Create   | `apps/server/test/plugin-authority-store.test.ts`                 | Transactions, per-command outcomes, replay, facade ownership.                                        |
| Create   | `apps/server/test/plugin-authority-integrity.test.ts`             | Real corrupt SQL/trigger/fault/boundary regressions.                                                 |
| Preserve | `apps/server/test/plugin-trust-store.test.ts`                     | Original behavior tests pass unchanged, especially mutable returned copies.                          |
| Update   | `docs/architecture/foundation.md`                                 | State only the verified persistence capability and deferred managed exposure.                        |
| Update   | `docs/superpowers/specs/2026-11-21-plugin-installation-design.md` | Link 6.2a and record the operation stream/global request identity.                                   |
| Create   | `docs/learning/2026-11-21-plugin-authority-database.md`           | Actual contracts, trust compatibility, atomicity/replay evidence and limits.                         |

Private dependency direction: compatibility wrapper → authority owner → log/data/types
and trust SQL primitives. The owner never imports the compatibility wrapper. The
trust error class is defined in the primitive module and re-exported at the old
path, preserving class identity. All changes remain in existing `apps/server`.

### Task 1: Static managed contracts and deterministic data

**Files:** Create `plugin-authority-types.ts`, `plugin-authority-data.ts`, the
fixture module and `plugin-authority-input.test.ts` at the paths above.

**Consumes:** Existing `PluginManifest`/`pluginManifestSchema` from `@weave/plugin`;
existing trust types from `@weave/plugin-host`; exact unions/interfaces in spec
§§4–6 and error codes in §11. **Produces:** those exact types, `managedRequestSchema`,
`managedPreparationSchema`, `recordedPluginInstallEventSchema`,
`recordedManagedOperationSchema`, `pluginDatabaseIdentitySchema`,
`pluginAuthorityOptionsSchema`, plus these data helpers:

```ts
export interface CanonicalManagedRequest {
  readonly request: ManagedRequest;
  readonly canonicalCommand: string;
  readonly fingerprint: string;
}
export function canonicalizeManagedRequest(input: unknown): CanonicalManagedRequest;
export function canonicalJson(input: unknown): string;
export function detachAndFreeze<T>(value: T): T;
```

- [ ] **Step 1: Add RED tests for the schema and static identity.** Use this complete
      minimal fixture and assert invalid cases do not get normalized into acceptance:

```ts
const request = {
  requestId: 'import-a',
  command: { kind: 'import', previewId: 'preview-a', expectedInstallSequence: 0 },
};
expect(canonicalizeManagedRequest(request).canonicalCommand).toBe(
  '{"command":{"expectedInstallSequence":0,"kind":"import","previewId":"preview-a"},"version":1}',
);
expect(canonicalizeManagedRequest(request).fingerprint).toMatch(/^[0-9a-f]{64}$/);
expect(() =>
  canonicalizeManagedRequest({
    ...request,
    command: { ...request.command, expectedInstallSequence: -1 },
  }),
).toThrow(expect.objectContaining({ code: 'plugin-authority-invalid' }));
```

Table-drive unknown fields/kinds, empty/201-character request or preview IDs,
invalid plugin IDs/digests/manifests, unsafe heads, nonpositive file counts,
NUL/relative provenance, unknown command/preparation discriminator values and missing managed
declarations. Zod validates preparation separately; lookup must not parse it.
For disable/revoke/uninstall, prove omitted `immediate` and false canonicalize
equally; changed preview, expected head, manifest, intent or timing differ.
Test object-key reordering is equal, array order is preserved, optional object
undefined is omitted, and undefined-array/cycle/nonfinite/non-JSON values reject.

- [ ] **Step 2: Run the targeted RED test.** Run
      `pnpm exec vitest run --config vitest.config.ts apps/server/test/plugin-authority-input.test.ts`.
      Confirm missing intended exports/behavior, not an unrelated import typo.
- [ ] **Step 3: Implement exact strict Zod types and pure helpers.** Schemas use safe
      integer refinements, managed ID syntax, digest/manifest identity, 200-character
      opaque IDs and static default false. Canonical JSON recursively sorts object
      keys; SHA-256 uses `node:crypto`. `detachAndFreeze` clones plain JSON data before
      recursively freezing every object/array; it exposes no mutable Map/SQLite value.
      Keep helper functions synchronous. A key assertion for the new guarantee is:

```ts
const source = { values: [{ label: 'original' }] };
const result = detachAndFreeze(source);
source.values[0]!.label = 'changed';
expect(result.values[0]!.label).toBe('original');
expect(Object.isFrozen(result)).toBe(true);
expect(Object.isFrozen(result.values)).toBe(true);
expect(Object.isFrozen(result.values[0])).toBe(true);
```

- [ ] **Step 4: Create pure reusable test fixtures.** Export `digestA`, `digestB`,
      `artifact(digest = digestA, version = '1.0.0')`,
      `importInput(requestId, expectedInstallSequence, identity = artifact())`,
      `activateInput(requestId, snapshot, identity = artifact(), intent = 'activate')`,
      and `decisionInput(kind, requestId, snapshot, immediate = false)`. Their exact
      signatures use these existing types:

```ts
export const digestA = 'a'.repeat(64);
export const digestB = 'b'.repeat(64);
export function artifact(digest?: string, version?: string): ValidatedArtifactIdentity;
export function importInput(
  requestId: string,
  expectedInstallSequence: number,
  identity?: ValidatedArtifactIdentity,
): ManagedCommitInput;
export function activateInput(
  requestId: string,
  snapshot: PluginAuthoritySnapshot,
  identity?: ValidatedArtifactIdentity,
  intent?: 'activate' | 'rollback',
): ManagedCommitInput;
export function decisionInput(
  kind: 'enable' | 'disable' | 'revoke' | 'uninstall',
  requestId: string,
  snapshot: PluginAuthoritySnapshot,
  immediate?: boolean,
): ManagedCommitInput;
```

`artifact` returns an ordinary plugin `notes` manifest with `contributes.commands`
and `permissions`, files 2 and bytes 128. `importInput` adds absolute provenance
`resolve(tmpdir(), 'weave-authority-fixtures', 'notes')` using Node path/os
helpers without I/O, and preview ID equal to the request ID. Review builders read
both authority heads and the selected digest from their supplied snapshot;
enable throws a fixture error if no selection exists. Fixtures contain plain
expected values and do not call production reducers or schemas as an oracle.

- [ ] **Step 5: Run targeted test, Server typecheck and focused Prettier; self-review.**
      Run the command above, `pnpm --filter @weave/server typecheck`, and
      `pnpm exec prettier --check` with the four created paths. Report actual evidence.
      Independent review checks complete spec field coverage and no dynamic I/O in
      identity comparison. Do not wire any constructor or runtime behavior yet.

### Task 2: Extract trust SQLite primitives with behavior unchanged

**Files:** Create `apps/server/src/plugin-trust-sqlite.ts`; refactor
`apps/server/src/plugin-trust-store.ts`; preserve and run its existing test file.

**Consumes:** Existing trust schemas/types and original store behavior.
**Produces:** private primitives on an already-owned connection:

```ts
export type PluginTrustStoreErrorCode =
  'plugin-trust-invalid' | 'plugin-trust-storage' | 'plugin-trust-closed' | 'plugin-trust-protocol';
export class PluginTrustStoreError extends Error {
  constructor(
    readonly code: PluginTrustStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PluginTrustStoreError';
  }
}
export function createTrustTableSync(database: DatabaseSync): void;
export function validateTrustInput(input: unknown): PluginTrustEvent;
export function readTrustEventsTx(database: DatabaseSync): readonly RecordedPluginTrustEvent[];
export function createRecordedTrustEvent(
  event: PluginTrustEvent,
  sequence: number,
  occurredAt: string,
): RecordedPluginTrustEvent;
export function appendRecordedTrustEventTx(
  database: DatabaseSync,
  event: RecordedPluginTrustEvent,
): void;
```

The class body/code union is the existing four-code implementation, not a new
subclass. Primitives do not open/close connections or begin/commit transactions.

- [ ] **Step 1: Run the current trust test as baseline.** Run
      `pnpm exec vitest run --config vitest.config.ts apps/server/test/plugin-trust-store.test.ts`.
      Read assertions for four errors, mutable copies, metadata, independent
      connections, read corruption, rollback cause and unchanged `user_version`.
- [ ] **Step 2: Extract only trust SQL/validation/error primitives.** Move the exact
      existing row schema, trust identity check and BigInt contiguous-log reader.
      Have the existing standalone owner call these primitives in its current short
      transactions; re-export the same `PluginTrustStoreError` at the old path.
      Before COMMIT construct the detached return event; it remains mutable. No
      managed gate/new owner is connected in this task, so the refactor is independently
      reviewable. Example call order inside its existing append remains:

```ts
const before = readTrustEventsTx(database);
const recorded = createRecordedTrustEvent(parsed, before.length + 1, occurredAt);
appendRecordedTrustEventTx(database, recorded);
const result = structuredClone(recorded);
database.exec('COMMIT');
return result;
```

- [ ] **Step 3: Run unchanged trust tests plus Server typecheck/lint.** All original
      tests pass without weakening mutable-data assertions or changing their expected
      four error codes. Confirm no nested transaction or async primitive exists.
      Run `pnpm --filter @weave/server typecheck` and `pnpm --filter @weave/server lint`;
      check formatting for both changed files.
- [ ] **Step 4: Request independent behavior/quality review.** Deliver only the
      extraction and its evidence. Confirm original API imports and class identity
      still work in existing management tests; do not add routes or new dependencies.

### Task 3: Complete append-only log model, schema and validation

**Files:** Create `apps/server/src/plugin-authority-log.ts` and
`apps/server/test/plugin-authority-log.test.ts`; extend pure fixtures only when
needed for direct SQL seeding.

**Consumes:** Task 1 contracts/canonical helpers; Task 2 trust primitives.
**Produces:** these Server-private functions for an already-owned connection:

```ts
export interface ResolvedManagedTransition {
  readonly trustEvent: RecordedPluginTrustEvent | null;
  readonly installEvent: RecordedPluginInstallEvent | null;
  readonly operation: RecordedManagedOperation;
}
export function initializeAuthoritySchemaTx(
  database: DatabaseSync,
  newDatabaseId: () => string,
): PluginDatabaseIdentity;
export function readAuthoritySnapshotTx(database: DatabaseSync): PluginAuthoritySnapshot;
export function resolveManagedTransition(
  before: PluginAuthoritySnapshot,
  input: ManagedCommitInput,
  occurredAt: string,
): ResolvedManagedTransition;
export function appendManagedTransitionTx(
  database: DatabaseSync,
  transition: ResolvedManagedTransition,
): void;
```

These functions expose neither owner nor asynchronous callback. The transaction
suffix means the caller already holds the read or write transaction required
by the function. The read returns
freshly parsed plain data; the owner applies deep-freeze at its public boundary.

- [ ] **Step 1: Add RED tests for old-database upgrade and empty log.** Use actual
      `DatabaseSync` in a temporary filename with preexisting trust rows, unrelated
      table and `PRAGMA user_version = 17`. In one explicit transaction initialize the
      additive schema, then read/validate the snapshot. Assert UUID survives close/
      reopen; heads are `{installSequence:0,trustSequence:oldCount,operationSequence:0}`;
      no old row, unrelated value, or `user_version` changes. Test partial new tables,
      missing/empty/bad identity and missing required unique index fail protocol.
- [ ] **Step 2: Run the targeted RED test.** Run
      `pnpm exec vitest run --config vitest.config.ts apps/server/test/plugin-authority-log.test.ts`.
      Then implement exact spec §7 SQL initialization, identity/table/index validation
      and lossless envelope parsing. New UUID is generated only when **none** of the
      three new tables exist; trust-only DB upgrade is one transaction. Do not add
      root binding or path/lease metadata.
- [ ] **Step 3: Add RED transition tests for every row in spec §8.** Build plain
      before-snapshots from explicit fixture records and compare exact events/heads:

```ts
const emptySnapshot = readAuthoritySnapshotTx(database);
const occurredAt = '2026-11-21T00:00:00.000Z';
const next = resolveManagedTransition(emptySnapshot, importInput('import-a', 0), occurredAt);
expect(next.trustEvent).toBeNull();
expect(next.installEvent).toMatchObject({
  kind: 'imported',
  pluginId: 'notes',
  digest: digestA,
  sequence: 1,
  operationSequence: 1,
});
expect(next.operation.decision).toMatchObject({
  changed: true,
  before: { installSequence: 0, trustSequence: 0 },
  after: { installSequence: 1, trustSequence: 0 },
  links: { installEventSequence: 1, trustEventSequence: null },
});
```

Include same-digest activate/rollback always adding selection+trusted; exact
selected/current-trust enable; revoke then enable failure; all fresh no-op
counts; metadata-only revoke/uninstall; stale heads/selected identity before
no-op; repeat candidate with changed provenance but equal metadata; sticky
ownership and no selection on import. Transition resolver is the single policy
used for both new writes and persisted-command validation; avoid two reducers.

- [ ] **Step 4: Implement the transition resolver and complete readback walk.**
      Apply manual trust intervals, then each operation's exact linked state facts in
      order, validating expected before/after states and fingerprint/evidence. Use
      existing `foldTrust` behavior without changing its package. Reject managed
      unlinked trust, orphan/reused links, wrong-kind/plugin/digest/manifest links,
      mismatched timestamps, unsafe/gapped stream heads and trailing install rows.
      Use SQL INSERT only in the append helper, with original trust JSON unchanged.
- [ ] **Step 5: Add real SQL round-trip/integrity tests.** In a transaction call
      resolver/append, then compare the read snapshot to explicit expected facts;
      this seed mechanism does not replace the separately asserted transition oracle.
      Seed old manual facts before first import and permit them; reject manual facts
      for owned IDs after import. Corrupt one row/envelope/link/fingerprint/decision
      at a time and require protocol errors. Verify the snapshot's first-import order.
- [ ] **Step 6: Run targeted log/input/trust tests, typecheck/lint and review.**
      Run one Vitest invocation naming these three test files, then Server typecheck/
      lint and changed-file Prettier. Reviewer checks the prefix walk covers all rows
      and cannot bless an invalid operation merely because its final fold matches.
      This task still creates no public managed owner, route or source integration.

### Task 4: Transaction owner, durable replay and legacy facade delegation

**Files:** Create `apps/server/src/plugin-authority-store.ts` and
`apps/server/test/plugin-authority-store.test.ts`; replace standalone owner code
in `apps/server/src/plugin-trust-store.ts` with delegation. Keep old tests unchanged.

**Consumes:** Tasks 1–3; exact `PluginAuthorityDatabase`/`ManagedLookup`/
`ManagedCommit` contracts in spec §6. **Produces:**
`createSqlitePluginAuthorityDatabase({filename,now?,newDatabaseId?})` and the
backwards-compatible standalone wrapper. One returned authority owner has one
connection, borrowed `trust` without close, synchronous read/commit methods and
idempotent async owner close.

- [ ] **Step 1: Add RED tests for owner lifetime and facade compatibility.** Test
      borrowed `trust` has no close, owner close invalidates it with old trust-closed
      and managed reads with authority-closed, repeated owner close succeeds, and
      standalone/borrowed returned trust facts remain mutable isolated copies.
      Open old and new constructors on the same temp DB, prove shared sequencing and
      class identity at the old import path. After import, both facade constructors
      reject every managed trust event kind with `plugin-trust-invalid`; manual IDs
      still append trust only without an operation. New snapshot/commit results are
      frozen; do not change the old mutable-copy test to accept freezing.
- [ ] **Step 2: Add RED transaction and lookup tests.** Use one temp owner helper
      with test-local afterEach closing all owners/removing their files. Import then
      activate, disable, enable, revoke, uninstall and re-activate with fresh reviews;
      assert exact counts/cross-links and reopening preserves all facts. Repeat each
      no-op with a **new** request ID and verify operation head alone advances.
      Reusing the prior command gives replay. Example core replay assertion:

```ts
const firstInput = importInput('import-a', 0);
const first = owner.commitSync(firstInput);
const replay = owner.commitSync({
  request: firstInput.request,
  prepared: { kind: 'invalid-evidence' } as unknown as ManagedPreparation,
});
expect(replay.kind).toBe('replayed');
expect(replay.operation).toEqual(first.operation);
expect(owner.snapshotSync().heads).toEqual({
  installSequence: 1,
  trustSequence: 0,
  operationSequence: 1,
});
```

This proves in-transaction request lookup precedes parsing evidence and stale
original CAS. Add global ID conflicts across commands/plugins and changed
preview/review/intent/immediate fields. `lookupSync` must find the same operation
after reopen and return current snapshot after later selection/revoke.

- [ ] **Step 3: Run targeted RED tests.** Run
      `pnpm exec vitest run --config vitest.config.ts apps/server/test/plugin-authority-store.test.ts apps/server/test/plugin-trust-store.test.ts`.
      Missing owner/expected behaviors are the intended failures.
- [ ] **Step 4: Implement one connection owner and prebuilt sync results.** Open and
      initialize schema under a short transaction. Read methods use a short read
      transaction. `commitSync` canonicalizes request; begins immediate; validates
      logs; checks durable request; only absent requests validate evidence and resolve
      transition; appends; validates after readback; prepares immutable result; commits
      and returns it. The critical tail is exactly:

```ts
const afterSnapshot = readAuthoritySnapshotTx(database);
const result = detachAndFreeze<ManagedCommit>({
  kind: 'committed',
  operation: transition.operation,
  afterSnapshot,
});
database.exec('COMMIT');
return result;
```

Replay constructs its `currentSnapshot` result before ending its transaction
and appends nothing. Clock/UUID are not called on replay. Rollback preserves the
primary failure if SQLite already rolled back. Closed/busy/protocol/storage
authority errors retain cause. Do not expose a general async transaction hook.

- [ ] **Step 5: Delegate the standalone API and manual facade.** The wrapper creates
      an owner and returns explicit `append`, `events`, `close` delegates. The owner
      manual facade reads full current logs inside its transaction, rejects owned IDs,
      appends through trust primitives and returns a prebuilt mutable detached copy.
      Facade errors retain the four original codes; a busy failure maps to trust-storage.
      Facade `events` returns mutable copied trust data after full validation. Only
      owner closes the connection; owner does not import the wrapper.
- [ ] **Step 6: Run all authority and existing trust tests; request review.** Include
      all four current targeted files, Server typecheck/lint and focused formatting.
      Reviewer verifies second lookup is before preparation/CAS, request ID is global,
      no-op has a durable operation, and successful COMMIT has no fallible tail. Do not
      add source/HTTP behavior to demonstrate a persistence-only API.

The owner implementation also follows the spec's explicit failure lifecycle:
`database.isTransaction` (Node since v24.0) distinguishes automatic rollback from
an active transaction on failure; failed/uncertain rollback poisons the owner.
Closing marks unavailable first, preserves storage errors on failure, and permits
cleanup retry without reopening data operations. Successful COMMIT still has no
state inspection/read/validation tail. If COMMIT throws with no active transaction,
treat the outcome as ambiguous and poison/reopen with the same request ID; this
is distinct from a precommit write's confirmed automatic rollback. Test that case
with an exec spy that performs native COMMIT and then throws, proving no ordinary
retry/application occurs and a new owner finds the original request fact.
Preserve the old runtime DROP-trust-table
error as trust-storage; do not map every failed SQL read to protocol.

### Task 5: Atomicity, corrupt history, complete verification and documentation

**Files:** Create `apps/server/test/plugin-authority-integrity.test.ts`; extend
focused authority tests when the failure concerns their existing contract; update
the three documentation paths in the file map. No production fault-hook API is
introduced solely for tests.

**Consumes:** Final public owner plus real append/readback/freeze seams.
**Produces:** behavior evidence proving the transaction/replay guarantees and
accurate persistence-only documentation.

- [ ] **Step 1: Add RED real-SQLite write-failure tests for all three streams.** After
      a valid imported candidate, install a trigger on the next expected write to
      trust/install/operation in turn, attempt activation and assert all heads/facts
      remain at the pre-operation snapshot. Drop trigger and repeat the **same** request
      to prove no durable request identity or sequence was consumed:

```sql
CREATE TRIGGER reject_operation BEFORE INSERT ON plugin_operation_events
BEGIN SELECT RAISE(ABORT, 'injected operation failure'); END;
```

Also exercise `RAISE(ROLLBACK, 'primary failure')`; rollback cleanup must not
replace the internal primary cause. Test the final operation INSERT failing
after trust/install INSERTs so cross-stream rollback is actually exercised.

- [ ] **Step 2: Add RED precommit readback/result-construction failure tests.** An
      AFTER INSERT trigger may deliberately replace the new operation JSON with
      malformed content; after-read validation must roll back the corrupt row and
      its authority facts. For construction, spy/mock the exported pure
      `detachAndFreeze` helper at the final result object and throw once when its
      input has `kind:'committed'`. Assert no new trust/install/operation remains,
      restore the spy, and retry successfully with contiguous heads. No public
      `onBeforeCommit`/`faultInjector` option is added to the owner.
- [ ] **Step 3: Add RED successful-COMMIT boundary tracing.** Capture real SQLite
      prototype methods before spying. Arm a test-only phase around one managed commit;
      after the real `exec('COMMIT')` succeeds, mark phase committed. A spied `prepare`
      or `detachAndFreeze` must throw if invoked while still in that post-commit phase.
      Disarm immediately after `commitSync` returns; assert a non-Promise result and
      valid durable facts by a subsequent normal read. In Vitest restore all spies
      in finally. This targets the externally important boundary rather than counts
      of incidental SQL calls. Also test invalid clock output rolls back and replay
      does not invoke the clock.
- [ ] **Step 4: Add rollback/close lifecycle failures and remaining adversaries.**
      Spy on native `exec` only at ROLLBACK to inject a cleanup failure, and at
      `isTransaction` getter for unreadable transaction state. Assert the original
      primary cause and cleanup cause survive, every managed/facade read/write
      now rejects as closed, and close still releases the native resource. In a
      separate case make native close throw once, prove all data methods stay
      unavailable, then restore close and repeat it successfully/idempotently.
      Preserve the existing RAISE(ROLLBACK) case proving a healthy owner remains
      usable when SQLite already ended the transaction. These are test-only spies,
      restored in finally; no fault option is added to the owner.

      Seed bad JSON/envelopes, gaps, unsafe BigInt sequences, missing identity/required
      index, wrong links/kinds/digests/manifests/timestamps, duplicated request IDs
      where schema replacement permits a corrupt fixture, altered fingerprint,
      impossible no-op/head/projection, and unlinked post-ownership trust. Every
      read/write rejects corruption without appending/repairing. Mutate original
      input/evidence after commit and attempt mutations of every nested result;
      persisted facts stay unchanged and managed outputs stay frozen. Existing trust
      output mutations still succeed without changing future reads.

- [ ] **Step 5: Run the focused integrity test and fix only proven gaps.** Run
      `pnpm exec vitest run --config vitest.config.ts apps/server/test/plugin-authority-integrity.test.ts`.
      Each failure must demonstrate a missing promised behavior. Preserve primary
      causes; no test-only production escape hatch, relaxed schema or extra queue.
- [ ] **Step 6: Synchronize design/learning documentation with final code.** Update
      installation design's table list and request-replay contract to link the 6.2a
      spec. Foundation describes only persistence and states managed exposure is still
      deferred. Learning doc shows actual imports and this DB-only usage:

```ts
// For a Server-internal module beside plugin-authority-store.ts:
import { createSqlitePluginAuthorityDatabase } from './plugin-authority-store.js';
const authority = createSqlitePluginAuthorityDatabase({ filename: '/absolute/weave.sqlite' });
try {
  const snapshot = authority.snapshotSync();
  // A later manager checks lookupSync before doing artifact/preview work.
  const prior = authority.lookupSync({
    requestId: 'import-example',
    command: {
      kind: 'import',
      previewId: 'preview-example',
      expectedInstallSequence: snapshot.heads.installSequence,
    },
  });
  console.log(prior.kind);
} finally {
  await authority.close();
}
```

Explain sticky managed ownership, old mutable facade compatibility, fresh no-op
versus replay, exact before-COMMIT construction, no historical application data,
and no ownership/Runtime/HTTP capability in 6.2a. Do not suggest the preview above
exists, grant trust from old bytes, or make DB calls stand in for artifact checks.

- [ ] **Step 7: Run complete verification and independent whole-topic review.**
      Run `pnpm --filter @weave/server test`, targeted changed-file formatting, then
      root `pnpm check`. Once passing, broaden/repeat only for new changes or concrete
      unresolved concerns. Record commands/results and review findings in the ledger.
      Review all diff paths for no package boundary/runtime/route/dependency changes,
      and ensure specification/plan/docs match final exported signatures.
- [ ] **Step 8: Hand completed reviewable work to root's approved Git workflow.**
      Root inspects explicit staged paths, writes a Chinese Conventional Commit,
      creates/attaches one 6.2a PR, waits for CI at the exact head and follows the
      repository's squash/delete workflow. This plan grants no task-agent Git action.
      6.2b begins on a different fresh topic branch; it is not added to this PR.

## Spec coverage and handoff checklist

| Spec contract                                                                          | Task/evidence                                  |
| -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Scope/package boundaries                                                               | Global constraints; Tasks 4–5 diff review      |
| External Zod/canonical command equality                                                | Task 1 input tests                             |
| Original trust API, errors, mutable copies and class identity                          | Tasks 2 and 4; unchanged old suite             |
| Three append-only logs, identity, lossless envelopes and full prefix validation        | Task 3; Task 5 corruption tests                |
| Every command transition/no-op and global request identity                             | Tasks 3–4                                      |
| Static lookup, transaction recheck, current-snapshot replay, no evidence use on replay | Task 4                                         |
| Atomicity and all fallible work before COMMIT                                          | Tasks 4–5 triggers/construction/boundary trace |
| No application history or premature integration                                        | Scope; Task 5 docs/review                      |
| Full checks and independently reviewed topic delivery                                  | Task 5                                         |

The manager's lookup-before-artifact ordering and post-commit source/admission
behavior are documented integration requirements only. Their actual tests belong
to 6.2c/d; this plan does not pretend a persistence test exercised Runtime effects.
