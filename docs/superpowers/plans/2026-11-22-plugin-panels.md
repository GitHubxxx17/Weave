# Weave declarative right-panel SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let trusted active ESM plugins show useful host-rendered right panels backed by own durable Session events, with form actions that prepare editable text for explicit user Send.

**Architecture:** Plugin owns closed panel definitions and governed contribution accounting. Server binds immutable current-only catalogs to observed authority and projects bounded host data; Studio independently validates HTTP DTOs, preserves stable tabs, and inserts prepared text into an explicitly owned composer draft. Runtime and the Tool Pipeline gain no panel-specific execution path.

**Tech Stack:** TypeScript ESM strict, existing Zod 4, Hono, React 19, Vitest/Testing Library, existing Session store and Generation coordinator. No added dependency.

**Spec:** `docs/superpowers/specs/2026-11-22-plugin-panels-design.md`, recorded before cross-package code. All executors read the complete spec as well as their task.

## Global Constraints

- Marketplace remains in left navigation; declarative extension panels appear only in the right tab system.
- Static closed blocks + latest own durable-event projection + prepare-command form only; no iframe, HTML, Markdown, CSS, URLs, React callbacks, generic RPC or direct execute action.
- Runtime has no panel vocabulary; Studio imports no `@weave/*`, Node or Electron module.
- API version stays 1.0.0; schema-2 declarative artifacts stay Skills-only.
- Per definition 64 KiB, complete catalog 1 MiB, complete data 64 KiB, request 16 KiB, prompt 32 KiB, prepared response 256 KiB; actual UTF-8 after escaping/envelope counts.
- Candidate Proxy traps can execute; ordinary getters are rejected; HTTP reads call no plugin code.
- UI authority is current-only, cached and synchronous, with positive epoch, rotating refs and checks before/after every await.
- Session readability/preparation is linearized to the observed durable prefix, not a stronger deletion fence.
- Cache:128 Session buckets,16 entries/Session,256 entries total,512 KiB/Session,8 MiB total;8 store jobs,32 admitted consumers,4 consumers/key, no queue.
- Tests in package/app `test/`; behavior changes require tests. No unrelated refactor or dependency.
- Root owns Git/branch integration. The ownership prerequisite must be merged first; start a fresh feature branch from latest origin/main following repo/skill workflow. Workers never switch branches, commit or push.
- Every worker reports precise files, RED/GREEN evidence, commands and remaining limits; only root broadens gates, publishes artifacts or updates shared documents.

---

## 0. Execution order and nonoverlapping ownership

Use four roles concurrently once the immutable handoff below is accepted. These are
subagents in the current task, not user-owned new chats.

| Role | Exclusive implementation ownership | Parallel start / dependency |
| --- | --- | --- |
| Plugin contract worker | `packages/plugin/src/{panels,seams,sdk,manifest,declaration,kernel,plugin-types,extension-point,index}.ts`, related Plugin tests; `packages/plugin-host/src/trust.ts` and its diff tests | Tasks 1-2 immediately after docs/interfaces |
| Server authority/read worker | All `apps/server/src` panel integration/mirrors and its designated tests except root acceptance/contract tests | Tasks 3-5; authority/types can start against agreed interfaces; final candidate assembly waits for Plugin exports |
| Studio renderer/draft worker | All `apps/studio/src` panel/layout/composer integration/mirrors and its designated tests except root contract fixture test | Tasks 6-8 from fixed DTO spec; no dependency on Server implementation until actual-output acceptance |
| Root examples/acceptance | Docs, `examples/plugins/quality-report`, exact two contract fixture files/tests named in Task 9, cross-worker integration/review/full checks | Task 0 then example while workers implement; Task 9 after seams exist |

Shared file rule: root requests changes from the owner rather than editing their
file concurrently. Plugin-host generation runner needs no edit: actual current-ID
comparison covers reentrant retirement. Session package needs no contract change:
Server adds a small lifecycle fold and tests its rules. Root alone changes any
unexpected package configuration after documenting the reason.

### Locked handoff interfaces

Plugin exports from `@weave/plugin`:

```ts
export type { DeclarativePanel, PanelBlock, FormField, Binding, Value, PanelSource,
  Scalar, DataPath, PanelsExtensionApi, AttributedPanel };
export const panelLimits: Readonly<{
  definitionBytes: 65536; sources: 8; blocks: 32; depth: 16; nodes: 4096;
}>;
export const declarativePanelSchema: z.ZodType<DeclarativePanel>;
export const attributedPanelSchema: z.ZodType<AttributedPanel>;
export function cloneDeclarativePanel(input: unknown): DeclarativePanel;
export const panelsExtensionPoint: ExtensionPoint<PanelsExtensionApi>;
// AttributedPanel extends DeclarativePanel with real host pluginId, matching Skills attribution.
```

`cloneDeclarativePanel` validates detached plain JSON and internal references; owner
metadata/actual event/command binding belongs to Server. The seam inserts host
pluginId rather than accepting it from author input. Follow the existing Skills
seam's host attribution pattern with the repaired atomic acceptance semantics.

Server files expose to their own package only:

```ts
// plugin-panel-types.ts: §4/§6 spec types and strict wire schemas
interface PanelService {
  catalog(): PanelCatalog;
  read(sessionId: string, panelRef: string, options: { signal?: AbortSignal }): Promise<PanelData>;
  prepare(sessionId: string, panelRef: string, input: PrepareRequest,
    options: { signal?: AbortSignal }): Promise<PreparedCommand>;
  closeSync(): void;
  drain(): Promise<void>;
}
interface PanelServiceOptions {
  readonly host: ServerHost;
  readonly authority: CurrentUiAuthority;
  readonly sessionStore: SessionEventStore;
}
function createPanelService(options: PanelServiceOptions): PanelService;
// agent-kernel.ts result + ServerGenerationResources:
readonly panels: readonly BoundPanelDefinition[];
// ServerHost gains currentPublicationSync/subscribePublicationSync from spec §4.
// Coordinator exposes captureCurrentUiSync/assertCurrentUiSync/subscribeUiInvalidationSync.
```

Studio exports only within Studio:

```ts
// plugin-panel-types.ts mirrors §2/§6 independently, no shared runtime import.
function fetchPanelCatalog(signal: AbortSignal): Promise<PanelCatalog>;
function fetchPanelData(sessionId: string, panelRef: string,
  signal: AbortSignal): Promise<PanelData>;
function preparePanelCommand(sessionId: string, panelRef: string,
  input: PrepareRequest, signal: AbortSignal): Promise<PreparedCommand>;
// use-composer-draft.ts
interface ComposerOwner { sessionId: string; projectId: string; rootKey: string; epoch: number }
interface PreparedInsertion {
  owner: ComposerOwner; panelRef: string; serverEpoch: string; generation: number;
  authorityEpoch: number; formId: string; requestEpoch: number; text: string;
}
type InsertPreparedResult = 'inserted' | 'stale';
// App owns and provides insertPrepared: (value: PreparedInsertion) => InsertPreparedResult.
```

### Task 0: Root establishes prerequisite, docs and fixtures protocol

**Files:**
- Read: `AGENTS.md`, `docs/architecture/foundation.md`, `docs/adr/0001-foundation-vertical-slice.md`, `docs/superpowers/specs/2026-11-14-weave-foundation-design.md`.
- Create: `docs/superpowers/specs/2026-11-22-plugin-panels-design.md`.
- Create: `docs/superpowers/plans/2026-11-22-plugin-panels.md`.
- Modify: `docs/architecture/foundation.md`, existing reference learning document only to record chosen panel scope/reference limitations.

**Interfaces:** consumes merged owner-bound services/contribution accounting. Produces the fixed source/wire seams above and grants exclusive worker paths.

- [x] Inspect status, branch, merge state and existing worktree attachments. Confirm the ownership prerequisite is actually merged and latest main contains its regressions. Use safe-git-workflow/using-git-worktrees; root creates a fresh feature branch only after protecting unrelated work. Do not repeat the owner review.
- [x] Copy the full final spec and this plan to the documented repo paths before changing cross-package implementation. Update Foundation with Plugin -> Server -> Studio contract, current-only/prefix semantics and deferred rich UI. Preserve verified upstream commit/snapshot references; make no new upstream panel SDK claim.
- [x] Ask each worker to read its full task and spec, then acknowledge the exact handoff exports/DTOs and file ownership. Fix any genuine compile seam disagreement in docs before allowing incompatible names to diverge.
- [x] Establish root fixture protocol: root owns `apps/server/test/plugin-panel-contract.test.ts`, `apps/server/test/fixtures/plugin-panel-contract.json`, `apps/studio/test/plugin-panel-contract.test.ts`, `apps/studio/test/fixtures/plugin-panel-contract.json`. The JSON fixtures are byte-identical copies; Server test compares actual HTTP JSON to its fixture, Studio parses its copy through the independent mirror. No app source imports another app source.

### Task 1: Closed Plugin JSON schema and defensive snapshot

**Files:**
- Create: `packages/plugin/src/panels.ts`.
- Create: `packages/plugin/test/panels.test.ts`.
- Modify: `packages/plugin/src/index.ts`.

**Interfaces:** produces all §2 schema/type/limit exports and `cloneDeclarativePanel(input:unknown):DeclarativePanel`; no Node import. No actual owner/service lookup is performed here.

- [x] Add schema tests for all seven block kinds and three fields, correct defaults, unique IDs, declared Binding.source, metric finite literals, forbidden paths, unknown keys, sizes, aliases, cycles, array density/extra properties and maximum work. Use an actual minimal valid definition:

```ts
const staticPanel = {
  schemaVersion: 1, id: 'report', title: 'Quality', icon: 'checklist',
  placement: 'right', sources: [],
  blocks: [{ id: 'summary', type: 'text', value: { literal: 'Ready' } }],
} as const;
it('rejects an ordinary accessor before getter execution', () => {
  let calls = 0;
  const input = { ...staticPanel };
  Object.defineProperty(input, 'title', {
    enumerable: true, get() { calls += 1; return 'unsafe'; },
  });
  expect(() => cloneDeclarativePanel(input)).toThrow();
  expect(calls).toBe(0);
});
it('detaches and freezes accepted host JSON', () => {
  const input = structuredClone(staticPanel);
  const result = cloneDeclarativePanel(input);
  expect(result).toEqual(input);
  expect(result).not.toBe(input);
  expect(Object.isFrozen(result.blocks[0])).toBe(true);
});
```

- [x] Run `pnpm exec vitest run packages/plugin/test/panels.test.ts`; expect RED for missing exports/behavior, not infrastructure failure.
- [x] Implement bounded descriptor walking, rejecting repeated identities, before strict Zod/cross-reference validation. Count property keys and nodes as spec; fail before unbounded escaping. Safely construct fresh plain host JSON, freeze recursively, measure UTF-8 serialized bytes with TextEncoder. Document Proxy traps honestly and test a throwing Proxy trap yields a controlled error without asserting zero trap calls.

```ts
const json = cloneClosedPanelJson(input, { maxDepth: 16, maxNodes: 4096 });
const parsed = declarativePanelSchema.parse(json);
if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 65_536) {
  throw new TypeError('Panel definition exceeds its byte limit');
}
return freezeHostJson(parsed);
```

`cloneClosedPanelJson` and `freezeHostJson` are private functions in panels.ts;
implement the full descriptor rules from spec §3 rather than a JSON round trip.

- [x] Run the focused suite GREEN, `pnpm --filter @weave/plugin typecheck`, and `pnpm --filter @weave/plugin lint`. Report boundary values (4096/4097 nodes,16/17 depth,65536/65537 bytes) with escaping and multi-byte inputs.

### Task 2: Governed panel seam, manifest accounting and trust diff

**Files:**
- Modify: `packages/plugin/src/{manifest,declaration,kernel,plugin-types,seams,sdk,index}.ts`.
- Modify: `packages/plugin-host/src/trust.ts`.
- Create: `packages/plugin/test/panel-contributions.test.ts`.
- Extend: `packages/plugin/test/{manifest,sdk,seams,declaration}.test.ts`, `packages/plugin-host/test/trust.test.ts`.

**Interfaces:** produces `panel` capability, `contributes.panels`, actual `contributed.panels`, owner-attributed `panelsExtensionPoint`; existing Plugin API constant unchanged. Plugin-host adds panels to existing manifest diff key vocabulary only.

- [x] Add real Kernel tests for declared/undeclared panel, missing capability, duplicate within owner across callbacks, same local name across owners, host-supplied pluginId spoof rejected, rejected host addPanel returning false absent from accounting and thrown contribution carrying real pluginId. Use real createPluginKernel/definePlugin/env.contribute, not a mocked accounting array.

```ts
const kernel = createPluginKernel();
await kernel.register(definePlugin({
  manifest: { id: 'quality-report', name: 'Quality', version: '1.0.0',
    apiVersion: '1.0.0', capabilities: ['panel'], contributes: { panels: ['report'] } },
  setup(env) {
    env.contribute(panelsExtensionPoint, api => api.addPanel(staticPanel));
  },
}));
const generation = await kernel.seal();
const delivered: AttributedPanel[] = [];
kernel.extensions.collect(panelsExtensionPoint, {
  addPanel(value) { delivered.push(attributedPanelSchema.parse(value)); return false; },
});
expect(generation.plugins()[0]?.contributed.panels).toEqual([]);
```

The guarded seam passes frozen `{ ...definition, pluginId }` as the structural
AttributedPanel subtype, matching the existing Skills pattern without changing the
ExtensionPoint generic. cloneDeclarativePanel rejects pluginId in author input;
Server parses only the already host-produced value with attributedPanelSchema.
Do not regress the repaired owner/accounting mechanism to wrap-and-mark.

- [x] Run the focused contribution/manifest/sdk suites RED, then add the optional vocabulary through every strict Plugin schema, declaration label/map, accounting init/snapshot, SDK frozen key allowlist and public exports. Enforce eight panels per owner. Keep declarative-host Skills-only checks intact.
- [x] Add a trust diff test proving adding/removing panels produces a visible `contributes.panels` change and participates in review. No new automatic trust/activation rule.
- [x] Run `pnpm --filter @weave/plugin test`, `pnpm --filter @weave/plugin-host test`, then both typechecks/builds. Build dependencies before Server worker imports new public exports. Notify Server/Studio workers of final export names; do not change DTOs silently.

### Task 3: Server immutable binding, publication and cached current authority

**Files:**
- Create: `apps/server/src/plugin-panel-types.ts`, `apps/server/src/plugin-panel-catalog.ts`.
- Modify: `apps/server/src/{agent-kernel,server-host,runtime,extension-types,extension-coordinator,local-plugin-host}.ts`.
- Create: `apps/server/test/plugin-panel-catalog.test.ts`, `apps/server/test/plugin-panel-authority.test.ts`.
- Extend existing ServerHost/coordinator tests only within Server worker ownership.

**Interfaces:** produces BoundPanelDefinition, HostPublicationSnapshot/observers and CurrentUiAuthority from spec §4. AssembledAgentKernel.panels contains frozen host data/command copies, not callbacks. `createPanelService` can consume these later.

- [x] Write failing candidate tests: actually accepted same-owner event/command passes; declaration-only or host-rejected event/command fails; cross-owner binding fails; duplicate/global count and exact total byte caps fail with specified attribution; command prompt mutation after assembly cannot alter snapshot.
- [x] Collect panel contributions after event/command collection and bind against successful owner accounting plus accepted event type/command maps. Clone/freeze safe owner metadata, definition, definitionHash and command strings. Global overflow yields ownerless terminal error; per-owner error retains pluginId for existing isolation.

```ts
const commands = new Map(acceptedCommands.map(command => [command.name, command]));
for (const source of panel.definition.sources) {
  if (!acceptedOwnerEvents.has(source.eventType)) throw ownerPanelError(ownerId);
}
for (const block of panel.definition.blocks) {
  if (block.type !== 'form') continue;
  const command = commands.get(block.submit.command);
  if (command?.pluginId !== ownerId) throw ownerPanelError(ownerId);
  // Copy name/prompt strings into the private frozen bound snapshot here.
}
```

`ownerPanelError` is a private PluginError helper with a fixed safe message and
pluginId; do not inspect the author manifest again in the catch path.

- [x] Write deferred/reentrant tests covering same-generation stamp withdrawal, immediate:false, ownership loss/adoption failure, global block, successful publication and close. Spy on source.snapshot/refresh/prepare/recheck/isReady and plugin factories: capture/assert invokes none. Test failed candidate preserves current legal refs, but blocked failed replacement stays blocked.
- [x] Implement cached source snapshots and explicit source/host-baseline identities. Store member-generation ID; mismatch with actual controller current ID fails closed. Increment UI epoch before signal abort/notifications. Publication observer reads inert BoundPanelDefinition only; actual controller ID comparison rejects old refs in reentrant retirement before observer notification. Host compares real current ID immediately after commit, before installing its publication snapshot and before each listener; coordinator compares before each current member-generation/members/blocked/error/UI write or notify. Superseded B skips those operations without treating its successful commit as failed disposal; isolate publication-listener exceptions from successful commits. Direct commit path gets equivalent invalidation but no implicit trust of unknown members. Source identity includes origin as well as pluginId/identity/source/instance/managed identity.

```ts
function assertCurrentUiSync(captured: CurrentUiObservation): void {
  if (!currentAvailable || captured.signal.aborted ||
      captured.authorityEpoch !== authorityEpoch ||
      captured.generationId !== memberGenerationId ||
      captured.generationId !== host.controller()?.current().id) {
    throw panelUnavailable();
  }
}
```

- [x] Add a reentrant A->B->C test: retiring A aborts a listener that publishes C during outer B commit, and separately first B publication listener publishes C. After B returns, real current, host publication, ref map and coordinator current-member binding remain C; no later B listener fires and B resources retire normally rather than failed-candidate disposal.
- [x] Run focused catalog/authority and existing ServerHost/coordinator suites GREEN. Verify old Turn can pin retired generation while old panel ref immediately fails; UI never retains generation/resources or increments runner pins. Verify the host baseline example works only with explicit baseline identity and cannot spoof a source identity.

### Task 4: Pure prefix projection, bounded cache/inflight and prepare expansion

**Files:**
- Create: `apps/server/src/plugin-panel-errors.ts`, `plugin-panel-projection.ts`, `plugin-panel-cache.ts`, `plugin-panel-service.ts`.
- Create: `apps/server/test/plugin-panel-projection.test.ts`, `plugin-panel-service.test.ts`, `plugin-panel-cache.test.ts`.
- Shared Server types stay in `plugin-panel-types.ts` under the same worker.

**Interfaces:** `createPanelService(options:PanelServiceOptions):PanelService` from locked handoff; `catalog()` synchronous, `read/prepare` prefix reads with AbortSignal guards, closeSync/drain idempotent. Private projection accepts neutral SessionEvent tail + prior bounded state + bound definition and returns bounded state/DTO, never a callback.

- [x] Add failing projection fixtures: exact requested sessionId and sequence===cursor+1, cold empty404 versus nonempty missing-created/gap/duplicate/cross-Session503 with no cache mutation; created/archived/restored/deleted lifecycle order; unknown Session; exact latest type; latest future version does not fall back; static zero-source ready; own-property path; missing/wrong scalar/metric; first100 rows with explicit counts; string/complete-envelope overflow compact marker; cursor advances past oversized event. Include archived GET allowed / prepare forbidden.

```ts
expect(projected.sources[0]).toMatchObject({ state: 'incompatible',
  latest: { sequence: 3, payloadVersion: 2 } });
expect(projected.lastSequence).toBe(3); // old compatible sequence 2 is not selected
expect(projected.blocks[0]).toMatchObject({ cell: { state: 'incompatible' } });
```

- [x] Run focused projection test RED. Implement the small host lifecycle fold and selected-value projection, with shared existing Session lifecycle fixtures for ordering, no full transcript projection. Preserve event prefix linearization explicitly in code/docs. Deep projection stores only selected bounded data and marker metadata.
- [x] Add deferred store tests. Pause read, revoke observed authority, resolve read: result must reject stale/unavailable. Pause read, append deletion after the captured prefix, resolve old prefix: it may succeed with old lastSequence; a subsequent prefix containing deletion must reject410. Repeat archived preparation. No assertion of atomic deletion guarantee.
- [x] Add cache/inflight boundary tests: ninth independent read job, fifth same-key consumer,33rd admitted consumer,128/129 Session buckets,16/17 entries per Session,256/257 global entries,512 KiB/8MiB retained budgets, stale epoch clears, finally cleanup, all consumers abort but underlying read slot held until settlement. Use controlled deferred promises, not timers/sleeps.

```ts
const read = deferred<readonly SessionEvent[]>();
store.read.mockReturnValue(read.promise);
const waiting = service.read('s', ref, { signal: controller.signal });
controller.abort();
expect(debug.activeStoreJobs).toBe(1); // exposed only through test fixture injection
read.resolve(createdPrefix);
await expect(waiting).rejects.toBeDefined();
await service.drain();
expect(debug.activeStoreJobs).toBe(0);
```

Do not add a public production debug API: inject private test-owned observation
counters or assert store read call counts/admission outcomes. `deferred` is a local
test helper with `{promise,resolve,reject}` from Promise.withResolvers.

- [x] Add exact job tests: two panels in the same Session with different cursor/base cannot share; empty tail preserves all prior latest values/markers; unrelated tail only advances cursor; epoch clear discards pending output/commit; LRU eviction during a job prevents resurrection/overwriting a replacement; failed tail leaves prior entry/cursor unchanged.
- [x] Implement LRU buckets/entries/bytes and bounded consumers/jobs without a pending work queue. Use full structured tuple+panelRef+sessionId+baseCursor+entryIdentity+entryVersion as exact job key, with at most one active job per projection tuple. Lookup active tuple job first and join its immutable captured base/cursor; never create a second job for a replacement cache base. Freeze the bounded base once and join only that exact job. Atomically commit only after a complete successful fold and exact current epoch/entry-version check. Evicted base completions may serve their still-valid consumers but cannot reinsert stale entries; cold-miss completion inserts only under the exact still-current miss identity/no-newer-entry rule and ordinary budgets. At most8 jobs retain at most512 KiB additional bounded base projections. Capture current ref/authority before joining a job; validate before/after await and after projection; no stable-ID fallback. Retain store slot until actual Promise settles even after abort. Clear old refs/cache on every effective epoch.
- [x] Add prepare tests for field order/types/required/select/unknown keys, defaults as explicit values, literal `$ARGUMENTS` replacement, multi-byte/control-character byte caps, command snapshot immutability, no data readiness prerequisite and no execution/append. Assert exact JSON field order from definition.

```ts
expect(prepared.text).toBe('Review\n\n{"target":"src","include-tests":true}');
expect(prepared.requiresUserSend).toBe(true);
expect(store.append).not.toHaveBeenCalled();
expect(toolExecute).not.toHaveBeenCalled();
expect(pluginEventParse).not.toHaveBeenCalled();
```

- [x] Run projection/cache/service suites GREEN plus typecheck/lint. Report the explicit raw-store cold-read memory/cancellation limitation; no extra Session API redesign.

### Task 5: Thin HTTP, all-path guards, mirrors and shutdown wiring

**Files:**
- Create: `apps/server/src/plugin-panel-api.ts`, `plugin-panel-request-guard.ts`.
- Modify: `apps/server/src/{app,main,server-shutdown,plugin-catalog,plugin-management-types}.ts`; other Server strict manifest/provides mirrors discovered by `rg 'capabilities|contributes|promptSections' apps/server/src`.
- Create: `apps/server/test/plugin-panel-api.test.ts`.
- Extend shutdown test covering panel service drain before Session store close.

**Interfaces:** adds optional PanelAppOptions.panelService to createApp; main constructs exactly one service per Server composition with raw host store and explicit authority. Handlers call service only. No route calls plugin registry or session writer.

- [x] Write failing API table cases for the exact three paths, success-only schemaVersion1 versus exact unversioned error envelope and bodyless HEAD/OPTIONS, non-JSON POST400 panel-invalid-input, strict malformed params/body, real stream overflow even absent/false Content-Length, fatal UTF-8, all error status/code mappings and no native error detail. GET guard rejects cross-site/nonloopback Host/bad Origin without Content-Type requirement; CLI no-Origin succeeds. All successes/404/guard failures are no-store.
- [x] Implement a bounded body reader and strict PrepareRequest parser; normal JSON last-member duplicate semantics are acceptable under the strict final schema. Compose no-store before read/write guard. GET/HEAD use explicit guard rather than the current write guard's bypass. OPTIONS exposes no data under current configured CORS policy.

```ts
app.use('/plugins/panels', noStore);
app.use('/sessions/:sessionId/plugin-panels/*', noStore);
// Register all-path local panel guard before GET/POST handlers.
// In POST: read <=16384 actual bytes -> fatal TextDecoder -> JSON.parse -> strict schema.
// Then await panelService.prepare(...), serialize the already bounded DTO.
```

Match Hono's actual route-pattern behavior in tests; do not assume this illustrative
wildcard covers the exact base endpoint if the router requires another registration.

- [x] Wire main/shutdown: panel.closeSync occurs before coordinator/host drain; panel.drain settles before Session store close; repeated shutdown safe. No aborted store Promise is abandoned. Add panel labels to Server list/manifest/review projections so Studio sees declarations and actual provides consistently.
- [x] Run API/shutdown tests and `pnpm --filter @weave/server typecheck`, lint/build. Hand root actual deterministic endpoint DTO output for contract fixtures; replace random tokens via injected test token factory only, never a production fixed epoch.

### Task 6: Studio strict transport mirror and v3 restoration

**Files:**
- Create: `apps/studio/src/features/panel/plugin-panel-types.ts`, `plugin-panel-api.ts`, `panel-layout.ts`, `use-plugin-panels.ts`.
- Modify: `apps/studio/src/features/panel/panel-registry.tsx`, `apps/studio/src/features/panel/use-panel-tabs.ts`, `apps/studio/src/features/panel/panel-container.tsx`.
- Modify: `apps/studio/src/features/plugins/plugin-types.ts`, `managed-plugin-types.ts`, `plugin-payload-description.tsx`, `plugin-trust-dialog.tsx`, `managed-plugin-dialog.tsx`, `plugins-panel.tsx` (all under that same feature directory).
- Create: `apps/studio/test/plugin-panel-types.test.ts`, `plugin-panel-api.test.ts`, `plugin-panel-layout.test.ts`.
- Extend: `apps/studio/test/panel-tabs.test.tsx`.

**Interfaces:** independent §2/§6 schemas and exact fetch functions in locked handoff; `normalizePanelLayout(v3:unknown,v2:unknown):SavedPanelLayout` pure with no live catalog input. BuiltinPanelKind remains closed; saved plugin panel ID stays stable across refs.

- [x] Add RED transport tests for wrong unions/unknown keys/schema version, mismatched IDs/counts, actual byte overflow, fatal UTF-8 and bounded error. Use runtimeApiUrl with existing `/plugins` and `/sessions` proxy; no config/proxy expansion needed.
- [x] Implement independent strict schemas and actual stream reader. Caller owns AbortSignal; every response still validates captured identity after transport. Use error cap1024, catalog1MiB,data64KiB,prepared256KiB.
- [x] Add v2 fixtures with two preview IDs and two terminal IDs, pins/order/active plus an obsolete plugin kind; assert exact surviving IDs. Add valid v3 plugin tab before catalog, failed/absent catalog, bad entry with good siblings, duplicate plugin IDs and active/pin normalization.

```ts
expect(migrated.tabs.map(tab => tab.id)).toEqual([
  'preview:first', 'terminal:first', 'preview:second', 'terminal:second',
]);
expect(migrated.active).toBe('terminal:second');
expect(migrated.pinned).toEqual(['preview:first', 'terminal:second']);
// Catalog is deliberately absent from normalizePanelLayout inputs.
```

- [x] Implement v3-only persistence, keep recoverable v2, never persist ref/epoch/data/endpoint. Reconcile live catalog outside normalization: unresolved/unavailable placeholder instead of disappearing tab. Keep builtin React keys and keepAlive/route-hidden semantics. Plugin active does not auto-open/pin; own add-menu group uses closed icon map/owner attribution.
- [x] Add panel vocabulary to strict management/review mirrors without broadening declarative Skills-only artifacts. Run focused types/API/layout/tabs GREEN, then Studio typecheck/lint.

### Task 7: Studio data lifecycle and native declarative renderer

**Files:**
- Create: `apps/studio/src/features/panel/use-plugin-panel-data.ts`, `declarative-plugin-panel.tsx`, `plugin-panel-form.tsx`, `plugin-panel.css`.
- Modify: `apps/studio/src/features/panel/panel-container.tsx`; worker owns all Studio overlap.
- Create: `apps/studio/test/declarative-plugin-panel.test.tsx`, `plugin-panel-lifecycle.test.tsx`.

**Interfaces:** render definition + exact PanelData validated together, narrow host context `{sessionId,projectId,rootKey,ownerEpoch,visible,insertPrepared}`; no builtin PanelContext exposure. Form emits prepare request via exact Session/ref, and receives App-owned insertion seam in Task8.

- [x] Write renderer RED tests for each block/field, escape `<img onerror=...>` as text, no author URL/HTML/style props, matching labels/table headings, table truncation, empty/incompatible/invalid/too-large states, malformed block correspondence and select/default validation.
- [x] Implement host components only. Form defaults are declaration literals; keyed form state never derives defaults from event payload. Disabled/placeholder states have no usable actions. Metric accepts number/null; static text remains visible alongside source failure.
- [x] Write deferred lifecycle tests for tab/session/root change, A->B->A, collapse, marketplace route hide->show with unchanged owner/ref, two-form/remount token collisions, epoch/ref replacement and unmount. Aborted transport intentionally resolves anyway: no stale paint, data update or insertion. Use fake timers only for the2s completion-based polling schedule; never overlapping reads.

```ts
const old = deferred<PanelData>();
api.read.mockReturnValueOnce(old.promise);
rerender(<Host sessionId="b" ownerEpoch={2} />);
rerender(<Host sessionId="a" ownerEpoch={3} />);
old.resolve(oldAResponse);
await waitFor(() => expect(screen.queryByText('old A value')).toBeNull());
```

Define Host as a local harness rendering actual panel hook/renderer with explicit
captured props and current refs; do not test only a tuple comparison helper.

- [x] Implement synchronous render-key invalidation and requestEpoch gates before/after await and before setState/insertion. Use one App-global monotonic interaction token; increment at every prepare and synchronously at hide/collapse/tab/unmount, with fresh identity on show/remount. A second form request invalidates the earlier insertion; keep only current token plus consumed flag for bounded deduplication, and do not rely on remount-local counters or transport abort. New App-owned catalog observes management invalidation hints but authorizes only fresh panel DTO. Poll immediate then2s after completion while active/visible; no prepare auto-retry.
- [x] Run renderer/lifecycle plus existing panel/container/marketplace tests GREEN. Confirm builtin preview/terminal remain mounted under route hiding and stable IDs.

### Task 8: App draft ownership and literal preparation insertion

**Files:**
- Create: `apps/studio/src/features/composer/use-composer-draft.ts`.
- Modify: `apps/studio/src/app/App.tsx`, `apps/studio/src/features/commands/use-command-picker.ts` for explicit selection notification only if the existing App callback cannot provide it.
- Create: `apps/studio/test/composer-draft.test.tsx`.
- Extend: `apps/studio/test/App.test.tsx` and panel lifecycle tests.

**Interfaces:** ComposerOwner/PreparedInsertion/InsertPreparedResult from locked handoff. Keep existing `use-session-skills` object refs separate. Session-keyed text/images,128 inactive bucket LRU, owner epoch on every transition, revision-checked normal-send clearing.

- [x] Add RED actual App tests for edits while waiting, existing image and Skill refs preserved, no Agent request on prepare, A->B and A->B->A late insertion rejected, root/ref/epoch/hide invalidation and duplicate request token insert once.

```ts
// Start real panel preparation with draft "first", selected image + Skill.
// While response waits, type "first edited".
// Resolve text="prepared" with exact current tuple.
expect(textarea.value).toBe('first edited\n\nprepared');
expect(agentRun).not.toHaveBeenCalled();
expect(currentImages[0]).toBe(originalImage);
expect(currentSkills[0]).toBe(originalSkill);
```

Use actual controls/hooks in the App harness; keep original object identities in
test-owned refs. Add a delayed image decode and ensure stale owner completion is
ignored, rather than silently attaching an image to a new Session.

- [x] Implement owner refs and functional append guarded by full tuple/request epoch, focus/caret and visible requires-Send status. Store literalSend with each text/images bucket. Successful send clearing must atomically clear text/images and reset literalSend only if captured owner/revision is still current; preserve all three when edits arrived during await.
- [x] Add provisional new-Session draft tests: same-owner unchanged-revision creation migrates captured bucket to created ID under a private owner/revision migration ticket; typing while creation waits keeps the provisional bucket active and preserves newer text/images/mode without migration/clear; switching to another Session while creation waits does not navigate back or migrate/clear its draft. No real Session means panel prepare disabled. Implement project/root-scoped host-local provisional keys (never HTTP Session IDs), atomic same-owner unchanged-revision migration+epoch advance and ticket-gated clear exactly as spec §8.
- [x] Add RED/GREEN send test where prepared text starts `/old-command`, then plugin generation replaces that name: explicit Send sends the literal full text without command lookup. Ordinary editing retains literal mode; both mouse and keyboard command-picker selection reset it; successful same-revision send resets mode; edited drafts retain mode; normal manually typed slash commands still expand.

```ts
const submitted = draft.literalSend ? draft.text.trim() : commandPicker.expand(draft.text.trim());
// After asynchronous normal submit completes:
clearSubmittedDraftIfCurrent({ owner: capturedOwner, revision: capturedRevision });
```

`clearSubmittedDraftIfCurrent` is a private method of the new draft hook, not a new
Agent API. Retry retains existing captured full submission behavior.

- [x] Run composer/App/panel lifecycle/image/Skills/command regression suites GREEN, then full Studio test/typecheck/lint/build. Report exactly how owner epoch differs from Session ID and why A->B->A is rejected.

### Task 9: Root useful example, actual DTO compatibility and acceptance

**Files:**
- Create: `examples/plugins/quality-report/{weave-plugin.json,index.mjs,README.md}`.
- Create root-owned: `apps/server/test/plugin-panel-example.test.ts` (declare ownership before worker starts), `apps/server/test/plugin-panel-contract.test.ts`, `apps/server/test/fixtures/plugin-panel-contract.json`, `apps/studio/test/plugin-panel-contract.test.ts`, `apps/studio/test/fixtures/plugin-panel-contract.json`.
- Modify docs only: accepted panel spec/plan tracking, Foundation/ref record and plugin development guide to show real supported API.

**Interfaces:** consumes built SDK/panels, actual Server HTTP service and Studio independent schema. No cross-app source import. Example receives runtime values through injected SDK and uses actual env.contribute/env.defineEvent/env.use patterns.

- [x] Write failing real example test using actual loader/factory and Kernel candidate: import remains inert, explicit trust enables, report Tool executes through Pipeline, own durable report appears in data, form prepares and appends no event/executes no tool. Prove unrelated owner cannot write the report using already merged boundary behavior without retesting the full prerequisite.
- [x] Implement a real single-file ESM factory and descriptor. Validate score0..100,summary<=2000,checks<=100,name<=120,status enum; require context Session ID and use owner-scoped writer only inside governed tool execution. Declare panel/event/command/tool/permissions exactly. Native report panel: metric score, summary text, checks table, target text + include-tests boolean form. Add README with current CLI validated commands and manual flow, not invented publication URLs.

```js
export default (sdk) => ({
  setup(env) {
    const report = env.defineEvent('report', {
      schema: sdk.z.strictObject({
        schemaVersion: sdk.z.literal(1),
        score: sdk.z.number().int().min(0).max(100),
        summary: sdk.z.string().max(2000),
        checks: sdk.z.array(sdk.z.strictObject({
          name: sdk.z.string().min(1).max(120),
          status: sdk.z.enum(['pass', 'warn', 'fail']),
        })).max(100),
      }),
    });
    const writer = env.use(sdk.sessionStoreRef);
    // Tool registration uses the real current ToolDefinition input/execute API.
    // Event write: (await writer.get()).append(context.sessionId, [report.create(input)]).
    // Command and panel registration use env.contribute with the injected SDK seams.
  },
});
```

The final example contains the complete registrations and actual context checks;
this plan sketch establishes exact schema/content, not permission to leave comments
instead of working code. Check Runtime ToolContext's real optional sessionId field
before using it and throw a clear tool error if absent.

- [x] Obtain actual deterministic Server catalog/data/prepared HTTP DTO in root-owned test, create byte-identical neutral JSON fixtures in both apps. Server test deep-compares actual route output to fixture; Studio test parses each fixture with independent strict schema then validates definition/data correspondence. Mutate version, unknown field, wrong block ID/type and over-budget body and assert rejection. Use no source import across app boundaries.
- [x] Run real source -> validate/build/artifact review via existing plugin CLI and loader. Do not install dependencies, run author package scripts, publish, or create trust as a hidden CLI side effect. User-authorized app trust interaction in isolated acceptance data is explicit and reversible.
- [x] Run end-to-end acceptance flow from spec §9 with a temporary data directory and stub deterministic LLM if needed: left marketplace remains main page; right add tab; report through normal Pipeline; prepare doesn't Send; explicit Send; restart stable tab/data; upgrade/reload old Turn continues but old ref fails; revoke pending operations fail; archive GET allowed/prepare409; delete tests assert prefix rule. Capture browser screenshots only if UI is actually exercised; no success claim from static tests alone.
- [x] Conduct independent spec and code review using free agents: Server current-only/prefix/callback purity + Studio draft/layout/transport. Resolve meaningful findings with owner workers, rerun changed focused tests, then full `pnpm check` once. Run `git diff --check`, inspect final scope/dependencies and docs. Do not repeat successful broad gates without changes.
- [x] Root reports concrete outcome, tests and honest limitations. Commit/push/PR/merge only under existing explicit user/task workflow; after any authorized integration, use the required fresh topic branch for the next unrelated feature. This task does not create a rich UI sandbox, stronger Session delete transaction or automatic developer-market publishing pipeline.

## Completion coverage matrix

| Spec requirement | Deliverable |
| --- | --- |
| Closed JSON/Proxy limits/byte budgets | Tasks1,2; actual DTO tests9 |
| Actual owner event/command binding / immutable command copies | Tasks2,3 |
| Host baseline/source identities, every publication, cached epoch/ref current-only | Task3; deferred/reentrant4; lifecycle7 |
| Prefix Session lifecycle/no plugin callbacks/selected projection | Task4; integration9 |
| LRU bytes, exact cursor/base job keys, prior-state tail fold, concurrency slots, no queue, cursor advancement, close/drain | Tasks4,5 |
| HTTP GET/write guards, no-store, body/response byte caps/error map | Task5; client6; contract9 |
| v3 restoration preserving builtin IDs/plugin placeholders | Task6 |
| Host renderer/forms/XSS/visibility/polling/authority match | Task7 |
| Exact draft owner, A->B->A, global hide/remount tokens, provisional migration, images/Skills/latest edits, literal send/reset | Tasks7,8 |
| Useful own-event report and real install/trust/activate/read/prepare/Send/revoke | Task9 |
| Docs before code, references/limits, full checks and independent review | Tasks0,9 |

## Review gates and work handoff

Each task ends with focused RED/GREEN evidence plus type/lint checks appropriate
to its owned surface. Plugin worker hands public exports/builds to Server worker;
Server worker hands actual deterministic DTO output to root/Studio worker; Studio
worker reports real App draft/lifecycle regressions, not only helper unit tests.
Root holds final full verification/integration. If a worker finds a contract change
necessary, stop only dependent edits, continue independent tests, tell root the
exact mismatch and let root update spec/handoff before implementation diverges.
The workflow is already assigned; no execution-choice permission question is needed.

## Completed verification — 2026-11-22

The implementation passed independent Plugin, Server and Studio reviews. Review
regressions cover exact catalog byte reservation, mirror node accounting, fresh
refs during reentrant publication, cancellation before deferred storage work, raw
unknown form keys and React StrictMode setup/cleanup replay.

Root `pnpm check` passed with 4,121 tests across 215 files, including 1,404 Server,
733 Studio, 480 Plugin and 585 Plugin-host tests. Root actual HTTP/SQLite example
and byte-identical cross-app DTO fixtures passed. A temporary-data browser session
verified the left marketplace, right panel selection, stored report, preparation
without sending, explicit Send, refresh, revoke and restore. No external market
deployment or rich renderer sandbox is claimed.
