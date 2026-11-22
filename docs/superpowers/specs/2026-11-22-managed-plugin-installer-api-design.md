# Stage 6.2d Managed Plugin Installer API Design

This design specifies Stage 6.2d against merged Stage 6.2c.2 at `917996f`. It supersedes the working Stage 6.2d drafts. The [implementation plan](../plans/2026-11-22-managed-plugin-installer-api.md) names the concrete private producer and consumer interfaces. The [installation ADR](../../adr/0005-plugin-installation-and-distribution.md), [installation design](2026-11-21-plugin-installation-design.md), [authority design](2026-11-21-plugin-authority-design.md), [ownership design](2026-11-21-plugin-store-ownership-design.md), and [managed source design](2026-11-21-managed-plugin-source-design.md) govern the underlying layers.

## Scope and owners

One Server-owned installer accepts already bundled local ESM directories. Import creates a managed candidate and sticky namespace reservation. Exact reviewed activation or rollback grants trust and selects a version through the existing combined transaction. Existing turn pins keep the concrete payload paths. Uninstall revokes authority and retains files and candidate history.

`@weave/plugin-host` supplies bounded read-only source inspection, reviewed staging, detached manual declaration claims, and typed identity metadata on managed prepared items. Server owns the registered-store lease, transient previews, provenance, detached MCP inspection, namespace checks, authority transactions, management queue and projection. The package continues to depend only on `@weave/plugin` among workspace packages. The SQLite schema and Runtime contracts stay at their current versions. Studio reaches this feature through HTTP JSON in Stage 6.3, which also handles Desktop wiring. Later ADR stages cover network acquisition, builds and artifact deletion. This design uses existing dependencies.

## Routes and access

Register the following under the shared plugin write guard. `startServer` supplies the manager only when local ESM discovery is configured and startup has acquired the registered store with the unified authority DB. An absent manager returns 404 `plugin-installer-disabled` after the shared guard and static request validation. A composition that has detected ownership loss can still return a cached GET while reachable and reconcile a durable replay while its authority connection remains available. Fresh work fails with 503.

| Method and route                                                                                     | Strict JSON body                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GET `/plugins/managed`                                                                               | Catalog read, no body                                                                                        |
| POST `/plugins/managed/preview`                                                                      | `{ sourceDirectory }`                                                                                        |
| POST `/plugins/managed/import`                                                                       | `{ requestId, previewId, expectedInstallSequence }`                                                          |
| POST `/plugins/managed/:id/activate`                                                                 | `{ requestId, digest, manifest, previousSelection, expectedInstallSequence, expectedTrustSequence, intent }` |
| POST `/plugins/managed/:id/enable`                                                                   | `{ requestId, selectedDigest, expectedInstallSequence, expectedTrustSequence }`                              |
| POST `/plugins/managed/:id/disable`, `/plugins/managed/:id/revoke`, `/plugins/managed/:id/uninstall` | `{ requestId, selectedDigest, expectedInstallSequence, expectedTrustSequence, immediate? }`                  |

The URL supplies the exact plugin ID and command kind, using the authority grammar `^[a-z0-9]+(?:-[a-z0-9]+)*$`. `intent` is `activate` or `rollback`. Previous selection and destructive-command selected digest accept an explicit null. Enable requires a digest. Sequences are nonnegative safe integers, digests are 64 lowercase hex characters, and request and preview IDs are strings of 1 to 200 characters. Omitted `immediate` normalizes to false through the existing authority canonicalizer. `manifest` uses the normalized strict schema with declared `contributes` and `permissions`, and its ID must match the route ID. Source must be a nonempty absolute local directory path without NUL. Reject unknown body fields and all query parameters for managed writes. The handler constructs the authority request from these static inputs. Whitespace and object key order are immaterial to replay, while array order remains significant.

Use the existing `managementWriteGuard` semantics and CORS configuration. Writes require JSON media type, a canonical loopback Host, and a non-cross-site fetch classification. A present Origin must meet the existing exact configured Studio origin check, or be loopback when no Studio origin is configured. Callers without Origin use the current native-client behavior. Guard the collection and descendants, including disabled routes and future writes. Install `Cache-Control: no-store` for the exact managed collection and descendants before CORS short circuits and the shared guard so it covers GET, OPTIONS, errors, and unknown descendants with existing routing. A legacy ID named `managed` continues to match its legacy ID-targeted routes.

Cap each managed POST body at 256 KiB (262,144 bytes) of actual bytes independently of Content-Length or transfer encoding. Read once from the Web Stream into bounded storage, count `Uint8Array.byteLength`, cancel overflowing input without awaiting the cancel promise, and release the reader. Decode and parse once. Return 413 for overflow and 400 for malformed JSON or schema failure. Preserve UTF-8 replacement decoding of artifact descriptors. A 64 KiB on-disk descriptor can expand to about 192 KiB in the serialized review manifest, plus the bounded request envelope. Supply the raw HTTP request signal to the manager. Clients use the existing JSON Content-Type.

Legacy manual routes keep their request and response schemas. Well-formed ID-targeted legacy trust, enable, disable, and revoke requests for sticky managed IDs return 409 `plugin-managed-review-required`, including after uninstall. The in-ticket assertion and transactional SQLite append backstop throw a typed `ManagedReviewRequiredError` extending `PluginTrustStoreError`. Direct callers keep the existing `plugin-trust-invalid` code and corresponding internal message. HTTP maps the subtype before generic manual validation. With no legacy manager, `startServer` supplies a separate authority-only assertion for well-formed ID mutations, including with local ESM disabled. Keep the ordinary disabled 404 for other IDs and reload, and preserve current manual catalog projection.

## Read-only review and exact staging

The artifact API adds one read-only operation and one optional reviewed stage field. The package exports the strict `pluginArtifactSourceIdentitySchema` for both its store and the owned wrapper. Public HTTP callers supply a path or token. Server supplies host evidence from its private review.

```ts
interface PluginArtifactSourceIdentity {
  readonly sourceDirectory: string
  readonly digest: string
  readonly manifest: PluginManifest
  readonly files: number
  readonly bytes: number
}

interface PreviewPluginArtifactOptions {
  readonly sourceDirectory: string
  readonly signal?: AbortSignal | undefined
}

interface StagePluginArtifactOptions extends PreviewPluginArtifactOptions {
  readonly expectedSource?: PluginArtifactSourceIdentity | undefined
}

// Additive member on PluginArtifactStore.
preview(options: PreviewPluginArtifactOptions): Promise<PluginArtifactSourceIdentity>
```

The input `sourceDirectory` remains the requested path. Returned identity contains the actual normalized path used for traversal. Existing standalone `stage` calls keep their prior behavior. A reviewed stage accepts the requested path and immutable expected identity. Its success proves those bytes and normalized source matched. Server records the verified normalized path already carried by that evidence.

1. Extract source normalization and overlap validation from `stage`. Both operations use the same initial real-directory check, realpath normalization, and overlap check against the managed store. Source root symlinks remain rejected. Linked ancestors may resolve to a normalized path. Preserve existing ignores, symlink and special-file rejection, depth, entry, file, descriptor, and byte limits.
2. Preview calls the existing `validatePayload` on that source. It already calls `checkPayload` to produce the bounded digest, measured counts, digested paths and descriptor bytes. It then parses the descriptor, checks host compatibility and reserved IDs, resolves the contained entry, and requires its relative path to be in the digested files. Return a detached identity without the entry path. Preview shares the store's existing `HostQueue`, error and abort helpers. It creates no directories and does not recover staging or consult publication capacity.
3. Reviewed stage re-normalizes the requested path and compares it with the expected normalized source. A changed link ancestor, replaced root symlink or disappeared source makes the review stale. Use the existing pre-copy digest and counts to reject changed bytes before creating a per-operation staging payload. Preserve the bounded checks on copied and post-copy source content. Require staged payload digest, normalized manifest, files and bytes to equal the review. Use structural equality on normalized manifest data independent of object member order. Digest already binds the descriptor and entry declaration.
4. Preserve staged final validation, same-digest published integrity checks, staging cleanup and the existing last-slot quota checks. For reviewed calls, move the bounded post-copy source traversal after the awaited reuse, quota, staged validation and destination checks. Immediately re-normalize the requested path after that traversal and compare with the expected normalized source. After the final abort check, accept reuse or call rename with no intervening awaited checks. Verify the returned staged or reused artifact's manifest, digest and counts against the review. A verified identical published object bypasses capacity, while still requiring current source review. Independent same-user edits between the final observation and rename remain outside the guarantee in ADR 0005.
5. Translate only reviewed source-side disappearance or replacement (`ENOENT`/`ENOTDIR`), link/bound violations and stable invalidity or drift to `plugin-artifact-source-changed`. Preserve genuine I/O, cancellation, capacity, recovery, cleanup, copy-destination, staged-snapshot and published-object failure types. Preview applies the ordinary artifact validation errors, including `plugin-artifact-invalid` for baseline-reserved IDs.
6. Use the same single owned artifact wrapper for `preview`, `stage` and `read`. Its generic dispatch combines caller and lease loss cancellation, checks ownership across the operation and tracks all three calls through quiescence. The package's one private queue uses a discriminated result for artifact and preview operations. Standalone callers keep their existing stage/read sequencing, and the shared host reload queue keeps its existing semantics.

### Preview tokens

One owned Server composition holds previews in memory. Each successful review returns a cryptographically random UUID and expires ten minutes from issuance. The private entry contains the original requested path, the frozen validated source identity, the install sequence at issuance, and the expiration. Use `performance.now()` for eligibility and compute the display deadline from `Date.now()` as a UTC ISO timestamp. There is no persisted preview table.

Allow 64 live entries and one pending preview inspection. Reserve the pending slot before the first await and release it in finally. Prune expired entries on preview and fresh import access and deny excess admission with 429 `plugin-preview-capacity`. After inspection, verify the installer lifetime and request signal before the synchronous authority head read. Recheck request, lifetime and lease synchronously before issuing, then sample the issuance deadline.

Return 409 `plugin-preview-stale` when the token is unknown, consumed or expired, the preview's install head is stale, or the reviewed source changed. The deadline is exclusive. Compare the preview head to live authority first, then compare the client's head. A wrong submitted head returns the authority conflict and preserves a review that still matches authority. Invalidate a review on stale live head, stable source identity failure or terminal namespace collision. Preserve it until expiry on incomplete namespace observation, transient I/O, capacity, busy or cancellation before invoking `commitSync`. Once invoked, consume the resolved token on every returned result (fresh or transactional replay) and every throw (including busy or CAS). The authority may return the same exception for rollback and ambiguous COMMIT, and a durable no-op can leave the install head unchanged. Reconcile uncertainty using the original request ID and canonical command. Early replay bypasses all token access and cleanup. Ownership loss or shutdown clears the map and closes admission. Restart creates an empty map.

## Import order, namespace and shutdown

Managed selection and import share the existing coordinator admin order. Preview is a bounded read in the owned artifact queue. It can issue a review for an ID whose availability changes later. Only the fresh import path claims the namespace.

1. Parse and canonicalize the static managed request. Inside the admin ticket, run `authority.lookupSync` before consulting cancellation of mutable preparation, the preview, the source, the lease or Generation state. Return the original operation plus a projection of current authority for an identical replay. A changed body under the same globally unique request ID returns 409 `plugin-authority-request-conflict`. Replay skips artifact work, authority adoption, reload and immediate cancellation. An already-aborted transport can abandon the response while the cached lookup has no side effects.
2. For an absent request, assert the admin lifetime and held lease. Lookup the private preview, check expiry and compare the reviewed install head with the request and authority. Check first-import namespace before staging. A matching managed candidate remains eligible for a durable no-op even when the store is at capacity, subject to the same exact reviewed source and integrity check.
3. A first import checks baseline reserved IDs, parsed manual ID claims, validated nonremoved MCP declarations, and matching manual/MCP members in current and still-retained Generations. A parsed manual declaration claims its ID even if entry, digest or compatibility checks fail, including when the submitted source is itself a visible discovered manual directory. Basenames, manual historical trust, absent descriptors, ignored links and observed malformed or oversized descriptors supply no claim. Missing manual root (`ENOENT`) is complete and empty. A disappearing child (`ENOENT`) supplies no claim. A configured non-directory root, unexplained stat/read errors and candidate truncation make the observation incomplete. Read descriptors with the actual 64 KiB bound, including concurrent growth, and check cancellation between filesystem observations. Share descriptor parsing and enumeration with normal discovery while preserving its human diagnostics. The detached inspection stops after parsing and performs no entry resolution or payload hash. Propagate completeness to managed eligibility so a later incomplete ordinary scan withdraws managed readiness.
4. Observe declarations before and after staging for a first import. Use the MCP adapter's `store.read({ knownPrefix: log.events })` and `validateMcpAuthorityLog` detached from installed state. Map every nonremoved record with the existing MCP plugin ID mapper, regardless of enabled or trust state. The detached reads have no observer, refresh, load or live-state effects. After the awaited checks, synchronously reread the install head before applying the final namespace result. If the head differs, repeat the request lookup before rejecting the stale review. Return a matching durable replay and consume the resolved token, with the same runtime behavior as a transactional replay. An absent request invalidates the stale token, and a request ID conflict propagates while the stale token is retired. A known namespace collision returns 409 and invalidates the review. An incomplete manual observation with no known collision returns namespace-unavailable and preserves the token. A corrupt persisted MCP log is a generic storage failure. Check baseline reservations plus current and retained manual/MCP membership synchronously using source ID and manual origin where applicable. Sticky IDs skip these detached collision scans and keep existing quarantine and selection behavior. Immediately before commit, check the exact open token, request, coordinator lifetime and lease, repeating the cancellation/lifetime checks after lease validation. SQLite CAS remains authoritative for races beyond the final observation.
5. Call `commitSync` with the unchanged request and exact verified artifact and provenance. It performs the second lookup before checking CAS or preparation and can return a replay. A fresh import appends its operation and, for new candidate identity, one import fact. It appends no trust or selection facts. A published artifact may remain inert after a stale collision/head, cancellation or DB failure. It counts under existing retention policy.
6. Preserve the returned durable after-state and consume the preview before another await. Adopt authority and paired sticky reservations synchronously through `adoptCommittedAuthoritySync`. Use `committed-no-rebuild` for both new candidate imports and fresh no-ops. Healthy imports preserve selection, Generation ID and admission. If adoption fails, synchronously withdraw affected unauthorized eligibility and return the saved decision with a fixed failed application issue. Store the known durable after-state in the composition cache before fallible adoption. Transactional replay consumes the resolved token and returns through `skip-rebuild` without adoption or rebuild.

Both managers use a shared synchronous commit wrapper. On a throw it reads a validated authority snapshot inside the ticket. Matching install and trust heads preserve existing admission and rethrow the exact original exception. Changed heads, unavailable authority or inability to establish intact state trigger the coordinator's synchronous managed-admission block using prior sticky IDs plus any prepared import ID, followed by composition invalidation even if the block call throws. The composition's private `invalidateAuthoritySync(cause, onSecondary?)` uses the optional collector only for this branch. It bypasses the existing zero-target explicit-marker shortcut and collects actual failures from local withdrawal, MCP denial, buffered observer publication and deferred preparation cancellation. Record each failure once in occurrence order, including thrown undefined. The caller passes a fresh `ExplicitLocalAuthorityError` whose cause is the original commit failure and ignores only that same instance when invalidation throws it as expected.

When protective readback or invalidation adds failures, `ManagedCommitFailure` carries the original commit failure as its first error and own cause, then the readback failure if present, then block and invalidation failures in order. With no secondary failures, rethrow the exact original. HTTP classifies only that original and publishes its fixed issue. Keep the cache at the last confirmed authority and apply no unconfirmed effects. A poisoned authority connection returns unavailable until reopened.

The caller signal affects fresh preparation only. Preview combines caller and installer lifetime, and the owned wrapper adds lease loss. Queued import and selection combine caller and coordinator lifetime; committed adoption and application use the Server lifetime. Reconcile a response lost after commit with the original request ID and canonical command. Shutdown, including failed startup, synchronously closes installer admission and clears previews before the coordinator begins owned drain and the wrapper quiesces. Register a one-time listener on the composition loss signal and handle an already-aborted signal at attachment. A preview continuation after loss or shutdown rechecks lifetime before any authority access. The owned consumer barrier waits for the running ticket and tracked artifact calls before releasing the lease, then closes authority. Explicit shutdown may reject a ticket before replay lookup; observed ownership loss alone leaves early replay available.

## Reviewed selection and readback

Keep ordinary scan completeness in the package's private declaration state. Explicitly project the existing public `DiscoveryResult` fields on every branch, preserving the exact public discovery and source snapshot shapes. The package controller exposes `mayReadManagedSync(id: string): boolean`, and the Server local adapter delegates its existing gate to it. This gate and managed eligibility share the same manual namespace predicate. Both require a completed, non-truncated scan with neither a parsed manual claim nor a baseline reservation for the ID. The gate suppresses routine runtime evidence reads for selected artifacts. Trust, sticky authority, MCP denials and lease checks retain their existing owners. On an ordinary root scan error, mark prior declaration evidence incomplete, withdraw managed readiness while preserving prior manual rows, and rethrow the original legacy error. Detached inspection never changes this state.

Extend the existing `applyManagedSelection(input, signal?)` facade. Both fresh and replay completions capture the current Generation and exact published members inside the same `mutateManaged` ticket. Both managers carry that observation to HTTP. Managed preparation carries typed `managedIdentity: { digest, activationSequence }` from the exact candidate through its Server adapter into the published and retained memberships. The existing opaque identity stays in private equality, recheck and exact application matching. The published member's manifest supplies the version.

Activate and rollback use both review heads, previous selection, manifest and digest. Enable requires the exact current selection and exact existing trust. Check heads and reviewed selection, and for activation compare the candidate manifest, before costly reads. Missing exact enable trust returns activation-required before attempting artifact reads. After the awaited evidence read, repeat only the open, cancellation and lease checks. SQLite repeats request lookup before CAS and policy validation at commit, allowing a matching request that became durable during preparation to replay. A selected artifact identity mismatch or corrupt or missing installed object returns artifact unavailable. Genuine I/O remains a generic storage failure. Disable, revoke and uninstall use both heads and the reviewed selection, including null where allowed, without reading command-preparation artifacts. The ordinary rebuild may read other selected eligible plugins. Fresh immediate decisions include the established cancellation behavior for current and retired managed memberships, including a fresh no-op. Replay repeats no timing effects.

Application succeeds when the requested exact activated or enabled identity is published, or when the requested destructive action has removed its managed target from the compliant Generation. Isolated preparation or load/setup failure can publish a Generation missing the target. Classify the missing exact target as preparation failure when rebuild completed with a compliant Generation and preserve available exact target attribution. A terminal refresh, failed publication, or continuing admission block is a publication failure and can leave older members published. A failed synchronous adoption or immediate bookkeeping yields the adoption failure classification. Preserve the optional private cause when caught or attributed, including a thrown undefined. Issue-only missing membership omits the cause. Private exact-target attributions retain `failureKind: preparation | publication`: preparation and assembly failures use preparation, while a host commit failure uses publication even if excluding that target later yields a compliant Generation. An unrelated recovered failure does not downgrade a requested identity that was actually published.

### Success DTOs

All successful requests use 200, including durable no-ops and fresh decisions with an application failure. Use schemas for the following allowlisted JSON data. `PluginManifest` is the declarative review schema, including its free-form author text. `Issue` is the existing safe `{ code, message }` pair.

```ts
type CandidateIdentity = {
  manifest: PluginManifest;
  digest: string;
  files: number;
  bytes: number;
};

type Issue = { code: string; message: string };

type ImportPreviewResponse = {
  previewId: string;
  expiresAt: string;
  expectedInstallSequence: number;
  candidate: CandidateIdentity;
};

type Selection = {
  digest: string;
  candidateImportSequence: number;
  activationSequence: number;
};

type PublishedMember = {
  pluginId: string;
  digest: string;
  version: string;
  activationSequence: number;
};

type Generation = { id: number; acceptingRuns: boolean; blocked?: Issue };

type ManagedCatalog = {
  heads: { installSequence: number; trustSequence: number; operationSequence: number };
  plugins: {
    pluginId: string;
    candidates: (CandidateIdentity & {
      importSequence: number;
      importedAt: string;
      provenance: 'local-directory';
    })[];
    selection: Selection | null;
    trust: { digest: string; enabled: boolean } | null;
    active: PublishedMember | null;
  }[];
  generation: Generation;
};

type OperationTarget =
  | { kind: 'import'; digest: string }
  | { kind: 'activate'; intent: 'activate' | 'rollback'; digest: string }
  | { kind: 'enable'; digest: string }
  | { kind: 'disable' | 'revoke' | 'uninstall'; digest: string | null; immediate: boolean };

type Decision = {
  requestId: string;
  operationSequence: number;
  occurredAt: string;
  pluginId: string;
  changed: boolean;
  target: OperationTarget;
  selection: Selection | null;
  trust: { digest: string; enabled: boolean } | null;
  installSequence: number;
  trustSequence: number;
  installEventSequence: number | null;
  trustEventSequence: number | null;
};

type ObservedApplication = {
  generation: Generation;
  active: PublishedMember | null;
} & ({ status: 'not-required' | 'applied' } | { status: 'failed'; issue: Issue });

type ManagedMutationResponse =
  | {
      kind: 'committed';
      decision: Decision;
      application: ObservedApplication;
      current: ManagedCatalog;
    }
  | {
      kind: 'replayed';
      decision: Decision;
      application: { status: 'unknown' };
      current: ManagedCatalog;
    };
```

`decision` projects the durable operation and its saved after-state for that target. Read the import target digest from `operation.evidence.artifact` and the other targets from the recorded command. Use the operation's timestamp, sequence, links, and durable `after`/ `pluginAfter` fields. The same decision appears on replay, when current selection, trust and actual version may differ. `not-required` covers normal import, including duplicate candidate no-ops. `application.active` identifies the target's actual managed membership captured in the fresh ticket, even if it differs from saved selection. Only current published members with local source ID and managed origin qualify. Fresh responses pair saved authority and the ticket's Generation observation. Replay pairs lookup authority and the observation captured inside that replay ticket, with application status always `unknown`.

GET pairs the composition's memory-only `cachedAuthoritySync()` and `coordinator.snapshot()` in the same synchronous stack. Cache the latest immutable successfully read composition authority or synchronously adopted committed snapshot, storing a committed snapshot before fallible adoption. Replay uses its own authoritative lookup without changing that cache. GET performs no filesystem or database read, refresh, plugin load or MCP launch. Order plugins and candidates by ascending `firstImportSequence`. Join the candidate to its imported installation event by sequence, ID and digest, project that event's timestamp as `importedAt` and alias the sequence as `importSequence`. Project trust only when the folded trust digest and normalized manifest match the exact selected candidate (join by candidate import sequence and digest). With no selection or match return `trust: null`, even if historical manual trust exists. Apply the same rule to a historic decision's `pluginAfter` using its own selection and the corresponding candidate from response authority, which retains historical candidates. The catalog includes global heads and candidate history without serializing operation history. The persistence layer continues validating its full append-only history.

Allowlist provenance kind, declarative manifest, sequences and identity fields. Keep original and normalized source paths, concrete payload and entry paths, lease metadata, database identity, request fingerprint, raw command/evidence and all private causes out of every managed response. The client retains the source path it entered for its own review. Manifest text is user-provided data. The Server adds no filesystem context to it.

### Error DTO

Use the existing strictly projected `{ error: { code, message } }` envelope. Messages are fixed per public code.

| Status | Public code                            | Fixed message                                                                                |
| ------ | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| 400    | `plugin-invalid-request`               | Invalid managed plugin request.                                                              |
| 400    | `plugin-artifact-invalid`              | The directory does not contain a valid compatible bundled plugin.                            |
| 400    | `plugin-artifact-unsupported-file`     | Plugin payloads require regular files and real directories.                                  |
| 400    | `plugin-artifact-too-large`            | The plugin exceeds the artifact size or traversal limits.                                    |
| 403    | `forbidden-origin`                     | Local management requires a trusted local origin and Host                                    |
| 404    | `plugin-installer-disabled`            | Managed plugin installation is unavailable.                                                  |
| 404    | `plugin-authority-not-found`           | The managed plugin or candidate was not found.                                               |
| 409    | `plugin-preview-stale`                 | Review the current plugin directory before importing it.                                     |
| 409    | `plugin-authority-conflict`            | Plugin authority changed. Review the current state.                                          |
| 409    | `plugin-authority-request-conflict`    | The request ID is already associated with a different decision.                              |
| 409    | `plugin-authority-activation-required` | Activate the selected plugin before enabling it.                                             |
| 409    | `plugin-managed-id-conflict`           | The plugin ID is unavailable for managed installation.                                       |
| 409    | `plugin-managed-namespace-unavailable` | The current plugin namespace could not be verified.                                          |
| 409    | `plugin-managed-review-required`       | Use the managed plugin review to change this plugin.                                         |
| 409    | `plugin-artifact-unavailable`          | The plugin artifact could not be verified.                                                   |
| 409    | `plugin-artifact-capacity`             | The artifact store is full. Existing artifacts are retained and exact matches can be reused. |
| 413    | `plugin-request-too-large`             | The managed plugin request exceeds 256 KiB.                                                  |
| 415    | `unsupported-media-type`               | Local management requires application/json                                                   |
| 429    | `plugin-preview-capacity`              | Preview capacity has been reached. Retry later.                                              |
| 503    | `plugin-authority-busy`                | Plugin authority is temporarily busy.                                                        |
| 503    | `plugin-installer-unavailable`         | The managed plugin store is currently unavailable.                                           |
| 500    | `plugin-management-failed`             | Managed plugin management failed.                                                            |

Map `plugin-authority-invalid` from static request validation to invalid request. Map `plugin-artifact-source-changed` to stale review. Map an explicit installed identity mismatch and `plugin-artifact-conflict`, `plugin-artifact-not-found`, or `plugin-artifact-corrupt` to artifact unavailable. Store ownership loss, closing, a closed authority connection and delivered precommit cancellation use installer unavailable. Preserve authority busy. Genuine I/O, invalid persisted protocol and other unknown or storage failures use the generic 500. Retain the private cause and never serialize it.

Every managed Generation block, including manual or MCP-origin failure, uses the fixed Generation pair below. Fresh committed failures use the fixed application pair for their private classification and still return 200. Responses carry neither arbitrary error code nor raw error message.

| Location or classification | Code                             | Message                                              |
| -------------------------- | -------------------------------- | ---------------------------------------------------- |
| Generation admission block | `plugin-generation-blocked`      | New runs are blocked pending a compliant Generation. |
| Application adoption       | `plugin-managed-adoption-failed` | Managed plugin authority could not be applied.       |
| Application preparation    | `plugin-load-failed`             | Managed plugin preparation failed                    |
| Application publication    | `plugin-reload-failed`           | Managed plugin Generation publication failed.        |

## Design tradeoffs

| Decision                                                                  | Tradeoff                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dedicated managed routes and DTOs                                         | A later unified catalog would need an API migration or explicit compatibility. Keeping the routes dedicated avoids changing Stage 5 and manual clients during 6.2d.                                                                   |
| Ten-minute, 64-entry, per-composition token map with one pending scan     | Slow reviews and parallel previews can require another review. Increasing limits makes the Server retain more private evidence or queue more filesystem work. Durable tokens would introduce another state lifecycle.                 |
| Bind normalized source and checked bytes                                  | Moving a source or repointing an ancestor requires review again, even with identical bytes. A content-only policy would permit provenance to change after review.                                                                     |
| Reject a first import with a retained manual or MCP member of the same ID | A removed declaration may still block import while an old Generation drains. Allowing it would require a design for simultaneously held identities across source kinds.                                                               |
| Reuse fresh detached manual and MCP observations for collision checks     | First imports cost additional scanning. Using only cached declarations can silently claim IDs created since the last refresh. Applying these scans to live sources can disrupt the healthy admission the import is meant to preserve. |
| Require typed reviewed staging before publication                         | Adds a small package contract and preserves the existing bounded traversal. A publish-then-compare workflow could consume quota with unreviewed bytes.                                                                                |
| Keep managed responses path-free                                          | A later UI that needs to redisplay the local source after restart would need an explicitly reviewed local disclosure. Current clients still receive provenance kind and can display their typed input.                                |
| Report replay application as unknown                                      | Clients also need current catalog and actual membership to understand current behavior. Durable application history requires a separate state design.                                                                                 |

## Verification order

1. Verify preview and reviewed staging on the real filesystem with the same fixtures and limits as stage/read. Include source disappearance, path retarget, pre-copy and in-copy edits, invalid descriptors and entry, quota proof for stale bytes, reuse at capacity, cancellation, and no plugin execution or preview writes.
2. Verify strict Hono requests, actual-byte limits, disabled availability, exact and descendant guard coverage, loopback and Origin, legacy sticky-ID refusal, cached GET, status mappings and path/exception sentinels on every response variant.
3. Verify the real owned Server with SQLite and filesystem evidence. Cover preview capacity, expiry, restart, stale heads, first-import manual and MCP conflicts, retained members, simultaneous same-ID management, source edits before publish, durable no-op, exact and conflicting replay, replay with expired preview and missing content, and cancel/shutdown/ownership loss on each side of the commit boundary. Keep healthy Generation and turn admission through import, and check no setup code runs until activation.
4. Verify exact selected/published identities for activation, rollback, enable and destructive operations, isolated failure and whole publication failure, old pinned paths, and immediate effects only once on fresh commands. Include a real loopback API smoke and restart. Run focused Server and plugin-host checks and root `pnpm check`, then CI. The browser and Electron workflow remains the Stage 6.3 verification gate.

References at review time include ADR 0005, installation design sections 4 to 6, authority design sections 4 to 5 and 8 to 10, ownership design section 3, and the managed source design's queued durable decisions and legacy public projection. Existing code sources include `plugin-api.ts`, `plugin-write-guard.ts`, `mcp-api.ts`, `owned-plugin-artifact-store.ts`, `artifact-store.ts`, and `artifact-copy.ts`.
