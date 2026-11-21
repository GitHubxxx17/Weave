# Stage 6.2c.2 Server Managed Plugin Source Integration Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` for task-by-task implementation. Each task requires observed RED/GREEN results and independent review before its handoff.

The implementation baseline is `0e61168`, which merged the Stage 6.2c.1 package capabilities in PR #87.

**Goal**

Compose the `@weave/plugin-host` managed local-source contracts with Server authority, ownership, MCP, Generation publication, HTTP projections, and shutdown so selected managed ESM runs safely in one Server Generation.

**Architecture**

`startServer` owns one authority database, an optional owned artifact store, and one extension coordinator. The local source receives explicit managed selections and bounded artifact verification callbacks. Server combines sticky managed IDs with MCP declarations, adopts both source snapshots synchronously, and publishes after final authority and lease checks. Existing HTTP routes expose cached projections. Installer routes and Studio changes are Stage 6.2d/6.3.

**Tech stack**

TypeScript ESM, Zod, Vitest, Node SQLite, stdio MCP.

**Spec**

`docs/superpowers/specs/2026-11-21-managed-plugin-source-design.md` §6.2c.2,
with the authority and ownership designs referenced there.

## Global Constraints

- TypeScript, ESM, strict typing, Zod validation, and tests under `apps/server/test/`.
- No new dependencies. Node `>=24.4.0`, pnpm `>=10.13.1`.
- SQLite authority is append-only and application results remain transient.
- The Server owns the sole `ExtensionCoordinator`; all source mutations and full assemblies use its queue.
- The managed artifact root is `<pluginsDirectory>/.weave-store`; ownership is acquired before source preparation or HTTP listen and released after consumers drain.
- Managed selection is explicit. Filesystem provenance, directory scans, or trust alone never create a managed candidate.
- Preserve standalone/manual source behavior and isolated database behavior when managed mode is absent or ESM is disabled.

## Owned Files and Dependencies

| Area                            | Existing files to modify                                                                                                                                                                               | New Server-private files                                                                                                                            | Depends on                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Startup and shutdown            | `apps/server/src/main.ts`, `apps/server/src/local-plugin-host.ts`, `apps/server/src/extension-coordinator.ts`                                                                                          | `apps/server/src/server-shutdown.ts` owns cleanup phases. `apps/server/src/managed-plugin-startup.ts` owns authority and artifact acquisition.      | authority and owned-store lifecycle from 6.2a/6.2b                 |
| Selected evidence and namespace | `apps/server/src/local-plugin-host.ts`, `apps/server/src/local-extension-source.ts`, `apps/server/src/mcp-source.ts`, `apps/server/src/extension-types.ts`, `apps/server/src/extension-coordinator.ts` | `apps/server/src/managed-plugin-composition.ts` owns authority/evidence cache, synchronous reconciliation and bound checks                          | package explicit-selection and guard contracts                     |
| Coordinator publication         | `apps/server/src/extension-coordinator.ts`, `apps/server/src/extension-types.ts`, `apps/server/src/local-extension-source.ts`                                                                          | none                                                                                                                                                | Generation-start hook, package managed origin and error marker     |
| Durable managed decisions       | `apps/server/src/local-plugin-host.ts`, `apps/server/src/local-extension-source.ts`, `apps/server/src/extension-coordinator.ts`                                                                        | `apps/server/src/managed-selection-manager.ts` owns queued durable decisions and results                                                            | existing authority parser, `lookupSync`, `commitSync`, owned store |
| Public projection               | `apps/server/src/plugin-catalog.ts`, `apps/server/src/local-extension-source.ts`, `apps/server/src/mcp-source.ts`                                                                                      | none                                                                                                                                                | private membership and sanitized issues                            |
| Verification                    | Suites named in the tasks below                                                                                                                                                                        | `apps/server/test/{managed-plugin-startup,managed-plugin-integration,managed-plugin-composition,managed-selection-manager,server-shutdown}.test.ts` | real restart, ESM and MCP fixtures and private fault injection     |
| Architecture                    | `docs/architecture/foundation.md`, tracked 6.2c.2 specification and formal Server plan                                                                                                                 | none                                                                                                                                                | Stage 6.2c.2 design and architecture                               |

This topic uses the Stage 6.2c.1 package exports for explicit source snapshots, candidate identity and origin, verification and its authority marker, lifecycle drain, and the Generation start hook.

`plugin-authority-data.ts`, `mcp-authority-store.ts`, `owned-plugin-artifact-store.ts`, `server-host.ts`, `runtime.ts`, and `agent-kernel.ts` supply existing contracts and ordinarily need no implementation changes. `agent-kernel.ts` already describes managed ESM and MCP contributions as `kernel`. Keep `AppOptions`, route shapes and Zod response schemas compatible by redacting before projection.

## Task 1. Establish the owned shutdown and consumer-drain contract

**Owns:** `apps/server/src/{main,server-shutdown,extension-coordinator}.ts` and
`apps/server/test/{server-shutdown,extension-coordinator,health}.test.ts`.

**Consumes:** Existing queue, controller and source cleanup, `disposeServerPlugins`,
`OwnedPluginArtifactStore.quiesce/close` and `PluginAuthorityDatabase.close`.
Existing `startServer` locals record acquired resources as soon as each returns.

**Produces** the following Server-private coordinator interfaces:

```ts
interface ExtensionMutationContext {
  readonly assertOpenSync: () => void;
  readonly signal: AbortSignal;
}

type OwnedDrainOutcome =
  | { readonly kind: 'drained'; readonly cleanupCauses: readonly unknown[] }
  | { readonly kind: 'incomplete'; readonly cause: unknown };

interface ExtensionCoordinator {
  // Existing members remain.
  mutate(
    sourceId: string,
    operation: (context: ExtensionMutationContext) => Promise<unknown>,
    options?: { readonly force?: boolean },
  ): Promise<ExtensionReloadResult>;
  beginOwnedDrainSync(): void;
  drainOwnedConsumers(preDrain: () => Promise<void>): Promise<OwnedDrainOutcome>;
}
```

`beginOwnedDrainSync` is idempotent. It synchronously closes admin and
admission, rejects pending tickets and aborts the coordinator lifetime signal
and current preparation. It does not cancel active turns. The legacy
`dispose()` entry point shares close-admission mechanics but keeps its current
early turn cancellation and settlement. Owned compositions use only the
owned methods. `drainOwnedConsumers` requires that owned drain has begun. It
starts the callback in the same stack, shares one in-flight attempt and waits
for the callback and captured running queue settlement before cancellation.
On callback rejection, wait for the running queue too, return
`{ kind: 'incomplete', cause }` and clear only the owned attempt promise.
On confirmed barrier completion, cancel active turns, await controller
disposal and close sources in existing reverse order. Record errors from
settled disposal operations and return one memoized `drained` outcome.
An unresolved controller/source promise keeps the attempt pending. Treat
`throw undefined` as a failure using discriminated outcomes.

**Produces** the following cleanup interfaces in `server-shutdown.ts`,
directly importable only through that Server-private module:

```ts
interface ServerShutdownResources {
  readonly server?: ServerType | undefined;
  readonly coordinator?: ExtensionCoordinator | undefined;
  readonly owned?: Pick<OwnedPluginArtifactStore, 'quiesce' | 'close'> | undefined;
  readonly authority?: Pick<PluginAuthorityDatabase, 'close'> | undefined;
}

interface ServerShutdown {
  stop(): Promise<void>;
  failStartup(cause: unknown): Promise<never>;
}

function createServerShutdown(options: {
  readonly resources: () => ServerShutdownResources;
  readonly disposeHost: () => Promise<void>;
  readonly stopRuntime: () => Promise<void>;
  readonly closeProjectStore: () => void | Promise<void>;
  readonly closeProviderSettingsStore: () => void | Promise<void>;
  readonly closeManualTrustStore: () => void | Promise<void>;
  readonly closeMcpAuthorityStore: () => void | Promise<void>;
}): ServerShutdown;

function retryFailedServerStartupCleanup(cause: unknown): Promise<void>;
```

On the first stop or boot failure, capture one resource set. Memoize an
in-flight attempt before invoking any externally supplied close, abort or
quiesce callback so synchronous reentry shares the same attempt. Move the
existing `closeServer` implementation from `main.ts` into the helper.
Begin HTTP close and attach outcome handling synchronously. For owned mode, synchronously
begin coordinator drain and start owned quiescence via the pre-drain callback.
If no coordinator has returned, start and await quiescence directly. Preserve
the same resources on incomplete drain. After a confirmed barrier and
coordinator drain, await ServerHost disposal, then close idle SSE and await
HTTP close. Keep Session persistence open through those consumer phases.
Continue existing Runtime/store cleanup in dependency order. Close the
owned wrapper only after consumers have drained. Close the main authority
after wrapper close succeeds. Never pass its borrowed trust facet to
`closeManualTrustStore`. Track confirmed quiescence, confirmed consumer
drain, settled other cleanup, wrapper release and authority close separately.
A subsequent stop attempt shares pending work and retries unfinished phases.
Retain settled causes for the returned failure without rerunning settled
cleanup. Attach rejection handling to stop called by process signal handlers.
For unowned stop, continue cleanup in the existing order and reject with the
original first cleanup error, including when later cleanup also fails.

On boot failure, preserve the original cause when cleanup succeeds. If
cleanup fails, throw an `AggregateError` whose first error and `cause` are
the original value, with cleanup failures after it. With confirmed drain
and an owned release rejection, make one immediate bounded retry of the
same wrapper close. If any acquired managed-resource phase still needs
retry, associate the exact thrown error object with the same
`ServerShutdown.stop` closure in a module-private
`WeakMap<object, () => Promise<void>>`. An original primitive remains the
`cause` of the aggregate object. This also covers an incomplete barrier
that prevented any release attempt. The retry function accepts only that
associated error object, calls the same closure, and removes the association
when remaining resource phases are complete even if a recorded settled
cleanup cause is reported. For other inputs return a rejected
`TypeError('No failed Server startup cleanup is available')`. Neither the
server entrypoint nor the success shape exports the retry handle.

- [ ] **RED.** Gate the running queue callback and owned quiescence.
      Assert admin is already closed, the lifetime signal is aborted,
      queued tickets reject and an active run remains pinned until both
      gates settle. Fail the first quiesce attempt and assert that no
      consumer, Session, authority or lease teardown is called. Retry,
      gate terminal append and setup settlement, then assert exactly one
      consumer drain before idle SSE close and release.
- [ ] **RED.** Assert concurrent stops share one attempt. Inject a
      settled cleanup error plus wrapper release and authority close
      rejection on separate calls. Verify the call sequence distinguishes
      held lease, completed drain, successful release and authority retry.
      Test boot errors as `Error` and primitive with persistent release
      failure, and incomplete boot drain that never called close. Use
      `retryFailedServerStartupCleanup` to resume the original objects.
      Assert it rejects unassociated input and rejects reuse after full
      cleanup. Preserve manual `dispose()` ordering in coordinator tests.
- [ ] Run the focused command below and observe failed assertions for
      the missing drain ordering and retry path before edits.
- [ ] Implement the coordinator lifetime and owned outcome, then move
      `main.ts` stop and catch into the shared helper. The acquire inputs
      are populated by Task 2. Test Task 1 using injected owned and
      authority phase callbacks and a real coordinator fixture.
- [ ] **GREEN.** Rerun the focused command and request independent review
      of close ordering, reentry, cause preservation and same-object retry.

```sh
pnpm exec vitest run apps/server/test/server-shutdown.test.ts apps/server/test/extension-coordinator.test.ts apps/server/test/health.test.ts
pnpm --filter @weave/server typecheck
```

## Task 2. Select the startup authority and acquire ownership

Write the task's behavior tests first and run the focused command below for RED.
Observe failures for first-bind parent, registered path, override or retry behavior. After implementation run the same
command for GREEN and run Server typecheck before independent review.

```sh
pnpm exec vitest run apps/server/test/managed-plugin-startup.test.ts apps/server/test/plugin-store-registration.test.ts apps/server/test/health.test.ts apps/server/test/plugin-path.test.ts apps/server/test/owned-plugin-artifact-store.test.ts
pnpm --filter @weave/server typecheck
```

**Files:** `apps/server/src/{managed-plugin-startup,plugin-authority-store,plugin-authority-types}.ts`
and `apps/server/test/{managed-plugin-startup,plugin-store-registration}.test.ts`.
Task 3 wires the startup module into `main.ts` and the local facade.

**Consumes:** Task 1's shared shutdown and owned drain contracts, `createSqlitePluginAuthorityDatabase({ filename })`, `readAuthoritySnapshotTx`, `readManagedRootRegistrationTx`, strict `readManagedRootStateSync()`, `openOwnedPluginArtifactStore`, `resolveDatabaseFile`, `resolvePluginsDirectory`, and baseline membership from `runtime.serverHost.controller().current().resources.plugins`.

**Produces:** A private authority and store acquisition module and its
strict managed startup options schema. Task 3 exposes the schema through
`StartServerOptions.managedPluginStore` and passes the borrowed handles into
the coordinator. Embedded manual composition retains its own trust store.

- [ ] Add strict Zod parsing for the optional
      `{ readonly initialBinding: 'allow-unbound' | 'require-bound' }` object
      before acquisition. Reject explicit managed mode paired with disabled
      ESM or `pluginTrustStore`. Use the database file and plugin directory
      resolved by the existing path policy. The helper opens authority
      even with ESM disabled, so Task 3 can use sticky history in MCP.
- [ ] Add the Server-private `PluginAuthorityDatabase.readStartupAuthoritySync()`
      from the design. In one `transaction('BEGIN', ...)`, use
      `readAuthoritySnapshotTx(database)` and
      `readManagedRootRegistrationTx(database, identity)` and pass their
      combined result to `detachAndFreeze`. This read validates durable state
      independently of filesystem eligibility. Keep strict root-state and
      registration checks on the acquisition path.
- [ ] Use the new decision read for ESM-disabled, override and unbound startup.
      Borrow `authority.trust` by default. A clean custom override supplies the
      sole manual trust facet and is closed once by Server. Reject the override
      when registration or any `installations` exist, and repeat the decision
      read after awaiting override events. An unregistered database without an
      option may carry sticky or selected data and leaves the artifact root
      unopened. Return the startup snapshot and its durable `registration`
      from the private helper. If the acquisition arm needs a strict root
      state, keep it local to that arm.
- [ ] After baseline `createServerAgentRunner`, pass baseline IDs and `serverHostVersion` through the owned factory. Resolve the configured plugin directory with `path.resolve` as manual discovery does, then join `.weave-store` and let the factory canonicalize checked paths. The missing plugin parent may be created recursively only when the latest validated state is unregistered and the caller explicitly asked for `allow-unbound`. Registered startup always uses `require-bound`, even with explicit `allow-unbound`, and neither it nor unregistered `require-bound` can create the parent or root. Attach the ownership-loss observer before acquisition and register the returned wrapper immediately with Task 1's shared cleanup path. Read/adopt fresh authority after acquisition, which awaits filesystem/lease work.
- [ ] Use real temp databases through the private acquisition module. Assert
      explicit first binding with the default `plugins` parent absent,
      configured relative path semantics and exact auto-resume with omitted
      options. Exercise unsatisfied `require-bound`, wrong root, busy owner,
      absent/corrupt owner metadata and registered `allow-unbound` at a wrong
      path. Failing bound acquisition creates neither the plugin parent nor
      the artifact root. Cover clean override, registration-only and
      imported-only/uninstalled override rejection, isolated databases and
      no root creation for ordinary unbound startup. Test acquisition and
      real lease release with the Task 1 cleanup tracker. Task 3 covers the
      live HTTP startup and failed-listen paths.
- [ ] In `plugin-store-registration.test.ts`, read startup authority through
      a database main-file symlink and assert the result is detached and
      frozen. Verify registration is validated and malformed durable
      registration still fails. Assert strict root state still rejects the
      same symlink. In `managed-plugin-startup.test.ts` use a main-file symlink
      for default-unbound, disabled ESM and clean override startup and assert
      no artifact root creation. With that symlink, explicit acquisition and
      registered ESM auto-resume still reject before artifact creation.

**Ordering.** Task 1's cleanup tracker owns each acquired resource immediately,
ahead of the next await. Verify acquisition and retention through the private
module during Task 2. Task 3 wires acquisition, facade disposal and the sticky
namespace into normal startup together. Task 6 enables selected evaluation
and publication in normal startup after the Generation guards and cached public
redaction are verified.

## Task 3. Compose explicit managed evidence and the MCP namespace

Complete 3a, 3b and 3c in order. Each checkpoint has its own RED, GREEN and
independent review. File ownership overlaps across checkpoints, so review
and hand off the preceding checkpoint before editing the next. They form
one Task 3 in the Server PR. Task 4 adds final publication and actual-start
guards in the internal composition. Task 6 enables selected execution and
publication in normal startup after public projection checks.

### 3a. Publish paired authority changes and enforce MCP reservations

**Owns** `apps/server/src/{extension-types,extension-coordinator,mcp-source,managed-plugin-composition}.ts`,
`apps/server/test/{extension-coordinator,mcp-source}.test.ts`, and
`apps/server/test/support/managed-plugin-composition-fixture.ts`.

**Consumes** Task 1's `ExtensionMutationContext`, existing source observers,
and MCP's authority log validation and mutation queue callback.

**Hands off** the following Server-private contracts for 3b and 3c:

```ts
// ExtensionCoordinator method
observeAuthorityBatchSync(changes: ReadonlyMap<string, ExtensionAuthorityChange>): void;

// Added to the private MCP source handle
declaredPluginIds(): readonly string[];
setDeniedPluginIdsSync(ids: ReadonlySet<string>): void;
refresh(): Promise<void>;

// Optional private McpExtensionSourceOptions hooks
readonly installAuthoritySync?: (applyValidatedLog: () => void) => void;
readonly assertCreateAllowedSync?: (pluginId: string) => void;
```

- [ ] **RED.** In the coordinator tests, start a run whose synchronous abort
      callback reads both effective source snapshots and coordinator
      admission. Deliver a paired policy change and assert it sees both
      final snapshots and the admission block, with one abort. Verify
      same-stamp changes and a higher validated sequence with steady
      eligibility. Cover consecutive notifications for the same source
      where an earlier one carries immediate metadata.
- [ ] **RED.** In the MCP source tests, deny an enabled trusted declaration
      and assert both snapshot and preparation exclude it. Include
      disabled, untrusted and broken non-removed declarations in the IDs
      returned for namespace decisions. Verify durable removal releases the
      future claim and leaves any existing allocation to its Generation.
      Reject malformed or rewritten prefixes before invoking the install
      hook. Suspend configuration before dispatch, add a sticky ID, then
      assert `mcp-conflict` and zero create writes. Verify closed admin also
      prevents dispatch after this await.
- [ ] Run the focused Vitest command below. Confirm RED on missing paired
      observation and MCP reservation before implementation.
- [ ] Route single-source notifications through the batch method. Apply all
      changed stamps and update `desiredRevision`, compute admission against
      final eligible identities, then dispatch immediate cancellation at
      most once. In `managed-plugin-composition.ts` put the synchronous
      composition-local observer buffer used by the private fixture and
      3b. Keep the last snapshot per source, union affected IDs and preserve
      immediate metadata from changed stamps. Clear the buffer before
      delivering the batch, so synchronous reentry sees completed state.
- [ ] MCP validates `knownPrefix` before invoking the optional install hook.
      The hook calls `applyValidatedLog` exactly once in the paired scope,
      including when the validated log is equal. After the apply call it can
      read the current declared IDs. Use a single denied-aware predicate in
      MCP snapshot and prepare. `setDeniedPluginIdsSync` emits a bufferable
      change without reentering the install hook. A deny-only change advances
      revision when effective eligibility changes. Preserve the validated log
      sequence even when effective eligibility is steady.
- [ ] Keep awaited normalization and the existing baseline, retained and
      manual declaration check. At create dispatch after `await command()`,
      call `assertCreateAllowedSync` with `mcp-${config.id}`, then check
      `assertOpenSync` immediately before `store.mutate`. The composition
      hook checks sticky state and throws the existing `mcp-conflict`.
      Keep existing immediate retained-membership retry for no-op cases
      and one cancellation for a changed installation. The private harness
      exercises both adapter snapshots with test-supplied authority, using
      the production observer buffer and real coordinator and MCP source.
- [ ] **GREEN.** Rerun the focused command, then typecheck and request
      independent review of stamp ordering, prefix validation and reentry.

```sh
pnpm exec vitest run apps/server/test/extension-coordinator.test.ts apps/server/test/mcp-source.test.ts
pnpm --filter @weave/server typecheck
```

### 3b. Read selected evidence and verify a joint Generation

**Owns** `apps/server/src/{managed-plugin-composition,local-plugin-host,local-extension-source,extension-types,extension-coordinator,mcp-source}.ts`,
`apps/server/test/{managed-plugin-composition,managed-plugin-integration,extension-coordinator,mcp-source}.test.ts`,
and `apps/server/test/support/managed-plugin-composition-fixture.ts`.

**Consumes** the 3a batch, observer buffer and MCP install/denial hooks,
Task 2's authority and optional owned store, and the package explicit selection,
candidate identity, origin and verification contracts.

**Hands off** one Server-private composition that can adopt a validated
`PluginAuthoritySnapshot` synchronously and refresh exact selected evidence
with an `AbortSignal`. The local adapter exposes cached
`snapshot(): ExtensionSourceSnapshot` and
`adoptExplicitSelectionSync(input: ExplicitLocalSelectionInput): void`
to that composition. It binds
`explicitChecks.verify(candidate, signal)` and
`assertReadySync(candidate): undefined` to the same authority. The
coordinator opts the combined composition into MCP-first authority phases
through a private `mcpFirstAuthority?: boolean` option.

- [ ] **RED.** In the composition tests gate owned reads and refreshes.
      Assert the verifier checks digest, descriptor manifest ID, files,
      bytes, canonical manifest and the durable first-import link. Cover
      reordered manifest properties, stale selection and revocation
      during a read, missing or corrupt bytes, and authority read or
      adoption failure. Record effective snapshots and admission after
      withdrawal, including a formerly manual same-ID member.
- [ ] **RED.** Gate a new MCP claim during assembly and another before a
      later digest in a multi-target read phase. Assert no subsequent
      managed read is dispatched for the newly denied target. Test both
      collision orders, manual same-ID conflicts, disabled/broken claims
      and a durable removal while an MCP allocation is pinned. Exercise
      cached batch observation inside an immediate reentrant callback.
- [ ] **RED.** Extend the private fixture to seed real SQLite authority,
      an owned artifact, an unrelated trusted manual ESM plugin and a
      trusted stdio MCP using `fixtures/mcp-server.mjs`. Exercise all three
      contributions through one stable runner and Generation. Assert an
      imported unselected digest receives zero managed reads and its module
      never executes. Task 6 reuses the fixture for real startup and restart.
- [ ] Run the focused Vitest command below. Confirm RED on missing verified
      selection, MCP-first ordering or joint membership before implementation.
- [ ] Take one validated snapshot per adoption. Derive all sticky installation
      IDs. Link each selection by ID, digest and
      `firstImportSequence === candidateImportSequence`, and retain its
      manifest and activation sequence even without readiness. Use
      `foldTrust` and `canonicalJson` to confirm enabled matching trust.
      In the shared observer buffer apply the intersection of sticky IDs
      and cached MCP declared IDs to both sources. Update local eligibility
      and MCP denial before flushing. Retain ready data only for the exact
      candidate, activation, trust, binding and namespace. After authority
      failure, publish the last validated prefix and sticky IDs without
      readiness and propagate the authority marker. If local adoption
      throws after a new sticky claim, publish a fail-closed effective local
      snapshot with a changed stamp and affected identities filtered out,
      including displaced manual members. Use that same snapshot for future
      reads. Apply MCP denial in the same batch and preserve private causes.
      Cancel unfinished local preparation that captured the old raw snapshot
      only after both effective snapshots and admission have been published.
      Preserve the authority marker through that cancellation and leave
      published or retired signals untouched. The local adapter tracks only
      pending raw `prepare` calls with private abort controllers. Withdrawal
      captures that set and returns a cancellation callback; composition runs
      it after the paired publication. Reentrant later attempts and returned
      Generation-owned resources are outside that captured set. Test an
      already-running manual preparation with an import spy and a synchronous
      abort observer.
- [ ] At MCP's validated-log boundary, add a private optional
      `onAuthorityFailureSync?: (cause: unknown) => never` hook. Call it on
      read/protocol failure, including fulfilled malformed or rewritten logs
      during facade refresh and mutation-result installation, before the
      source can return without withdrawal. Ordinary request conflicts do not
      enter this hook. Bind the combined composition to its existing authority
      invalidation; standalone MCP preserves the original failure. Test both
      facade paths with a published managed Generation and blocked admission.
- [ ] Reuse one bounded `owned.read(digest, { signal })` verifier for runtime
      evidence. Compare the returned digest, descriptor manifest ID, files,
      bytes and canonical manifest to the durable candidate and build
      readiness from the checked entry and directory. Check cancellation
      and exact policy before dispatch and after every awaited read.
      Ordinary artifact failures become safe selection issues or identity
      failures. Authority failure withdraws eligibility and surfaces
      `ExplicitLocalAuthorityError`. The synchronous guard checks lease,
      selection, trust and known namespace, reconciles or withdraws stale
      evidence and returns `undefined` on success.
- [ ] Keep the existing registration and preparation order. In combined
      mode refresh MCP authority before local runtime reads during initial
      load, reload, preparation and retries, including retries that skip
      normal refresh after attribution. Recheck prepared MCP before the
      final bounded local recheck even when local prepared first. Validate
      MCP authority again before a local read when intervening async work
      could reveal a new claim. Use the current effective policy to skip
      later denied targets. Task 5 uses the same ordered phase after
      adoption and includes the mutated local source. Keep legacy
      mutation skip behavior elsewhere.
- [ ] Keep package trust and manual discovery refresh and recheck. Bound the
      final managed comparisons to prepared items still eligible after those
      checks and current namespace reconciliation. Use
      `eligibleLocalSourceCandidates` and `localSourceCandidateIdentity` in
      the adapter. Preserve candidate identity and origin when mapping
      preparations and failures for Task 4.
- [ ] **GREEN.** Rerun the focused command, then typecheck and request
      independent review of evidence, phase ordering and joint membership.

```sh
pnpm exec vitest run apps/server/test/managed-plugin-composition.test.ts apps/server/test/managed-plugin-integration.test.ts apps/server/test/extension-coordinator.test.ts
pnpm --filter @weave/server typecheck
```

### 3c. Wire startup authority, ownership and facade shutdown

**Owns** `apps/server/src/{main,local-plugin-host,local-extension-source,managed-plugin-startup}.ts`
and `apps/server/test/{managed-plugin-startup,mcp-integration,health}.test.ts`.

**Consumes** Task 1's memoized shutdown, Task 2's acquisition module and
raw override trust prefix, and 3a/3b's paired namespace composition.

**Hands off** live `startServer()` acquisition and sticky reservation,
including disabled ESM, unowned and custom override modes. The local facade
accepts a private optional `dispose?: () => Promise<void>` callback and
delegates to `coordinator.dispose` when omitted. An owned startup supplies
the same `stop` closure exposed in the existing Server return.

- [ ] **RED.** Test live imported-only startup with no artifact root and
      sticky MCP reservation. Repeat the namespace case with ESM disabled
      and a clean override. Use unrelated main and override trust histories.
      Verify a sticky override rejection prevents listening and real
      lease contention resolves after normal stop and failed-listen cleanup.
- [ ] **RED.** Start an active turn and a gated admin operation. Invoke
      `started.pluginHost.dispose()` with gated owned quiescence and assert
      the turn remains pinned until both gates settle. Call
      `started.stop()` during or after facade disposal and verify one
      consumer drain and one lease release. Cover existing manual and
      embedded facade disposal behavior.
- [ ] Run the focused Vitest command below. Confirm RED on the missing
      live startup namespace or owned facade drain behavior.
- [ ] Wire acquisition and sticky adoption before coordinator reload and
      listen. Use Task 2's synchronous hooks to register authority and
      wrapper with the shutdown tracker as soon as acquired. Track
      independently owned override trust cleanup separately from the main
      database. Pass the exact Server `stop` function to the owned facade.
      Normal startup applies sticky and MCP namespace policy without
      supplying managed ready evidence or dispatching selected reads.
- [ ] Forward and retain the override's raw event prefix through the
      Server-owned adapter. Use only those events for package adoption,
      including paired namespace updates. Use the validated main snapshot
      for sticky IDs. If a gapped append temporarily leaves no complete
      override prefix, let the package read it back. Block any matching
      newly sticky manual identity immediately through the effective
      snapshot. Task 6 adds the authoritative override append dispatch
      check.
- [ ] **GREEN.** Rerun the focused command, then typecheck and request
      independent review of binding, prefix ownership and both stop
      entry points.

```sh
pnpm exec vitest run apps/server/test/managed-plugin-startup.test.ts apps/server/test/mcp-integration.test.ts apps/server/test/health.test.ts
pnpm --filter @weave/server typecheck
```

## Task 4. Guard Generation publication and admission

Write the task's behavior tests first and run the focused command below for RED.
Observe failures for pre-commit and queued-start assertions and unfinished-only cancellation. After implementation run the same
command for GREEN and run Server typecheck before independent review.

```sh
pnpm exec vitest run apps/server/test/extension-coordinator.test.ts apps/server/test/managed-plugin-integration.test.ts
pnpm --filter @weave/server typecheck
```

**Files:** `apps/server/src/{local-plugin-host,extension-types,extension-coordinator,local-extension-source,managed-plugin-composition}.ts` and `apps/server/test/{managed-plugin-integration,extension-coordinator}.test.ts`.

**Consumes:** package origin-aware lifecycle and authority marker, `RunnerGeneration.assertCanStartSync`, owned-store `assertHeldSync`, and Task 3 ordered runtime read and adoption contracts.

**Produces:** Safe publication/admission behavior for managed members and exact generation-start checks.

- [ ] Carry local `origin` from package prepare results through `PreparedExtensionItem`, `ExtensionPreparationFailure`, `ExtensionMember`, and `ExtensionFailure`. A tagged MCP origin or an absent local origin for MCP both distinguish it from manual ESM. `sourceId: 'local-esm'` alone cannot support filtering, even when manual and managed bytes have equal ID/digest. Keep origins private. In the no-rebuild fast path, a managed current still requires valid current evidence and held lease.
- [ ] Perform ordinary source rechecks and the exact managed artifact rechecks before the synchronous publication section. When ordinary artifact verification finds tampering, use the existing identity-refresh path or a per-plugin selection issue that removes eligibility. Record the initial and latest stamps, verify survivors and identity-based membership, run MCP `isReady`, and check open state. Place final lease and exact selected checks outside per-plugin attribution, then confirm cached revision/eligibility, origin-aware membership and absence of persistent loss in the same stack as `ServerHost.commit`. A guard can synchronously change cached state or block the coordinator, so check revision/open state after it. Keep normal attributable setup/provider-conflict isolation where `ServerHost.commit` itself throws.
- [ ] Recognize direct `ExplicitLocalAuthorityError` and `PluginError` with code `plugin-setup-failed` whose `cause` is that marker before `normalizeError` and before applying attribution. Follow the authority failure branch (reject and keep current), with Task 6 safe public state. Preserve private cause. Check the `attributePluginError` path in `agent-kernel.ts` for the retained marker in the merged baseline.
- [ ] Latch loss once and establish the persistent block for current managed membership before doing any withdrawal that may throw. Managed evidence getters and publication/command guards consult the latch independently of the cached package snapshot. Withdraw readiness synchronously and ensure loss signals still reach unfinished reads/candidates if withdrawal throws. Preserve the original loss and withdrawal cause privately and surface `ExplicitLocalAuthorityError` from the verification, evaluation or publication path so an adapter exception cannot become per-plugin exclusion. Unmanaged admission remains available when already compliant. If a block is already latched and an unmanaged commit proceeds, reapply it in the same stack because package commit resets blocking.
- [ ] Scope loss abort to unfinished managed reads and the unfinished attempt containing managed work, including that attempt's unpublished MCP allocations. Remove the per-attempt loss target as part of successful publication. Never compose the permanent loss signal into the shared preparation signal retained by already-published MCP allocations. Leave active and retired pins and their payloads alone. Install `assertCanStartSync` only on the actual managed Generation passed to `host.commit`. It checks held lease, routes observed loss through the latch and returns `undefined` without artifact reads.
- [ ] Exercise the guarded managed composition through the internal harness.
      Inject gated loss at verification, import/factory/setup, publication
      and actual queued-head start, including withdrawal itself throwing.
      Expect no managed admission, no successful stale publication and no
      per-plugin exclusion from a guard marker. Queue a second same-Session
      turn behind a pin, then lose the lease and assert the refused turn never
      writes `turn.started`. Check previously published MCP tools through pins
      and the still-compliant unmanaged current after loss, including a pin
      to a retired Generation. Verify the persistent block through a later
      compliant commit and an old managed tool reading bytes beside
      `import.meta.url` after replacement. Task 5 extends this to the queued
      uninstall, and Task 6 attaches guarded managed execution to normal startup.

**Risk:** Existing `rebuild` catches attribution errors and clears `blocked` after a successful commit. Persistent ownership loss needs an independent latch, and final checks must stay outside per-plugin catches so a managed authority marker cannot be downgraded to an ordinary plugin failure.

## Task 5. Apply durable managed decisions on the admin queue

Write the task's behavior tests first and run the focused command below for RED.
Observe failures for replay effects, saved-vs-applied result and queue-owned outcome. After implementation run the same
command for GREEN and run Server typecheck before independent review.

```sh
pnpm exec vitest run apps/server/test/managed-selection-manager.test.ts apps/server/test/extension-coordinator.test.ts apps/server/test/managed-plugin-integration.test.ts
pnpm --filter @weave/server typecheck
```

**Files:** `apps/server/src/managed-selection-manager.ts`, `apps/server/src/extension-coordinator.ts`, `apps/server/src/local-plugin-host.ts`, `apps/server/src/local-extension-source.ts`, `apps/server/test/managed-selection-manager.test.ts`, `apps/server/test/managed-plugin-integration.test.ts`, `apps/server/test/extension-coordinator.test.ts`.

**Consumes:** `ManagedRequest`, `ManagedSelectionRequest`, `PluginAuthorityDatabase.lookupSync/commitSync`, `ManagedPreparation`, Task 3 adoption/ordered refresh, and Task 4 publication/loss rules.

**Produces:** Server-private `applyManagedSelection(request): Promise<ManagedSelectionResult>` with durable decision/application separation.

- [ ] Attach `applyManagedSelection` only to the owned internal composition. Return the exact result union in the spec and leave public HTTP/app options alone. Call `canonicalizeManagedRequest(input)` and reject command `import` before file work. `rollback` is `kind: 'activate', intent: 'rollback'`, so its preparation kind is still `activate`.
- [ ] Reuse Task 1's `{ assertOpenSync, signal }` and add `coordinator.mutateManaged` with the contract below. Keep legacy `mutate()` as an adapter over the same enqueue/drain, with its existing refresh behavior and result shape. Lookup first within the ticket. Both early and transactional replay return `'skip-rebuild'` plus saved operation/current authority and skip refresh, rebuild, readback, and cancellation. Transactional replay may follow provisional evidence.

```ts
function mutateManaged<Replay, Saved>(
  sourceId: string,
  operation: (context: ExtensionMutationContext) => Promise<ManagedMutationStep<Replay, Saved>>,
): Promise<ManagedMutationCompletion<Replay, Saved>>;

type ManagedMutationStep<Replay, Saved> =
  | { disposition: 'skip-rebuild'; replay: Replay }
  | { disposition: 'rebuild'; saved: Saved }
  | { disposition: 'committed-failed'; saved: Saved; cause: unknown };

type ManagedMutationCompletion<Replay, Saved> =
  | { kind: 'replayed'; replay: Replay }
  | {
      kind: 'committed';
      saved: Saved;
      generation: ExtensionGenerationSnapshot;
      members: readonly ExtensionMember[];
      outcome: { kind: 'completed' } | { kind: 'failed'; cause: unknown };
    };
```

Capture the committed result before adoption. Finish the typed outcome within the ticket and use a discriminated failed branch to preserve even a thrown `undefined`. Keep original refresh/rebuild failures in the internal attempt result separately from the legacy public issue. Resolve the ticket only after it captures applied/failed state from its own attempt. Reject true precommit failures normally.

- [ ] For fresh activation use the requested digest's durable candidate; for enable require the exact selected link and use that candidate. `ManagedPreparation.artifact` is only `pluginId/digest/manifest/files/bytes`, never entry, payload path, or provenance. Capture locally checked ready evidence separately. For disable/revoke/uninstall pass only `{ kind }`. Recheck the queue lifetime and held lease after awaits and immediately before `commitSync`. Leave exact CAS and review validation to the database.
- [ ] On fresh commit synchronously capture `operation` and `afterSnapshot`, then adopt both effective snapshots before the first await. If adoption throws, first fail closed for affected membership, including a formerly manual same-ID member. In either branch, issue exactly one `retryImmediateRevocation` for fresh destructive `immediate`, including durable no-op. Extend its retained-membership predicate with managed origin and inspect current and retired membership. Keep this cancellation out of the adoption observer and both replay branches. If invalidation itself fails, retain the independent admission block, record the failure, and still perform the one retry. Report committed + failed with the saved decision and private cause.
- [ ] Return the rebuild disposition without doing local readback inside the mutation callback. The same queue ticket then runs MCP authority refresh and adoption, followed by managed local refresh/readback, including the mutated local source, then rebuilds. Reuse provisional ready evidence only under exact current authority and namespace. If a new MCP claim appears in this refresh, detach old ready evidence and skip runtime reads for that target. Both replay branches bypass this ordered path.
- [ ] Capture operation-specific Generation snapshot and members inside the queue at completion, including thrown postcommit failure paths; a `.then` outside the queue reading `coordinator.snapshot()` can observe the next mutation. Use exact managed identity including activation sequence for enabled selection, and require the target managed member absent in a compliant Generation for destructive application. A fresh no-op can reuse a compliant current Generation. Replays never call `retryImmediateRevocation`, even if a historical request was immediate.
- [ ] Test both replays and conflicting request IDs using the same queue. Count reads and assembly/cancellation around each branch. Force adoption failure while the target has a retained managed member, then replay and assert one cancellation across the pair. Include a retired managed member, a manual same-ID comparison, and a durable destructive no-op. Append a new MCP claim immediately before postcommit refresh and assert zero runtime reads of its target, independently of any earlier command evidence read. Queue a second mutation to verify that the first result carries its own Generation and original private failure cause. Verify bytes-free destructive preparation, shutdown while evidence is awaited, and fresh rejection with replay after ownership loss.

**Risk:** `commitSync` is the durable boundary. A committed operation must never be reported as an unqualified precommit error, and replay must not restore historical selection or trigger runtime work.

## Task 6. Preserve cached public projections and manual mutations

Write the task's behavior tests first and run the focused command below for RED.
Observe failures for origin filtering, fixed safe errors, and manual sticky mutation checks. After implementation run the same
command for GREEN and run Server typecheck before independent review.

```sh
pnpm exec vitest run apps/server/test/plugin-catalog-projection.test.ts apps/server/test/plugin-management-api.test.ts apps/server/test/mcp-api.test.ts apps/server/test/managed-plugin-integration.test.ts
pnpm --filter @weave/server typecheck
```

**Files:** `apps/server/src/{main,local-plugin-host,plugin-catalog,local-extension-source,mcp-source,extension-coordinator}.ts` and `apps/server/test/{plugin-catalog-projection,plugin-management-api,mcp-api,managed-plugin-integration}.test.ts`.

**Consumes:** composition snapshots and private managed state from Tasks 3–5.

**Produces:** Existing `/plugins` and `/commands` projections that show effective managed/manual/MCP results without exposing managed desired/retired internals.

- [ ] Project desired rows, active membership and reload failures from manual origin only. Use the existing path-free `kernel` base for published managed and MCP members. Suppress a conflicting manual overlay if the ID already belongs to a published base and is absent from active manual membership. Preserve the original display path within the private/manual projection. Deduplicate by plugin ID while preserving the existing order of surviving rows.
- [ ] Sanitize before both projection and reload return. Map attributed managed failures to `plugin-load-failed` and `Managed plugin preparation failed`. Map whole-candidate failures with managed/mixed/unknown attribution to `plugin-reload-failed` and `Extension generation could not be published`. Keep the original exception in a private attempt result used by the managed application facade. Preserve safe manual-origin messages. Catalog GETs continue reading cached `snapshot()` and base Generation catalogs only.
- [ ] Check the MCP facade's mutation-result mapper, which currently copies failures across sources. Preserve its compatible DTO and cached allocation state while avoiding a managed desired ID/path disclosure through that secondary response. Apply the fixed safe whole-candidate issue at the projection boundary too.
- [ ] Before manual trust/enable/disable/revoke, read current sticky authority synchronously. Repeat after the package mutation awaits and before it can return idempotently. Throw the existing safe `PluginTrustStoreError('plugin-trust-invalid', ...)` and preserve the write-facade transaction backstop. Package's cached sticky check protects internal awaited branches; ensure legacy immediate retry cannot fire on a newly sticky ID by checking authority on the callback path as well. Override composition keeps authoritative sticky checks even though the override owns its own trust prefix.
- [ ] In Task 3's custom override adapter, check authoritative sticky IDs
      synchronously at the `append` dispatch after the package's awaited
      steps. Add a gated override mutation that becomes sticky after the
      initial check and verify the override receives no append for that ID.
- [ ] Assert cached GET read counters, one same-ID published base row, manual-only `local.generation.plugins`, manual contributions/commands and existing trust errors. Inject a distinctive private payload path into both a managed-attributed failure and an unattributed mixed-generation failure. Assert its absence in serialized catalog/reload projections and the exact fixed public code/message.
- [ ] After origin filtering and sanitization, attach the guarded managed
      composition to normal startup. Run Task 3's joint fixture with real
      `startServer()`, check its cached HTTP projections, then restart with
      omitted binding options and confirm the same registered root and
      selected managed contribution. Recheck existing compatibility and
      owned cleanup through both stop entry points.

**Risk:** Existing `projectPluginCatalog` assumes all local rows come from one manual source. Managed rows must remain private in source state while the effective member still appears exactly once in the public catalog.

## Task Interface Order and Verification

Use the `feat/managed-plugin-server` topic branch from the merged package baseline. Follow the handoff order below.

| Task                         | Accepts                                                                       | Hands off                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Shutdown                  | Coordinator lifetime/admin state and 6.2b quiesce/close                       | A synchronous owned close start, typed `OwnedDrainOutcome`, retryable phase tracking and `{ assertOpenSync, signal }` for queue callbacks   |
| 2. Startup                   | Task 1 phase contract, validated authority and baseline IDs                   | Private acquisition module for authority, standalone or borrowed trust, and optional wrapper with a loss observer                           |
| 3. Evidence and namespace    | Task 1 cleanup and queue context, Task 2 acquisition and validated MCP prefix | Live startup with owned cleanup and sticky reservations. Paired snapshots and MCP-first runtime reads for the internal managed composition. |
| 4. Publication and admission | Task 3 paired snapshots, managed evidence, and ordered rechecks               | Exact Generation commit/start guards, persistent loss block, and cancellation limited to unfinished work                                    |
| 5. Managed decisions         | Task 3 authority adoption/ordered refresh and Task 4 publication              | Typed same-ticket durable result, exact application Generation, and origin-aware immediate retry                                            |
| 6. Public projection         | Tasks 3–5 cached state, private origin and failures                           | Production selected execution, existing catalog and API shapes, and real restart coverage                                                   |

Update `docs/architecture/foundation.md` with the delivered Stage 6.2c.2 contracts on the formal branch. Before focused RED on a fresh worktree, run `pnpm --filter @weave/server... build` to resolve the package imports. For the complete review, rerun all six focused commands above. Include the real restart and shutdown suites, and run `pnpm check`. The focused integration set is `pnpm exec vitest run apps/server/test/managed-plugin-integration.test.ts apps/server/test/managed-plugin-composition.test.ts apps/server/test/extension-coordinator.test.ts apps/server/test/mcp-source.test.ts apps/server/test/mcp-integration.test.ts apps/server/test/plugin-catalog-projection.test.ts apps/server/test/plugin-management-api.test.ts apps/server/test/server-shutdown.test.ts apps/server/test/health.test.ts`.

## Package Integration Checks

- The artifact-store factory currently validates manifests against baseline reservations and `hostVersion` inside `read()`. A preliminary metadata-only compatibility check is not required by the spec and the package exports no compatibility helper. Plan treats incompatibility as a bounded read finding with a retained declaration.
- Stock package commit clears runner blocking. Reapply a previously latched loss block synchronously after any permitted unmanaged commit or reject that commit. Reapply the block in the commit stack if publishing a compliant unmanaged Generation after the block was latched.
- Verify the merged package signatures. In particular a setup authority marker must reach Server as the direct `PluginError('plugin-setup-failed')` cause, and managed prepared items must actually drain original setup. These are contract integration checks, not additional package work.
