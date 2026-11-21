# Managed Plugin Source Design

Stage 6.2c follows the store ownership work merged in PR #86 at `47aabaa`. It
delivers selected, trusted managed ESM through the same Generation as manual ESM
and MCP. The first PR (6.2c.1) delivers the reusable `@weave/plugin-host`
capabilities below. The second topic (6.2c.2) starts from fresh `origin/main`
after the first merges and wires the Server composition and end-to-end behavior.
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
Resolve the artifact root to `<pluginsDirectory>/.weave-store`. With ESM enabled,
default Server startup opens one `PluginAuthorityDatabase` and borrows its
`.trust` facet. If the validated database is registered, auto-resume with
`require-bound` at the exact configured root, including when explicit options
request `allow-unbound`. With no registration and no explicit option, read
sticky and selection history, create no artifact root and permit no managed
execution. Explicit `allow-unbound` can bind through the existing owner factory.
Root mismatch, busy lease, missing or corrupt ownership and unsatisfied
`require-bound` fail startup. Acquire before source preparation or HTTP listen,
with the synchronous loss observer registered and baseline reserved IDs known.

Reject explicit managed mode if local ESM is disabled or a legacy
`pluginTrustStore` override is supplied. In normal `startServer` with ESM
enabled, inspect validated root state and authority even for a custom override
and reject the override when registration exists or any sticky history is
present, including imported-only and uninstalled IDs. Keep one trust writer.
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
exact selection, enabled trust, binding and namespace remain valid. After an
await, revalidate current authority before adopting evidence. The final async
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
Whenever either validated authority is adopted, one synchronous composition
callback derives the set and publishes both effective snapshots before it
returns. This applies to MCP install, refresh and recheck. Run it without
recursive queue calls or selected payload reads. Validate initial MCP
declarations before managed preparation, and refresh MCP authority before the
local managed read phase. A removed MCP declaration releases its claim for
future Generations. A retired Generation keeps pinned resources until drain.
New MCP configuration rejects every sticky ID using current validated
authority and the existing manual ID check. Manual-only collisions otherwise
follow the existing behavior.

### Publication and loss

Managed origin flows through `PreparedExtensionItem`, `ExtensionMember` and
private failure attribution. Keep origin independent of wire metadata.
Before publication, asynchronously revalidate selected evidence with bounded
owned reads and complete the existing source rechecks. After all awaits,
perform the final synchronous lease and exact still-selected checks adjacent
to the commit path, outside per-plugin attribution. Apply final cached
revision, eligibility, membership and persistent-loss checks in the same
stack, then call `ServerHost.commit`. A changed or absent artifact under intact
authority uses the existing candidate identity recheck or an attributed
selection issue. A guard marker, including the kernel setup cause, bypasses
per-plugin exclusion and takes the authority failure path.

A composition-local ownership-loss latch is independent of ordinary revision
blocking. On first observed loss, synchronously withdraw managed eligibility
and block new runs when current has managed members. Keep an already-compliant
unmanaged current Generation available and keep already-pinned turns on their
resources. Commits cannot clear the persistent admission block after loss.
Managed commands except durable replay fail for the rest of the composition.
Managed publication and already-queued turns check the held lease. Install
`assertCanStartSync` on the exact published Generation containing managed
members. The callback uses the synchronous lease check and loss handler before
Runtime can create a turn. This adds no per-turn digest or ownership reacquire.
Ownership is scoped to cooperating processes and the checks in 6.2b.

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
file work. Extend the existing queued mutation callback with
`{ assertOpenSync, signal }` and a per-call `'skip-rebuild'` disposition.
Legacy callbacks default to the usual refresh/rebuild. A replay lookup runs
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
still agree. Fresh evidence or refresh can follow adoption, since the queue's
usual refresh skips its mutated source. If adoption fails, immediately
invalidate affected eligibility and block any now-unauthorized current
membership, including a formerly manual same-ID member. Recover through a
fresh authoritative refresh. Return the saved durable decision with a failed
application when adoption, later checks or publication fail.

Compare application against the exact Generation returned by this queue
operation. An enabled selected target is applied only when that exact managed
identity, including activation sequence, is published. A requested
disable/revoke/uninstall is applied when the compliant Generation excludes
the target managed member. A fresh no-op may reuse a compliant current
Generation. Honor a fresh destructive immediate request once through
`retryImmediateRevocation`, including a durable no-op when a retained
Generation still has the target. Replays perform no cancellation. Normal
publication preserves pinned turns and their payloads.

Legacy manual trust, enable, disable and revoke read current sticky authority
before mutation and again before any awaited branch can return idempotent
success. Preserve the existing trust transaction backstop. These commands
return the existing safe invalid-trust error for a sticky ID.

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

Begin HTTP close and synchronously close admin and admission, reject pending
commands, and abort in-flight evidence and preparation with the lifetime
signal. Start owned `quiesce()` while the lease is held. A narrow Server-private
pre-drain barrier waits for dispatched artifact work and the running admin
operation before explicitly cancelling active turns and disposing the
controller, sources and ServerHost. Natural retirement and pinned work can
settle independently while the lease is held. Retain consumers and the lease
until tracked plugin work settles, including managed setup that outlives
timeout or cancellation. Keep terminal Session writes available during
run drain and close remaining idle SSE before waiting for HTTP close.

Release the owned wrapper and lease after confirmed consumer drain, then close
the borrowed authority. A settled cleanup aggregate can accompany confirmed
drain. A failed or incomplete barrier delays release. Keep completed phases
and previously reported cleanup causes separate from the retryable release
phase. Subsequent `stop()` calls retry the unfinished owned or authority close.
Keep the authority available between owned close attempts.

Use the same completed-resource ordering after partial boot or listen failure.
The owner factory handles failures before it returns a wrapper. After a
confirmed drain, boot-failure cleanup makes one retry of a rejected owned
close. If it still fails, propagate both startup and cleanup errors and keep
a private retry handle with the failed composition so the same owner and
authority can be closed later. This handle carries cleanup only.

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
