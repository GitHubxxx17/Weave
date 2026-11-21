# Managed Plugin Source Design

Stage 6.2c follows the store ownership work merged in PR #86 at `47aabaa`. It
delivers selected, trusted managed ESM through the same Generation as manual ESM
and MCP. Stage 6.2c.1 delivered the reusable `@weave/plugin-host` capabilities
in PR #87 at `0e61168`. Stage 6.2c.2 uses that baseline to wire the Server
composition and end-to-end behavior.
Stage 6.2d owns installer HTTP, preview and import workflows, first-import
collision prevention, and managed catalog DTOs. Stage 6.3 owns Studio and
Desktop product integration.

This extends the unified extension composition and local ESM trust contracts
in [Foundation](../../architecture/foundation.md),
[ADR 0003](../../adr/0003-local-plugin-loading-and-trust.md) and
[ADR 0005](../../adr/0005-plugin-installation-and-distribution.md). It consumes
the durable facts and transaction semantics in the
[authority design](2026-11-21-plugin-authority-design.md) and the binding, lease
and drain semantics in the
[ownership design](2026-11-21-plugin-store-ownership-design.md).

## Boundaries

One `local-esm` source combines manual declarations and explicit selections
before preparation. The package owns filesystem validation, source eligibility,
the shared loader and plugin lifecycle, and actual Generation start. Server owns
durable authority, artifact ownership, MCP namespace reconciliation,
Generation publication, and client projection. Package callbacks carry explicit
data and lifecycle checks. SQLite, Runtime, HTTP and installer logic stay in
Server or their existing owners. The existing admin queue and owned artifact
queue retain their respective responsibilities.

The existing TypeScript, ESM, strict typing, Zod and test-directory rules apply.
Node stays at `>=24.4.0` and pnpm at `>=10.13.1`. This design adds no dependencies.
The shared Runtime and Tool Pipeline continue to execute contributions. Durable
authority stays append-only and application results stay transient.

## 6.2c.1 package capabilities

### Validated artifact entry

Add `readonly entry: string` to `PluginArtifact`. It is the absolute concrete
entry already resolved by `validatePayload()` and checked against the digested
files. `read()` and the existing-object `stage()` path return the verified
published entry. A collision at publication keeps the existing
`plugin-artifact-conflict` result. For a new rename, use the relative
path from the validated staging directory to that entry and rebase it onto the
final payload directory along with `directory`. The result preserves the existing
freeze and digest guarantees.

### Explicit selection inputs and effective eligibility

The additive package inputs and effective-candidate types are:

```ts
interface ExplicitLocalSelection {
  readonly manifest: PluginManifest;
  readonly digest: string;
  readonly activationSequence: number;
  readonly ready?: ReadyLocalPlugin | undefined;
  readonly issue?: LocalPluginIssue | undefined;
}

interface ExplicitLocalSelectionInput {
  readonly stickyIds: readonly string[];
  readonly selections: readonly ExplicitLocalSelection[];
  readonly deniedIds: readonly string[];
  readonly trustEvents: readonly RecordedPluginTrustEvent[];
}

type ManagedLocalCandidate = ReadyLocalPlugin & {
  readonly origin: 'managed';
  readonly activationSequence: number;
};

type LocalSourceCandidate =
  (ReadyLocalPlugin & { readonly origin: 'manual' }) | ManagedLocalCandidate;

interface ExplicitLocalCandidateChecks {
  verify(
    candidate: ManagedLocalCandidate,
    signal: AbortSignal,
  ): Promise<Pick<ReadyLocalPlugin, 'entry' | 'digest'>>;
  assertReadySync(candidate: ManagedLocalCandidate): undefined;
}
```

Add `LocalPluginSourceController.adoptExplicitSelectionSync(input)` returning
`LocalPluginSourceSnapshot`, `LocalPluginSourceOptions.explicitChecks?`, and
`LocalPluginSourceSnapshot.managedEligible` of type
`readonly ManagedLocalCandidate[]`. Add `explicit-selection` to
`LocalSourceAuthorityReason`. Add `origin: 'manual' | 'managed'` to
`PreparedLocalPlugin` and `PreparedLocalPluginFailure` so callers can preserve
origin across mapping and errors. Export the added types and the two shared
package helpers:

```ts
function eligibleLocalSourceCandidates(snapshot: LocalPluginSourceSnapshot): LocalSourceCandidate[];
function localSourceCandidateIdentity(candidate: LocalSourceCandidate): string;
```

Standalone source construction defaults to empty explicit state. Supplying
nonempty ready evidence requires `explicitChecks`. Omit `explicitChecks`
from the standalone `CreatePluginHostOptions` type and strict host schema.
`ReadyLocalPlugin` has `status: 'ready'`, `id`, `directory`,
`entry`, `manifest`, and `digest`. Keep these actual fields. Validate explicit
input synchronously with Zod, including manifests, exact lowercase digest
syntax, positive safe activation sequences, absolute directory and entry,
unique IDs, one selection per sticky ID and denied IDs drawn from sticky IDs.
Require mutual exclusivity of ready and issue. Check the ready ID, digest and
normalized manifest against the declaration. Validate the complete contiguous
trust-event prefix against the same source cache used for normal trust refresh.
Parse and detach the entire input before changing state. Cache immutable copies.
Issue data stays private, and Server supplies safe messages.

Keep the manual scan's names, limits, ordering and public
`discoverLocalPlugins()` result. Internally capture raw inspected declarations
before that function's legacy ID rules run. Use this cache to apply the combined
policy during sync adoption and after future scans. Manual-only duplicate
behavior stays as it is today. For a managed collision, a manual row claims the
ID only through a successfully parsed manifest, including an invalid row whose
entry or digest failed afterward. Basenames are diagnostics. Every selected
manifest claims its declared ID even without ready evidence, and every sticky
ID suppresses a matching manual declaration even without selection. Mark the
manual declaration with a safe conflict issue and retain its display path.
Baseline reservations apply to both origins, and `deniedIds` suppresses managed
eligibility even when the selected evidence is present. Managed eligibility
requires a completed, non-truncated manual scan. A completed scan of a
missing manual directory meets this requirement. Managed eligibility also
requires a folded, enabled trust record with exactly matching digest and
manifest. The snapshot's `plugins` and `discovery` remain manual projections.

Adoption replaces the cached projection and synchronously notifies the observer
after assignment. Recompute the manual and managed results against the latest
cached authorities. Preserve existing manual revision behavior. Advance the
revision for applicable declaration-policy changes that affect the manual
projection or effective managed eligibility, including withdrawal, new
eligibility, activation sequence changes, and changed ready data. Replacing
equivalent input or changing facts for an already ineligible managed selection
without changing these projections does not advance the eligible revision.
Retain the validated trust-event high-water mark in `stamp.trustSequence` even when no effective
revision advances. Reject a stale trust read rather than rolling back an adopted
prefix. Legacy manual mutations reject a cached sticky ID before work and again
after their awaited reads before apparent idempotent success. Server provides
the authoritative precheck in 6.2c.2.

One helper merges eligibility in byte order by ID. Manual identity remains
`JSON.stringify([id, digest])`. Managed identity is
`JSON.stringify([id, digest, 'managed', activationSequence])`. Source
`prepare()`, exclusions, `recheck()` and downstream Server stamps and membership
use the same helper. A fresh activation of identical bytes therefore displaces
the prior authorization. The ESM module URL can still use the existing digest
query since lifecycle distinguishes activations and the published entry is
stable for immutable bytes.

### Final bounded verification and evaluation guards

Add an optional `LoadLocalPluginOptions.explicitChecks` with
`verify(signal: AbortSignal): Promise<Pick<ReadyLocalPlugin, 'entry' | 'digest'>>`
and `assertReadySync(): undefined`. Source preparation binds these callbacks to
the exact managed candidate. At each synchronous check, run the bound
authority guard and confirm the same candidate identity and ready data remain
in the current effective snapshot, in the same stack. The source wrapper
preserves a defined guard return for the loader's validation and rejection
observer. Only an `undefined` return proceeds to the cached identity check.
Register the preparation in the existing in-flight set before invoking an
explicit callback. If the verifier synchronously calls `close()`, close aborts
preparation and waits for the registered work to settle, even when verification
is still pending after cancellation.
The existing signal is required in explicit mode. The async verifier replaces
the manual digest call for that invocation. Validate its result with a strict
Zod object containing an absolute entry and lowercase 64-character hexadecimal
digest. Compare both to the candidate and execute using that verified entry.
An invalid or mismatched result enters the identity failure path. The manual
invocation keeps its existing digest verification. Both branches use one
import, factory and lifecycle path.

Add an exported `ExplicitLocalAuthorityError` constructed with
`constructor(cause?: unknown)`, fixed code
`plugin-explicit-authority-failed` and fixed message
`Explicit local plugin authority check failed`. A guard wrapper converts any
throw or defined return to that error and preserves the original cause
privately. Guard failures carry no plugin ID. Reject any defined return from
a misconfigured guard and observe possible Promise or thenable rejection.
The async verifier propagates the same marker when it detects authority
failure, and uses the existing
identity failure path (`PluginHostError('plugin-digest-mismatch')`) for a
missing or changed artifact under intact authority.

Call the synchronous guard after the final verification await immediately
before `import()`, again after import immediately before invoking the factory,
and at the actual entry to the plugin's `setup` wrapper. The setup guard runs
after the lifecycle's microtask handoff, immediately before user code.
Check the preparation signal before and after each synchronous guard, so a
guard that aborts and returns successfully still prevents the handoff.
Keep guards outside the
loader's import/factory attribution catches. In the source's per-item catch,
rethrow the marker before cancellation or failure attribution. The outer
preparation catch disposes previously prepared items and rethrows. When a
synchronous setup guard aborts the attempt and then throws, the managed
lifecycle must surface the marker to the kernel even if the concurrent
cancellation wins the setup race. Record the marker in the same invocation of
the setup wrapper before its rejection is observed by the race. Existing
cancellation behavior continues when no marker was thrown. The kernel
wraps the setup marker as `PluginError('plugin-setup-failed')` with the marker
as its cause. Server recognizes the direct marker and that wrapped cause
before per-plugin exclusion or public error projection. Ordinary import,
factory and setup errors stay attributable.

For managed prepared items only, disposal of the existing lifecycle also waits
for settlement of the original setup promise. Track the scheduled
`original.setup` promise before its first microtask and keep it separately
from the timeout/cancellation race. The race still rejects promptly and
invalidates the environment. Start the existing one-time plugin disposer and
await both the disposer and setup settlement, so a disposer can help unblock
setup. Observe late rejection without reporting it twice. Use an internal
lifecycle option derived from candidate origin and preserve manual behavior.

### Guard the actual Generation start

Add `readonly assertCanStartSync?: (() => undefined) | undefined` to
`RunnerGeneration`. Retain current behavior with the hook absent. At the head
of a Session queue, capture current and verify the configured hook is callable
and returns exactly `undefined` before setting phase to running, acquiring a
pin or invoking Runtime. Observe rejection of an accidental Promise or thenable result
and reject the run for any defined result. After the hook, honor cancellation,
closure and blocking, and reject the head if current has changed. This makes
the run's admission check apply to the same Generation it would pin.

Guard execution may synchronously cancel, dispose or replace. Suspend this
head's waiter flushing during the check so a reentrant cancellation followed
by a throw can still settle the pending `next()` as a failure. On a throw pass
the value to `finish(cause, true)`, including `undefined`, and release only
if the run still owns a queued slot. Restore flushing when the check unwinds.
On successful return, a reentrantly finished head stays finished and an
unaffected queued head can progress. Existing explicit iterator return and
pinned-run cleanup semantics continue to apply.

## 6.2c.2 Server composition

### Startup and authority

Add a Zod-validated
`StartServerOptions.managedPluginStore?: { readonly initialBinding: 'allow-unbound' | 'require-bound' }`.
Resolve the configured plugin directory as the manual scanner does, including
relative paths, then join `.weave-store`. With ESM enabled,
default Server startup opens one `PluginAuthorityDatabase` and borrows its
`.trust` facet. Add this Server-private decision read:

```ts
readStartupAuthoritySync(): {
  readonly snapshot: PluginAuthoritySnapshot;
  readonly registration: ManagedRootRegistration | null;
};
```

Run `readAuthoritySnapshotTx` and `readManagedRootRegistrationTx` in one
`BEGIN` read transaction and return the validated, detached and frozen
snapshot and registration. Validate the durable registration schema and
database identity. Use this read for override, sticky history, ESM-disabled
and default-unbound startup decisions. Legacy database paths, including
SQLite-openable main-file symlinks, remain usable on those paths.
Apply strict filesystem eligibility checks via `readManagedRootStateSync()`
when attempting acquisition, including registered ESM auto-resume and
explicit managed mode. Registration and the owner factory continue using
the existing strict path checks.

If the validated database is registered, auto-resume with
`require-bound` at the exact configured root, including when explicit options
request `allow-unbound`. With no registration and no explicit option, read
sticky and selection history, create no artifact root and permit no managed
execution. Explicit `allow-unbound` can bind through the existing owner factory.
Create a missing plugin parent only for this explicit first bind when
validated registration is absent. Registered startup and unregistered
`require-bound` create neither the plugin parent nor the artifact root.
Root mismatch, busy lease, missing or corrupt ownership and unsatisfied
`require-bound` fail startup. Acquire before source preparation or HTTP listen,
with the synchronous loss observer registered and baseline reserved IDs known.

Reject explicit managed mode if local ESM is disabled or a legacy
`pluginTrustStore` override is supplied. In normal `startServer` with ESM
enabled, inspect validated registration and authority even for a custom override
and reject the override when registration exists or any sticky history is
present, including imported-only and uninstalled IDs. A clean override's
Server-owned adapter forwards and retains its raw trust events for source
adoption. The main database supplies sticky reservations separately.
Keep one trust writer.
Embedded manual composition without authority retains its standalone contract.
With ESM disabled, read known sticky history for MCP reservation, without binding
or opening the managed artifact root. Preserve explicit database isolation and
the existing source paths.

### Selected evidence and shared namespace

One validated `PluginAuthoritySnapshot` defines all sticky IDs through
`installations`, including imports without selection and uninstalled history.
Link selection to the same ID, digest, and
`firstImportSequence === candidateImportSequence`. Disabled, revoked, missing,
incompatible or corrupt selections stay as declarations. Only the selected,
enabled and matching trust entry can authorize bytes. No provenance path or
scan of managed directories can produce a candidate.

Server reads selected evidence through bounded `owned.read(digest, { signal })`
and compares returned digest, ID, file count, byte count and canonical manifest
with the durable candidate. Build ready data from the verified concrete
directory and entry. Canonical manifest comparison uses the authority
implementation. Disabled, revoked, denied, and unselected records require no
payload work. On ordinary artifact failures capture a safe issue and omit
eligibility. Authority read failure invalidates cached managed eligibility and
fails the attempt. Detach invalid evidence synchronously when adopting the
latest validated authority. Retain previously checked readiness only while
exact selection, enabled trust, binding and namespace remain valid. Check
effective policy before dispatching each digest and revalidate current
authority after each awaited read before adopting or returning evidence. The final async
verification callback uses the same bounded owned read and exact comparison
with selected identity. Each immediate import/factory/setup handoff asserts
held lease and confirms exact current selection, enabled matching trust and the
known effective namespace. The synchronous lease check alone covers binding
and path identities, so selected authorization is checked separately.

Derive the shared quarantine set as the intersection of all sticky managed IDs
and IDs from validated non-removed MCP declarations. MCP owns refresh and
validated `knownPrefix`. Give the composition a private cached read of these
declaration IDs, including disabled/broken MCP declarations, and a synchronous
denied-ID update used by both MCP snapshot eligibility and preparation.
Whenever either validated authority is adopted, derive the set and apply both
effective snapshots in the same stack before emitting either source
notification. Publish stamps and admission blocks before an immediate
observer can trigger cancellation. This applies to MCP install, refresh and
recheck and uses no recursive queue calls or selected payload reads.

Validate and reconcile MCP authority before each runtime phase that reads
selected bytes, including initial load, reload, prepare, identity retry,
postcommit refresh and final publication recheck. Complete the MCP recheck
before the local bounded recheck even when local preparation ran first.
Reviewed precommit evidence for a managed command precedes its separate
runtime readback. A removed MCP declaration releases its claim for future
Generations, and a retired Generation keeps pinned resources until drain.

A failed local adoption also invalidates local preparation that was already
using the old raw package snapshot. Publish both final effective source
snapshots and the resulting admission block before synchronously cancelling
that unfinished work. Preserve the authority marker as its rejection, and do
not invalidate published or retired resource signals. A new prepare-entry
check alone does not protect a candidate captured before an await.

MCP owns validation at the actual log installation boundary, including its
facade's initial refresh and mutation result. Route read or malformed/rewritten
prefix failures at that boundary to the composition's authority withdrawal,
including when the store fulfilled with invalid data. Preserve the original
cause in the marker. Ordinary request conflicts keep their existing handling.

New MCP configuration rejects every sticky ID. Finish awaited request
preparation and existing manual ID checks first, then read and adopt sticky
authority and check that administration is open at store dispatch, after the
last await. This uses MCP's validated declaration cache and performs no
managed payload reads. Sticky reservation applies with ESM disabled and with
the managed root unopened. Manual-only collisions otherwise follow the
existing behavior.

### Publication and loss

Local origin flows through eligible identities, prepared items and failures,
and current and retained members. Match source, plugin ID, package candidate
identity and origin in admission and publication. Managed identity includes the
activation sequence. Keep these checks and origin metadata private.

The composition supplies this private `managedAuthority` option to the
coordinator when managed execution is enabled.

```ts
interface ManagedGenerationAuthority {
  readonly ownershipLossSignal: AbortSignal;
  assertNotLostSync(): undefined;
  assertManagedPublicationSync(identities: readonly ExtensionIdentity[]): undefined;
  assertManagedStartSync(): undefined;
}
```

The publication hook takes only the exact managed identities in the proposed
membership. It checks the latch and held lease, then reconciles the latest
durable selection, enabled matching trust and known paired MCP namespace. It
resolves those identities against current ready evidence using the package
identity contract. The closure shares the evaluation guard's authority and
evidence and performs no artifact reads. Selection mismatch withdraws stale
eligibility and rejects with `ExplicitLocalAuthorityError`.

Before publication, complete the ordered ordinary source and bounded exact
managed artifact rechecks. Use identity refresh or an attributed selection
issue for an ordinary artifact mismatch. Validate stamps and surviving
membership, check MCP `isReady`, and run the final publication hook outside
per-plugin attribution. Because the hook can change authority synchronously,
recapture cached stamps and eligibility and check revision, open state, exact
origin-aware membership and the latch before `ServerHost.commit` in the same
stack. Apply the same hook and post-guard checks to current managed members
before returning an unchanged result after the ordered refresh. A change during
the hook invalidates the unchanged result or candidate. Ordinary attributable
assembly and ServerHost commit errors keep the existing isolation path.

Recognize a direct `ExplicitLocalAuthorityError` and a `PluginError` with
code `plugin-setup-failed` and that marker as its direct cause before
normalizing or attributing errors. Both reject through the authority failure
path and leave the current pointer in place. Preserve the original thrown
value and its cause privately. When an interrupted mixed iteration reports an
incidental cancellation or plugin failure, use the latched authority marker.

The composition exposes the synchronous receiver
`onOwnershipLostSync(error: PluginStoreOwnershipError): undefined`. The startup
observer retains the first error before forwarding it.
Attach the composition receiver after the coordinator exists and before initial
authority adoption, reload and listen. Deliver a pending first error once at
attachment. A held check that first observes loss also routes that error
through the same receiver. Owned startup can transport loss while production
managed execution is disabled.

On first notification, latch the original loss before any callback and call
the private coordinator `blockManagedOwnershipLossSync()` before withdrawing
eligibility. The coordinator latches a persistent admission block if current
membership contains a managed origin. The composition withdraws ready evidence
synchronously through the paired authority flow. The latch stays authoritative
for managed evidence, publication and fresh commands even if projection throws
or a raw package snapshot is stale. Preserve the loss and any withdrawal
failure as private causes and signal unfinished work even when withdrawal
fails. The receiver returns `undefined` and managed checks surface the marker.
Durable replay retains its existing no-effects path.

An already-compliant unmanaged current remains available when loss observes it.
If a persistent block was established and a compliant unmanaged commit later
proceeds, reapply it in the same stack as the package commit that clears runner
blocking. Keep ordinary revision and shutdown blocks independently.

Give each unpublished preparation iteration its own abort controller. After
the MCP-first snapshot and before preparing the first source, register the
iteration as a loss target when the eligible survivors include managed work.
Bridge loss to that controller through a detachable listener and consult the
latch defensively before entering managed preparation. Use the iteration
signal for both sources through assembly and the final rechecks. Detach its
loss listener during successful publication before any retirement await, and
on rollback or retry after disposal. The next iteration uses a new controller.
Keep shutdown cancellation wired to the active iteration. Combine the caller
and permanent loss signals only at the managed read boundary. A managed read
in flight when loss occurs rejects through the authority path. Later runtime
refreshes skip managed payloads and can still assemble compliant unmanaged
membership from the paired snapshots.
Published MCP allocations retain their iteration signal listener until disposal.
Their signal stays independent of the permanent loss signal, preserving active
and retired pins and their resources. Keep the existing local fallback
invalidation of unresolved raw local preparations as a separate cancellation.

Install `assertManagedStartSync` as `assertCanStartSync` on the exact wrapped
Generation passed to `ServerHost.commit` when its final membership contains
managed origin. The package invokes it at the actual Session queue head before
the runner starts the turn. It checks the latch and held lease and routes any
newly observed loss through the receiver. Start admission performs no selected
evidence refresh, artifact read or ownership reacquire. Ownership is scoped to
cooperating processes and the checks in 6.2b.

### Queued durable decisions

Server exposes the following only within owned composition:

```ts
type ManagedSelectionRequest = ManagedRequest & {
  readonly command: Exclude<ManagedCommand, { readonly kind: 'import' }>;
};

type ManagedSelectionResult =
  | {
      readonly kind: 'replayed';
      readonly operation: RecordedManagedOperation;
      readonly currentAuthority: PluginAuthoritySnapshot;
    }
  | {
      readonly kind: 'committed';
      readonly operation: RecordedManagedOperation;
      readonly savedAuthority: PluginAuthoritySnapshot;
      readonly application: {
        readonly status: 'applied' | 'failed';
        readonly generation: ExtensionGenerationSnapshot;
        readonly cause?: unknown;
      };
    };

function applyManagedSelection(request: ManagedSelectionRequest): Promise<ManagedSelectionResult>;
```

Normalize the request with the authority parser and exclude import before
file work. Extend queued mutation callbacks with `{ assertOpenSync, signal }`.
The private managed mutation returns a per-call `'skip-rebuild'` disposition
for replay. Legacy callbacks retain the usual refresh and rebuild. A replay lookup runs
first and returns the original operation and current authority even after
prior application failure or ownership loss. It performs no lease checks,
payload reads, adoption, refresh, assembly or cancellation. A replay detected
by `commitSync` after provisional evidence performs no runtime work or additional
reads. Both skip before the queue refreshes sources and leave cached admission
as it was.

Fresh activate/rollback and enable pass exact owned evidence for the requested
candidate to the existing authority transaction. Disable, revoke and uninstall
need no bytes. After any await, check openness and the lease synchronously
before the write. Capture the returned fresh `operation` and `afterSnapshot`
immediately. Adopt the new authority, sticky and selected projection and
publish both effective sources in the same stack before the first await.
Reuse prechecked evidence only when the exact candidate and current policy
still agree. After adoption, the same queue ticket refreshes MCP authority
before runtime readback of the mutated local source. If adoption fails, immediately
invalidate affected eligibility and block any now-unauthorized current
membership, including a formerly manual same-ID member. Recover through a
fresh authoritative refresh. Return the saved durable decision with a failed
application when adoption, later checks or publication fail.

Capture the exact Generation, membership and private, discriminated failure
cause inside the queue ticket, preserving even a thrown `undefined`. An
enabled selected target is applied only when that exact managed
identity, including activation sequence, is published. A requested
disable/revoke/uninstall is applied when the compliant Generation excludes
the target managed member. A fresh no-op may reuse a compliant current
Generation. Run a fresh destructive immediate request once through
`retryImmediateRevocation` after adoption or fail-closed invalidation. Match
managed-origin members in current and retained Generations, including a
durable no-op and committed adoption failure. Replay leaves running turns
alone. Normal publication preserves pinned turns and their payloads.

Legacy manual trust, enable, disable and revoke read current sticky authority
before mutation, before immediate retry, and again before any awaited branch
can return idempotent success. Preserve the existing trust transaction
backstop. For a custom override, check current sticky authority synchronously
at the override append dispatch as well. Use the existing safe invalid-trust
error for a sticky ID.

### Legacy public projection

Keep manual display paths and the existing manual shape. Select manual
membership, desired rows and reload failures by source origin. Use the
existing path-free base `kernel` item for a published managed member. When a
failed or displaced manual row shares an ID with a published managed or MCP
contribution, keep the published base entry and a single catalog ID. Keep
managed desired and retired state private. Before projection, map attributed
managed failures and mixed or unattributed whole-candidate failures to fixed
safe codes and messages. Use the existing `plugin-load-failed` code with
`Managed plugin preparation failed` for attributed managed failures, and
`plugin-reload-failed` with `Extension generation could not be published` for
whole-candidate failures with managed or unknown attribution. Keep original
causes private. Catalog GETs project cached state.

### Shutdown and failed startup

Install the owned consumer drain before startup can acquire a wrapper. Begin
HTTP close and synchronously close admin and admission, reject pending
commands and abort in-flight evidence and preparation through the lifetime
signal. Start owned `quiesce()` while the lease is held. The Server-private
barrier waits for dispatched artifact work and the running admin operation
before cancelling active turns and disposing the controller, sources and
ServerHost. Direct and manual disposal retain their current cancellation
order. Keep Session persistence open through terminal writes and close idle
SSE before awaiting HTTP close.
Unowned stop continues through the existing cleanup phases and returns its
first cleanup failure unchanged, even when later phases also fail.

When `startServer` owns a wrapper, the returned `pluginHost.dispose()` calls
the same memoized Server shutdown as `stop()`. Both entry points share the
owned barrier and phase bookkeeping. Manual startup and embedded facades
keep their existing coordinator dispose binding.

Confirmed drain includes settlement of tracked plugin work, including managed
setup that outlives timeout or cancellation. A confirmed drain may carry
settled cleanup causes. An incomplete barrier leaves host, Session persistence,
authority and lease live. Normal stop and failed startup share a phase
tracker for HTTP close, fulfilled quiescence, consumer drain, wrapper release
and authority close. Concurrent stops share an active attempt. Later attempts
resume unfinished phases and retain settled cleanup causes separately. Close
the wrapper only after confirmed drain and close the authority after successful
wrapper release.

Use the same cleanup phases after partial boot or listen failure. The owner
factory handles failures before it returns a wrapper. After confirmed drain,
boot cleanup retries a rejected owned close once. If an acquired managed
phase remains unfinished, including an incomplete barrier before release,
associate the thrown error with the retained cleanup closure in a module
private `WeakMap<object, () => Promise<void>>`.
`retryFailedServerStartupCleanup(cause: unknown): Promise<void>` is available
only from the Server-private cleanup module. When startup and cleanup both
fail, throw an aggregate object with the exact startup value as its first
error and `cause`. This preserves primitive startup errors and supplies an
object key for the association. Remove the association once resource cleanup
completes, even when a settled cleanup error still needs reporting. The
successful startup return and public Server and HTTP surfaces retain their
existing shapes.

## Acceptance

The package PR exercises real published paths and ESM loading, same-ID manual
and managed collision, sticky unselected IDs, invalid manifest diagnostics,
truncation, stable stamps, all three evaluation guard boundaries and a
previously queued Session head. It retains the existing standalone test suite.

Server verification uses a real owned restart and real manual, managed and
MCP contributions in one Generation. Test both collision orders and the
durable removal path with retained MCP resources. Prove exact selected-only
reads, manual override and isolated DB cases, synchronous adoption and
replay without runtime effects, ownership loss at import/setup/publication
and actual start, and absence of a refused run's durable `turn.started`.
Keep an old managed turn through replacement and uninstall and demonstrate
usable retained `import.meta.url` bytes. Test drain ordering through terminal
writes and a release retry, startup cleanup, and cached legacy projections
with a distinctive private path supplied in an error.
