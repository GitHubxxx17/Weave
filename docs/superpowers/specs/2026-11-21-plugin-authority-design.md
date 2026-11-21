# Plugin Authority Database Design — Stage 6.2a

**Date:** 2026-11-21

**Status:** Accepted implementation refinement of Stage 6, following the approved delivery plan.

## 1. Goal and scope

Add the independently reviewable persistence foundation for managed plugin
installation. Server owns one SQLite connection and three append-only logs:
installation, existing trust, and managed operation. It can atomically record
reviewed authority changes, durably identify every successful request including
no-ops, and return an immutable validated decision before any future application.

This slice adds no managed startup mode, artifact I/O, root lease, source discovery,
Generation change, coordinator method, HTTP route or Studio behavior. It does not
change `main.ts`, `plugin-api.ts`, `local-plugin-source.ts`, package exports or
package dependencies. 6.2b owns artifact-root binding/recovery, 6.2c owns selected
source/application, and 6.2d owns routes/composition. Managed installation remains
unexposed until those boundaries are complete. No historical application events
are persisted in this database.

Read ADR 0001, Foundation, the first-round Foundation design, ADR 0005 and the
installation design §5 before implementation. This document refines the
installation/trust/request contracts without changing the package direction or
copying Orbit runtime boundaries. The later product behavior remains: candidate
import does not select or trust; reviewed activation/rollback appends new exact
trust plus selection; uninstall atomically removes selection and revokes.

## 2. Constraints and files

- Existing strict TypeScript ESM, Node `>=24.4.0`, pnpm `>=10.13.1`, Zod and Vitest.
- No new package, dependency, `@weave/plugin-host` API or cross-package source change.
- Every external option, request, prepared evidence and persisted row is validated
  with Zod before use. SQL integers are read as bigint before safe-number checks.
- Facts use INSERT/SELECT only; no UPDATE/DELETE, mutable authority projection,
  database-wide `user_version`, async transaction callback or raw connection escape.
- All tests live in `apps/server/test/`; use disposable SQLite files, never user data.
- New authority snapshots/results are deeply frozen detached plain data. Existing
  trust facade results remain detached **mutable** copies for compatibility.
- All fallible managed result construction occurs before successful COMMIT.

The implementation uses these files inside the existing Server app:

| File                            | Responsibility                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/plugin-authority-types.ts` | Readonly contracts, strict Zod schemas, authority errors.                                                            |
| `src/plugin-authority-data.ts`  | Canonical JSON/fingerprint and detached deep-freeze of plain data.                                                   |
| `src/plugin-trust-sqlite.ts`    | Existing trust SQL/schema/read/append primitives and original trust error class; no connection ownership.            |
| `src/plugin-authority-log.ts`   | Additive schema/identity, complete three-stream readback, fold/projection and one deterministic transition resolver. |
| `src/plugin-authority-store.ts` | Sole connection owner, read transactions, managed commits, borrowed manual trust facade and close.                   |
| `src/plugin-trust-store.ts`     | Existing constructor/import path as a small standalone compatibility wrapper over the owner.                         |

The `src/` prefix in this table means `apps/server/src/`. Tests cover input/data,
log/integrity, transactional store, and the unchanged existing trust suite.
No general-purpose SQLite framework or new repository abstraction is introduced.

## 3. Connection ownership and compatibility

```ts
export function createSqlitePluginAuthorityDatabase(options: {
  readonly filename: string;
  readonly now?: () => Date;
  readonly newDatabaseId?: () => string;
}): PluginAuthorityDatabase;

export function createSqlitePluginTrustStore(options: {
  readonly filename: string;
  readonly now?: () => Date;
}): PluginTrustStore & { close(): Promise<void> };
```

`createSqlitePluginAuthorityDatabase` owns exactly one `DatabaseSync`. Its
`trust` property is a borrowed `PluginTrustStore`, deliberately without `close`.
Only `owner.close()` closes that connection. The existing standalone constructor
creates a private composite owner and delegates `append`/`events`; its `close`
closes that private owner. It does not create a second connection or call another
facade from within an active transaction. Independent standalone constructors
still open independent connections and serialize writes through `BEGIN IMMEDIATE`.

Preserve the standalone import path, signatures, async method behavior, trust JSON,
metadata, original four error codes (`plugin-trust-invalid`, `plugin-trust-storage`,
`plugin-trust-closed`, `plugin-trust-protocol`), and idempotent close. Preserve the
existing test that mutates append/read results and proves storage is unchanged:
facade results must not be frozen. Deep-freezing is a new managed API guarantee,
not a reason to rewrite that test or break old callers.

The old error class may move to `plugin-trust-sqlite.ts`, but
`plugin-trust-store.ts` re-exports the **same class object** so existing `instanceof`
and `plugin-api.ts` imports work. The authority owner imports only the primitive
module, never the compatibility wrapper; this avoids a cycle.

Both constructors retain the existing filename acceptance, including SQLite's
`:memory:` spelling for persistence tests. Reject empty filename, nonfunction
clock/UUID dependencies and unknown authority options before opening SQLite;
the legacy constructor retains its existing option normalization rather than
newly rejecting harmless extra option keys passed by untyped callers. Validate
clock return values as Date and generated identity as UUID before use.
Root/persistent-file restrictions are exclusively 6.2b configuration concerns.

Opening either constructor creates only additive private tables and an
append-once authority UUID; it leaves unrelated tables, database settings,
`user_version` and old trust rows unchanged. Validate options/identity on open;
event-log validation occurs on each read/write rather than changing the old
constructor's lazy trust-corruption behavior. A partial/malformed authority schema
or identity is a protocol error, never an opportunity to overwrite metadata.

Manual trust facade append starts a short transaction and reads a complete
validated authority snapshot before writing. It appends only one trust fact for
an ID that is not managed-owned. Every event kind for a managed-owned ID is
rejected as `plugin-trust-invalid`, with a message requiring the combined managed
API, even after uninstall or when the digest matches. This is the storage
backstop; route-level ownership dispatch/409 belongs to 6.2d. Managed commands
use private trust primitives so they do not recursively enter this backstop.

Facade `events()` validates the complete three-stream snapshot, then returns a
detached mutable trust-array copy. Translate invalid/protocol/storage/closed
failures into the corresponding original trust error with its cause preserved.
An ordinary SQLite busy failure remains `plugin-trust-storage` at this facade.
The existing test that drops `plugin_trust_events` after open still receives
`plugin-trust-storage` from the failed SQL read. Do not broadly translate missing
runtime tables/other SQL failures to protocol merely because readback validates
rows. Invalid returned rows/schema metadata are protocol; a failed SQL operation
retains storage classification. The new owner uses authority errors in §11.

Close has explicit unavailable/closed state: mark the owner unavailable before
attempting native close; all managed/data/facade operations reject as closed from
that point. On successful close, later close calls resolve. If native close
throws, preserve its cause as authority-storage (or trust-storage at the legacy
wrapper), retain unavailable state, and permit a later close call to retry native
cleanup; never reopen data operations. A poisoned transaction owner also allows
close cleanup. Inspect `database.isOpen` only on cleanup/failure paths to avoid
re-closing an already closed native handle. Only the owner owns these states.

## 4. Exact managed contracts

Names below are the proposed implementation names; types are Server-private.
`PluginManifest`, trust event types and `PluginTrustStore` come from existing
packages. New data uses plain arrays/records, never externally mutable Maps.

```ts
type Digest = string;
type Sequence = number;

interface PluginDatabaseIdentity {
  readonly version: 1;
  readonly databaseId: string;
}
interface PluginAuthorityExpectation {
  readonly installSequence: Sequence;
  readonly trustSequence: Sequence;
}
interface PluginAuthorityHeads extends PluginAuthorityExpectation {
  readonly operationSequence: Sequence;
}
interface LocalDirectoryProvenance {
  readonly kind: 'local-directory';
  readonly sourceDirectory: string;
}
interface ValidatedArtifactIdentity {
  readonly pluginId: string;
  readonly digest: Digest;
  readonly manifest: PluginManifest;
  readonly files: number;
  readonly bytes: number;
}
interface ManagedSelection {
  readonly digest: Digest;
  readonly candidateImportSequence: Sequence;
  readonly activationSequence: Sequence;
}
interface ManagedCandidate extends ValidatedArtifactIdentity {
  readonly firstImportSequence: Sequence;
  readonly provenance: LocalDirectoryProvenance;
}
interface ManagedPluginRecord {
  readonly pluginId: string;
  readonly firstImportSequence: Sequence;
  readonly candidates: readonly ManagedCandidate[];
  readonly selection: ManagedSelection | null;
}

interface ManagedRequest {
  readonly requestId: string;
  readonly command: ManagedCommand;
}
type ManagedCommand =
  | {
      readonly kind: 'import';
      readonly previewId: string;
      readonly expectedInstallSequence: Sequence;
    }
  | {
      readonly kind: 'activate';
      readonly pluginId: string;
      readonly digest: Digest;
      readonly manifest: PluginManifest;
      readonly previousSelection: Digest | null;
      readonly expectedInstallSequence: Sequence;
      readonly expectedTrustSequence: Sequence;
      readonly intent: 'activate' | 'rollback';
    }
  | {
      readonly kind: 'enable';
      readonly pluginId: string;
      readonly selectedDigest: Digest;
      readonly expectedInstallSequence: Sequence;
      readonly expectedTrustSequence: Sequence;
    }
  | {
      readonly kind: 'disable' | 'revoke' | 'uninstall';
      readonly pluginId: string;
      readonly selectedDigest: Digest | null;
      readonly expectedInstallSequence: Sequence;
      readonly expectedTrustSequence: Sequence;
      readonly immediate: boolean;
    };

type ManagedPreparation =
  | {
      readonly kind: 'import';
      readonly artifact: ValidatedArtifactIdentity;
      readonly provenance: LocalDirectoryProvenance;
    }
  | { readonly kind: 'activate' | 'enable'; readonly artifact: ValidatedArtifactIdentity }
  | { readonly kind: 'disable' | 'revoke' | 'uninstall' };
interface ManagedCommitInput {
  readonly request: ManagedRequest;
  readonly prepared: ManagedPreparation;
}
```

The schemas exported from the Server-private types module are
`managedRequestSchema`, `managedPreparationSchema`,
`recordedPluginInstallEventSchema`, `recordedManagedOperationSchema`,
`pluginDatabaseIdentitySchema` and `pluginAuthorityOptionsSchema`. All
command/preparation object schemas are strict discriminated unions. Reject
unknown fields, malformed IDs, unsafe integers and mismatched kind pairs. Managed
plugin ID syntax follows `PluginManifest.id` (`^[a-z0-9]+(?:-[a-z0-9]+)*$`); do not
tighten the existing trust event schema's older nonempty-ID acceptance. Digests
are exactly 64 lowercase hexadecimal characters. Heads are nonnegative safe
integers; recorded/link sequences are positive safe integers. `files` is positive
and safe; `bytes` is nonnegative and safe. Manifest ID equals named plugin ID.

`requestId` and `previewId` are nonempty strings of at most 200 characters with no
trimming/case folding. Missing `immediate` normalizes statically to `false` before
canonicalization; normalized commands always contain it. No other review field
is filled from current state. `intent` is explicit. `manifest` uses the existing
strict manifest schema; managed artifact evidence additionally requires its
`contributes` and `permissions` declarations to be present as the descriptor does.
Provenance is a nonempty absolute path string without NUL, already normalized by
the future Server manager. Validate absolute syntax without realpath/stat/I/O;
6.2a does not acquire, normalize or execute that path.

Preparation contains Server-manager evidence, not a wire DTO or a filesystem
capability. Before a **new** import/activation/enable, later slices must freshly
validate the preview/artifact and source conflicts. The DB can validate metadata
equality, not prove disk bytes or ownership. Disable/revoke/uninstall require no
artifact read so corrupt/missing content remains removable. Store no execution
path in an artifact identity.

Import CASes the expected global install head only because it changes no trust
or selection. Every other managed command CASes both global install/trust heads
and every supplied identity. `operationSequence` is a readback head, not an extra
CAS field: a successful no-op increments it without invalidating unchanged
authority review. Unrelated trust changes still invalidate both-head reviews.

## 5. Canonical request identity

Request ID is unique across all managed command kinds and plugin IDs in one
authority database, durably enforced by SQL. Validate/normalize the **static**
request before consulting mutable resources. Canonicalize `{version:1,command}`
by recursively sorting object keys, preserving array order and exact strings,
and encoding JSON without spaces. Omit schema-accepted optional object properties
whose value is `undefined`, matching their absent JSON representation; reject
undefined array entries, nonfinite numbers, cycles and all other non-JSON values.
Unknown command properties are rejected before this step.

Compute SHA-256 over the canonical UTF-8 bytes. Persist both normalized command
and fingerprint. Compare canonical command bytes **as well as** the fingerprint
for replay, so the digest is not the sole equality proof. Request ID is the
lookup key and is not included in the command fingerprint.

The command includes preview ID, intent, immediate, exact manifest/digest,
previous/selected digest, and every expected head. Changing any of them with the
same request ID is `plugin-authority-request-conflict`, even if the new preview
resolves to the same bytes or the desired state is already present. Static object
key order and omitted/default `immediate:false` are equivalent. Do not remove
expected review fields, refresh them, infer current selection, resolve previews,
check expiry or perform filesystem I/O when comparing requests.

Persist resolved import artifact/provenance as operation evidence separately;
they are not transient prerequisites for future replay. A replay can therefore
succeed after preview expiry, source deletion or artifact corruption.

## 6. Events, durable decision and snapshots

### 6.1 Trust facts stay unchanged

Keep existing `PluginTrustEvent`/`RecordedPluginTrustEvent` JSON and schemas:
`trusted(pluginId,digest,manifest)`, `revoked(pluginId)`, `enabled(pluginId)` and
`disabled(pluginId)`, each recorded with `sequence`, `occurredAt`, `scope:'user'`.
Do not add request IDs or operation links to trust JSON, and do not tighten old
timestamp parsing. `trusted.pluginId === manifest.id` remains required.

### 6.2 Installation facts

```ts
type PluginInstallEvent =
  | {
      readonly kind: 'imported';
      readonly pluginId: string;
      readonly digest: Digest;
      readonly manifest: PluginManifest;
      readonly files: number;
      readonly bytes: number;
      readonly provenance: LocalDirectoryProvenance;
    }
  | {
      readonly kind: 'activated';
      readonly pluginId: string;
      readonly digest: Digest;
      readonly candidateImportSequence: Sequence;
      readonly previousSelection: Digest | null;
      readonly trustEventSequence: Sequence;
      readonly intent: 'activate' | 'rollback';
    }
  | {
      readonly kind: 'uninstalled';
      readonly pluginId: string;
      readonly previousSelection: Digest | null;
      readonly trustEventSequence: Sequence;
    };
type RecordedPluginInstallEvent = PluginInstallEvent & {
  readonly sequence: Sequence;
  readonly occurredAt: string;
  readonly scope: 'user';
  readonly operationSequence: Sequence;
};
```

The first imported fact creates sticky managed ownership. A candidate is unique
by `(pluginId,digest)`, and its first provenance remains immutable. A repeated
identical import appends no second imported fact; different metadata for the same
candidate is a conflict. A later no-op import's provenance is retained in that
operation evidence. Activation references the exact earlier same-ID/digest import;
uninstall clears selection while retaining every candidate and ownership fact.

### 6.3 Operation facts

```ts
interface ManagedTrustState {
  readonly digest: Digest;
  readonly manifest: PluginManifest;
  readonly enabled: boolean;
}
interface ManagedPluginState {
  readonly selection: ManagedSelection | null;
  readonly trust: ManagedTrustState | null;
}
interface ManagedDecision {
  readonly kind: ManagedCommand['kind'];
  readonly pluginId: string;
  readonly changed: boolean;
  readonly before: PluginAuthorityExpectation;
  readonly after: PluginAuthorityExpectation;
  readonly pluginBefore: ManagedPluginState;
  readonly pluginAfter: ManagedPluginState;
  readonly links: {
    readonly installEventSequence: Sequence | null;
    readonly trustEventSequence: Sequence | null;
  };
}
interface RecordedManagedOperation {
  readonly version: 1;
  readonly sequence: Sequence;
  readonly occurredAt: string;
  readonly scope: 'user';
  readonly requestId: string;
  readonly command: ManagedCommand;
  readonly fingerprint: Digest;
  readonly evidence: ManagedPreparation;
  readonly decision: ManagedDecision;
}
interface PluginAuthoritySnapshot {
  readonly identity: PluginDatabaseIdentity;
  readonly heads: PluginAuthorityHeads;
  readonly trustEvents: readonly RecordedPluginTrustEvent[];
  readonly installEvents: readonly RecordedPluginInstallEvent[];
  readonly operationEvents: readonly RecordedManagedOperation[];
  readonly installations: readonly ManagedPluginRecord[];
}
```

The operation fact is the durable result, not a transient command receipt. Every
successful fresh request, including no-op, appends exactly one. `changed` means
an install/trust fact was appended; it does not mean Runtime application occurred.
No-op has equal authority heads, null links and equal plugin before/after state.
The plugin states are small deterministic folds at stored prefixes, not historical
whole snapshots; validate them against those prefixes. The operation's sequence
is its separate head. Candidate/import ordering is first-import sequence; plugin
records are ordered by their first-import sequence.

### 6.4 Result interface

```ts
type ManagedLookup =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'replayed';
      readonly operation: RecordedManagedOperation;
      readonly currentSnapshot: PluginAuthoritySnapshot;
    };
type ManagedCommit =
  | {
      readonly kind: 'committed';
      readonly operation: RecordedManagedOperation;
      readonly afterSnapshot: PluginAuthoritySnapshot;
    }
  | {
      readonly kind: 'replayed';
      readonly operation: RecordedManagedOperation;
      readonly currentSnapshot: PluginAuthoritySnapshot;
    };
interface PluginAuthorityDatabase {
  readonly identity: PluginDatabaseIdentity;
  readonly trust: PluginTrustStore;
  snapshotSync(): PluginAuthoritySnapshot;
  lookupSync(request: ManagedRequest): ManagedLookup;
  commitSync(input: ManagedCommitInput): ManagedCommit;
  close(): Promise<void>;
}
```

Every new snapshot/result and nested value is detached and deeply frozen.
`afterSnapshot` is built inside the new commit's transaction. Replay always reads
a fresh **currentSnapshot** and returns the original operation. It never returns
an old after-snapshot for source adoption. `lookupSync` returns absence or replay;
changed canonical command throws conflict rather than appearing absent.

## 7. SQLite layout and complete readback

Keep the existing `plugin_trust_events` columns exactly. Add:

```sql
CREATE TABLE IF NOT EXISTS plugin_authority_identity (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  identity_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_install_events (
  sequence INTEGER NOT NULL PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  scope TEXT NOT NULL,
  operation_sequence INTEGER NOT NULL UNIQUE,
  event_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_operation_events (
  sequence INTEGER NOT NULL PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  scope TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  event_json TEXT NOT NULL
);
```

Initialize schema/identity under a short transaction. On first upgrade of a
trust-only database, create all new tables and a strict UUID identity together.
On later opens, require exactly one valid identity and the complete new table
set. A missing/empty identity when either new event table already exists is
protocol corruption; never silently insert a new UUID. A database with none of
the three new tables may be initialized, including one containing old trust rows.
Validate existing table column/index shapes needed by this contract; incompatible
schemas fail protocol instead of being hidden by `IF NOT EXISTS`. A schema check
must not claim to prevent arbitrary same-user SQL tampering.

All three streams are contiguous from 1; empty head is 0. Read integer columns
losslessly with `setReadBigInts(true)` then reject gaps/unsafe/negative values and
next-sequence exhaustion. Strictly parse JSON and match row/payload sequence,
time/scope, request/fingerprint and install operation sequence. New operation/
install timestamps are UTC ISO and equal across each operation's linked facts.
Keep legacy trust timestamp acceptance unchanged; validate newly linked trust
facts against their operation timestamp.

Read/fold full logs initially; no optimization cache is required. The validator
walks operations in sequence while advancing trust/install prefixes:

1. Start with empty install/trust projections and zero authority heads.
2. Before each operation, advance unlinked manual trust facts from the previous
   operation's trust after-head to this operation's before-head. Each such fact
   must name an ID unowned at this install prefix. Before-install head equals
   the previous operation's after-install head exactly; there is no manual install
   writer. Heads may not go backwards or exceed available rows.
3. Validate the canonical stored command/fingerprint/evidence. Verify its recorded
   preconditions against this before-prefix, calculate the transition in §8,
   and compare expected install/trust facts, links, before/after heads and plugin
   states to the recorded operation. Apply exactly those linked facts.
4. Require every install fact to be claimed once with matching operation back-link,
   every managed trust fact to be claimed once, and no wrong-kind/wrong-plugin or
   reused link. Install activation/removal links equal the operation's trust link.
5. After the final operation, consume only valid unlinked manual trust facts under
   final ownership. No trailing install fact or unclaimed managed trust is allowed.
   The final folds determine the exported installations/head arrays.

An original manual trust may precede first import and remains immutable. Once
owned, only combined operations may append trust for that ID. Import does not
make that old trust executable without a selected candidate. Source/manual path
collision checks remain later manager preconditions; SQL cannot inspect live or
retired filesystem candidates.

## 8. Transition rules and successful no-ops

A new request validates stated expected heads/selection **before** deciding it is
a no-op. Stale review never succeeds merely because the final state matches.
Every named ID except first import must be managed-owned. Import evidence matches
its resolved preview; DB validation does not claim preview authentication.

| Command                            | Required checks beyond ownership                                                      | Install facts |       Trust facts | Operation facts |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ------------: | ----------------: | --------------: |
| import new candidate               | expected install head; artifact identity                                              |    1 imported |                 0 |               1 |
| import identical candidate         | same, digest/manifest/files/bytes equal; provenance may differ                        |             0 |                 0 |               1 |
| activate/rollback                  | both heads; exact previous selection; known import; digest/manifest/evidence exact    |   1 activated | 1 **new trusted** |               1 |
| enable disabled selected trust     | both heads; exact selected/current trust digest and manifest; artifact evidence exact |             0 |         1 enabled |               1 |
| enable already enabled             | same checks                                                                           |             0 |                 0 |               1 |
| disable enabled trust              | both heads; exact reviewed selection                                                  |             0 |        1 disabled |               1 |
| disable disabled or absent trust   | same checks                                                                           |             0 |                 0 |               1 |
| revoke existing trust              | both heads; exact reviewed selection                                                  |             0 |         1 revoked |               1 |
| revoke absent trust                | same checks                                                                           |             0 |                 0 |               1 |
| uninstall with selection or trust  | both heads; exact reviewed selection                                                  | 1 uninstalled |         1 revoked |               1 |
| uninstall unselected and untrusted | same checks                                                                           |             0 |                 0 |               1 |
| identical replay                   | canonical static request equals original                                              |             0 |                 0 |               0 |

Enable with missing/revoked trust fails activation-required; it never grants new
trust. Activation/rollback with a new request is **never** a no-op, including the
same selected digest or previously trusted bytes. Disable/revoke preserve
selection/history. A changing uninstall always pairs removal plus revoked even
if trust was already absent, and works without artifact bytes. No automatic
selection rollback, candidate deletion, old-trust resurrection or manual adoption.

`immediate` is persisted intent only in 6.2a. A fresh authority no-op with
`immediate:true` may request timing effects in 6.2c; a replay must never repeat
them. Thus consumers branch on `kind:'replayed'`, not `decision.changed`.

## 9. Lookup and transaction protocol

Static Zod validation/canonicalization is first. `lookupSync` opens a short read
transaction, validates a consistent complete current snapshot and searches the
globally unique request ID. Equal canonical input returns a prebuilt frozen replay
with the original operation/current snapshot; changed input conflicts. Absence
returns absent. Complete any fallible read-result construction before ending
the transaction. It never calls a preview/artifact/source/runtime callback.

The later manager must run lookup **before** resolving preview expiry, artifact
reads, source discovery or mutation. Only absent requests perform preparation.
This required order is documented here, but actual artifact/coordinator integration
and its integration tests are not part of 6.2a.

`commitSync` performs this protocol without any await:

1. Validate the input container/request shape and canonicalize only the static
   request; require the owner open. Do not parse/require prepared evidence yet
   (an existing replay can ignore even missing/invalid runtime evidence). Begin `BEGIN IMMEDIATE`, then read a full valid before-snapshot.
2. Repeat the request lookup before CAS **and before parsing/using preparation**.
   Existing equal input returns a prebuilt replay/current snapshot with no INSERT.
   Existing changed input conflicts. A race after the outer lookup cannot cause a
   duplicate grant, stale CAS failure or second application.
3. For an absent request, validate preparation and its kind/metadata; perform the
   exact global CAS/ownership/review checks; calculate §8's transition/no-op.
4. Validate the injected synchronous clock result, allocate safe next sequences,
   build all events/operation, and INSERT 0/1 trust, 0/1 install, exactly 1 operation
   on this connection. No async code, filesystem work or arbitrary transaction
   callback is permitted. Injected clock/UUID functions are narrow synchronous
   construction dependencies, not transaction extensibility points; replay does
   not call the clock or generate an ID.
5. Read/fold/validate the complete after-snapshot and all cross-links inside the
   transaction. Construct the **whole** result, detach and deep-freeze it before
   COMMIT. A validation/serialization/clone/freeze/readback failure rolls back all
   event and operation inserts, preserving the primary cause.
6. Execute COMMIT, then immediately return that prebuilt result. No new DB read,
   JSON parsing, schema validation, cloning/freezing, clock call, callback or await
   is allowed after successful COMMIT. `commitSync` is not a Promise.

Use a private transaction helper with these failure rules. The Node SQLite
`isTransaction` property is available since v24.0, below the project's v24.4 floor;
read it only on the failure path, never after successful COMMIT:

- If SQLite already ended the transaction (for example `RAISE(ROLLBACK, ...)`),
  do not issue another rollback; preserve the primary error and allow a subsequent
  operation on the still-open healthy owner.
- If it remains active, attempt ROLLBACK. If rollback succeeds and the transaction
  is ended, preserve the primary error and allow a subsequent operation.
- If ROLLBACK throws, the transaction remains active, or transaction/open state
  cannot be determined, mark the owner poisoned/unavailable. Preserve primary and
  rollback/state-inspection causes (for example an AggregateError as cause), reject
  every managed/data/facade operation as closed, and still allow close cleanup.

A COMMIT exception has a distinct ambiguous-end case: if COMMIT throws and
`isTransaction` is false, absence of an active transaction does NOT prove rollback
or success. Mark unavailable and reconcile after reopen with the SAME request ID;
do not take the healthy automatic-rollback branch above. If COMMIT throws while
the transaction is still active, a confirmed successful rollback can retain a
healthy connection; failed/uncertain cleanup poisons it. An ambiguous/unusable
connection stays unavailable. Only a COMMIT that returns successfully is a
reported durable success; never issue a new automatic request ID to recover.
No ordinary post-commit result-construction failure may imply nothing persisted.
Manual facade appends also prebuild their detached returned trust fact before
COMMIT, while retaining their mutable-result compatibility.

## 10. Later application boundary — no application history

6.2a has no Generation or `applied` field. Later new-commit code must call source
adoption synchronously after `commitSync` in the same stack, before any await.
Adoption failure retains the committed operation, synchronously blocks affected
old unauthorized admission and reports durable saved decision plus application
failure with its internal cause. It must not turn into an unqualified precommit
error/500. This slice does not implement that integration.

Replay returns the original saved decision and **current** authority, skips
adoption/rebuild/immediate cancellation, and never restores its historical
selection. Activation replay after revoke/corruption still identifies the original
save; import replay needs neither live preview nor source directory. Historical
application after restart is `unknown`; current Generation is separate, and an
explicit reload is a separate recovery action. No Runtime application facts are
stored or inferred from a later current Generation.

Preserve ADR 0003 isolation later: an individual plugin may fail and be excluded
from a new compliant Generation; candidate-wide failure retains the old Generation
with unauthorized admission blocked. This DB neither introduces required-plugin
mode nor changes Runtime/Agent/Tool Pipeline semantics.

## 11. Errors and verification acceptance

`PluginAuthorityError` has stable codes:

- `plugin-authority-invalid`: external options/request/preparation/clock invalid.
- `plugin-authority-request-conflict`: same request ID, different canonical input.
- `plugin-authority-conflict`: stale heads, selection, candidate metadata or review.
- `plugin-authority-not-found`: managed ID or imported target absent.
- `plugin-authority-activation-required`: enable has no exact current trust.
- `plugin-authority-protocol`: invalid persisted schema/identity/events/links/folds.
- `plugin-authority-storage`: other SQLite operation failure.
- `plugin-authority-busy`: SQLite busy/locked condition during managed transactions.
- `plugin-authority-closed`: unavailable/closed owner.

Keep internal `cause`; public messages contain no SQL/path/stack detail. No HTTP
status mapping is added. Manual facade errors translate to its original four
codes as described in §3. Invalid input must consume no sequence or operation.

Acceptance requires real temporary SQLite files and assertions across reopen:

1. Existing trust suite passes unchanged, including mutable detached copies,
   independent connection sequencing, four error codes, rollback causes and
   unrelated schema/version preservation. Borrowed facade has no close; owner
   closure closes it; legacy wrapper cannot bypass sticky managed ownership.
2. Exact §8 event counts/identities/heads for all commands and fresh no-ops.
   Repeated same-digest activation adds new trust. Revoked enable fails. Corrupt
   filesystem cannot affect metadata-only revoke/uninstall because DB does no I/O.
3. Global request conflict across kinds/IDs and every changed review/preview field;
   key-order/default-false equivalence; lookup/replay persistence across reopen.
   Replay after a later revoke or selection returns original operation plus
   current snapshot and appends nothing. Transaction replay ignores invalid
   prepared evidence and stale original CAS, while changed static command conflicts.
4. Complete log integrity: envelope/payload mismatch, unsafe integers/gaps, missing
   identity/table/index shape, orphan/reused/wrong-kind links, fingerprint mismatch,
   invalid transition/before-after fold, unclaimed post-ownership trust. Invalid
   history prevents all new writes; no cleanup/rewrite makes it appear valid.
5. Real SQLite abort/rollback triggers at each event stream prove atomicity.
   Inject post-insert readback corruption and result detach/freeze failure:
   no state or operation row survives, and next valid write uses contiguous heads.
   Trace post-COMMIT reads/validation/freezing to prove no fallible work follows
   the successful boundary; clock failure also rolls back without consuming heads.
6. Trigger-driven automatic rollback preserves the primary cause and permits a
   later valid operation. Injected rollback/state-inspection failure poisons the
   owner and rejects all data methods, but close can still clean up. Injected
   native close failure leaves unavailable state, preserves its storage cause,
   and allows a successful repeated close; cleanup never reopens operations.
7. Snapshot/results are immutable detached data; changing original command or
   evidence cannot rewrite history. Existing facade mutable copies remain isolated.
8. Targeted tests, Server typecheck/lint, root `pnpm check`, architecture docs and
   learning evidence are complete before root's reviewed topic PR. Do not claim
   artifact ownership, browser/Electron or post-commit source behavior was tested.
