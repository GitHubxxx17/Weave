# Managed Plugin Store Ownership Implementation Plan — Stage 6.2b

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Bind one managed artifact root to one authority database and hold an exclusive cooperative live lease before any Server-owned 6.1 artifact work.

**Architecture:** The existing authority owner gains two narrow registration methods without exposing SQL/connection. A separate private rollback-journal owner SQLite connection commits root binding, then retains a lifetime exclusive transaction. A Server wrapper creates one artifact store only after exact main registration and drains its operations before releasing the lease.

**Tech Stack:** Existing strict TypeScript ESM, Node >=24.4 SQLite/fs/crypto/child_process, Zod and Vitest; no new dependency.

**Spec:** `docs/superpowers/specs/2026-11-21-plugin-store-ownership-design.md`; ADR 0005 and the completed Stage 6.2a authority API.

## Global constraints

- Server-private only; no new package/dependency or public `@weave/plugin-host` contract.
- No HTTP/config-variable/default-managed startup/source/Runtime/Generation/coordinator/Studio integration in 6.2b. Do not edit `main.ts` or route DTOs.
- Root binding commit → lifetime owner lease → matching main registration commit. No main transaction held while acquiring owner lock; owner busy_timeout 0.
- One root per authority DB; exact UUID/canonical path/store ID matching. Append-only metadata, no takeover/reset/relocation/migration endpoint.
- Main/owner regular file nlink 1; canonical linked ancestors allowed, leaf/descendant links rejected. Bounded no-link layout scan; no manual adoption or payload execution.
- Owner DB journal DELETE only; main DB settings/user_version/unrelated tables unchanged.
- One private 6.1 store; every stage/read combines caller signal with private loss abort. Observed loss aborts synchronously before observer; normal quiesce never aborts it. No raw handle, second queue or heartbeat/PID lease.
- Explicit allow-unbound root initialization only; detected partial/malformed metadata fails closed. Main marker+root tables initialize only when both absent; erased root rows/both tables are not guaranteed detectable. No reset API; existing valid 6.1 artifacts remain inert.
- Preserve internal primary/cleanup/observer causes. Stop new operations before draining, keep lock through consumer lifetime, close authority last.
- Tests live in apps/server/test and use disposable local data. Real independent child processes prove exclusion/crash release. Report only platforms/runtimes actually exercised; Electron in 6.3.
- Root owns all branch/commit/push/PR workflow; task agents do not commit or push.

## File structure

| Action | Exact path                                              | Responsibility                                                                                        |
| ------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Modify | `apps/server/src/plugin-authority-types.ts`             | Binding/registration/state types and narrow owner methods; strict schema exports.                     |
| Create | `apps/server/src/plugin-store-registration.ts`          | Main append-once root table/read/register primitives on existing connection.                          |
| Modify | `apps/server/src/plugin-authority-store.ts`             | Two domain methods inside existing owner transaction/lifecycle closure; approved initialization hook. |
| Create | `apps/server/src/plugin-store-ownership-types.ts`       | Ownership options/error/binding event/lease contracts and Zod.                                        |
| Create | `apps/server/src/plugin-store-paths.ts`                 | Canonical files/root validation, nlink identities and bounded 6.1 structural scan.                    |
| Create | `apps/server/src/plugin-store-lease.ts`                 | Owner DB schema/binding and exclusive lock acquisition/release; no artifact/runtime behavior.         |
| Create | `apps/server/src/owned-plugin-artifact-store.ts`        | Exact acquisition orchestration, guarded single artifact instance, tracking/quiesce/close.            |
| Create | `apps/server/test/plugin-store-registration.test.ts`    | Existing owner registration/lifecycle/main-head invariants.                                           |
| Create | `apps/server/test/plugin-store-ownership.test.ts`       | Filesystem policy, binding, lease integrity and cleanup faults.                                       |
| Create | `apps/server/test/owned-plugin-artifact-store.test.ts`  | Wrapper initialization, queued signals, drain and cleanup using the real artifact factory.            |
| Create | `apps/server/test/plugin-store-lease-process.test.ts`   | Real child exclusion, SIGKILL/recovery and races.                                                     |
| Create | `apps/server/test/support/plugin-store-owner-child.mjs` | IPC fixture for actual built Server ownership helper.                                                 |
| Update | `docs/architecture/foundation.md`                       | Verified ownership utility status, no managed runtime/API claim.                                      |
| Create | `docs/learning/2026-11-21-plugin-store-ownership.md`    | Exact binding/lock/cleanup protocol and platform evidence.                                            |

Private direction: owned artifact factory → paths/lease and authority domain API;
registration primitives → shared types and 6.2a private transaction/data helpers;
authority owner owns main connection. No owner raw connection callback escapes.

### Task 1: Narrow append-only main root registration

**Consumes:** Stable 6.2a source: constructor in `plugin-authority-store.ts`,
interface/options/errors in `plugin-authority-types.ts`, data helpers in
`plugin-authority-data.ts`, log initializer/readback in `plugin-authority-log.ts`.
Resolved initialization policy: add exactly one schema-marker
table plus the single root-events table. Initialize both atomically only when
both absent; reject partial/malformed state. No core identity version/rewrite or
redundant binding anchor is introduced. Erased root rows/both tables have an
explicit detection limit rather than a hidden strict-recovery claim.
**Produces:** `ManagedStoreBinding`, `ManagedRootRegistration`, `ManagedRootState`
from spec §3 and exactly two methods on `PluginAuthorityDatabase`:

```ts
readManagedRootStateSync(): ManagedRootState;
registerManagedRootSync(binding: ManagedStoreBinding): ManagedRootRegistration;
```

- [ ] **Step 1: Add RED real-SQLite tests for registration.** Open authority at a temp
      regular file; state returns its SQLite main location, immutable database ID and
      null registration. Register one exact binding and reopen; exact repeat appends
      zero rows, different root/store/database ID/path conflicts, second registration
      is impossible. Assert install/trust/operation heads unchanged, unrelated schema
      and user_version unchanged. Assert `plugin_managed_root_schema` holds exactly
      one immutable `{version:1,databaseId}` marker and root table starts empty;
      reopen preserves marker bytes and never appends another marker. A memory
      owner can read null location but register rejects managed configuration.
      Start from genuine 6.2a core tables with neither new table: opening initializes
      both and marker in one transaction, without changing core identity JSON.

```ts
const before = authority.snapshotSync().heads;
const record = authority.registerManagedRootSync(binding);
expect(record).toMatchObject({ sequence: 1, kind: 'managed-root-registered', binding });
expect(authority.registerManagedRootSync(binding)).toEqual(record);
expect(authority.snapshotSync().heads).toEqual(before);
```

- [ ] **Step 2: Run targeted RED tests, then implement table/primitives and owner methods.**
      Use exact `plugin_managed_root_schema`/`plugin_managed_root_events` schemas
      from spec §4. Export a strict `ManagedRootSchemaMarker` schema/type with
      version1/exact databaseId. A private `initializeManagedRootSchemaTx` receives
      the actual core identity, inspects BOTH table names, creates both/inserts one
      marker only if neither exists, validates both if present, and rejects a
      partial pair. Existing empty/malformed marker is never filled/replaced.
      Root-state read/register validates marker plus root schema/rows every time;
      no runtime missing-table fallback and no lazy CREATE in guards. Root events
      permit zero or one append-only registration.
      Obtain actual file with `database.location('main')`, canonicalize/check before
      short txn; never trust caller path alone and never open another main connection.
      Add the two methods directly inside the existing owner return object, using
      its private `transaction('BEGIN', ...)` / `transaction('BEGIN IMMEDIATE', ...)`
      closure and `timestamp()` only for a new event; `detachAndFreeze` completes
      before transaction COMMIT. These closure helpers are not imports/exports.
      New registration primitives take the private owned connection; no callback
      API or second main connection is added. The approved registry initialization
      hook goes after `initializeAuthoritySchemaTx` in the SAME constructor init
      transaction, never lazily in a read/guard. Keep root schema validation in the
      sibling registration module; existing log `validateSchema` stays private and
      its identity/install/operation all-or-none table set stays intact. This
      method registers configuration, not a managed request, so it appends no operation/trust/install fact.
- [ ] **Step 3: Add corruption/rollback/lifecycle cases.** Wrong SQL envelope/JSON,
      duplicated sequence under corrupt table fixture, malformed UUID/path, closed/
      poisoned owner, missing/incompatible table and trigger failure must preserve
      6.2a causes/lifecycle. Failed registration leaves no root row. Ambiguous COMMIT
      is reconciled on reopen by exact binding, never a fresh store ID. Existing trust
      API tests remain unchanged, including original four errors/mutable copies.
      Root methods must share actual owner unavailable/closed and failedTransaction
      state: frozen `identity` alone is no live-connection check. Owner methods
      poison/retry close through existing closures rather than independent states.
      Add RED before-open tests dropping only marker table or only root table:
      constructor rejects protocol and does not recreate the missing half. Empty
      marker rowset, wrong databaseId/version/shape and malformed root schema/record
      also reject without repair. Runtime deletion is a failed read, never an empty
      registration result. Inject initialization failure after table creation or
      marker INSERT and verify both new tables/marker roll back together. Use an
      initialization SQL exec/prepare spy for the deterministic thrown boundary,
      restored in finally; no production fault option or repair path is added.
      Document the negative limit: erased registration rows or BOTH tables before
      restart cannot be identified as former registration with this schema. A
      legacy-core-only fixture therefore still initializes; do not write an assertion
      promising detection of two-table loss or a new root's hidden prior history.
- [ ] **Step 4: Run package targeted tests/typecheck/lint/format and independent review.**
      Verify root table is additive; owner method names/types match the approved spec.
      Task 2 may proceed only after actual 6.2a/6.2b domain contracts are stable.

### Task 2: Path policy, owner binding and lifetime SQLite lease

**Consumes:** Task 1 domain state/binding; accepted ownership decisions; existing 6.1 layout.
**Produces:** strict ownership schemas/errors; bounded path checks; one private
lease constructor usable by the factory. Internal interfaces are:

```ts
interface ValidatedStorePaths {
  readonly databaseFile: string;
  readonly storeDirectory: string;
  readonly ownerDatabaseFile: string;
  readonly rootExists: boolean;
}
interface ManagedStoreLease {
  readonly binding: ManagedStoreBinding;
  assertHeldSync(): void;
  close(): Promise<void>;
}
async function validateStorePaths(options: {
  readonly databaseFile: string;
  readonly directory: string;
  readonly initialBinding: 'allow-unbound' | 'require-bound';
}): Promise<ValidatedStorePaths>;
async function acquireManagedStoreLease(options: {
  readonly paths: ValidatedStorePaths;
  readonly databaseId: string;
  readonly existingRegistration: ManagedRootRegistration | null;
  readonly initialBinding: 'allow-unbound' | 'require-bound';
}): Promise<ManagedStoreLease>;
```

- [ ] **Step 1: Add RED filesystem policy and first-binding tests.** Use temp roots
      and actual fs symlink/hardlink cases. Canonical ancestor aliases are accepted;
      symlink root/owner leaf, owner/main/payload or staging file nlink >1, main inside root, root special or
      unexpected children and overbounded artifact/staging trees reject. Staging
      UUID names must be lowercase v4; exact limit fixtures accept an empty operation,
      optional payload, 2,001 visited entries including payload (root excluded), and
      65 directory levels from operation root. Reject 2,002/66. Artifact payloads
      retain 2,000-entry/64-level bounds; never count their fixed wrappers against
      payload limits. Empty and
      valid populated 6.1 roots bind only with allow-unbound/main-unregistered/no prior
      owner file. Metadata-only structural scan never executes/hash-imports payloads,
      does not clean staging, and leaves trust/install/operation heads unchanged.
- [ ] **Step 2: Add RED binding/schema/recovery tests.** Newly reserved file gets
      DELETE journaling, timeout0 and exactly one strict bound event; existing empty/
      corrupt/missing-schema owner file never receives CREATE/INSERT repair. Existing
      bound file with WAL/unexpected tables/linked journal rejects. Accept a regular
      SQLite rollback journal only through SQLite recovery, without manually deleting
      it. Exact binding reopens; database/path/store mismatch fails; no binding rewrite.
- [ ] **Step 3: Implement bounded validation and exclusive reservation.** Use async
      realpath/lstat/scans for acquisition; synchronous lstat/stat identity comparison
      for later assertion guards. Scan the complete layout before initializing an
      unbound root. For an existing owner, validate canonical leaves, fixed root
      children and sidecars before open and defer artifact/staging traversal until
      the lease is held so live staging changes do not interfere with contention.
      Owner reservation uses `wx` 0600 and only its creator
      initializes schema. Never pass unsupported read-write/no-create flags to Node
      SQLite 24.4: existing-file open is bracketed by identity checks and no repair SQL.
      Detectable disappearance/replacement fails closed and may leave an inert empty
      native-created file; do not pretend same-user hostile races are excluded.
- [ ] **Step 4: Implement binding commit then lease on one private owner connection.**
      For virgin reservation set/verify DELETE and busy0; bind in short exclusive txn,
      prebuild result then COMMIT. Then acquire lifetime BEGIN EXCLUSIVE on SAME
      connection, re-read binding and recheck leaf identities/layout. Existing binding
      is validated without schema creation. No main transaction is active. Return
      lease only while `isOpen && isTransaction`; no async application SQL is exposed.

The private lease module also owns
`readAndValidateBinding(owner: DatabaseSync): RecordedManagedStoreBinding` and
`assertExactBinding(actual: ManagedStoreBinding, expected: ManagedStoreBinding): void`;
neither is exported to consumers. Compare transient dev/ino/type/nlink, not
ordinary database size/mtime or directory child-count link changes.

```ts
owner.exec('BEGIN EXCLUSIVE');
const heldBinding = readAndValidateBinding(owner);
assertExactBinding(heldBinding.binding, expectedBinding);
// Retain this transaction on the private connection until explicit release.
```

- [ ] **Step 5: Add lease failure/close tests and review.** Invalid query/transaction
      state, rollback/close errors preserve causes; unavailable lease never silently
      reconnects. Repeated successful close is idempotent; failed cleanup can retry
      without restoring operations. Keep committed binding intact on every unwind.
      Run targeted ownership tests plus Task 1 tests, typecheck/lint/format and review.
      No new disposable feasibility probe; permanent process evidence belongs Task 4.

### Task 3: Owned artifact wrapper and fail-closed lifecycle

**Consumes:** Authority root methods, validated paths/lease, existing
`createPluginArtifactStore`, `PluginArtifactStore`, and `PluginArtifact`.
**Produces:** exact `openOwnedPluginArtifactStore`/`OwnedPluginArtifactStore`
contracts in spec §3; no raw store, queue or SQL exposure.

- [ ] **Step 1: Add RED initialization-order and half-binding tests.** Spy only on
      narrow authority domain methods/native lease boundary when order cannot be
      observed directly; assert real persisted records. Root binding exists before
      lifetime acquisition, main registration after held lease. Failure before main
      registration releases local lock but retains binding; next exact factory can
      finish, conflicting main registration cannot. Main registration already naming
      a different root rejects BEFORE any owner file is created at the requested root.
- [ ] **Step 2: Implement orchestration with reverse-order resource cleanup.** Validate
      options/state/path and root's prior registration; acquire root lease; call main
      registration while held; recheck state/identities; create ONE private 6.1 store.
      On failure close only acquired local resources, leave durable metadata/content.
      The wrapper borrows authority and does not close it. Use its root
      state method to verify actual availability; reading frozen identity alone
      cannot detect closed/poisoned owner. Factory returns no source,
      reload, Runtime or HTTP objects. Create one private loss AbortController before
      any store call. Require the spec's observer signature returning `undefined`,
      callable Zod validation and runtime exactly-undefined result;
      Promise/thenable return fails synchronously without awaiting, with rejection
      observed to avoid an unhandled promise. Preserve observer/ownership causes.
- [ ] **Step 3: Add RED guarded-operation and drain tests.** Use real 6.1 stage/read
      for payload behavior, with a deterministic fs spy/promise gate only to hold an
      operation at a safe I/O point. Track all dispatched calls including pending
      artifact queue items. Add an always-resolving completion ticket to a private
      Set BEFORE each synchronous underlying dispatch; ticket removal/resolve is
      after wrapper settlement guard in finally, including synchronous dispatch
      failure. Caller result retains its real rejection; avoid a detached rejecting
      finally Promise. The Set is accounting, not a scheduler: no chained enqueue,
      new HostQueue or altered call order. Quiesce closes new admission synchronously
      before its first await, snapshots tickets and awaits them; repeated quiesce
      shares the barrier. Failed state is retained while draining rather than
      rewritten to normal quiescing, so loss abort/cause cannot be cleared. It rejects new work immediately, waits dispatched calls,
      and a second lease remains busy until explicit close; close waits before release.
      Finishing a normal quiesce is not reported as ownership lost. No extra wrapper
      queue changes operation order or permits untracked access to the raw store.
      Add the deterministic must-fix case: A is held at an actual 6.1 filesystem
      promise gate while B (a read targeting a distinct known-artifact sentry) is
      queued. Seed A/B different digests using the owned real store before arming
      spies. A read is blocked at its distinct payload `opendir`; B read is then
      dispatched synchronously with a valid caller signal. Wrap the actual factory
      return only in the test to record passed effective signals, while still calling
      the original real store/HostQueue. Now close borrowed authority and call
      `assertHeldSync` before releasing A's promise gate; observer records that both
      captured effective signals are already aborted. Release A, await both wrapper
      promises and quiesce tickets. Assert B's distinct payload sentry has zero
      lstat/opendir/open/read entry and real bytes remain unchanged. Test seam is a
      Vitest module spy/real fs gate, never a production failpoint/API injection.
      Restore gate/spies in finally even on assertion failure.
      Observe real paths/state, not only callback counts. Do not claim A's already
      issued native I/O is cancelled retroactively. Run normal-quiesce counterpart:
      neither effective signal aborts, B completes while lease is still held.
- [ ] **Step 4: Implement synchronous fail-closed boundaries.** `assertHeldSync`
      validates lease state, main availability/current registration, main/root/owner
      identity/nlink. Every private underlying call receives `AbortSignal.any` of
      caller and private loss signals (or loss signal alone when no caller signal),
      including queued stage/read. On observed loss: mark failed/save cause, abort
      private controller synchronously, invoke/validate observer once, then throw;
      no await occurs between those actions. Store settlement preserves the saved
      loss and relevant operation/observer causes. Existing 6.1 queued pre-filesystem
      abort check prevents B starting after observed loss; active work stops only
      at supported abort boundaries. Quiesce never aborts this controller. Caller
      abort and ordinary artifact errors keep their original behavior/code while
      ownership stays healthy; they never trigger the loss observer/controller.
      A throwing/async/thenable observer fails closed. External authority.close
      triggers managed failure at next guard. No heartbeat, second queue or API hook.
- [ ] **Step 5: Add lifecycle cleanup/admission-contract cases.** Missing/replaced
      owner path after startup, native lease state loss, observer throw, operation+
      cleanup failure, close retry and partial-init failures all preserve cause and
      prevent new operations. Test quiesce retains lease for a simulated consumer
      barrier; caller releases barrier before close. Repeated/concurrent quiesce
      shares drain; close shares an in-progress attempt but clears a failed attempt
      so later cleanup retry works while all data operations remain rejected.
      Do not cache a rejected close Promise forever. Test caller-only cancellation
      leaves the loss controller/observer untouched; test async and custom-thenable
      observers cannot delay fail-closed state. Document real pinned-generation
      integration as 6.2c/d responsibility, not a fake Runtime claim in this task.
- [ ] **Step 6: Run all ownership/registration/6.1/6.2a relevant tests and review.**
      Package checks pass; verify only Server files change and the plugin-host package
      API remains unchanged. A separate reviewer checks order, lost-lock observer,
      wrapper inaccessible raw store and exact cleanup phase reporting.

### Task 4: Permanent real-process tests and delivery evidence

**Consumes:** Final owned factory and bound metadata protocol. **Produces:** real
process acceptance under disposable local roots and accurate documentation.

- [ ] **Step 1: Create a real Node IPC fixture against fresh compiled Server modules.**
      The fixture is ordinary `.mjs`; it dynamically imports two exact module file URLs
      supplied by the test parent. In beforeAll, make a unique output directory below
      Server workspace `apps/server/node_modules/.cache/weave-owner-test-*` (create `.cache` if absent),
      first require fresh workspace dependency builds with
      `pnpm --filter @weave/server^... build` as its beforeAll prerequisite, also
      when invoked directly. Then use `execFile` for the existing TypeScript CLI without
      shell interpolation:

```ts
await execFileAsync(process.execPath, [
  require.resolve('typescript/bin/tsc'),
  '-p',
  join(repositoryRoot, 'apps/server/tsconfig.json'),
  '--outDir',
  join(outputRoot, 'server'),
]);
await writeFile(join(outputRoot, 'package.json'), '{"type":"module"}');
```

The output remains beneath apps/server/node_modules ancestry so compiled imports
find the Server package's existing workspace dependency links, not assumed root
workspace links. No shared `dist` is overwritten; afterAll removes
only its unique output after child exit. Parent passes compiled
`server/plugin-authority-store.js` and `server/owned-plugin-artifact-store.js`
as `pathToFileURL(...).href` file URLs in IPC startup config; child does not
import a test substitute. Use `{ execArgv: [] }` for ordinary forked `.mjs`
fixtures so Vitest-only inherited loaders/arguments cannot leak into child startup.
For race tests, the fixture first opens authority and reports `prepared`; the
parent opens same-main handles sequentially, then releases their `start` gates.
This prevents authority-constructor contention from substituting for an owner
acquisition race. It reports `{kind:'held',pid,binding,nodeVersion,sqliteVersion}`
only after actual acquisition, accepts `close`/`write-main` messages, and sends structured typed
errors on failure. Parent uses fork/IPC and bounded event deadlines, no fixed
sleep guesses. Use `createRequire(import.meta.url)` for CLI resolution and the
existing Node util promisify; no ts-node/tsx dependency is added.

- [ ] **Step 2: Add RED exclusion and SIGKILL tests using three real children.** A
      obtains the root lease. B with same DB/root reports busy and exits with no store.
      Parent SIGKILLs A and awaits actual exit; C acquires same unchanged binding and
      closes normally. Establish/release a seed binding and read its event baseline
      before A starts, since a live exclusive holder blocks a second owner-file read.
      Read bound event bytes/count after all holders close; integrity_check is
      ok. In finally terminate/await every live child before deleting temp data.

The test harness defines `startOwnerChild(config)` returning an IPC handle with
`waitFor(kind)`, `kill(signal)`, and `waitForExit()`; every wait rejects on child
error/early exit/deadline and detaches listeners when settled. No wait can hang
the suite indefinitely. The following uses that test-local harness:

```ts
const held = await ownerChild.waitFor('held');
expect((await contenderChild.waitFor('error')).code).toBe('plugin-store-busy');
ownerChild.kill('SIGKILL');
await ownerChild.waitForExit();
const replacement = await startOwnerChild(sameConfiguration);
expect((await replacement.waitFor('held')).binding).toEqual(held.binding);
```

- [ ] **Step 3: Add real main-write/race/recovery scenarios.** While A retains owner
      lease, its main authority append/read remains available and another main DB
      transaction is not globally locked by owner DB. After A exits, a different DB
      or copied UUID at another path cannot acquire root; old path/new UUID cannot
      adopt it. Two children same DB/different roots race: at most one root registers,
      loser releases its lease and cannot overwrite winner. Root-bound/main-unregistered
      child termination is recovered only by exact identity; corrupt/missing owner
      after registration refuses recreation. Parent seeds committed half-binding with
      SQL fixture or a child intentionally terminating at known protocol phase; no
      production failpoint is added.
- [ ] **Step 4: Add exclusive-create/partial-unbound and path acceptance.** Simultaneous
      virgin contenders cannot both initialize/hold root. Existing reserved-but-empty
      owner fails recovery-required rather than auto-delete/rebind. Hardlink/symlink
      cases and bounded populated 6.1 first-binding run on actual local fs where
      supported. Unsupported capabilities are explicit skips with reason; failures
      cannot be swallowed as success. Record actual OS/Node/SQLite in evidence;
      Windows forced termination is not reported as POSIX SIGKILL semantics.
      `AbortSignal.any` (Node20.3/18.17), SQLite location/isTransaction (24.0) and
      isOpen (22.15) meet the 24.4 floor; declarations/static checks do not replace
      actual supported-platform tests.
- [ ] **Step 5: Synchronize architecture/spec/learning docs.** Explain root/main
      append-only registration, lock order, exact half-binding recovery, no-create
      Node limitation, one private store, quiesce/drain/lease/authority close order,
      private loss abort for already queued calls, synchronous observer/thenable
      rejection and later integration guard obligations. Include marker+root
      initialization/partial-corruption refusal and the explicit erased-row/both-
      tables detection limit; do not promise arbitrary metadata repair protection. Explain no
      HTTP/default managed mode, no takeover/GC, no heartbeat and no trust granted by
      binding. List actual macOS/process tests separately from earlier feasibility
      probe and deferred Windows/Linux/network FS/Electron acceptance.
- [ ] **Step 6: Run complete checks and independent review; root owns delivery.** Run
      focused process test after build, Server tests/typecheck/lint, formatting, then
      root `pnpm check`. Review no accidental source/API exposure or package dependency
      changes. Root handles one topic PR/CI/exact-head squash after the work is concrete;
      6.2c source integration starts on its own fresh branch. No task-agent commits.

## Contract calibration and review

Stage 6.2a is merged as PR #85 (`c437a34`). Task 1 extends its existing
constructor/lifecycle closures through the exact methods in spec §3.1. The
accepted marker+single-root policy initializes metadata only when both tables
are absent, rejects detectable partial/malformed metadata, and acknowledges
erased-row/two-table-loss non-detection. No core identity mutation or redundant
binding anchor is introduced.

The temporary compile fixture remains within the existing toolchain; dependency
build/file URLs/execArgv and unique cleanup are explicit. No change to 6.1 package
contracts is assumed. Use private in-flight completion tracking and a loss
AbortSignal around its existing stage/read; no queue/lifecycle API is added to
plugin-host.

Spec coverage: Task 1 owns marker+main append-only registration and detectable
partial-corruption refusal; Task 2 owns bounded paths/root binding/lifetime lock;
Task 3 owns order/half-binding/wrapper/lifecycle; Task 4 owns real-process evidence,
documentation and full review. Source eligibility, Generation drain integration,
management routes and Electron acceptance remain outside this implementation plan.
