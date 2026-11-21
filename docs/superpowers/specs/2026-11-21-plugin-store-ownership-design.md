# Managed Plugin Store Ownership Design — Stage 6.2b

**Date:** 2026-11-21

**Status:** Accepted Stage 6.2b implementation refinement after Stage 6.2a delivery.

## 1. Goal, scope and existing evidence

Give Server one enforceable, cooperative live owner for an immutable 6.1 artifact
root and bind that root permanently to one authority database identity/path.
The lease uses a separate rollback-journal SQLite file held in a lifetime
`BEGIN EXCLUSIVE`. The main authority database continues ordinary short
transactions. Binding is append-only configuration metadata, not a trust grant,
selection, application history or another managed-command operation.

This slice adds Server-private persistence/ownership helpers and a guarded wrapper
around one `PluginArtifactStore`. It adds no HTTP routes, environment variables,
default managed mode, source selection, Runtime import, Generation changes,
coordinator queue or Studio interaction. It must not silently enable managed
loading merely because a root or registration exists. `main.ts`, existing route
DTOs and `@weave/plugin-host` public contracts stay unchanged in this slice.

Use ADR 0005, the installation design, the 6.2a authority design, and the approved Stage 6 delivery decisions. The earlier disposable real-process
probe found exclusion and SIGKILL release on local macOS Darwin 24.6.0 arm64,
Node 24.4.0/SQLite 3.50.2.
This is feasibility evidence only; do not rerun that probe or describe it as a
permanent test. This slice adds permanent child-process tests. Electron acceptance
belongs to 6.3; Windows/Linux/network-filesystem behavior remains unclaimed until
actually tested there. No heartbeat, PID expiry, lease stealing or OS sandbox
promise is introduced.

## 2. Accepted decisions

- Through normal APIs one authority database UUID/path may register at most one
  root/store UUID; changed binding is rejected and there is no reset route.
- Main registry initializes one append-once version-1 schema marker containing
  databaseId and an empty single-root events table together, only when BOTH tables
  are absent. Partial/malformed metadata fails closed. Core identity stays version 1.
  Deleted root rows or both ownership tables cannot always be distinguished from
  legacy/unregistered state; §4 states this limit without promising arbitrary SQL
  or disk-metadata repair protection.
- Root binding commits FIRST, lifetime lease is acquired SECOND, matching main
  registration commits THIRD. There is no distributed two-database transaction.
- Never retain a main DB transaction while acquiring/waiting for a root lock.
  Owner `busy_timeout=0`; contention fails promptly. No main journal setting changes.
- A root-bound/main-unregistered crash can finish only with the exact recorded
  UUID, canonical database path, root path and store ID. Mismatches never rebind.
- Main/owner DB files must be regular, have `nlink === 1`, and use canonical paths.
  Resolve linked ancestors; reject linked managed descendants and symlink leafs.
  Unsupported file identity semantics fail configuration rather than guessing.
- Existing populated 6.1 roots can receive a first binding only through explicit
  managed-startup initialization, validated layout, no main registration and no
  prior ownership database. Existing artifacts remain inert, never auto-selected.
- Missing/corrupt owner metadata after main registration is fatal. A copied main
  UUID at another path, or new UUID at the old path, cannot inherit the root.
- Admission/administration and preparation stop and generations drain before lease
  release. A lost/unusable lease blocks managed work; an in-memory queue is not a
  replacement for ownership.

## 3. API and why this shape

Prefer two narrow domain methods on the existing authority owner over an
arbitrary connection/transaction callback or a second main-DB connection:

```ts
interface ManagedStoreBinding {
  readonly version: 1;
  readonly databaseId: string;
  readonly databaseFile: string; // canonical main file
  readonly storeId: string;
  readonly storeDirectory: string; // canonical managed root
  readonly ownerDatabaseFile: string; // root/ownership.sqlite
}
interface ManagedRootRegistration {
  readonly version: 1;
  readonly sequence: 1;
  readonly kind: 'managed-root-registered';
  readonly occurredAt: string;
  readonly binding: ManagedStoreBinding;
}
interface ManagedRootState {
  readonly databaseId: string;
  readonly databaseFile: string | null; // SQLite main location; null for memory
  readonly registration: ManagedRootRegistration | null;
}

// Add these exact domain operations to PluginAuthorityDatabase in 6.2b.
readManagedRootStateSync(): ManagedRootState;
registerManagedRootSync(binding: ManagedStoreBinding): ManagedRootRegistration;
```

These two methods are Server-private configuration operations; only the owned
factory calls registration after holding the root lease. The method itself cannot
prove an external lock from a JSON binding and is not exposed to plugins/HTTP.
Do not mistake its path/schema validation for a lease capability. The state
obtains the main filename from `DatabaseSync.location('main')` on the
OWNED connection, not a caller's arbitrary file claim. Node exposes `location`
and `isTransaction` since v24.0, within the repository's >=24.4 floor. The
ownership layer canonicalizes/checks that location. Because SQLite resolves a
symlink leaf in its reported location, the managed root methods also check the
constructor opening filename leaf without changing legacy manual API behavior. Registration verifies the
binding database ID and its canonical path against that owned main file before
its short write transaction; it never opens another main connection. `:memory:`
remains usable by 6.2a/manual callers but cannot enter managed ownership.

`readManagedRootStateSync` uses a short read transaction and returns immutable
plain data; `registerManagedRootSync` begins immediate, compares absent/equal
registration, prebuilds/validates/freeze result, commits, and returns it. A matching
registration is idempotent with zero new fact; a changed registration conflicts.
The same owner lifecycle/error boundaries from 6.2a apply, including poisoned
rollback state and ambiguous COMMIT reconciliation. These two methods need no
request ID, do not advance any install/trust/operation head and cannot select or
trust a plugin. They are configuration metadata operations, not managed commands.

The Server wrapper is:

```ts
interface OwnedPluginArtifactStore extends PluginArtifactStore {
  readonly binding: ManagedStoreBinding;
  assertHeldSync(): void;
  quiesce(): Promise<void>; // reject new stage/read, drain started calls; keep lock
  close(): Promise<void>; // quiesce then release lock; caller has drained consumers
}
async function openOwnedPluginArtifactStore(options: {
  readonly authority: PluginAuthorityDatabase; // borrowed, never closed here
  readonly directory: string;
  readonly initialBinding: 'allow-unbound' | 'require-bound';
  readonly hostVersion?: string;
  readonly reservedIds?: readonly string[];
  readonly onOwnershipLost: (error: PluginStoreOwnershipError) => undefined;
}): Promise<OwnedPluginArtifactStore>;
```

The wrapper privately creates exactly ONE 6.1 store only after lease and main
registration succeed. It exposes guarded `stage/read`, not the raw underlying
store or owner DB/SQL handle. It tracks in-flight calls without a new scheduling
queue; the existing artifact queue still serializes its instance. Later 6.2c/d
uses the sole coordinator for application/admin order.

`onOwnershipLost` is a required synchronous observer for the lifecycle owner to
block affected managed admission before an ownership error escapes/another await.
It is not called for ordinary busy acquisition before any owner was returned.
6.2b tests it with a recorder; it neither imports Runtime nor prescribes the
future observer implementation. Its return type is `undefined`, rather than
`void`, so TypeScript rejects an async observer. Zod validates callable input;
at invocation the wrapper also requires the return value to be exactly undefined.
A returned Promise/thenable is a synchronous observer-contract failure, never an
awaited notification: keep failed state and preserve the violation with the
ownership cause. Observe any returned promise rejection without awaiting it so
it cannot become an unrelated unhandled rejection; it cannot authorize recovery.
Observer throws/return-value inspection errors are preserved too. This runtime
check remains necessary for untyped callers and must not widen into a generic
callback protocol. `assertHeldSync` is also the explicit later
admission/publication guard; a no-heartbeat design checks at operations and
admission boundaries, not on a timer. No independent monitor or PID record.

The wrapper borrows authority; composition must close it AFTER generations,
artifact wrapper and lease drain. Closing authority early is a lifecycle error:
state verification detects it, stops managed work and calls the observer. A lost
owner is never automatically reacquired by the same wrapper.

This is a Server-only interface extension; no package API change is needed. The
two owner methods and owned factory use the completed 6.2a transaction/lifecycle
implementation. A second main connection could split that policy and is excluded.

### 3.1 Calibration to the stable 6.2a implementation

The actual constructor is `createSqlitePluginAuthorityDatabase(options:
PluginAuthorityOptions)` in `apps/server/src/plugin-authority-store.ts`;
`PluginAuthorityDatabase`, `PluginAuthorityOptions`, `PluginDatabaseIdentity` and
`PluginAuthorityError` live in `plugin-authority-types.ts`. Its current interface
is identity/trust/snapshotSync/lookupSync/commitSync/close, exactly as assumed;
the two root-registry methods above are new Stage 6.2b methods, not existing APIs.

Keep registration SQL in a sibling `plugin-store-registration.ts`, using private
primitives on the same owned connection. `plugin-authority-log.ts` exports
`initializeAuthoritySchemaTx`, `readAuthoritySnapshotTx`,
`resolveManagedTransition` and `appendManagedTransitionTx`. Its `validateSchema`
is private, validates the existing four tables/unique indexes and tolerates
unrelated tables. Do not export it, add the root table to the existing three-table
all-or-none identity test, or pretend `readAuthoritySnapshotTx` validates root
metadata. Root registration validates its own schema/rows. It must not enter the
managed transition resolver or change authority event-head projections.

The store's `transaction`, `failedTransaction`, `timestamp` and error translators
are PRIVATE closure functions, not imported helpers. Add root read/register as
methods in that owner's returned object, reusing `transaction('BEGIN', ...)` /
`transaction('BEGIN IMMEDIATE', ...)`, `timestamp()` for a new registration, and
`detachAndFreeze` from `plugin-authority-data.ts` BEFORE COMMIT. Keep raw connection
inside the owner; no new exported transaction/callback or second main connection.
The registry initialization hook must occur in the constructor's existing short
initialization transaction after core initialization. It creates marker and root
events only when both are absent; an existing pair is validated and a partial pair
is protocol failure. It must not lazily CREATE during a guard.

The actual owner uses `unavailable`/`closed` state: failed/uncertain rollback or
COMMIT acknowledgement with no active transaction can poison it. All new
methods use that same requireOpen/transaction path and therefore reject with
`plugin-authority-closed` after poison/close. `close` marks unavailable before
native cleanup, succeeds idempotently, and permits retry after failed native close;
root registry code adds no independent main lifecycle. A wrapper guard must call
`readManagedRootStateSync`, rather than relying on the always-readable frozen
`authority.identity` to prove a live connection. Existing legacy wrapper delegates
to owner.trust and maps failures to its original four error codes; no legacy API
or output mutability changes are needed for this extension.

**Resolved initialization decision:** Root selected one append-once schema marker
plus the existing single-root events table, without a duplicate binding anchor or
core identity rewrite. The precise detection limits below are part of the
contract and do not imply arbitrary metadata-deletion recovery.

## 4. Persistent records and strict schemas

Main database adds these two append-once metadata tables:

```sql
CREATE TABLE plugin_managed_root_schema (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  marker_json TEXT NOT NULL
);
CREATE TABLE plugin_managed_root_events (
  sequence INTEGER NOT NULL PRIMARY KEY CHECK (sequence = 1),
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL
);
```

The schema marker is a strict immutable JSON value:

```ts
interface ManagedRootSchemaMarker {
  readonly version: 1;
  readonly databaseId: string;
}
```

Use these initialization/read rules:

1. In the existing owner's short initialization transaction, after core schema/
   identity validation, inspect existence of BOTH new tables. If both are absent,
   create both and INSERT exactly one marker `{version:1,databaseId:identity.databaseId}`
   in that SAME transaction; leave root events empty. This upgrades a valid 6.2a
   database without mutating its immutable singleton core identity or other facts.
2. If exactly one table exists, reject protocol without creating the missing table.
   If both exist, validate required column/primary-key shapes and read exactly one
   strict marker row with singleton 1/version 1/exact current databaseId. Empty,
   duplicate, malformed or mismatching marker is protocol; never reinsert/replace.
3. Existing root rows must be zero or one strict `ManagedRootRegistration` with
   sequence 1 and consistent SQL envelope/time/binding. Zero is an unregistered
   state; one may only be repeated with the exact same binding. Appending a changed
   root/store/UUID/path is conflict. No UPDATE/DELETE/reset/second root through APIs.
4. Every root-state read/register validates this marker and root schema/rows;
   runtime disappearance never becomes `registration:null` via lazy CREATE or
   missing-table fallback. Detectable SQLite corruption/read errors fail closed
   under existing protocol/storage error boundaries; invalid metadata is not repaired.

The marker records schema initialization only, not a second binding or a durable
copy of a previously registered root. Therefore an externally deleted root event
row can look unregistered, and deletion of BOTH tables before restart can look
like a valid legacy 6.2a database. This design cannot detect those states and does
not claim strict one-DB/one-root history after arbitrary same-user SQL or disk
metadata deletion/repair. A marker left behind with its root table missing, or the
reverse, IS detectable partial corruption and must fail rather than initialize.
The same is true for malformed marker/schema/row or SQLite-reported corruption.
No hidden repair, root search, identity cache or redundant binding anchor is added.
An intact root binding still prevents replacement/adoption of THAT root and permits
only its exact half-binding recovery; it cannot reveal a lost main registration
for another root. Normal API one-root enforcement and no-reset policy remain firm.

Initialization leaves unrelated tables, user_version, settings and all 6.2a event
heads unchanged. No root method advances install/trust/operation sequence. The
marker and root event never UPDATE/DELETE; no mutable mapping or reset endpoint.

`<root>/ownership.sqlite` is dedicated solely to root metadata/lease:

```sql
CREATE TABLE managed_store_binding_events (
  sequence INTEGER NOT NULL PRIMARY KEY CHECK (sequence = 1),
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL
);
```

Its one event is:

```ts
interface RecordedManagedStoreBinding {
  readonly version: 1;
  readonly sequence: 1;
  readonly kind: 'managed-store-bound';
  readonly occurredAt: string;
  readonly binding: ManagedStoreBinding;
}
```

Use `journal_mode=DELETE` and `busy_timeout=0` on THIS connection only. For a newly
created owner DB set DELETE and verify SQLite's returned mode; existing owner DB
must already use DELETE, not WAL/unsupported mode silently converted on startup.
Do not set main DB journal/timeout pragmas. The lifetime transaction inserts no
application or authority fact; binding is committed in an earlier short txn.

Strict Zod schemas validate external options, bindings/records, SQL envelopes,
SQLite query results and callbacks before use. UUIDs are valid strings compared
exactly; all paths are nonempty absolute without NUL. Owner path equals
`path.join(storeDirectory, 'ownership.sqlite')`; binding is version 1. Timestamp
is a valid UTC ISO string and envelope/time/payload sequence agrees. Read SQLite
integers as bigint then require exactly 1. Reject unknown fields, duplicate/empty
records in an existing owner DB, unknown user tables/triggers/views, malformed
JSON and conflicting data; do not create/insert into an existing unknown file to
make it look valid. Owner/main event timestamps may differ; binding objects must
be exactly equal. UUID/path equality, not a persisted inode, survives restart.

A binding event/result is detached/deeply frozen before its short transaction
COMMIT. A failure after a binding COMMIT cannot erase it; report acquisition
failure/recovery-required with original cause and leave inert metadata intact.
Main registration uses the identical binding payload, not a re-canonicalized new
path chosen after a conflict.

## 5. Filesystem/path policy and bounded existing layout

The main location must be a persistent regular local file. Canonicalize its
ancestors with `realpath`; `lstat` the leaf and reject symlink/nonregular/`nlink != 1`.
The authority owner captures managed eligibility before and immediately after the
native SQLite open. Each managed read and registration compares the opening path
and the SQLite main location to the captured canonical path and transient file
identity. Filesystem resolution preserves ancestor symlink and `..` lookup order.
The managed root may be absent (explicit first initialization creates it) or a
real directory. Its leaf cannot be a symlink; linked ancestors are canonicalized.
Owner file and every managed descendant may not be a symlink or special file;
owner/main files require nlink 1. Require positive usable device/inode metadata
for the supported local filesystem and retain current `(dev,ino)` only as a
transient replacement check, never as durable identity across restart. All
regular managed descendants, including payload, staging and SQLite journal files,
also require nlink 1; copied 6.1 payloads satisfy this without retaining hardlinks.
Reject unknown/unsupported filesystem identity rather than implying network FS
safety.

Compare canonical main file, root and owner paths to forbid the main SQLite file
or its sidecars inside the managed root and forbid owner/main being the same file.
The root's configured location is explicit; do not discover one by scanning manual
plugins or claim that a `.weave-store` spelling proves ownership. No manual path
is moved, adopted, overwritten or deleted. A caller's misconfiguration is rejected
when it does not match the exact allowed layout below.

Validate layout with lstat-based traversal that never follows descendants. Before
a first binding, only these optional children may exist:

- `artifacts/` with at most 64 lowercase SHA-256 directory names, each containing
  exactly a real `payload/` directory; payloads contain only real directories and
  regular files with nlink 1, subject to 6.1's 64-level/2,000-entry/1,000-file/20-MiB bounds.
- `staging/` with at most 64 operation directories whose names match lowercase
  UUIDv4 (`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).
  An operation root is depth 0 and may be empty; its only optional child is a real
  `payload/` at depth 1. Partial payload content requires neither descriptor nor
  digest. Count that payload wrapper plus its descendants: at most 2,001 visited
  entries (`2,000 + 1`, operation root excluded). Directory depth from operation
  root may be at most 65 (`64 + 1`), allowing 64 payload levels beneath payload.
  No descendant link/special file is accepted. These exact cleanup-shape bounds
  mirror 6.1; do not accidentally apply 2,000/64 to the operation wrapper itself.

No other root child, including a prior `ownership.sqlite` or sidecar, is accepted
as an unbound initial root. Empty and valid populated 6.1 roots are both allowed
only with `initialBinding:'allow-unbound'` and main registration absent. Structural
validation does not execute, hash, select or trust artifacts and does not infer
current selection. Full selected-artifact digest validation belongs to 6.2c using
6.1 `read` after ownership; it is not duplicated in this layer.

For a bound root, add only `ownership.sqlite` and the regular rollback-journal
sidecar `ownership.sqlite-journal` to the allowed root names. SQLite may need a
hot journal after crash; do not delete or treat it as lease ownership. Refuse WAL/
SHM sidecars and linked/special/unexpected descendants. Never scan unboundedly:
64 artifact payloads each use the 2,000-entry/64-level payload bound; 64 staging
operations use the exact 2,001-entry/65-level operation-root bound above. Fixed
artifacts/object/payload and staging roots are counted explicitly, never folded
into a stricter payload limit. Stop immediately at a per-tree limit/unexpected
entry. Cleanup is still performed only by 6.1 after an owned stage operation;
no ownership code deletes staging or published content.

Perform a bounded initial scan of an unbound root before creating/binding the
owner DB. For a root with an existing owner file, check the canonical leaf
identities, fixed root children and sidecars before opening owner SQLite.
Defer traversal below `artifacts/` and `staging/` until holding the lifetime
lease so a live owner's staging changes cannot interfere with contention
detection. Recheck canonical leaf identities and the complete bounded layout
under the lease, before main registration/return. A normal returned wrapper checks native lease state and
cached main/root/owner canonical identities/nlink at each guarded boundary
using synchronous lstat; descriptor binding/content remains immutable under the
held private lock. Transient replacement checks compare device/inode/type and the
required regular-file nlink, not main DB size/mtime or directory link counts that
change during ordinary writes/new child creation. Do not recursively rescan or hash all payloads on each admission. 6.1 stage/read
continues enforcing bounded payload rules on its actual target.

These checks exclude cooperating misconfiguration and detectable replacement;
they do not stop a malicious process with the same OS account from replacing
files or bypassing locks. Do not call inode checks an atomic filesystem sandbox.
No promise is made about unsupported network FS or sudden-power-loss behavior.

## 6. Initialization/acquisition protocol and lock order

The only explicit first-binding entry point is the factory with
`initialBinding:'allow-unbound'`. Future startup configuration may choose that
mode; this slice adds no default/config variable/HTTP initializer. `require-bound`
never creates an owner file or binding. An existing main registration always wins
over `allow-unbound`; the option never permits reset, relocation or takeover.

1. Validate static options/callback and require authority open. Read main identity,
   actual SQLite main location and existing registration in a completed SHORT
   main read transaction. Canonicalize paths and validate persistent/nlink
   eligibility and the pre-acquisition layout described in §5. If an existing
   registration conflicts with the requested canonical
   database/root, stop BEFORE creating/binding another root. Never retain this
   main transaction while touching/acquiring owner SQLite.
2. If owner file is missing and main registration exists, fail recovery-required;
   never recreate it. If owner file is missing, main is unregistered, layout is
   valid and initial binding is explicitly allowed, reserve `ownership.sqlite`
   with exclusive `wx` creation (0600). Only the invocation that created this
   previously absent file may initialize its schema. If another process creates
   it first, do not initialize/overwrite it; reopen only through the existing-file
   validation path, or return busy/recovery-required if it is not yet readable.
3. For the newly reserved file, open a private Node SQLite connection with DELETE
   journaling and timeout 0. In one synchronous SHORT `BEGIN EXCLUSIVE` transaction,
   create/validate the owner schema and INSERT one root binding (new store UUID,
   exact main UUID/canonical paths). Build/read/validate/freeze that binding before
   COMMIT. For an existing owner file, lstat/canonical identity-check before opening a
   read-write connection and immediately recheck that identity after open; validate
   its original schema/event/mode and never call CREATE/INSERT to repair emptiness.
   Node SQLite 24.4 has no read-write/no-create option. A disappearance/replacement
   race therefore fails closed and may leave an inert empty file from native open;
   it must never bind or repair it. Do not invent an unsupported constructor flag
   or silently raise the Node floor. This cooperating protocol does not promise
   same-user hostile replacement exclusion. A temporarily locked existing file
   yields busy; do not inspect another file.
4. After root binding has committed and with NO main transaction active, acquire
   lifetime `BEGIN EXCLUSIVE` on that SAME private owner connection. Re-read and
   compare the binding under the held transaction; recheck canonical identities/
   layout. A mismatch releases/cleans only this invocation's resources and fails.
   The committed root binding is never rolled back/removed. Existing binding may
   enter this lifetime transaction directly after its initial validation.
5. While the lifetime owner lock is held, call the authority's narrow
   `registerManagedRootSync(binding)` for a short main write transaction. It reads
   current registration AGAIN, verifies main UUID/file and exact absent/equal
   binding, INSERTs only if absent, and prebuilds result before COMMIT. A racing
   different root registration fails; never rewrite either binding. No code
   acquires an owner lock while holding a main transaction. Busy/other failure
   unwinds the lease but keeps already committed facts intact for exact retry.
6. Verify the held lease/identities and current matching registration, construct
   one 6.1 store and the guarded wrapper, then return. No source/reload/listen is
   started here. Any failed startup releases only acquired local resources in
   reverse order; a later exact startup may finish a root-bound/main-unregistered
   state without selecting artifacts or issuing a trust/operation fact.

The lifetime owner transaction intentionally spans awaited artifact/consumer work;
its only purpose is retaining the lock. The rule against await applies to the
SHORT binding/main-registration transactions, not to this deliberately long-lived
read/lock holder. It does not run arbitrary application SQL in that transaction.
Owner and main connections have separate responsibilities. With timeout 0 no
cross-DB acquisition waits are hidden behind the main transaction.

## 7. Recovery and contention outcomes

| Observed state                                                   | Result                                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| No main registration, no owner file, empty/valid 6.1 root        | Initialize only with explicit allow-unbound; never select payloads.                                                   |
| Exact root binding, no main registration                         | Acquire lease, then append exact main registration; no new store UUID.                                                |
| Exact root and main bindings, no live holder                     | Acquire lease and reuse immutable records; append zero facts.                                                         |
| Same canonical root held by another process                      | Immediate busy; no artifact store/operations/loader.                                                                  |
| Different main UUID/path targets bound root                      | Owner mismatch when binding can be read; if locked, busy first is acceptable.                                         |
| Existing main registration targets another root                  | Reject before creating/binding requested root.                                                                        |
| Copied main DB UUID at a new canonical path                      | Reject exact path mismatch, even after prior owner exits.                                                             |
| Recreated main file at old path/new UUID                         | Reject root's old UUID; no adoption.                                                                                  |
| Main registered, owner file missing/corrupt/empty                | Fatal recovery-required; do not recreate/insert/reset.                                                                |
| Existing owner file with no committed binding, main absent       | Fatal recovery-required, even allow-unbound; do not infer this is virgin.                                             |
| Crash after new owner file reserved but before binding commit    | Same conservative unbound-file failure; no automatic deletion/rebinding.                                              |
| Crash after root binding commit, before/during lease/main commit | SQLite main all-or-none; exact restart inspects current registration and finishes if absent.                          |
| Main/root registration mismatch                                  | Fatal; neither side overwritten.                                                                                      |
| Same main concurrently initializes two different roots           | At most one main registration wins; loser releases lease and remains an inert bound root that cannot override winner. |
| SIGKILL while holding lifetime lease                             | OS SQLite lock is released; exact later process may acquire; no PID/timeout decision.                                 |

This protocol sacrifices automatic repair of an unknown pre-binding file to avoid
silently resetting a previously bound root. There is no reset/takeover/relocation
API in 6.2b. Operator/offline migration tooling is a separate design. Startup
errors preserve which durable phase completed but do not pretend two DB commits
were atomic. Repeated same-binding initialization is a safe config retry, not a
repeat plugin command or a reason to append a new trust decision.

## 8. Guarding operations, loss and shutdown

Each returned wrapper retains one private ownership-loss `AbortController`
(named `ownershipLossAbort` below). It is separate from caller cancellation and is never exposed
or reset/reused for a later owner. Every underlying 6.1 `stage/read` receives an
effective signal combining the caller's optional signal with this loss signal:

```ts
const signal =
  callerSignal === undefined
    ? ownershipLossAbort.signal
    : AbortSignal.any([callerSignal, ownershipLossAbort.signal]);
```

`AbortSignal.any` is available below Node 24.4 (Node 20.3/18.17) and needs no
polyfill/dependency or package contract change. Always pass the effective signal
on both operations, including `read(digest, {signal})` with no caller signal.

`stage/read` validates options, verifies held/open ownership and borrowed authority
availability, adds an in-flight completion ticket to a private Set BEFORE
synchronously calling the single private artifact store with that signal, then
attaches settlement to that returned promise. The ticket always resolves in
finally after the wrapper's settlement guard/error handling; caller-facing
promise still resolves/rejects with the real result. Thus the Set records pending
and active work but never schedules it, chains calls behind each other or creates
a second queue. Dispatch calls remain in caller order on the one 6.1 HostQueue.
Sync dispatch throws also settle/remove their ticket. Never use an unhandled
rejecting `.finally()` branch for bookkeeping. Ownership is checked again before
reporting success. On the FIRST
observed ownership/path/state loss, perform these actions synchronously in order:
mark failed and save the loss cause → abort `ownershipLossAbort` with that cause
→ invoke/validate `onOwnershipLost` once → throw/report the saved failure. Do not
await before aborting or notifying, and do not call the observer before aborting.
Preserve ownership/observer/operation/cleanup causes as applicable. Future calls
reject immediately; wrapper settlement reports ownership failure if loss occurred.

This signal is also the guard for calls already waiting in 6.1's private queue.
When loss has been observed before a pending callback starts, its 6.1 pre-filesystem
signal check rejects it before filesystem work begins. Active copying/recovery
stops at existing supported abort boundaries. Do not promise cancellation of a
native I/O call already issued, atomic rollback of published bytes, or an atomic
filesystem sandbox. No second queue or plugin-host hook is added.

Ordinary caller cancellation keeps its original abort reason/behavior when the
lease remains healthy; it must not mark ownership lost, abort the loss controller
or notify the observer. Ordinary artifact invalid/corrupt/capacity failures also
leave ownership healthy. A previously aborted caller signal remains aborted in
the combined signal. If ownership loss also occurs, preserve relevant concurrent
failure causes rather than reclassifying a plain caller abort as lease loss.

`assertHeldSync` checks the private owner connection is open and in its lifetime
transaction, validates its binding/current main registration through the narrow
state method, and compares cached canonical main/root/owner identities with
fresh synchronous lstat/nlink results. A failed read (including an unavailable main owner)
closes managed eligibility; never assume cached data authorizes work after a
failed guard. The subsequent caller must block admission in the synchronous
observer before it throws. No silent reconnect, lock stealing or deferred
observer await. Native owner connection is private, so normal code has no separate
path that can intentionally close it while continuing work.

Wrapper lifecycle separates accepting-work from retained-lease validity:
`active` accepts calls; `quiescing` rejects NEW calls but permits settlement and
`assertHeldSync` for already dispatched work; `failed` retains loss cause/aborted
signal; `closed` has confirmed release. No state returns to active. On an active
wrapper, `quiesce` switches to quiescing synchronously before its first await;
on an already failed wrapper it retains failed/loss state while draining. It
snapshots the private Set's always-resolving completion tickets (no new dispatch
can enter), and awaits
all of them, including calls pending in the internal artifact queue. Repeated
quiesce shares its drain barrier. It retains the lease and MUST NOT abort
`ownershipLossAbort` or caller/effective signals. Dispatched/queued calls intentionally drain under the held lease, rather
than being cancelled as if ownership were lost. It does not cancel consumer
generations or return a raw artifact store that can continue. A normal quiesce
is not ownership loss. An operation finishing while normally closing is still
allowed to complete under the retained lock; post-operation validation distinguishes closing from loss.

The future composition shutdown order is: stop new HTTP/admin/admission → quiesce
artifact/preparation work while keeping the lease → drain/dispose current and
retired/pinned generations and their resources → close owned artifact wrapper/
lease → close authority DB. Startup failure unwinds the subset actually acquired
in reverse order. 6.2b can test the wrapper/drain barriers but cannot claim Runtime
pins were drained without the later integration.

`close` calls quiesce and releases only after in-flight work settles and the
caller has drained consumers. Release is ROLLBACK of the lifetime transaction,
then native close. It never COMMITs/changes metadata or deletes a file/artifact.
Mark unavailable before release. Successful close is idempotent. Release/close
failure retains unavailable state and cause, allows cleanup retry and never
reopens managed operations. Concurrent close calls share the current close
attempt. After a failed attempt clears, a later close starts cleanup again while
the drained/quiescing barrier stays closed to new work; do not permanently cache
a rejected close Promise and thereby prevent the required retry. If rollback fails, do not claim the lease was released
until native close is confirmed; if native state cannot be known, report cleanup
failure and retain the handle/state for retry. Preserve operation and cleanup
errors together. Do not automatically release an uncertain lease while in-flight
work is still executing; stop new work and wait for tracked activity to settle.

## 9. Errors and permanent acceptance

Server-private `PluginStoreOwnershipError` codes are:
`plugin-store-invalid`, `plugin-store-busy`, `plugin-store-owner-mismatch`,
`plugin-store-recovery-required`, `plugin-store-protocol`, `plugin-store-storage`,
`plugin-store-ownership-lost`, and `plugin-store-closed`. Validate API options
with Zod; preserve internal causes and do not expose raw paths/SQL/stacks in public
messages. No HTTP status map is added. Acquisition busy means no owner was returned;
loss applies only to a previously returned wrapper. Retain errors from 6.1 artifact
operations when ownership remains healthy.

Permanent tests use real Node child processes against disposable local roots and
separate main DBs, not two in-memory wrappers. Children announce IPC ready only
after root/main bindings and lifetime lock are established. Parent waits on IPC/
exit events with bounded deadlines, never sleeps to guess acquisition. Terminate
and await every child in finally before deleting files. Child fixture must run
with actual repository-supported Node >=24.4. Build workspace dependencies with the
normal task prerequisite before fresh Server compilation; a direct focused test
must not silently use stale dependency dist. Compile fixture/Server code using
the existing toolchain, without a new dependency. Convert compiled paths with
`pathToFileURL`, and clear unintended runner-only inherited `execArgv` when forking
ordinary Node fixtures. macOS local execution must pass; record OS/Node/SQLite in reports. Skip only genuinely unsupported FS
capabilities with explicit reason; do not translate errors into a false pass.

Acceptance includes: same-root live exclusion, SIGKILL release with unchanged
binding, regular main writes while owner lease is held, different-DB mismatch,
copy/relocation/new UUID rejection, two roots racing one main registration,
root-bound/main-unregistered exact recovery and conflicting recovery refusal,
owner missing/corrupt/empty fatal behavior, both-new-main-tables initialization,
exactly-one-main-table-missing refusal, invalid/empty marker refusal, explicit
non-guarantee for externally erased root rows/both tables, exclusive-create race,
hard links and
symlink descendants rejected, canonical ancestor aliases, bounded populated 6.1
layout initialization without authority changes, operation draining before release,
partial-startup reverse cleanup, lease loss synchronous observer and rejected
async/thenable observer, rollback/close failure cleanup retry, and byte-for-byte
binding stability across close/reopen. A targeted deterministic queue case holds
A in an actual artifact operation while B is pending in the same 6.1 queue, then
forces/detects ownership loss through `assertHeldSync`, verifies loss abort precedes
the observer, releases A and proves B never reaches its distinct filesystem sentry.
A normal-quiesce counterpart proves B does reach/completes under the retained lease;
caller-only cancellation proves no ownership observer/loss abort is triggered.
No test may execute a plugin, reclaim artifacts or claim universal power-loss/
network-filesystem/Windows/Electron behavior. Windows forced child termination is
not a POSIX SIGKILL claim; report only the actually tested native behavior.
Tests for Runtime admission/pinned turn integration remain in 6.2c/d; actual Electron acceptance remains in 6.3.
