# Weave declarative right-panel SDK — final implementable specification

Date: 2026-11-22. Repository: `/Users/mi/.codex/worktrees/plugin-generation/weave`.
This document incorporates the accepted Server, Plugin and Studio audits. The separate contribution
ownership fix is a prerequisite and is not reopened or bundled here.

## 1. Product outcome and boundaries

A trusted, enabled in-process ESM plugin can contribute a small host-rendered right
panel. The panel combines static text, the latest compatible durable events owned
by that plugin, and a native form. A form prepares a declared same-owner slash
command's fully expanded text in the current composer; the user edits and presses
Send. Merely opening, refreshing or preparing a panel never runs a tool/model,
appends a Session event, changes trust or rebuilds a Generation.

The main plugin marketplace stays in left navigation. Plugins do not register
React, HTML, CSS, Markdown, URLs, links, assets, iframe/webview entry points,
renderer callbacks, RPC handlers or direct tool-execute buttons. Runtime has no
panel vocabulary. Package dependencies stay Plugin -> Server -> Studio-over-HTTP;
Studio imports no `@weave/*`, Node or Electron module. No new dependency is needed.
Schema-2 `host: declarative` artifacts remain Skills-only; a panel is not silently
accepted as a new declarative artifact type. Existing API version remains 1.0.0:
panel vocabulary is an additive optional host capability, and older strict hosts
reject its unknown vocabulary before importing the artifact.

In-process plugin trust is not a sandbox. Ordinary accessor-based input is rejected
without invoking its getter; Proxy reflection traps may execute during trusted
candidate assembly. Every HTTP operation uses detached host JSON and invokes no
plugin callback. Own-event registration/write enforcement comes from the merged
ownership prerequisite. Historical Session envelopes do not attest which artifact,
Generation or tool produced an event; compatible own-type history may be shown
after an upgrade, and UI attribution must not imply stronger provenance.

## 2. Public Plugin contract

Create `packages/plugin/src/panels.ts`. Export the types, schemas, limits and seam
through `index.ts` and `PluginSdk`. The extension point ID is `weave.studio.panels`,
with required capability `panel` and `contributes.panels` a closed list of local IDs.
The public attributedPanelSchema validates the host-produced definition-plus-owner
shape; source cloneDeclarativePanel still rejects an author-supplied pluginId.
Use the repaired atomic contribution mechanism: return false does not account a
name, throws are attributed, and only accepted registrations appear in `provides`.

```ts
interface PanelsExtensionApi {
  addPanel(definition: DeclarativePanel): void | false;
}
interface AttributedPanel extends DeclarativePanel {
  readonly pluginId: string; // inserted by host, never accepted from author JSON
}
```

The author calls `env.contribute(sdk.panelsExtensionPoint, api => api.addPanel(...))`.
A local ID is `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, length 1..64. Panel, source, block,
field and column IDs use this rule. Panel IDs need only be unique within their
owner, including registrations from separate callbacks. The durable layout ID is
`plugin:<pluginId>/<panelLocalId>`; panel-contributing plugin IDs are 1..64 chars
under the existing plugin ID pattern. This topic does not globally tighten legacy
manifest names. A panel-contributing owner's name is 1..120 chars and its x.y.z
version string is 1..64 chars; reject out-of-range metadata, never truncate IDs.

All object shapes below are strict: unknown properties reject. All arrays are
readonly; optional means absent, not explicit undefined. Text is plain text.

```ts
type Scalar = string | number | boolean | null;
type DataPath = readonly string[];
interface Binding { readonly source: string; readonly path: DataPath }
type Value =
  | { readonly literal: Scalar }
  | { readonly binding: Binding };
interface PanelSource {
  readonly id: string;
  readonly eventType: string;
  readonly payloadVersion: number;
}
type FormField =
  | { readonly id: string; readonly type: 'text'; readonly label: string;
      readonly required: boolean; readonly default?: string }
  | { readonly id: string; readonly type: 'boolean'; readonly label: string;
      readonly default?: boolean }
  | { readonly id: string; readonly type: 'select'; readonly label: string;
      readonly required: boolean;
      readonly options: readonly { readonly value: string; readonly label: string }[];
      readonly default?: string };
type PanelBlock =
  | { readonly id: string; readonly type: 'heading'; readonly text: string }
  | { readonly id: string; readonly type: 'text'; readonly value: Value }
  | { readonly id: string; readonly type: 'status'; readonly label: string; readonly value: Value }
  | { readonly id: string; readonly type: 'metric'; readonly label: string;
      readonly value: Value; readonly unit?: string }
  | { readonly id: string; readonly type: 'key-value';
      readonly rows: readonly { readonly label: string; readonly value: Value }[] }
  | { readonly id: string; readonly type: 'table'; readonly rows: Binding;
      readonly columns: readonly { readonly id: string; readonly title: string;
        readonly path: DataPath }[] }
  | { readonly id: string; readonly type: 'form'; readonly fields: readonly FormField[];
      readonly submit: { readonly type: 'prepare-command'; readonly command: string;
        readonly label: string } };
interface DeclarativePanel {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly icon: 'table' | 'chart' | 'checklist' | 'info';
  readonly placement: 'right';
  readonly sources: readonly PanelSource[];
  readonly blocks: readonly PanelBlock[];
}
```

`chart` is only a host icon, not a chart block. Labels/title/heading/unit contain
nonblank text without trimming stored content. `text.literal` can be empty.
Numbers are finite. Source/block IDs are unique per definition; field IDs are
unique across the entire panel (not only a form); column IDs are unique per table;
select option values are unique per field. Select defaults must equal an option.
Every Binding.source must exist. Every source eventType must be both an actually
accepted event of this same candidate owner and start `<ownerId>/`; declaration
alone is insufficient. Every form command must be an actually accepted command of
the same candidate owner. Copy its name and prompt into the host panel snapshot.

## 3. Exact limits and clone rules

A KiB is 1024 bytes. Character limits use JavaScript string length (UTF-16 code
units); byte limits use actual UTF-8 of the final JSON including escaping and all
envelope metadata. Never use Content-Length or character count as a byte bound.

| Item | Limit |
| --- | --- |
| Panels per plugin / total active candidate panels | 8 / 128 |
| Detached serialized definition / complete catalog response | 64 KiB / 1 MiB |
| Sources / blocks per panel | 8 / 32 (blocks minimum 1) |
| Definition maximum depth / traversal nodes | 16 / 4096 |
| Panel title / description | 80 / 300 chars |
| General label, heading text, table title, option label | 120 chars |
| Metric unit | 32 chars |
| Scalar literal or returned non-table display string | 4096 chars |
| Path segments / length per segment | 1..8 / 1..64 chars |
| key-value rows / table columns | 1..32 / 1..10 |
| Returned table rows / string cell | 100 / 1024 chars |
| Total form fields per panel / fields per form | 32 / 1..32 |
| Select options / option value | 1..32 / 1..128 chars |
| Form text default and submitted text value | 2048 chars |
| Complete prepare request / final prompt | 16 KiB / 32 KiB |
| Complete prepared response / complete data response | 256 KiB / 64 KiB |
| Session ID path value | 1..128 chars; existing nonempty string ID, no invented UUID constraint |
| serverEpoch / publicationId / panelRef | 32 base64url chars from 24 random bytes |
| generation / authorityEpoch / lastSequence | positive safe integer / positive safe integer / nonnegative safe integer |
| Error envelope | 1024 UTF-8 bytes maximum |

Prepared responses allow 256 KiB because valid 32 KiB prompt text may require six
JSON bytes per control character; the independent complete-envelope limit still
applies. Form request size can reject combinations of individually valid fields.
Source payloadVersion is a positive safe integer. Event type and command names
are at most 129 / 64 chars and obey their existing patterns. `occurredAt` uses the
existing Session timestamp format and is capped at 64 chars.

The host clone accepts unknown input before Zod. Root depth is 0; each object,
array, scalar and property-key occurrence consumes one traversal node. Every
child edge increments depth. Reject repeated object identity (including aliases),
cycles, functions, undefined, symbols, bigint, nonfinite numbers, custom object
prototypes, ordinary getters/setters, nonenumerable record properties, sparse
arrays and extra array properties. Arrays may have only own dense index data
properties plus their ordinary length property. Records may have Object.prototype
or null prototype only, with string enumerable own data properties. All keys are
bounded to 128 chars and all strings to 4096 before expensive escaping; a strict
schema can impose smaller field limits. Copy descriptor.value into fresh host
objects with safe property creation. No toJSON, property getter, iterator or
user callback is consulted. Reflection on Proxy candidates can run traps; catch
and attribute failures, and make no zero-code-execution claim at assembly.

After a bounded detached clone: strict host Zod validation, cross-reference checks,
actual serialized-byte check, deterministic JSON hash, then recursive freeze.
Plugin-owned values, schema objects, registries, functions and Generation resources
are not retained by the HTTP panel service. Candidate catalog admission reserves the maximum safe integer widths for the
future generation/authorityEpoch envelope, together with exact fixed token widths.
This can conservatively reject a catalog within roughly 30 bytes of the actual
current envelope limit, but ensures a later epoch increment cannot overflow an
already accepted catalog. Final HTTP serialization still checks actual complete
UTF-8 bytes against 1 MiB. Global catalog count/byte overflow is
an ownerless terminal candidate failure; retain the current published Generation.
An invalid individual panel is owner-attributed and uses the existing source
isolation/retry policy. Host-baseline failures cannot be silently source-isolated.

Data paths are literal own-property record segments. Reject `__proto__`,
`prototype`, `constructor`, empty strings, `.` and `..`, and segments matching
`/^\d+$/`. No dotted-path splitting, JSONPath, inherited-property lookup or array
indexing. Only the explicit table rows Binding can yield an array; column paths
then traverse each row record under the same rule.

## 4. Candidate snapshots and current UI authority

Collect panels in `agent-kernel.ts` after accepted event and command collection.
Return immutable attributed definitions and private command copies as
`AssembledAgentKernel.panels: readonly BoundPanelDefinition[]`. Server owns the
following private shape, never sent directly to Studio:

```ts
interface BoundPanelDefinition {
  readonly panelId: string;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly definitionHash: string; // SHA-256 lowercase hex of detached definition
  readonly definition: DeclarativePanel;
  readonly commands: Readonly<Record<string, { readonly name: string; readonly prompt: string }>>;
}
type HostUiMemberIdentity =
  | { readonly kind: 'host'; readonly pluginId: string; readonly baselineId: string }
  | { readonly kind: 'source'; readonly pluginId: string; readonly sourceId: string;
      readonly identity: string; readonly origin?: ExtensionIdentity['origin'];
      readonly instanceId?: string;
      readonly managedIdentity?: ManagedPreparedIdentity };
interface CurrentUiObservation {
  readonly generationId: number;
  readonly authorityEpoch: number;
  readonly available: boolean;
  readonly members: readonly HostUiMemberIdentity[];
  readonly signal: AbortSignal;
}
interface CurrentUiAuthority {
  captureCurrentUiSync(): CurrentUiObservation;
  assertCurrentUiSync(capture: CurrentUiObservation): void;
  subscribeUiInvalidationSync(listener: () => void): () => void;
}
```

`ManagedPreparedIdentity` is the existing Server/private plugin-host identity;
it is never a new public Plugin type. Source identity is copied from the exact
prepared member, including origin and managed activation identity. Source-member
matching uses every existing identity dimension: pluginId + identity + origin,
then the bound source/instance/managed identity; do not omit origin. Host baseline identity is
explicit composition-owned metadata for reserved registered/configured plugins:
random stable baselineId per Server composition + pluginId. It is constructed
before any external source candidate and cannot be supplied by author JSON.
ServerHost initializes an explicit immutable baseline before first publication via
`initializeHostUiMembersSync(ids: readonly string[]): void` and exposes it through
`hostUiMembersSync(): readonly HostUiMemberIdentity[]`; identical initialization
may be retried, but IDs cannot expand or be set after publication.
its frozen allowlist contains only initially registered/configured plugin IDs,
never external candidates. Missing source/baseline membership never means trusted. Test/embedded hosts must
supply an explicit host-only authority adapter with an allowlisted baseline; no
automatic trust-all fallback exists.

Coordinator tracks a frozen copy of each source's latest observed snapshot and
its current member-generation binding. capture/assert read only cached fields:
no source.snapshot/refresh/prepare/recheck/isReady, lease probe, plugin service,
registry, factory or callback. `hasActive` is unsuitable because it includes
retained generations. `assertManagedStartSync` is unsuitable because it probes
and can mutate authority. UI authorization concerns the actually current
Generation and already observed authority only; it does not discover unobserved
disk changes or promise stronger lease monitoring than the source system.

On every effective source stamp change conservatively increment authorityEpoch,
replace UI signal and notify the inert panel service. Also invalidate on managed
ownership loss/adoption failure, global block, successful publication, close
admission and owned drain/dispose. Update cached state, epoch and signal ownership
before calling abort or subscriber callbacks so reentry sees the new state. Refs
rotate on every epoch, including changes that leave the same member eligible.
Pending operations fail; a fresh eligible capture can use the new catalog/ref.
Authority withdrawal uses this rule even when Agent policy says immediate:false.
Ordinary failed candidates preserve current valid refs. A failure after authority
withdrawal does not restore old availability.

Add to ServerHost a pure successful-publication observation seam:

```ts
interface HostPublicationSnapshot {
  readonly generationId: number;
  readonly publicationId: string;
  readonly panels: readonly BoundPanelDefinition[];
}
currentPublicationSync(): HostPublicationSnapshot | undefined;
subscribePublicationSync(listener: (snapshot: HostPublicationSnapshot) => void): () => void;
```

Host commit validates its inert candidate catalog and allocates publicationId
before mutating the controller. After successful controller commit, compare the
candidate ID with real controller.current().id immediately before writing
currentPublication and before every listener invocation. Only the still-current
candidate may install its snapshot or notify remaining listeners. Retirement
abort/dispose or an earlier listener may synchronously publish a newer Generation;
if B is superseded by C, outer B skips every subsequent current-snapshot/ref-map
write and notification and must never overwrite C. This is a successfully committed
but now superseded B, not a failed candidate: preserve its retirement/resource
ownership and return its normal commit result rather than disposing B as failed.
Listeners are host-owned, never plugin callbacks. Catch/isolate listener
exceptions so a successful controller publication is never reported as failed;
a failing listener cannot undo the publication or trigger failed-candidate disposal. The panel service also compares real
`host.controller()?.current().id` with captured and published IDs at every
capture/final check; a reentrant callback during controller retirement cannot use
old refs even before host notification completes.

The coordinator binds its new member snapshot immediately after successful host
commit only if real current ID still equals that candidate ID, rechecking before
each current-members/member-generation/blocked/error/UI-snapshot write or notify.
If reentry superseded it, skip these current-state writes and preserve the newer
binding. Historical retained-resource bookkeeping may still record B as retired,
but cannot authorize UI or overwrite C's current members. Then invalidate/republish
UI observation only for the still-current candidate. Between actual publication and member binding, capture is unavailable
because member-generation ID does not match. Direct embedded publications also
fail closed until their explicit authority adapter binds that publication. This
covers commitServerGeneration/replaceServerGeneration, rather than assuming all
publications pass one coordinator branch.

The panel service owns only the current inert snapshot/ref map and signal. A
catalog capture uses `{serverEpoch,generation,authorityEpoch,panelRef}`. Old ref
maps are discarded, never searched through retained generations. Neither reads
nor tabs acquire a Generation pin. Last synchronous validation followed by
serialization/return has no further await and no callback. Store wait completions
must validate caller signal, UI signal, real current ID, epoch and exact ref map
entry identity; no retry by stable ID or same-name plugin is allowed.

## 5. Durable-prefix event reads and projection

Inject the raw host-owned `SessionEventStore` directly at Server composition.
Never resolve the plugin-facing Session service and never call event parse/project,
plugin Zod refinements or schema getters during a panel read. The owner registry
and all binding checks were consumed at candidate assembly.

A read produces one observed append-only Session prefix: validate sessionId,
every envelope has event.sessionId exactly equal to the requested sessionId and
sequence exactly previousCursor+1, with valid envelope shape/timestamps and
initial `session.created` at sequence 1. Cold empty read is 404 session-not-found;
a nonempty cold history missing created, any sequence gap/duplicate or cross-Session
envelope is 503 panel-session-invalid. A failed fold never mutates the cache. Fold only lifecycle fields needed for
readability and that panel's exact source event types; unrelated payloads and
messages/transcript are not retained. Use existing Session lifecycle rules for
created/archived/restored/deleted ordering, via a small host lifecycle fold with
shared regression fixtures. Only a cold empty prefix is not-found; malformed
nonempty prefixes fail503 as above. A deletion in this observed prefix rejects
both operations. Archive in the prefix allows data
GET and forbids prepare; a later restore allows prepare. Do not call full Session
DTO/transcript projection just to establish these flags.

**Linearization contract:** data and prepare use the lifecycle and lastSequence of
the durable prefix returned by their store read. A concurrent delete/archive
appended after that prefix may settle before the HTTP response and is not promised
to invalidate it. No strong atomic deletion fence or Session execution-queue lock
is added. Subsequent reads that observe the tombstone reject. The final synchronous
UI authority check is stronger for already observed plugin withdrawal but is not
an atomic Session lifecycle fence. Tests and user copy must preserve this distinction.

For each source choose the latest event with exact eventType. Require its payload
to be a plain record with own positive integer `schemaVersion` equal to
source.payloadVersion. A latest future/wrong version is incompatible; never fall
back to an older compatible event. A cold prefix with no matching event is empty.
On a tail read, no newer matching event retains that source's prior bounded latest
projection/provenance/marker; an empty tail retains the complete prior state and
cursor, while unrelated events advance the cursor without erasing source data. Persisted malformed
JSON values produce invalid-data; a valid payload with missing/wrong selected field
is invalid-data. Access only referenced fields with descriptor/own-record host
checks; do not recursively clone an entire payload merely to select a few fields.
The store yields neutral parsed data; no author callback may be invoked.

Status/text/key-value accept Scalar; metric accepts a finite number or null only.
Table requires an ordinary dense array of ordinary record rows; project first 100
rows and record total/truncated counts. Check only selected column values of those
rows. A selected value of wrong kind is invalid-data; display strings exceeding
limits produce data-too-large, never silent text truncation. Extra unselected keys
and rows beyond the first 100 are not returned. A source with any selected size
failure is data-too-large; any selected type failure is invalid-data. Priority is
`data-too-large > invalid-data > incompatible > ready > empty`. A zero-source
static panel is ready. When a source is not ready, its cells have the same marker;
static literal cells remain available.

## 6. Exact HTTP JSON contract

Routes (path segments encoded normally):

```text
GET  /plugins/panels
GET  /sessions/:sessionId/plugin-panels/:panelRef
POST /sessions/:sessionId/plugin-panels/:panelRef/prepare-command
```

Every successful catalog/data/prepared JSON DTO is strict host JSON and includes
schemaVersion:1. Error JSON is exactly the strict PanelErrorBody shown below with
no schemaVersion; HEAD/OPTIONS have no body. All routes (success, errors,
preflight and guard rejects) send Cache-Control:no-store. Definitions use the exact
§2 schema. All DTO fields are required except noted optional fields.

```ts
type DataState = 'empty' | 'ready' | 'incompatible' | 'invalid-data' | 'data-too-large';
interface AuthorityTuple {
  readonly serverEpoch: string;
  readonly generation: number;
  readonly authorityEpoch: number;
}
interface PanelCatalog extends AuthorityTuple {
  readonly schemaVersion: 1;
  readonly acceptingRuns: boolean;
  readonly panels: readonly {
    readonly panelId: string;
    readonly panelRef: string;
    readonly pluginId: string;
    readonly pluginName: string;
    readonly pluginVersion: string;
    readonly state: 'available' | 'unavailable';
    readonly definition: DeclarativePanel;
  }[];
}
type Cell =
  | { readonly state: 'ready'; readonly value: Scalar }
  | { readonly state: 'empty' | 'incompatible' | 'invalid-data' | 'data-too-large' };
type ProjectedBlock =
  | { readonly id: string; readonly type: 'text' | 'status' | 'metric'; readonly cell: Cell }
  | { readonly id: string; readonly type: 'key-value'; readonly cells: readonly Cell[] }
  | { readonly id: string; readonly type: 'table'; readonly state: DataState;
      readonly rows: readonly (readonly Cell[])[];
      readonly totalRows: number; readonly truncatedRows: number };
interface SourceResult {
  readonly id: string;
  readonly eventType: string;
  readonly payloadVersion: number; // expected version from definition
  readonly state: DataState;
  readonly latest: null | {
    readonly sequence: number;
    readonly occurredAt: string;
    readonly payloadVersion: number | null; // observed version; null when missing/invalid
  };
}
interface PanelData extends AuthorityTuple {
  readonly schemaVersion: 1;
  readonly panelRef: string;
  readonly panelId: string;
  readonly sessionId: string;
  readonly lastSequence: number;
  readonly state: DataState;
  readonly sources: readonly SourceResult[];
  readonly blocks: readonly ProjectedBlock[];
}
interface PrepareRequest {
  readonly formId: string;
  readonly values: Readonly<Record<string, string | boolean>>;
}
interface PreparedCommand extends AuthorityTuple {
  readonly schemaVersion: 1;
  readonly panelRef: string;
  readonly panelId: string;
  readonly sessionId: string;
  readonly lastSequence: number;
  readonly formId: string;
  readonly command: string;
  readonly text: string;
  readonly requiresUserSend: true;
}
type PanelErrorCode =
  | 'panel-invalid-input' | 'session-invalid-input' | 'panel-request-forbidden'
  | 'panel-not-found' | 'session-not-found' | 'panel-stale' | 'session-archived'
  | 'session-deleted' | 'panel-request-too-large' | 'panel-prompt-too-large'
  | 'panel-data-too-large' | 'panel-unavailable' | 'panel-busy'
  | 'panel-store-unavailable' | 'panel-session-invalid';
interface PanelErrorBody {
  readonly error: { readonly code: PanelErrorCode; readonly message: string };
}
```

Data `blocks` contains only text/status/metric/key-value/table blocks in definition
order; heading/form are rendered from the definition and have no data object.
Lengths/IDs/types must match the definition exactly at Studio consumption. All
numbers are finite safe integers where appropriate. For non-ready table state,
rows=[], totalRows=0 and truncatedRows=0; ready totalRows is safe array length and
truncatedRows=max(0,totalRows-100). A source with static-only no consumers is still
version checked but its payload is not otherwise projected. If the complete data
JSON exceeds 64 KiB, return a valid compact data-too-large DTO with the same IDs,
source metadata, every dynamic cell marked data-too-large and table rows empty.
Metadata is already bounded; if even the compact envelope cannot fit, fail with
`panel-data-too-large` 413. Cache the compact markers and advance the cursor so
one oversized event is not reread forever. No raw payload is placed in errors.

Preparation requires a current available ref and a readable/runnable prefix, but
not a ready data source. Forms take only declared literal defaults/local edits.
Reject unknown fields, wrong value types,
missing required text/select, blank required text, and select values outside the
options. Optional missing text/select become `''`; missing boolean becomes false;
Studio sends default values explicitly. Serialize a new object with fields in
definition order using JSON.stringify (canonical ordered arguments); never merge
user objects into prototypes or interpret shell/template syntax. Expand the frozen
command prompt with literal `split('$ARGUMENTS').join(argumentsJson)`; absent
marker means `prompt + '\n\n' + argumentsJson`. Check final UTF-8 prompt and complete
response caps. Return text only, with requiresUserSend:true. Do not resolve the
command again by name or call existing Agent/Tool APIs.

Read/prepare guard uses the existing loopback Host and configured-origin policy,
but explicitly covers GET/HEAD as well as POST. Host must be current permitted
loopback host; reject Sec-Fetch-Site:cross-site; a present Origin must exactly equal
configured studioOrigin, otherwise meet existing loopback-origin policy. No-Origin
CLI/local clients are allowed under the same Host rule. GET/HEAD need no JSON
Content-Type; POST requires application/json, with a non-JSON media type returning
400 panel-invalid-input (not an undeclared 415). OPTIONS is bounded preflight under
the configured CORS policy and returns no catalog/data. This is local-origin
request hardening, not authenticated isolation from other local processes.

POST reads actual stream bytes with a 16 KiB cap before fatal UTF-8/JSON parse.
Use JSON.parse followed by a strict shallow known request schema; JSON member
duplicates use normal last-member semantics and cannot bypass that schema.
Studio similarly reads bounded actual bytes before fatal UTF-8/strict schema parse:
1 MiB catalog, 64 KiB data, 256 KiB prepared, 1024 error. Never call unbounded
response.json().

| Status | Fixed error codes |
| --- | --- |
| 400 | panel-invalid-input, session-invalid-input |
| 403 | panel-request-forbidden |
| 404 | panel-not-found, session-not-found |
| 409 | panel-stale, session-archived |
| 410 | session-deleted |
| 413 | panel-request-too-large, panel-prompt-too-large, panel-data-too-large |
| 503 | panel-unavailable, panel-busy, panel-store-unavailable, panel-session-invalid |

Error code is the closed union above; message is host-owned text limited to300
chars and the complete1024-byte budget, never exception.message.
Unknown syntactically valid panelRef is panel-stale (409), without keeping a retired
ref list. panel-not-found is used for a nonexistent form/definition in a current
ref, not same-name fallback. Malformed refs are 400. Native paths, plugin stack
traces, payloads and submitted field values are not exposed. Caller-aborted reads
may end transport without a fabricated error body.

## 7. Bounded projection cache and shutdown

Implement a panel-only cache, not the transcript projection cache. Key each entry
by current `{serverEpoch,generation,authorityEpoch,panelRef,sessionId}`. Retain only
lastSequence, lifecycle flags, bounded projected source/cell data and size markers.
Never retain payload/transcript, schema callbacks, services, kernel or Generation.
A cache entry has an opaque host entryIdentity and a monotonic entryVersion. Each
read job captures an immutable bounded base projection, its exact baseCursor,
entryIdentity and entryVersion before issuing store.read(afterSequence:baseCursor).
The exact job key is the full projection tuple above plus baseCursor,
entryIdentity and entryVersion; use collision-free structured encoding. Never
share jobs by Session alone, across different panelRefs, cursors or base snapshots.
At most one active job exists for the projection tuple and hence its full key.
Look up that tuple's active job first: a joining GET/prepare adopts its captured
immutable base/cursor, never substitutes a current cache entry or starts a second
job for another base. If a caller cannot share that captured base, reject busy.
GET and prepare may join only that exact captured job.
For a miss allocate one host-owned empty base identity/cursor0 before admission;
concurrent exact misses share it without inserting an unbudgeted cache entry.

A tail fold starts from that immutable base, preserves prior source values when
no matching event arrives, and computes a new detached state. Commit the complete
successful state atomically only while its authority tuple is current and the
entry identity/version still matches the captured base. No partial cursor/source
writes occur on parse/store/projection failure. If LRU eviction removed the base,
the completed job may return its captured valid prefix to its own consumers but
must not resurrect or overwrite a newer/missing entry; the next request cold-reads.
If a competing completion or invalidation advanced/replaced the entry, skip the
old commit. Insert a successful cold-miss result only if that exact miss identity
is still current in the job map, no newer entry exists and every LRU/byte cap can
be met by ordinary deterministic eviction. Epoch clearing invalidates both commit
rights and usable responses, even if the store ignores abort.

Hard retained limits: 128 Session buckets, 16 projection entries per Session, 256
projection entries globally, 512 KiB serialized projected bytes per Session, 8 MiB
globally. Each projection entry is at most 64 KiB serialized host projection state;
oversized state becomes compact too-large markers, with its cursor advanced.
Use deterministic LRU eviction: entry access updates its Session/entry recency;
evict oldest entries until all caps fit, then empty Session buckets. A new ref/epoch
or publication clears obsolete cache entries synchronously. Definition/catalog
storage has its separate 1 MiB budget and is not charged as duplicated per entry.

Admission limits: at most 32 admitted panel data/prepare HTTP operations globally;
at most 8 underlying store reads in flight and 8 read-job map keys; at most 4
consumers per exact read-job key including the first. Same-key GET/prepare can
share one prefix read/projection job, then each performs its own captured authority
and runnable/readable checks. A ninth independent store job or fifth same-key
consumer fails panel-busy immediately; there is no unbounded waiting queue. Finish
or abort decrements consumer admission; a store job retains its slot until its
underlying Promise settles, even when every consumer detaches. Job-map entries
are removed in finally. Catalog is synchronous and does not consume a store slot. Up to8 in-flight jobs
may separately hold their bounded64 KiB immutable base snapshots (maximum512 KiB
transient projection bases beyond the8 MiB retained cache); jobs never hold raw
payload history after projection settlement. These are explicit projected-data
bounds, not a whole-process heap bound.
Count cache/memory and concurrency with actual values in tests, not implied LRU
behavior. Avoid a fresh job when all consumers are already aborted.

The current Session store `read(afterSequence)` can materialize an unbounded cold
history or tail and has no AbortSignal/max-events API. These limits bound retained
projection/output and admitted work, not raw cold-read memory, store CPU or forced
cancellation. Do not claim otherwise. No Session-store API redesign is hidden in
this topic. Store close must await started reads to settle.

`PanelService.closeSync()` closes admission, rotates epoch/refs, aborts caller/UI
work and clears retained cache. `drain():Promise<void>` waits for all started store
jobs and then resolves; it starts no new read. Shutdown calls closeSync before
coordinator/host drain, and drain before closing the Session store. Repeated close
and drain are idempotent. No UI pin delays plugin Generation retirement.

## 8. Studio restoration, rendering and draft ownership

Create a separately validated bounded HTTP mirror in `features/panel`; no importing
Plugin/Server types. Store layouts at `weave.studio.panelTabs.v3`:

```ts
type SavedPanelTab =
  | { readonly id: string; readonly kind: 'builtin'; readonly builtinKind: BuiltinPanelKind }
  | { readonly id: string; readonly kind: 'plugin'; readonly panelId: string };
interface SavedPanelLayout {
  readonly schemaVersion: 3;
  readonly tabs: readonly SavedPanelTab[];
  readonly pinned: readonly string[];
  readonly active: string;
}
```

Valid v3 first; absent/structurally invalid falls back to v2. Normalize entries
individually. Preserve all valid preview/terminal instance IDs, order, pins and
active ID; singleton builtin IDs remain kind-based. Drop obsolete v2 plugin/future
kinds individually. Keep old v2 key, write only v3. Plugin singleton tab id equals
its stable panelId, cap total128 tabs/ID256 chars, dedupe and enforce pin/active
subsets. Storage never includes ref, endpoint, generation, code or panel data.
Valid plugin identities survive loading/error/absent catalogs. Render unresolved
before fresh catalog, unavailable after authoritative absence/block/stale ref, and
available only for exact current descriptor. Activation never auto-opens a tab.
Plugin tabs default unpinned; add menu attributes owner and uses the closed icon
map. Builtin callbacks/context remain private. Preserve terminal/preview keepAlive,
keys, tabs, pin/close/reorder/resizer and route-hidden inert behavior.

Catalog store is App-owned. Plugin-management changes are invalidation hints, not
authority; invalidate panel requests and refetch dedicated catalog. Data polling:
only one active visible plugin panel with Session; immediate read then every 2s
after completion (no overlapping timer), plus explicit host refresh. Stop/abort on
inactive tab, collapse, route hidden, owner/ref/epoch/root/session change and unmount.
No automatic retry of prepare. Clear old ready data synchronously by exact render
key; do not rely on useEffect after an old frame has painted.

Native host renderer escapes every string, has accessible labels/errors/table
headings, visibly reports table truncation and empty/incompatible/invalid/too-large
states. No raw HTML/Markdown, URLs, styles, remote resources or author props are
rendered. Form defaults are literal definition values; never bind event payloads
into editable inputs. Key form/renderer by Session/project/root/ownerEpoch plus
serverEpoch/generation/authorityEpoch/panelRef. Hidden panels have no usable data or
prepare action under a new ownership tuple.

Extract the App-owned draft seam without changing Agent protocol:

```ts
interface ComposerOwner {
  readonly sessionId: string;
  readonly projectId: string;
  readonly rootKey: string;
  readonly epoch: number;
}
interface PreparedInsertion {
  readonly owner: ComposerOwner;
  readonly panelRef: string;
  readonly serverEpoch: string;
  readonly generation: number;
  readonly authorityEpoch: number;
  readonly formId: string;
  readonly requestEpoch: number;
  readonly text: string;
}
type InsertPreparedResult = 'inserted' | 'stale';
insertPrepared(insertion: PreparedInsertion): InsertPreparedResult;
```

Owner epoch increments on every ownership transition, including A->B->A and root
change with same Session ID. At click capture owner + exact authority tuple +
requestEpoch; before/after every await and before insertion compare all fields and
visibility against current refs. requestEpoch comes from one App-global monotonic
interaction token (not a remount-local counter). Allocate a fresh token at every
prepare start and synchronously invalidate it on hide/collapse/tab change/unmount,
then on show/remount allocate a fresh interaction identity. A later request from
another form invalidates the earlier pending insertion. Thus hide->show with the
same Session/ref/authority still rejects old responses and two forms/remounts
cannot collide even when transports ignore AbortSignal. An ignored transport abort is not authorization.
Keep only the current pending token and its consumed boolean, not an unbounded
set of all completed tokens. Insert once per requestEpoch by a functional update against that same owner's
latest text; join with `\n\n` only if both parts are nonempty. Preserve image objects,
Skill selection objects, provider/model/permission and concurrent user edits. No
navigation or Send occurs. Focus textarea and put caret after appended text.

Use Session-keyed draft text/images/literalSend with active-owner epoch and
monotonically increasing revision. Enforce at most 128 inactive draft buckets by LRU; never evict
active bucket. Pending image decoding captures owner epoch and is discarded after
ownership transition. Existing Skill hook remains separate and its refs unchanged.
Normal send keeps existing trimmed-text submission behavior and clears text/images
and resets literalSend only for the captured
owner's unchanged revision. If user edits while an await is pending, preserve all
three. Mouse and keyboard command-picker selection both reset literalSend.

Before a real Session exists, use a host-local provisional draft key scoped to
project/root, never sent to the Server as a Session ID; panels cannot prepare
without a real Session. ensureSessionForMessage captures provisional owner/epoch
and submission revision before its await. If the same provisional owner is still
active with the unchanged captured submission revision when creation resolves,
atomically migrate that captured bucket to the created Session, activate it and
advance owner epoch; return a private migration ticket mapping the captured
submission revision to that exact destination owner. A later
send-clear may use that ticket only if the destination bucket still has the same
revision; newer text/images/mode remain. If ownership or draft revision changed, do not activate the new Session,
switch back, migrate, or clear any draft bucket; keep the provisional/newly active
draft and allow only the already captured submission to target its newly created
Session. Session creation may update the project/session list without selecting it.
A pending image decode uses the owner epoch and is discarded after migration.
No Session creation completion may select/clear a newly active unrelated draft. Existing retry snapshots retain
full submitted content and need no new panel token.

Successful preparation sets the draft to literal-send mode. Ordinary editing keeps
that mode; explicit mouse or keyboard command-picker selection resets it. Submission in literal mode
sends the current text directly rather than commandPicker.expand. Thus prepared
text beginning `/old-command` cannot be rebound to a later same-name plugin. Typed
slash commands without prepared insertion preserve existing expansion. Revoke
after insertion does not erase visible plain user-editable text; Send uses normal
current Agent admission and Tool Pipeline.

## 9. Quality-report example and acceptance

Add an actual schema-1 ESM example `examples/plugins/quality-report/` with
`weave-plugin.json`, `index.mjs`, README and test fixture/sample data. It declares
tool/event/command/panel, owns `quality-report/report`, has panel local ID `report`,
and requests only services it uses. Its governed `quality_report` tool accepts a
small validated report (score 0..100, summary <=2000 chars, <=100 checks, each
name<=120/status in pass|warn|fail), appends one own schemaVersion:1 event through
its owner-scoped Session writer, and returns a short result. This is a report
submission example, not a claim to execute a real linter or enforce CI quality.
The panel displays score/status, summary and a checks table; a form selects target
and include-tests, preparing its same-owner `quality-report` command. The command
asks the Agent to gather evidence via ordinary available tools and record a
report; no form invokes that tool directly. Avoid tool APIs absent from the actual
SDK; verify the final example against the generated current SDK/build.

Acceptance flow: inert local import -> explicit review/trust/activate -> plugin
listed on left marketplace -> add report tab on right -> normal Agent/Pipeline tool
writes own event -> panel data updates -> form prepares editable draft -> explicit
Send only -> restart restores stable tab and durable data -> plugin reload rotates
ref while old Turn continues -> revoke makes panel unavailable and aborts pending
read/prepare. New Generation can read old compatible event; latest future version
shows incompatible. Archived data read works but preparation fails. Concurrent
Session deletion tests assert prefix semantics, not an invented atomic fence.

Mandatory independent tests include accessor/alias/Proxy-trap boundaries, rejected
registration accounting, cross-owner events/commands, global catalog limits,
authority withdrawal on same Generation and ownership/adoption loss, direct host
publication, reentrant abort, failed candidate preservation/blocking, no callbacks
on reads, cursor advancement on oversize, exact byte limits, all concurrency/LRU
caps, close/drain, no side effects, Studio strict mirror against actual Server DTO,
v2 builtin IDs and plugin placeholders, XSS plain text, A->B->A/root/hide->show/ref races,
two-form/remount token collision, provisional-to-real draft migration, literal-mode
clear/reset behavior, reentrant A->B->C publication, distinct-panel/cursor job keys,
empty/unrelated tails, sequence gaps/cross-Session rejection and evicted-job commits,
latest user edits/images/Skill preservation and literal slash send.

## 10. Verified external principles

Use only already verified sources recorded in
`docs/learning/2026-11-22-official-plugin-references.md` and the proposal:
DeepSeek Harness marketplace commit d98f5d68519215da48f3002da2cb9c9d2068d81d and
historical HMR 2e39e70496aa02986ca6a820c5d497e816b69d7e support separating discovery,
installation, activation and registration lifetime/serialized mutation. Codex
cf3ff1530d821ec2d26452da4971d8e3e7d18d25 and plugin reference
981b02c0c44058b595f3b4180002c3ae3c806d40 support binding visible/executed authority
exactly. Kiro MCP security official snapshot retrieved 2026-11-22, SHA-256
56cd89d9a15021d40e942080d3e82a4ad4c3e5944e0ef97a854a7475dceb6e50, supports separating
launch trust from tool approval. No verified Codex/Kiro custom panel SDK is claimed;
Weave does not inherit their sandbox/security guarantees. VS Code webview reference
is motivation for deferring richer UI, not a v1 feature or safety claim.
