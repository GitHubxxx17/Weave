# Stage 6.3 Studio Plugin Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver local bundled plugin installation and reviewed lifecycle controls in Studio, including Desktop picking and first binding.

**Architecture:** Extend the App-owned PluginCatalogStore and its single write gate with the existing managed HTTP API. Publish the ESM, MCP and managed catalogs together after matching enabled sources. Keep exact requests and durable receipts in App memory, with panel-local draft reviews and a purpose-limited Electron chooser.

**Tech stack:** TypeScript 5.9, ESM, React 19, Zod 4, Vitest, Testing Library, Vite and Electron 39.

**Spec:** [Stage 6.3 Studio design](../specs/2026-11-22-studio-plugin-installer-design.md). The [Stage 6.2d wire contract](../specs/2026-11-22-managed-plugin-installer-api-design.md) and merged Server schemas are authoritative.

## Global Constraints

- Node.js ≥24.4.0，pnpm ≥10.13.1，使用仓库现有 TypeScript、ESM、React 和 Zod。无新增依赖。
- Studio 保持 HTTP/SSE 客户端，禁止导入 `@weave/*`、Server 源码、Node 或 Electron。Desktop Main 仅通过既有 Server 启动接口和受控 IPC 集成。
- 所有外部输入在使用前校验。保留既有 Server 守卫、权限、工具 Pipeline、append-only authority、Generation 和 pinned turn 语义。
- Provider 首次挂载、打开面板、切换面板和程序还原只读 GET。预览和所有管理 POST 由明确的用户事件触发。
- 保持 App 内一套 ESM/MCP/managed 写入门。隐去预览令牌和服务私有路径。精确重试的数据仅保存在 App 内存。
- 使用现有 Plugins 面板和对话框样式与中文标签。按现有惯例在各包 `test/` 中为行为写测试。
- 以实际浏览器、实际 Electron 开发进程、根 `pnpm check` 及 PR CI 验证交付。

The controller begins from a fresh `feat/studio-plugin-installer` branch at updated `origin/main` after Stage 6.2d merged as `39e1c2c` (PR #89). Finalize and check the cross-package design before implementation. Task names below supply Conventional Commit messages if the authorized branch workflow calls for commits.

## File Responsibilities

| Unit         | Files and responsibility                                                                                                                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Studio HTTP  | `managed-plugin-types.ts` mirrors the strict HTTP DTOs. `managed-plugin-api.ts` serializes immutable commands and correlates server receipts. Both live in `apps/studio/src/features/plugins/`.                                                                                                                 |
| Studio Store | `plugin-catalog-store.ts` owns orchestration and requests. `plugin-catalog-observation.ts` contains the stateless generation and authority-head comparisons, in the same directory.                                                                                                                             |
| Studio UI    | The existing `plugins-panel.tsx` owns composition and the reload controls. `managed-plugins-section.tsx` owns candidate/current/receipt rendering and action handoff. `managed-plugin-dialog.tsx` owns the local import and selection review. `managed-plugins.css` contains responsive styles for these views. |
| Desktop      | `desktop-config.ts` resolves the plugin directory and first-binding mode. `main.ts` validates the chooser and supplies Server options. `preload.cts` exposes the chooser purpose, and `apps/studio/src/vite-env.d.ts` types the renderer.                                                                       |
| Acceptance   | `README.md` documents the browser owned launcher and Desktop defaults. Real fixture paths and browser/Electron traces are captured in the acceptance record for the PR.                                                                                                                                         |

---

### Task 1 — Strict managed Studio HTTP client

**Files**

- Create `apps/studio/src/features/plugins/managed-plugin-types.ts` and `apps/studio/src/features/plugins/managed-plugin-api.ts`.
- Create `apps/studio/test/managed-plugin-api.test.ts` and `apps/studio/test/support/managed-plugin-fixtures.ts`.
- Read `apps/server/src/managed-plugin-catalog.ts`, `apps/server/src/managed-plugin-api.ts`, and `packages/plugin/src/manifest.ts` at the merged revision.

**Interfaces**

- Consumes `runtimeApiUrl(path: string): string` and `PluginApiError(code: string, message: string, status: number)`.
- Produces `ManagedManifest`, `ManagedHeads`, `ManagedCatalog`, `ManagedPlugin`, `ManagedCandidate`, `ManagedPreview`, `ManagedMutationResponse`, `ManagedReview` and `PreparedManagedRequest`.
- Produces `fetchManagedCatalog(signal?: AbortSignal): Promise<ManagedCatalogObservation>`, `previewManagedPlugin(sourceDirectory: string, signal?: AbortSignal): Promise<ManagedPreview>`, `prepareManagedRequest(review: ManagedReview, requestId: string): PreparedManagedRequest` and `sendManagedRequest(request: PreparedManagedRequest): Promise<ManagedMutationResponse>`.

```ts
type ManagedCatalogObservation =
  | { readonly kind: 'enabled'; readonly catalog: ManagedCatalog }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'legacy' };

type SelectionReview = {
  readonly pluginId: string;
  readonly expectedInstallSequence: number;
  readonly expectedTrustSequence: number;
};

type ManagedReview =
  | { readonly kind: 'import'; readonly preview: ManagedPreview }
  | (SelectionReview & {
      readonly kind: 'activate';
      readonly digest: string;
      readonly manifest: ManagedManifest;
      readonly previousSelection: string | null;
      readonly intent: 'activate' | 'rollback';
    })
  | (SelectionReview & {
      readonly kind: 'enable';
      readonly selectedDigest: string;
    })
  | (SelectionReview & {
      readonly kind: 'disable' | 'revoke' | 'uninstall';
      readonly selectedDigest: string | null;
      readonly immediate: boolean;
    });

type PreparedManagedRequest = Readonly<{
  url: string;
  body: string;
  requestId: string;
  pluginId: string;
  target: ManagedMutationResponse['decision']['target'];
}>;
```

- [ ] **Red**. Add Fetch table tests for all six durable commands and preview. Assert exact path, method, headers, no query, JSON and preservation of optional host/engines, unsorted arrays and empty declarations. Cover initial activate with null previous selection and rollback with a previous digest. Accept legal committed/uninstall with old active and null selection, and historical replay decision that disagrees with current selection/trust/heads. Reject non-200 successes, wrong status/code pairs, non-JSON 200, unrelated 200, path leaks, unsafe/non-integral sequences and candidate references that do not match. For GET compare explicit disabled, fixed Hono plain-text 404, unknown 404, malformed 200 and valid empty 200. Preview sends path spaces unmodified.

```ts
const prepared = prepareManagedRequest(rollbackReview, 'review-1');
expect(JSON.parse(prepared.body)).toEqual({
  requestId: 'review-1',
  digest: rollbackReview.digest,
  manifest: rollbackReview.manifest,
  previousSelection: rollbackReview.previousSelection,
  expectedInstallSequence: 3,
  expectedTrustSequence: 4,
  intent: 'rollback',
});
await expect(sendManagedRequest(prepared)).rejects.toMatchObject({
  code: 'plugin-invalid-response',
  status: 200,
});
```

- [ ] Run `pnpm exec vitest run apps/studio/test/managed-plugin-api.test.ts` and check the test fails on the missing adapter or its first unimplemented assertion.
- [ ] **Green**. Use strict object schemas throughout managed DTOs. Preserve optional keys and array order. Use positive safe integers for files, Generation id, importSequence, candidateImportSequence, activationSequence, decision operationSequence and non-null installEventSequence/trustEventSequence. Use nonnegative safe integers for bytes, all heads and all expected sequences. Match candidate manifest ID and active plugin ID to the row, selection by candidate import sequence plus digest, trust by current selection digest, and active by any historical digest in the row. Older active and active with no selection are both valid. A fresh receipt's application generation and active must agree with the same ticket's `current` for that plugin. A replay receipt uses its ticket's current active. Historic decision selection, trust and heads are independent of current; do not force equality.
- [ ] **Green for request/response decoding**. Use `preview.candidate.manifest.id` and `preview.candidate.digest` for import correlation. Import body carries only request ID, token and preview install head. Selection moves plugin ID and command into the URL. Serialize once in `prepareManagedRequest`, resolve URL with `runtimeApiUrl`, and freeze target and request. Send stored URL/body without a durable abort signal. Browser URL identifies the Vite proxy entry, while Desktop URL contains the initial loopback port. Accept data only on HTTP 200, mapping any 200 parse, schema or correlation failure to `plugin-invalid-response`. Accept exact Hono text fallback on GET only. Preserve recognized Server status/code pairs using the Stage 6.2d error table plus 403/415 guard pairs, otherwise throw `plugin-request-failed` and preserve status. A Fetch exception uses `plugin-network` and status 0. Abort from the preview call may propagate.

```ts
const url = runtimeApiUrl(`/plugins/managed/${encodeURIComponent(review.pluginId)}/activate`);
const {
  digest,
  manifest,
  previousSelection,
  expectedInstallSequence,
  expectedTrustSequence,
  intent,
} = review;
const body = JSON.stringify({
  requestId,
  digest,
  manifest,
  previousSelection,
  expectedInstallSequence,
  expectedTrustSequence,
  intent,
});
```

- [ ] Run the focused test, `pnpm --filter @weave/studio typecheck` and `pnpm --filter @weave/studio lint`. Confirm unsupported JSON and absent-route cases produce distinct outcomes. Suggested commit `feat: 增加受管插件 HTTP 客户端`.

### Task 2 — App Store catalog consistency and request recovery

**Files**

- Modify `apps/studio/src/features/plugins/plugin-catalog-store.ts`.
- Create `apps/studio/src/features/plugins/plugin-catalog-observation.ts` and `apps/studio/test/managed-plugin-store.test.ts`.
- Update route-aware fetch fixtures in `apps/studio/test/plugin-catalog-store.test.ts`, `apps/studio/test/plugin-catalog-context.test.tsx`, `apps/studio/test/mcp-store.test.ts`, `apps/studio/test/mcp-panel.test.tsx`, `apps/studio/test/mcp-dialogs.test.tsx`, `apps/studio/test/plugins-panel.test.tsx`, `apps/studio/test/plugin-dialogs.test.tsx` and `apps/studio/test/App.test.tsx` and `apps/studio/test/panel-tabs.test.tsx` wherever the App or Provider fetches catalogs; answer exact `/plugins/managed` GET for pre-existing scenarios without altering their write counts. Share a narrow disabled observation fixture if used by multiple files.

**Interfaces**

- Consumes `fetchManagedCatalog()`, `previewManagedPlugin(sourceDirectory, signal?)`, `prepareManagedRequest(review, requestId)`, `sendManagedRequest(prepared)` and their types from Task 1. Consumes existing `fetchPluginCatalog()`, `fetchMcpCatalog()`, `reloadPlugins()`, `reloadMcpServers(expectedSequence)`, and the existing read/write gates.
- Produces `store.previewManaged(sourceDirectory: string, signal?: AbortSignal): Promise<ManagedPreview>`, `store.submitManaged(review: ManagedReview): Promise<ManagedAttemptOutcome>`, `store.retryManaged(): Promise<ManagedAttemptOutcome>` and `store.stopTrackingManaged(): Promise<void>`. Existing `ensureLoaded()`, `refresh()` and `reload()` signatures stay. Import review uses `preview.expectedInstallSequence`. Every selection uses `expectedInstallSequence` and `expectedTrustSequence`.
- Exposes `managed: ManagedCatalogObservation | undefined`, `managedUnresolved: ManagedAttemptContext | undefined`, `managedLastResult: ManagedMutationResponse | undefined`, `managedLastRejection: ManagedRejection | undefined`, `managedReviewRequiredId: string | undefined`, `sharedManagementBlocked: boolean`, `canRecoverManagedLag: boolean`, availability reason `'managed-authority-lag'`, and `pendingOperation.source` with `'managed'` and kinds `'import' | 'activate' | 'uninstall'`. Keep the prepared request private. Store derives `sharedManagementBlocked` from consistency, active reservation and unresolved slot before publishing each snapshot.

```ts
type ManagedAttemptContext = Readonly<{
  pluginId: string;
  target: ManagedMutationResponse['decision']['target'];
  error: PluginApiError;
}>;

type ManagedRejection = ManagedAttemptContext &
  Readonly<{
    recovery: 'none' | 'review' | 'preview' | 'retry-review' | 'activate';
  }>;

type ManagedAttemptOutcome =
  | { readonly kind: 'saved'; readonly response: ManagedMutationResponse }
  | ({ readonly kind: 'unresolved' } & ManagedAttemptContext)
  | ({ readonly kind: 'rejected' } & ManagedRejection)
  | { readonly kind: 'not-sent'; readonly error: PluginApiError };
```

Apply the following closed table after an actual durable send. Wrong commands or status mismatches fall through to the final row.

| Status/code                                                                                                                                         | Command                                      | First send | Exact retry | Rejection recovery                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------- | ----------- | ----------------------------------------- |
| 200 validated and correlated                                                                                                                        | any                                          | saved      | saved       | none                                      |
| 400 `plugin-invalid-request`, 403 `forbidden-origin`, 404 `plugin-installer-disabled`, 413 `plugin-request-too-large`, 415 `unsupported-media-type` | any                                          | rejected   | unresolved  | none                                      |
| 409 `plugin-authority-request-conflict`                                                                                                             | any                                          | rejected   | rejected    | none                                      |
| 409 `plugin-preview-stale` or `plugin-managed-id-conflict`                                                                                          | import                                       | rejected   | rejected    | preview                                   |
| 409 `plugin-managed-namespace-unavailable` or `plugin-artifact-capacity`                                                                            | import                                       | rejected   | rejected    | retry-review                              |
| 409 `plugin-authority-conflict`                                                                                                                     | import                                       | unresolved | unresolved  | none                                      |
| 409 `plugin-authority-conflict` or 404 `plugin-authority-not-found`                                                                                 | activate, enable, disable, revoke, uninstall | rejected   | rejected    | review                                    |
| 409 `plugin-authority-activation-required`                                                                                                          | enable                                       | rejected   | rejected    | activate                                  |
| 409 `plugin-artifact-unavailable`                                                                                                                   | import, activate, enable                     | rejected   | rejected    | preview for import, review for selections |
| Transport, invalid 200, all 5xx, every other combination                                                                                            | any                                          | unresolved | unresolved  | none                                      |

- [ ] **Red for reads**. First emit mismatched blocked presence under the same generation, then a matching set whose managed `blocked` text differs from ESM/MCP. Confirm only the complete second set publishes. Repeat with mismatched ESM/MCP block details and recovery after three rounds. For mutation response with heads `{2,4,8}` and generation 7, assert a later same-generation GET `{3,4,7}` never publishes despite the increased install head. Then accept `{2,4,9}` at generation 7 and show no MCP epoch change. Assert disabled and exact legacy are acceptable initially but loss of previously confirmed managed capability preserves the old directory.

```ts
expect(store.getSnapshot().managedLastResult?.decision.requestId).toBe(requestId);
await expect(store.refresh()).rejects.toMatchObject({
  code: 'catalog-managed-authority-lag',
});
expect(store.getSnapshot().managed).toBe(acceptedManaged);
expect(store.getSnapshot().consistency).toEqual({
  kind: 'unavailable',
  reason: 'managed-authority-lag',
});
```

- [ ] **Red for writes**. After an import no-op loses its response, let GET succeed and assert Store still rejects manual, MCP PUT/DELETE and preview with no Fetch calls. Remount a subscriber and replay after expiry and source removal, with GET failing. Check identical URL/body, typed saved outcome, retained receipt and cleared slot. Table-test each classification row including guard/disabled on a first send versus retry, stale token on retry, wrong status/command, and import versus activation authority conflict. Check typed outcome still returns the initiating command's error after reconciliation, and legacy handoff still targets the caller ID after reconciliation. Exercise an older in-flight GET and reentrant `ensureLoaded()` / `refresh()` during a write, including initial-load from inside the gate. Abandonment reserves the GET before ready can publish. For recovery, start with cached MCP disabled, return fresh enabled MCP plus a different authority head, and assert only MCP reload with the newly read head. Check exact disabled fallback and unrelated inconsistency suppressing POST.
- [ ] Run `pnpm exec vitest run apps/studio/test/managed-plugin-store.test.ts apps/studio/test/plugin-catalog-store.test.ts apps/studio/test/mcp-store.test.ts` and confirm failures concern the new behavior.
- [ ] **Green for reads**. Split comparisons into `sameLegacyGeneration(a,b)`, `sameManagedGeneration(a,b)` and `managedHeadsAtLeast(candidate, confirmed)` in the observation module. Use `Promise.allSettled` per concurrent round. Reuse mutation seeds only on round zero. Public `ensureLoaded()` and `refresh()` defer new reads until the write and its reconciliation settle. Gate internals initialize and reconcile through a private read entry that never waits on its own write promise. Explicit refresh probes all three sources, including MCP previously disabled. Diagnose lag only after fresh ESM/MCP match, managed generation/admission match and capability checks succeed. If round zero’s seed is low, use real GET before interpreting persistent lag. Leave old complete snapshot on exhaustion and publish the appropriate consistency reason. Keep acknowledged heads separate from the last complete display catalog.

```ts
return (
  candidate.installSequence >= confirmed.installSequence &&
  candidate.trustSequence >= confirmed.trustSequence &&
  candidate.operationSequence >= confirmed.operationSequence
);
```

- [ ] **Green for writes**. Reserve the shared gate before invoking subscribers. Ordinary writes require ready and no unresolved request, with source-specific checks. Recheck managed review heads after older reads and generate UUID once before first send. Check the public shared gate in `previewManaged()` before calling the detached API; once dispatched, the preview finishes independently. Inside an already reserved ordinary write, check readiness, unresolved state and review conditions without rejecting its own reservation; its signal is scoped to preparation. Publish a correlated 200 receipt and advance only non-decreasing `current` before reconciliation. Classify a sent failure using the exact table and return the per-attempt outcome after reconciliation, preserving the original response or error. Publish confirmed rejection and remediation for a retry even if the dialog closed. Retry awaits older reads under the same gate, ignores their failures, and sends saved request without ready, capability or review expiry checks. Legacy `trust/setEnabled/revoke` captures its caller's ID for `managedReviewRequiredId` on managed-review-required; keep that ID through GET reconciliation. Clear it on the next deliberate legacy mutation attempt, or replace it with that attempt's managed-review-required ID.
- [ ] **Green for reload and exit**. Explicit lag `reload()` rereads all three without seeds. Both the current classification and the fresh source capabilities matter: use new MCP 200 with exact legacy generation pair and new `authoritySequence`, or new explicit MCP-disabled 404 plus local ESM for fallback. Require ready or lag as the only incompatibility. A cached unavailable MCP flag cannot choose the route. Keep the existing read-only fallback without a manager. Block reload while unresolved. `stopTrackingManaged()` clears only after the UI's explicit confirmation and reserves a fresh read before opening ordinary writes.
- [ ] Run the focused tests from Red and `pnpm --filter @weave/studio test`, then Studio typecheck and lint. Suggested commit `feat: 协调受管插件目录和精确请求重试`.

### Task 3 — Managed section and review dialogs

**Files**

- Create `apps/studio/src/features/plugins/managed-plugins-section.tsx`, `apps/studio/src/features/plugins/managed-plugin-dialog.tsx`, and `apps/studio/src/features/plugins/managed-plugins.css`.
- Modify `apps/studio/src/features/plugins/plugins-panel.tsx`, `apps/studio/src/features/mcp/mcp-panel.tsx` and `apps/studio/src/vite-env.d.ts`. Reuse existing ESM/MCP confirmation props, the PluginDialog focus shell and review markup.
- Add `apps/studio/test/managed-plugins-panel.test.tsx`; extend `apps/studio/test/App.test.tsx` for explicit panel reopening/restoration and `apps/studio/test/mcp-panel.test.tsx` for blocked controls.
- Review fix scope: modify `apps/studio/src/app/app.css` for a reachable narrow-screen activity panel and `apps/studio/src/features/plugins/plugin-dialog.tsx` for a labelled keyboard-scrollable body and valid focus restoration. Extend shared modal and managed panel tests for complete manifest review, deferred-preview focus, and stop-tracking completion followed by GET failure.

**Interfaces**

- Consumes `ManagedReview`, `ManagedCatalogObservation`, `ManagedMutationResponse`, `ManagedAttemptOutcome` and App Store methods `previewManaged(sourceDirectory, signal?)`, `submitManaged(review)`, `retryManaged()`, `stopTrackingManaged()`, `refresh()`, `reload()`. Consumes Store's `managed`, `managedUnresolved`, `managedLastResult`, `managedLastRejection`, `managedReviewRequiredId`, `sharedManagementBlocked`, `canRecoverManagedLag` and `pendingOperation`.
- Produces `<ManagedPluginsSection getFallbackFocus={...} />`, with prop `readonly getFallbackFocus: () => HTMLElement | null`. It uses the same Store context. The Plugins panel filters a base `kernel` row only when the same complete snapshot has a managed published member with its ID. The section takes `provides` from that exact base row. Other `origin` rows remain.
- Produces optional Studio bridge fields `pluginDirectoryPicker?: true` and `pickDirectory?: (purpose?: 'project' | 'plugin-import') => Promise<{ readonly path: string; readonly name: string } | null>`. Existing no-arg project calls remain.

- [ ] **Red**. Mount a populated Store through the actual Plugins panel and simulate previewing one path then changing input before its deferred response. Assert only the later review renders, exact path is preserved and mounting/opening/restoration cause zero writes. The old bridge has no plugin picker; the capability-marked bridge sends the exact purpose. Null cancellation, invalid runtime result and result arriving after path edits leave the input unchanged and do not send preview. Assert two equal digests with different activation sequences show divergent selection and publication. Verify initial activation with null prior selection and rollback with an existing previous digest, expiry feedback, terminal stale vs recoverable namespace failure, managed `kernel` row dedup and a same-ID manual row remaining visible.

```ts
fireEvent.click(screen.getByRole('button', { name: '回退' }));
fireEvent.click(screen.getByRole('button', { name: '确认回退' }));
await waitFor(() => expect(activateBodies).toHaveLength(1));
expect(activateBodies[0]).toMatchObject({
  intent: 'rollback',
  previousSelection: digestV2,
  digest: digestV1,
});
```

- [ ] **Red for recovery and accessibility**. Confirm locally stale and recoverable reviews stay open, while an ambiguous submission retires the draft and unmount/remount preserves the retry prompt. When GET returns ready during ambiguity, all ESM/MCP/managed write controls and already-open confirms stay disabled, including MCP PUT/DELETE and new preview. GET stays usable through an independent refresh control even when consistency is ready and the unresolved slot remains. Restart the panel and simulate rejected retry with recoverable namespace error, assert a new preview control is offered. Test a failed or replayed receipt with one actual identity while a later GET shows another. Both remain visible with different labels. Verify legacy handoff targets the caller ID even after reconciliation. Uninstall preserves candidate history. Verify keyboard focus, tab, Escape, and explicit lag reload via real control names.
- [ ] Run `pnpm exec vitest run apps/studio/test/managed-plugins-panel.test.tsx apps/studio/test/plugins-panel.test.tsx apps/studio/test/mcp-panel.test.tsx apps/studio/test/App.test.tsx` and confirm the relevant Red assertions fail.
- [ ] **Green**. Build the panel with history, selected/trust/actual identities, availability and durable status. Use `sharedManagementBlocked` for ESM/MCP/managed action and confirmation controls, including writes from still-open dialogs. Use separate GET and retry/recovery conditions. Launch previews and writes only from event handlers. Use a revision for picker, preview, edits and unmount to reject outdated returns. Only the short-lived preview receives an abort signal. A native picker is offered only with the literal capability and a callable method. Decode result using strict Zod `{path,name} | null`, with non-empty name and absolute POSIX or full Windows path (drive or UNC) without NUL. Keep the raw valid path. Manual path entry uses Server rules as the final platform boundary.

```tsx
const selectedIsPublished =
  row.selection !== null &&
  row.active !== null &&
  row.selection.digest === row.active.digest &&
  row.selection.activationSequence === row.active.activationSequence;
const outcome = managedLastResult?.application.status;
```

- Final review correction: keep disable, revoke and uninstall available for sticky managed rows after ordinary decisions, including null selection/trust/active. New immediate no-op decisions can cancel retired pins. Confirmations must disclose Server-wide running-turn cancellation rather than plugin-only cancellation; preserve existing Server semantics and default false. Add regression coverage for repeat commands and the global-effect copy.
- [ ] Use the existing modal behavior and Chinese action copy. Show full digest with wrap, file/byte counts on preview, candidate version and import time. Only destructive commands carry immediate, default false. Switch on the returned per-attempt outcome: keep local review on not-sent or recoverable rejection, dismiss on saved or unresolved, and show the rejection's recovery action. For mounted/reopened panels, use Store's durable rejection to offer a new preview when the prior dialog is gone. `retryManaged` and `stopTrackingManaged` each require their own action. Label refresh separately from lag reload. Render receipt decision and receipt-time published member independently from the latest panel catalog; committed uses `application.active` and replayed uses its own `current`. Locate the managed handoff using `managedReviewRequiredId`; the legacy review never authorizes the new command.
- [ ] Run the focused tests, `pnpm --filter @weave/studio test`, Studio typecheck, lint and build. Suggested commit `feat: 增加 Studio 受管插件安装界面`.

### Task 4 — Desktop chooser and managed store first binding

**Files**

- Modify `apps/desktop/src/desktop-config.ts`, `apps/desktop/src/main.ts`, and `apps/desktop/src/preload.cts`.
- Update `apps/desktop/test/desktop-config.test.ts`, `apps/desktop/test/main.test.ts`, and `README.md`.

**Interfaces**

- Consumes `startServer(0, StartServerOptions)` with existing `pluginsDirectory?: string | false` and `managedPluginStore?: {readonly initialBinding: 'allow-unbound' | 'require-bound'}`. Reads config from the same environment passed to `createDesktopConfig({userDataDirectory, environment})`.
- Produces `DesktopConfig.pluginsDirectory: string` and `DesktopConfig.allowInitialManagedPluginBinding: boolean`. New Preload exposes `pluginDirectoryPicker: true` and implements `pickDirectory(purpose?: 'project' | 'plugin-import'): Promise<PickedDirectory | null>`. Keeps `handlePickDirectory(event, studioOrigin, ...pickerArgs: unknown[]): Promise<PickedDirectory | null>` and `weave:pick-directory`.

- [ ] **Red**. Test default resolves `join(userDataDirectory,'plugins')` and passes `managedPluginStore: {initialBinding:'allow-unbound'}` plus the explicit directory. Test absolute, relative and empty overrides are passed verbatim to Server with no managed option. Main picker tests assert no-arg and explicit project calls keep current title/properties, plugin purpose removes createDirectory and a filesystem root yields a nonempty fallback name, bad origin and bad/extra parameters never open the dialog, and cancel returns null. Mock Server rejection for the empty override and assert the existing startup error is visible, with no window creation.

```ts
await handlePickDirectory(trustedEvent, config.studioOrigin, 'plugin-import');
expect(mocks.dialog.showOpenDialog).toHaveBeenCalledWith({
  title: '选择已打包的插件文件夹',
  properties: ['openDirectory'],
});
await expect(
  handlePickDirectory(trustedEvent, config.studioOrigin, 'plugin-import', {}),
).resolves.toBeNull();
```

- [ ] Run `pnpm exec vitest run apps/desktop/test/main.test.ts apps/desktop/test/desktop-config.test.ts` and confirm the new behavior is missing.
- [ ] **Green**. Use `z.string().optional()` for override input. Pass actual override verbatim, including an empty string or relative path. Server resolves relative values against its cwd and rejects an empty value through existing validation. Only a missing override selects `<userData>/plugins` and permits first binding. Keep `userData`, database selection, Server origin, random port, Provider codec and startup error handling. Main checks sender origin first, then a Zod union of empty arguments or exactly one closed-purpose argument, and calls the existing native dialog. For plugin import only, return `basename(folderPath) || folderPath` as name so a selected filesystem root meets renderer validation, while project results remain unchanged. The new Preload advertises `pluginDirectoryPicker: true` and omits an undefined purpose argument. Verify project calls still use zero arguments.

```ts
const pickerArgsSchema = z.union([z.tuple([]), z.tuple([z.enum(['project', 'plugin-import'])])]);
const override = parsed.pluginsDirectory;
const pluginsDirectory = override ?? join(userDataDirectory, 'plugins');
const allowInitialManagedPluginBinding = override === undefined;
```

- [ ] Document browser and Desktop availability in README. For Browser, use the existing Server module rather than adding a new CLI/environment flag. Example launcher after `pnpm --filter @weave/server... build`, invoking from repo root with a real absolute isolated profile:

```bash
WEAVE_TEST_PROFILE=/absolute/isolated/profile node --input-type=module -e '
  import { join } from "node:path";
  import { startServer } from "./apps/server/dist/main.js";
  const dataDirectory = process.env.WEAVE_TEST_PROFILE;
  const server = await startServer(4317, {
    dataDirectory,
    databaseFile: join(dataDirectory, "weave.sqlite"),
    pluginsDirectory: join(dataDirectory, "plugins"),
    studioOrigin: "http://127.0.0.1:5173",
    managedPluginStore: { initialBinding: "allow-unbound" },
  });
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, async () => {
    try { await server.stop(); } catch (error) { console.error(error); process.exitCode = 1; }
  });
'
```

- [ ] Run the focused tests, `pnpm --filter @weave/desktop test`, Desktop typecheck and lint, and `pnpm --filter @weave/desktop... build`. Suggested commit `feat: 接入桌面插件目录选择和首次绑定`.

### Task 5 — Real Browser and Electron acceptance

**Files**

- Read `apps/server/test/support/managed-plugin-composition-fixture.ts` for the existing `writeFixturePlugin` pattern and `apps/server/test/fixtures/mcp-studio-server.mjs` for safe MCP evidence.
- Keep process harnesses, version fixture roots and traces in a temporary test directory. Reference browser and Electron results in the PR. Scope docs edits to factual corrections discovered during acceptance.

**Interfaces**

- Consumes shipped Studio UI, six existing managed writes plus preview, three GET catalogs, `startServer(...)`, and the genuine Electron app entry `apps/desktop/dist/main.js`.
- Produces reproducible acceptance evidence: profile and fixture layout, exact process startup mode, method/path trace, marker checks, results before/after restart, focused package checks, root check and PR CI.

- [ ] Arrange a failing fixture signal before the positive cycle. Build two versions of one bundled ESM ID using the existing fixture pattern. Use a different execution marker per version and a third version with setup failure. Place all bundled sources outside both plugin roots; start with no markers. Assert a pre-activation fixture check would fail on a marker appearing during preview/import and an active-version check would fail if import v2 replaced v1. Use TypeScript Server tests as the authority for pinned retired turn assertion. The fixture manifest has declared contributions/permissions, a deterministic tool body and no dependencies.
- [ ] **Browser.** Start the Task 4 launcher on 127.0.0.1:4317 in a clean isolated profile and run `pnpm --filter @weave/studio dev --port 5173 --strictPort`. Visit `http://127.0.0.1:5173`, the exact configured Studio origin, through the real Vite proxy. Record requests when restoring and reopening Plugins. Type a source path and confirm no marker after preview or import. Activate v1, verify actual tool and marker, import v2 and verify marker absence/continued v1. Activate v2, then explicitly roll back v1 and verify intent, ID and previous digest. Uninstall, confirm selection/trust absence and history retention. Exercise ordinary ESM/MCP controls and verify the shared write gate. For application failure, activate the setup-failure fixture and verify a valid 200 with fixed issue, saved selection and distinct actual state. Verify 360×640 and 640×420 capture and focus/tab/Escape with no horizontal document overflow.
- [ ] **Browser retry and stale catalog with live Server.** Forward one managed POST to the real Server and then fail delivery of its known successful response. Verify a close/reopen leaves one retry control and all ordinary writes disabled even when GET succeeds. Temporarily reject or skew one catalog response during reconciliation to verify the previous whole directory remains visible. Capture both URL/body pairs, assert exact match, and validate replay decision sequence and unchanged application side effects. Include a duplicate import no-op with unchanged install/trust heads when proving the ambiguity cannot be resolved by catalog content alone.
- [ ] **Electron dev process.** Run the existing build with `pnpm --filter @weave/desktop run rebuild` and `pnpm --filter @weave/desktop... build`. Reuse the fresh development Vite endpoint. Launch the installed Electron executable with an isolated dev-process launcher that sets `app.setPath('userData', canonicalTemporaryDirectory)` before dynamically importing the real `apps/desktop/dist/main.js` entry. Use a tmp app package with `main.mjs` as its entry if required by the Electron launch command. Check `app.getPath('userData')` points at that temp directory before the import. Clear `WEAVE_PLUGINS_DIR` for the first run. Use actual system chooser cancel/select, verify idle/absolute path, and execute import v1, activate v1, import v2 inert, activate v2, rollback v1. Verify the managed store initializes under this profile and HTTP targets its random loopback endpoint. Quit normally, restart the same temporary profile with the source directories removed, verify v1 and candidate history, then uninstall and verify retained history. Check that a deliberately incorrect root on the same profile, or a second process on the bound root, reaches the established startup failure. Also check a new custom-override profile stays ordinary ESM without creating a managed root. Use actual desktop app reads for these checks and record the processes used.
- [ ] **Regression and CI.** Run `pnpm --filter @weave/studio test`, `pnpm --filter @weave/desktop test`, `pnpm --filter @weave/server test` and `pnpm check`. Fix verified defects through the relevant focused Red/Green test, rerun the affected acceptance case, and rerun root checks after fixes. Verify PR CI on the final submitted revision before merge. Record which checks ran in the development process; installer package validation is a separate activity.

## Coverage and source review

Tasks 1 and 2 cover DTOs, observations, single gate and recovery. Task 3 covers the user approval and visibility path. Tasks 4 and 5 cover first bind and actual desktop/browser behavior. React handlers own interaction-triggered POSTs, render derives review readiness, and GETs in one round start together. Retain review fixture evidence and concise PR acceptance notes.

Product principles use the approved links in [Foundation](../../architecture/foundation.md#product-references). [Codex binding tests](https://github.com/openai/codex/blob/bfe3c825702e9235a631a1db58f291bed7a44cfe/codex-rs/codex-mcp/src/binding_tests.rs) · [Kiro MCP configuration](https://kiro.dev/docs/mcp/configuration/) · [Kiro requirements-first](https://kiro.dev/docs/specs/feature-specs/requirements-first/) · [DeepSeek Harness HMR](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/boot/hmr/README.md).
