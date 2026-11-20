# Stage 4.5 Studio Local Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development`. Steps use checkbox syntax for tracking.

**Goal:** Review and manage local plugins from Studio with the exact digest a
person reviewed, one cached catalog, and accessible human-only controls.

**Architecture:** Studio owns browser Zod projections and HTTP clients only; it
imports no `@weave/*`, Node, Electron, filesystem, or host implementation. One
App-lifetime store/provider serves the panel and entry badge. Initial rendering
and restored tabs only GET; explicit user activation/Refresh may POST reload.
Server owns discovery, durable decisions, publication and turn cancellation.

**Tech Stack:** Existing TypeScript ESM, React 19, Zod, lucide-react,
Vitest/Testing Library, CSS tokens. No dependency additions.

**Spec:** `docs/superpowers/specs/2026-11-20-plugin-host-design.md` §§5.2, 6,
8.6, 10.5, 11; `docs/architecture/foundation.md`; ADR 0001/0003;
`docs/superpowers/specs/2026-11-14-weave-foundation-design.md`.

## Baseline and execution gate

Reconciled against current Stage 4.4b `apps/server/src/plugin-management-types.ts`,
`plugin-api.ts`, `plugin-catalog.ts`, route/guard/projection tests, and existing
Studio panel/App/tests. These source files resolve the earlier draft's proposed
wire fields. Recheck their merged versions; do not silently change these seams.

- Create `feat/studio-local-plugin-management` from latest `origin/main` after
  4.4b merges. Do not reuse its branch. The ongoing PR/CI/squash workflow is authorized by the user.
- Root/integration owner updates tracked plugin-host design §10.5/§11 and a
  tracked implementation plan **before implementation**. In §11.1, “open” means
  explicit human activation, including clicking an already-active plugin tab.
- Keep tests in `apps/studio/test/`; no new Server/Runtime feature is required.
- `isRunning` stays selected-session state. Add required `hasRunningSessions`
  from `Object.values(runStateBySession).some(run => run.status === 'streaming')`.
  It observes all Studio sessions, not external clients; generation membership
  cannot establish whether a turn is running.

## Frozen Server wire contract

GET `/plugins` is a cached read, never disk discovery. Without a manager it
returns `{plugins}`; with one it adds `local`. Absence of `local` is the old or
management-disabled read-only mode, not a reason to probe POST at startup.

Existing list fields remain. Add browser `state: z.string().default('loaded')`,
`error?: PluginIssue`, and `local?: LocalPluginMetadata`. Continue accepting
unknown origin/host/capability/permission/hook strings and future state strings;
unknown states render read-only. Keep old provides.events/commands/hooks defaults
as `[]`. Do not default all missing required fields or synthesize a manifest.

```ts
// Browser-owned projection; schemas produce these exact exported names.
export interface PluginIssue { readonly code: string; readonly message: string }
export interface PluginDeclarations {
  readonly tools?: readonly string[]; readonly providers?: readonly string[];
  readonly promptSections?: readonly string[]; readonly events?: readonly string[];
  readonly commands?: readonly string[]; readonly hooks?: readonly string[];
  readonly services?: readonly string[];
}
export interface PluginManifestProjection {
  readonly id: string; readonly name: string; readonly version: string;
  readonly apiVersion: string; readonly description?: string;
  readonly host?: string; readonly capabilities: readonly string[];
  readonly engines?: { readonly weave: string };
  readonly contributes?: PluginDeclarations; readonly permissions?: readonly string[];
}
export interface LocalPluginMetadata {
  readonly directory: string; readonly digest?: string; readonly enabled: boolean;
  readonly manifest?: PluginManifestProjection;
  readonly trusted?: { readonly digest: string; readonly trustedAt: string;
    readonly manifest: PluginManifestProjection };
  readonly active?: { readonly generation: number; readonly digest: string;
    readonly manifest: PluginManifestProjection };
}
export interface LocalPluginHostSummary {
  readonly directory: string; readonly exists: boolean; readonly truncated: boolean;
  readonly trustSequence: number;
  readonly generation: { readonly id: number; readonly acceptingRuns: boolean;
    readonly plugins: readonly { readonly id: string; readonly digest: string;
      readonly manifest: PluginManifestProjection }[]; readonly blocked?: PluginIssue };
  readonly error?: PluginIssue;
}
export interface PluginCatalog {
  readonly plugins: readonly PluginListItem[]; readonly local?: LocalPluginHostSummary;
}
export interface PluginReloadResult {
  readonly generation: number; readonly unchanged: boolean;
  readonly failed: readonly { readonly id: string; readonly error: PluginIssue }[];
  readonly error?: PluginIssue;
}
export interface PluginMutationResponse extends PluginCatalog {
  readonly local: LocalPluginHostSummary; readonly result: PluginReloadResult;
}
```

Actual types should use local Zod inference, with readonly consumer interfaces
where useful. Digests are exactly 64 lowercase hex characters. Generation ids
and active.generation are positive integers; trustSequence is a nonnegative
integer. Server trustedAt is **z.string()**, not a stricter timestamp contract.
Manifests validate display structure/string arrays without plugin semver rules.

The desired row and `local.active`/generation membership can disagree. Only a
matching loaded row has nonempty actual `provides`. Changed/disabled/failed rows
must not borrow contributions from retained active metadata. Do not fabricate a
row for a removed directory present only in generation.plugins.

| Operation | Request | Successful response |
| --- | --- | --- |
| Read | GET `/plugins` | PluginCatalog |
| Rediscover/reload | POST `/plugins/reload`, `{}` | PluginMutationResponse |
| Trust+enable | POST `/plugins/:id/trust`, `{digest: reviewedDigest}` | same |
| Enable | POST `/plugins/:id/enable`, `{}` | same |
| Disable | POST `/plugins/:id/disable`, `{}` | same |
| Revoke | DELETE `/plugins/:id/trust`, `{}` | same |

Every write sends JSON Content-Type and encoded id. Only disable/revoke may
append `?immediate=true`, only after an explicit checked choice; otherwise omit.
No immediate query on trust/enable/reload. Use runtimeApiUrl and preserve
AbortError; never set browser-forbidden Host/Origin/Sec-Fetch headers.

Errors are `{error:{code,message}}`: 400 invalid request/trust, 403 forbidden
origin/Host, 404 plugin-not-found or plugin-management-disabled, 409
plugin-not-trusted/not-loadable/digest-mismatch/generation-blocked, 415 media
type, 503 host/trust-store closed, 500 storage/discovery/unknown failures. Decode
code/message/status into PluginApiError, with a safe malformed-body fallback.
A successful 200 may have result.error/failed after a durable decision; preserve
it and never resubmit trust as a repair. `result.generation` may differ from the
newer response `local.generation.id`: the result describes an operation, while
the catalog is the current synchronous snapshot. Never require their equality.

## Frozen public interfaces — agree before parallel implementation

Owner A supplies `plugin-types.ts`, `plugin-api.ts`, store and React context.
Keep `PluginApiError(code: string, message: string, status: number)` and existing
`fetchPlugins` compatibility. All following functions are named exports:

```ts
fetchPluginCatalog(signal?: AbortSignal): Promise<PluginCatalog>;
fetchPlugins(signal?: AbortSignal): Promise<readonly PluginListItem[]>;
reloadPlugins(signal?: AbortSignal): Promise<PluginMutationResponse>;
trustPlugin(id: string, digest: string, signal?: AbortSignal): Promise<PluginMutationResponse>;
// Reject immediate=true with enabled=true as a caller error; never send an
// unsupported immediate query for enable.
setPluginEnabled(id: string, enabled: boolean, options?: PluginDecisionOptions): Promise<PluginMutationResponse>;
revokePluginTrust(id: string, options?: PluginDecisionOptions): Promise<PluginMutationResponse>;
type PluginDecisionOptions = { readonly immediate?: boolean; readonly signal?: AbortSignal };

type PluginPendingOperation = { readonly kind: 'reload' | 'trust' | 'enable' | 'disable' | 'revoke';
  readonly id?: string; readonly digest?: string };
interface PluginCatalogState {
  readonly catalog: PluginCatalog | undefined;
  readonly initialLoading: boolean;
  readonly pendingOperation: PluginPendingOperation | undefined;
  readonly error: PluginApiError | undefined;
  readonly lastResult: PluginReloadResult | undefined;
}
interface PluginCatalogStore {
  getSnapshot(): PluginCatalogState;
  subscribe(listener: () => void): () => void;
  ensureLoaded(): Promise<void>;
  reload(): Promise<void>;
  trust(id: string, digest: string): Promise<void>;
  setEnabled(id: string, enabled: boolean, immediate?: boolean): Promise<void>;
  revoke(id: string, immediate?: boolean): Promise<void>;
}
createPluginCatalogStore(): PluginCatalogStore;
PluginCatalogProvider(props: { readonly store: PluginCatalogStore;
  readonly children: ReactNode }): ReactElement;
usePluginCatalogStore(): PluginCatalogStore;
usePluginCatalogState(): PluginCatalogState;
PluginPendingBadge(): ReactElement | null;
```

A store never aborts a shared fetch/write because one subscriber/panel unmounts.
Provider calls ensureLoaded and catches the already-published error. Immutable
snapshots stay referentially stable until changed; closure-bound methods work
with useSyncExternalStore directly. Initial GET is deduplicated across StrictMode
replay and consumers; mutations await it so it cannot overwrite a later result.
Set pendingOperation synchronously before awaits. Concurrent reload callers share
one in-flight reload; all other concurrent operations reject a typed
`plugin-operation-pending` without a request. All action buttons use global busy.

After **every rejected write**, attempt a deduplicated cached GET before clearing
busy: the durable decision may already exist. Preserve the original error and
reject it to the dialog after reconciliation; a failed GET retains prior catalog
and never masks that error. A successful write atomically replaces catalog and
lastResult, then clears the request error. Never clear cached rows/badge on error.

`reload()` after initial GET uses POST only when catalog.local exists; otherwise
it explicitly refreshes with GET. If a write returns
`404 plugin-management-disabled`, reconcile with GET and remain read-only when
local is absent. A `plugin-not-found` row error does not disable management.
Initial GET failure is retried by the next explicit reload (GET before deciding
POST); no automatic retry loop/polling or localStorage trust cache.

Owner B supplies pure review helpers and two dialog exports. They consume A's
projection/error types; they never fetch or own catalog state:

```ts
interface PluginReview {
  readonly id: string; readonly name: string; readonly version: string;
  readonly description?: string; readonly directory: string; readonly digest: string;
  readonly manifest: PluginManifestProjection;
  readonly previousTrusted?: { readonly digest: string; readonly manifest: PluginManifestProjection };
}
createPluginReview(plugin: PluginListItem): PluginReview | undefined;
type PluginDeclarationCategory = 'capabilities' | keyof PluginDeclarations | 'permissions';
interface PluginDeclarationChange { readonly category: PluginDeclarationCategory;
  readonly added: readonly string[]; readonly removed: readonly string[] }
diffManifestDeclarations(previous: PluginManifestProjection,
  next: PluginManifestProjection): readonly PluginDeclarationChange[];
pluginImpact(kind: 'hook' | 'permission', value: string): {
  readonly level: 'high' | 'medium' | 'low'; readonly description: string;
  readonly recognized: boolean };
PluginTrustDialog(props: { readonly review: PluginReview; readonly busy: boolean;
  readonly onCancel: () => void; readonly onTrust: (review: PluginReview) => Promise<void>;
  readonly getFallbackFocus: () => HTMLElement | null }): ReactElement;
PluginDecisionDialog(props: { readonly plugin: PluginListItem;
  readonly action: 'disable' | 'revoke'; readonly hasRunningSessions: boolean;
  readonly busy: boolean; readonly onCancel: () => void;
  readonly onConfirm: (immediate: boolean) => Promise<void>;
  readonly getFallbackFocus: () => HTMLElement | null }): ReactElement;
```

createPluginReview returns undefined unless local digest+manifest are valid;
it clones the captured review/manifest rather than keeping a live row lookup.
Trust submits only this captured id/digest. Dialog catches submitted errors for
local copy. `409 plugin-digest-mismatch` permanently disables this review's Trust
button and requires closing/reopening through an explicit Review action; GET
reconciliation must never replace its content or automatically trust new bytes.

Owner C supplies `PluginsPanel({hasRunningSessions: boolean}): ReactElement`,
uses both seams, and owns App/panel integration. Panel mount only reads the store.
App creates the store with lazy useState and wraps its whole returned tree in
PluginCatalogProvider, outside conditional PanelContainer/settings views. A
factory is not called at module scope. PanelContainer explicit plugin tab click
and plugin add-menu click call store.reload even if tabs.activate/open causes no
state change. Programmatic tab restoration and panel remount never call POST.
Panel Refresh calls the same method; activation/reload errors are already inline
and handlers consume rejected promises. Keep plugins single-instance/non-keepAlive.

## Ownership matrix and work packages

| Owner | Exclusive implementation files | Exclusive tests/docs |
| --- | --- | --- |
| A — API + store | existing plugins/plugin-types.ts, plugin-api.ts; new plugin-catalog-store.ts, plugin-catalog-context.tsx | plugin-api.test.ts; new plugin-catalog-store.test.ts, plugin-catalog-context.test.tsx |
| B — review + dialogs | new plugins/plugin-review.ts, plugin-dialog.tsx, plugin-trust-dialog.tsx, plugin-decision-dialog.tsx, plugin-dialog.css (imported by shell) | new plugin-review.test.ts, plugin-dialogs.test.tsx |
| C/root — panel + App/integration | existing plugins/plugins-panel.tsx; panel/panel-container.tsx, panel-registry.tsx, panel-data.ts; app/App.tsx, app.css; vite.config.ts | plugins-panel.test.tsx, panel-tabs.test.tsx, App.test.tsx; context-panel.test.tsx and plan-panel.test.tsx typed fixtures; tracked design/plan; browser evidence |

Paths above are under `apps/studio/src/features/`, `apps/studio/test/` or
`apps/studio/` as appropriate. Only C edits app.css; B keeps dialog rules in its
feature CSS, reusing tokens and existing dialog classes without global changes.
Other agents request seam changes through C; nobody edits a neighbor's files.

### Task 1: Browser boundary and observable cache

- [ ] Freeze schemas/exports first and notify B/C. Add API behavior tests for
  every method/body/header/query, encoded ids, desktop base URL, signal/abort,
  old GET/unknown strings, malformed success/error, 409, disabled management,
  result.error and nonmatching result/current generation ids; then implement.
- [ ] Test the coordinator with controlled promises: StrictMode dedup; initial
  GET settled before POST; same reload shares a promise; double-click trust
  cannot duplicate; new catalog immediately changes badge; rejected disable
  then GET reflects durable disabled/blocked state; GET failure keeps cache and
  original error; separate factories are isolated. Implement the contract above.
- [ ] Badge counts only local pending-trust+changed rows; zero absent, nonzero
  exposes text such as “2 个插件待审阅”. Provider and badge perform no POST.
  Test provider unmount/subscriber independence and stable external snapshots.

### Task 2: Review, diffs and accessible decisions

- [ ] Test then implement diffs across capabilities, all seven contributes keys
  and permissions; missing arrays are empty, Set membership avoids duplicates,
  stable display order, added/removed clear, version a→b. Equal declarations but
  changed digest says “声明没有变化，但代码已更新”.
- [ ] Render this warning **verbatim and uncollapsed**: “信任后，这个插件的代码会以和 Weave 相同的权限在你的电脑上运行。它可以读写你能访问的文件、联网、读取所有会话内容。下面是插件自己的声明，Weave 无法限制进程内插件的实际行为。只信任你了解其来源的插件。” Display identity/version,
  description, directory, first 12 digest characters and keyboard-accessible full
  digest. High impact before medium/low; highlight added high impact entries.
  Use exact §11.2 hook/permission table; unknown hooks/permissions are high and
  explicitly unrecognized. Show providers/services as declarations too.
- [ ] Dialog shell portals to a dedicated document.body child outside #root;
  inert background body children except portal, preserve/restore prior inert
  values, trap Tab/Shift+Tab among enabled controls, focus Cancel initially,
  stop Escape in capture before App's window listener, restore connected enabled
  origin or supplied visible plugin-tab/region fallback after removing inert.
  Clean up on unmount; strict replay must not leak listeners/inert state.
- [ ] Header/risk and action row stay visible with a separately scrolling body
  on short/narrow windows. Buttons type=button; Enter on Cancel never trusts.
  Busy blocks repeat submit; Escape may close after sending without pretending
  to cancel the durable operation (shared store owns completion/error).
- [ ] Disable/revoke say “下一回合起生效”. Only global hasRunningSessions shows
  unchecked “立即生效（取消进行中的回合）”; explain cancellation of all current and
  retired-generation turns. When true→false reset/hide; false→true starts
  unchecked. Submit false if currently no runs. Enable has no dialog/immediate.
- [ ] Tests cover frozen digest after replacement, stale 409 invalidation, all
  diff/risk rules, both Tab directions/Escape/Cancel Enter, restoration when row
  changes, root already inert, panel inert/collapse, pending close/double submit,
  and global run-state transitions resetting the checkbox.

### Task 3: Panel and integration after frozen seams

- [ ] Document contracts before code. Add App-lifetime provider/store and
  hasRunningSessions; update every typed PanelContext fixture. Standalone panel
  tests inject a store/provider; existing App/panel tests answer GET /plugins
  with a read-only fixture so the new startup read does not hit real transport.
- [ ] Origins: builtin, registered, kernel, local, then future encountered order.
  Local statuses: pending-trust, changed, loaded, disabled, failed, invalid,
  incompatible, unknown. Preserve discovery order within status and arrays.
  Key rows by `(origin,id,directory)`; invalid/duplicate/reserved ids and future
  states expose no ambiguous management button.
- [ ] Actions: pending→Review; changed→Review differences/Revoke;
  loaded→Disable/Revoke; disabled→Enable/Revoke; failed→error/Disable/Revoke;
  invalid/incompatible→reason only. Require trustworthy local metadata and
  unambiguous valid id; nonlocal rows read-only. Review must use B's capture.
- [ ] Keep declarations separate from actual provides; show errors and retained
  active digest/generation honestly. Footer: configured directory, missing-dir,
  truncated and host error. Show acceptingRuns/blocked and result.error without
  claiming persisted decisions failed or retained turns lost their plugin.
- [ ] Keep cached rows during reload/error; global pending disables row writes
  and spins/disables Refresh. Add badge to plugin tab and add menu without
  changing panel kind/id. Provide dialog focus fallback to current visible plugin
  tab, then panel region (tabIndex=-1); if whole view vanished use visible App nav.
- [ ] Add `/plugins` and `/commands` proxies to `http://127.0.0.1:4317`. Test
  startup including restored active plugins tab issues GET only/no modal;
  explicit tab/add-menu activation (including already active) POSTs once;
  reopen, Refresh and StrictMode dedup; old Server refresh stays GET; selected
  idle session plus another streaming session supplies global true.
- [ ] Integrate A/B, run focused tests, then Studio lint/typecheck/test/build and
  root `pnpm check`, format:check, diff --check. Fresh review before any requested
  commit/PR; follow the authorized PR/CI/squash workflow after review.

## Browser review and remaining limits

Use a temporary directory outside the repo with explicit databaseFile,
dataDirectory, pluginsDirectory and environment:{}; start real Server/Vite with
mock Provider. No account or user plugin/trust/provider store is needed. Prepare
pending/loaded/disabled/changed/failed/invalid/incompatible fixtures through the
real guarded routes. Verify startup GET-only/badges, explicit reload, keyboard
review and exact digest, real stale409 after editing fixture bytes, directory /
truncation/blocked/result.error rendering, narrow-window scrolling and proxies.
Use two sessions and an abortable fixture tool plus mock `/tool` support to
verify default vs immediate behavior including an inactive streaming session.
Reopen slash picker after publication to see updated commands. Capture ignored
screenshots/network evidence, stop processes and remove temporary stores.

No wire uncertainty remains from 4.4b. Two deliberate scope limits remain:
Studio's global run observation cannot see another HTTP client's turns; in-process
plugin permissions are declarations, so the warning must not imply containment.
The feature does not add a running-count endpoint, automatic polling, or a second
cancellation state machine.

### Task 4: Verification and integration

- [ ] Run independent task reviews and fix concrete findings with behavioral regressions.
- [ ] Run focused Studio tests, lint/typecheck/build and root pnpm check.
- [ ] Verify real temporary Server/Vite in a browser: initial GET, pending badge, explicit reload, trust, stale digest 409, slash command after trust, disable/revoke, global immediate choice, keyboard focus and narrow layout.
- [ ] Run whole-branch independent review; fix findings and rerun relevant checks.
- [ ] Commit Chinese Conventional Commit, push explicit feature branch, open/attach PR, wait for CI and squash merge to main, delete remote feature branch.
