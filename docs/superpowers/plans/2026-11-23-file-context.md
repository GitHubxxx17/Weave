# Project File Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add explicit project file references through `@` selection and the file tree, freeze exact file snapshots before durable queue acceptance, and render those snapshots faithfully before model context budgeting.

**Architecture:** Protocol owns relative reference/summary values; Session owns one accepted capture bundle and its projections; Runtime owns rooted capture, idempotent admission and rendering. Server resolves trusted Project membership and composes the capture port; Studio owns path-only drafts and independent HTTP schemas. Existing queue, Tool Pipeline, approval and Generation ownership remain authoritative.

**Tech Stack:** TypeScript ESM strict, Zod 4, Node fs/crypto, React 19, existing Vitest/Testing Library, pnpm/Turborepo. No dependency additions.

**Spec:** `docs/superpowers/specs/2026-11-23-file-context-design.md`. Official source links and checked revisions are recorded in that design.

## Global Constraints

- 消息队列 PR 通过 CI 并合入 main 后，才从最新 `origin/main` 创建 `feat/file-context`；不继续 `feat/message-queue`。
- 本 PR 只做当前项目的完整 UTF-8 文本文件，不混入联网、语义检索、目录、glob、行范围或新上传系统。
- 最多 8 个文件，每个最多 64 KiB（65,536 字节），合计最多 256 KiB（262,144 字节）。整批接受或拒绝；不截断、不跳过文件。
- Browser 只提交相对 paths，不接受 captured content/hash/root/identity。路径最大 1024 个 JavaScript UTF-16 code units，拒绝 Unicode Cc/Cf/Cs/Zl/Zp 与路径禁用形式；候选查询最大 256 字符、展示最多 20 项。
- Logical digest 包含有序 file refs，排除 capture。durable request replay 在 capture、sampling、capacity 和 runnable 检查前完成。
- accepted 内只有一份 body；metadata/queue/SSE/Session detail 仅 summary。append-only facts 不被后续 FS 变化改写。
- 实际 model text 必须在 buildModelContext 和最终 middleware budget gate 前出现；user file text overflow 必须失败，provider 调用为零。
- Session/Agent/Tool Pipeline/Plugin 与 Generation 边界不变，Studio 不导入任何 `@weave/*`、Node 或 Electron。
- Tests 放在 package/app 的 `test/`。提交仅按该会话已授权的独立分支/PR workflow 进行。

## File map and task graph

| Unit                                                          | Responsibility                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/protocol/src/file-context.ts`                       | Strict pure FileReference / FileAttachmentSummary values       |
| `packages/session/src/file-context.ts`                        | CapturedFileContext schema, UTF-8 integrity, summaries         |
| `packages/session/src/file-context-projection.ts`             | Join accepted capture with exact started user messages         |
| `packages/runtime/src/workspace-file-capture.ts`              | Bounded rooted regular-file read, exact bytes, abort/guards    |
| `packages/runtime/src/file-context-render.ts`                 | Deterministic v1 model text and history mapping                |
| `apps/server/src/agent-file-context.ts`                       | Trusted Project/Session/root resolution around Runtime capture |
| `apps/studio/src/features/file-context/file-context-types.ts` | Independent HTTP file ref/summary schema                       |
| `apps/studio/src/features/file-context/file-mention.ts`       | Pure active `@` token parsing and candidate ranking            |
| `apps/studio/src/features/file-context/use-file-picker.ts`    | Owner-keyed cancellable path-only discovery/picker state       |
| `apps/studio/src/features/file-context/file-picker.tsx`       | Accessible candidate menu                                      |
| `apps/studio/src/features/file-context/file-attachments.tsx`  | Composer removable refs and history summary tags               |

Task 0 precedes all implementation. Protocol/Session 的文件和 exports 由同一 owner 修改；Runtime 的 agent-execution-types.ts（error union/options/snapshot）及 index.ts 由同一 Runtime contracts owner 修改，capture/admission owner 之间不并发编辑它们。renderer 为 Runtime internal helper，不需要新增 public export。 Task 1 的类型契约先冻结；Task 1 与 Task 2 可按下述文件所有权并行编辑，Task 2 的联编验证等待 Task 1 exports/build。Task 3/4/5 使用 Task 1 的最终导出，capture Task 2 与 renderer Task 4 可独立推进。 Task 3 admission consumes 2; Task 5 composition consumes 1/2/3/4. Studio draft Task 6 may proceed after 1 using mirrored schema; picker Task 7 consumes 6, display Task 8 consumes 1/3/5/6. Task 9 verifies the complete flow. Keep each file focused; do not rewrite the large App or scheduler for unrelated cleanup.

### Task 0: Rebase the planned work onto completed queue main and document contracts

**Files:**

- Create: `docs/superpowers/specs/2026-11-23-file-context-design.md`
- Create: `docs/superpowers/plans/2026-11-23-file-context.md`
- Modify: `docs/architecture/foundation.md`
- Read: `docs/adr/0001-foundation-vertical-slice.md`, `docs/superpowers/specs/2026-11-14-weave-foundation-design.md`, merged message queue spec.

**Interfaces:** Consumes merged queue APIs and exact-retry invariants. Produces the cross-package design that every later task follows.

- [x] Confirm queue PR is MERGED with final green CI, working tree clean, and fetch latest `origin/main` using safe-git-workflow. Use existing suitable managed checkout or create a new isolated one; start `feat/file-context` from `origin/main`. Do not move unfinished queue edits into it.
- [x] Copy reviewed `/tmp` design/plan to the named docs paths, replace the plan Spec path, and update foundation: accepted.fileContext, captureFiles port, renderer-before-budget, summary-only surfaces, official pinned links and explicit safety tradeoffs.
- [x] Compare actual merged `execution-*`, projection, Studio owner, and Generation APIs with this plan. Retarget line locations and preserve any queue terminal-view fix; do not undo later queue changes to match older draft snippets.
- [x] Run `pnpm format:check` for the docs and `git diff --check`. If the session workflow authorizes checkpoints, suggested Conventional Commit: `docs: 明确项目文件引用与快照契约`.

### Task 1: Define strict reference/capture values and durable projections

**Files:**

- Create: `packages/protocol/src/file-context.ts`, `packages/protocol/test/file-context.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/session/src/file-context.ts`, `packages/session/src/file-context-projection.ts`, `packages/session/test/file-context.test.ts`
- Modify: `packages/session/src/execution-events.ts`, `packages/session/src/projection.ts`, `packages/session/src/index.ts`
- Test regression: `packages/session/test/execution-queue.test.ts`, `packages/session/test/projection-cache.test.ts`

**Interfaces:** Produces `fileReferenceSchema`, `fileReferencesSchema` (1..8, unique path), `fileAttachmentSummarySchema` and types in Protocol; `capturedFileContextSchema`, `fileAttachmentSummaries(context)`, `projectMessageFileContexts(events)` in Session. Add logical `AgentExecutionInput.files?`, accepted `fileContext?`, `SessionMessage.fileAttachments?`, and queue metadata `fileCount`.

- [x] Write failing Protocol tests covering canonical path forms and wire exclusivity. Include these table cases and multibyte/space names:

```ts
it.each([
  "../x",
  "a/../x",
  "/x",
  "C:/x",
  "a\\x",
  "a//x",
  "./x",
  "a\0x",
  "file:x",
])("rejects unsafe reference %j", (path) => {
  expect(fileReferenceSchema.safeParse({ path }).success).toBe(false);
});
it("accepts a real relative filename and rejects supplied content", () => {
  expect(fileReferenceSchema.parse({ path: "src/中文 file.ts" })).toEqual({
    path: "src/中文 file.ts",
  });
  expect(
    fileReferenceSchema.safeParse({ path: "a", content: "forged" }).success,
  ).toBe(false);
});
```

- [x] Write a self-contained accepted-payload test with valid capture, then alter digest/size/order/count/missing bundle/extra fields. Test omitted files is legacy-compatible and `files:[]` is rejected. For valid bytes use Node SHA-256 from exact UTF-8 text, not repeated dummy content digests:

```ts
const content = "\uFEFFline\r\n";
const bytes = Buffer.from(content, "utf8");
const capture = {
  version: 1,
  projectId: "p",
  rootIdentity: "a".repeat(64),
  files: [
    {
      path: "a.txt",
      encoding: "utf-8",
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content,
      fileIdentity: "b".repeat(64),
    },
  ],
} as const;
expect(capturedFileContextSchema.parse(capture)).toEqual(capture);
expect(
  capturedFileContextSchema.safeParse({
    ...capture,
    files: [{ ...capture.files[0], byteLength: bytes.length - 1 }],
  }).success,
).toBe(false);
```

- [x] Run the two new tests before implementation and confirm missing exports/behavior fail. Implement pure Protocol schema; Session validates actual UTF-8 byte counts, cap sum, digest, round-trip and NUL. Add equality refinement between logical refs and capture; files acceptance requires queued dispatch + runInput, with existing effective sampling invariant unchanged.
- [x] Add summary-only projection state for pending accepted message bindings. On exact turn.started bind summaries to its user message; wrong execution/turn/user IDs or duplicate ownership fail. Clear pending metadata when an unstarted item finishes. Implement `projectMessageFileContexts` by joining validated accepted facts with exact started user message IDs; unstarted queue items return no history contexts.
- [x] Replace queue metadata rest spread with explicit allowlisted metadata (or explicitly omit fileContext in both type and runtime). Prove JSON of queue projection contains fileCount but not unique file text/rootIdentity/fileIdentity. Compare full replay and incremental cache after acceptance/claim/start/cancel.
- [x] Build exports and run focused tests plus old queue/projection tests:

```bash
pnpm --filter @weave/session... build
pnpm exec vitest run packages/protocol/test/file-context.test.ts packages/session/test/file-context.test.ts packages/session/test/execution-queue.test.ts packages/session/test/projection-cache.test.ts --maxWorkers=4
```

Expected: all pass; no `@weave/runtime` import from Session. Suggested checkpoint: `feat: 增加文件引用与不可变快照事件契约`.

### Task 2: Implement rooted bounded UTF-8 capture

**Files:**

- Create: `packages/runtime/src/workspace-file-capture.ts`, `packages/runtime/test/workspace-file-capture.test.ts`
- Modify (same Runtime contracts owner): `packages/runtime/src/index.ts`, `packages/runtime/src/agent-execution-types.ts`（新增设计中的 file error codes）
- Reuse without semantic changes: `workspace-policy.ts`, `workspace-mutation.ts`
- Regression tests: `packages/runtime/test/safe-file-undo.test.ts`, `packages/runtime/test/workspace-file-tools.test.ts`

**Interfaces:** Produces `captureWorkspaceFiles(root: string, files: readonly FileReference[], options: {readonly signal: AbortSignal}):Promise<Omit<CapturedFileContext,'projectId'>>`. Throws the stable `AgentExecutionError` codes defined by design; this task adds those codes to the existing union before using them. No dependency on Server/Hono/ProjectStore.

- [x] Write failing temp-directory tests for exact caps and UTF-8 preservation. Every fixture closes handles and recursively removes its own mkdtemp root. Include this core assertion:

```ts
const root = await mkdtemp(join(tmpdir(), "weave-file-context-"));
try {
  await writeFile(join(root, "a.txt"), Buffer.from("\uFEFF中文\r\n", "utf8"));
  const result = await captureWorkspaceFiles(root, [{ path: "a.txt" }], {
    signal: new AbortController().signal,
  });
  expect(Buffer.from(result.files[0]!.content, "utf8")).toEqual(
    await readFile(join(root, "a.txt")),
  );
  await writeFile(join(root, "a.txt"), Buffer.alloc(65_537, 0x61));
  await expect(
    captureWorkspaceFiles(root, [{ path: "a.txt" }], {
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "execution-file-too-large" });
} finally {
  await rm(root, { recursive: true, force: true });
}
```

- [x] Run and observe the missing helper failure. Implement root queue admission inside `withWorkspaceMutation`, strict lexical recheck, every-component lstat, no symlink, single-link regular final file and positive birthtime object identity.
- [x] Implement final `open(O_RDONLY | O_NOFOLLOW | O_NONBLOCK)`, handle fstat identity comparison, loop into cap+1, aggregate count, strict BOM-preserving decoder/byte round-trip/NUL check/hash, post-read metadata and component/root checks, finally-close and abort checkpoints. Derive file identity from opened metadata, never later pathname stat. Do not call viewer or paginating read tool.
- [x] Add deterministic races using a Vitest mock around `node:fs/promises` that delegates real I/O and pauses a specific `open`/`stat` via test-owned promises; replace a parent/root/file only while paused. Add unsupported no-follow/nonblock flag fail-closed, symlink inside/outside root, symlink parent, directory, missing, FIFO where supported, hardlinks/alias identity, file growth/read mutation, root mutation queue serialization, aborted wait/read and handle closure. Do not use sleeps to guess ordering or claim absent OS races.
- [x] Verify exactly 65,536 and aggregate 262,144 succeed, +1 rejects, 8 empty refs succeed, 9 rejects before I/O, invalid UTF8/NUL fail. If direct helper empty refs are supplied, return a valid empty-free no-capture result only through caller omission: public helper itself uses nonempty refs schema and rejects `[]`.
- [x] Run:

```bash
pnpm exec vitest run packages/runtime/test/workspace-file-capture.test.ts packages/runtime/test/safe-file-undo.test.ts packages/runtime/test/workspace-file-tools.test.ts --maxWorkers=4
pnpm --filter @weave/runtime typecheck
```

Expected: valid captures exact; failures produce safe stable code without host path. Suggested checkpoint: `feat: 安全捕获项目文件文本快照`.

### Task 3: Integrate one-time capture into idempotent queue admission

**Files:**

- Modify: `packages/runtime/src/agent-execution-types.ts`, `packages/runtime/src/agent-execution-service.ts`
- Create: `packages/runtime/test/agent-execution-file-context.test.ts`
- Extend regression: `packages/runtime/test/agent-execution-queue-persistence.test.ts`, `packages/runtime/test/agent-execution-queue.test.ts`

**Interfaces:** Consumes CapturedFileContext and Task 2 helper. Produces `AgentExecutionServiceOptions.captureFiles?`, `AgentExecutionSnapshot.fileAttachments?`, queue entry `fileCount`, file error union, service-owned admission abort/deadline. `resolveInput` remains unchanged.

- [x] Write failing exact retry and changed-body tests with real memory store plus real AgentRunner/fake deterministic LLM. Use `vi.fn` capture callback returning a valid Task 1 bundle and assert once, even after underlying fixture text changes. A representative sequence is:

```ts
const request = {
  requestId: "same",
  input: { ...input, files: [{ path: "a.txt" }] },
};
const first = await service.launch("s", request);
const replay = await service.launch("s", structuredClone(request));
expect(replay.executionId).toBe(first.executionId);
expect(captureFiles).toHaveBeenCalledTimes(1);
await expect(
  service.launch("s", {
    ...request,
    input: { ...request.input, files: [{ path: "b.txt" }] },
  }),
).rejects.toMatchObject({ code: "execution-request-conflict" });
expect(captureFiles).toHaveBeenCalledTimes(1);
```

`input` is the existing queue test input (`mock/model/ask`, user text hello); initialize Session before launch. CloseSync/drain fixture in finally. No assertion relies on exact intermediate active status.

- [x] Run the new test and see missing capture behavior fail. Add optional port and all error codes from design. Allocate existing identity IDs before capture; call port after in-gate replay, runnable/capacity and sampling, revalidate cloned bundle against exact refs, then append once inline. Refuse nonempty files when port absent.
- [x] Derive summaries for public snapshot and only fileCount for metadata; account actual accepted snapshot size under existing bounds without serializing full capture into live buffers. Freeze/clone callback output so later callback mutation cannot affect facts/model input.
- [x] Add `AbortController` owned by service and signal union with cooperative 5,000ms deadline. closeSync aborts capture; observer disconnect does not. Do not detach capture with Promise.race: wait cleanup, discard any late result and never accept it. Only pre-append abort maps to definitive capture-timeout; once append starts, preserve existing uncertain-acceptance reconciliation regardless of deadline. Ensure no reservation/accept/start exists on capture refusal and no mutable append occurs after closure.
- [x] Extend existing append-failure injection tests: acceptance commits then throws; confirmation read throws; same exact request later reconciles original bundle and starts once; files modified after original capture cannot trigger recapture. Confirm no-commit permits later fresh capture, uncertainty blocks others and reservations remain conservative. Test concurrent same ID returns one acceptance/capture.
- [x] Add queued tests for modified/deleted file before promotion, reorder/cancel/Stop/recover paths and queue-full rejection before capture. Existing current Generation selection remains at claim. Test snapshot/queue JSON excludes unique text/root identity while store accepted fact includes exactly one content copy.
- [x] Run:

```bash
pnpm exec vitest run packages/runtime/test/agent-execution-file-context.test.ts packages/runtime/test/agent-execution-queue.test.ts packages/runtime/test/agent-execution-queue-persistence.test.ts packages/runtime/test/agent-execution-service.test.ts --maxWorkers=4
```

Expected: all old queue semantics and uncertain-admission recovery remain green. Suggested checkpoint: `feat: 接受排队消息时冻结文件上下文`.

### Task 4: Render all started message snapshots before model budgeting

**Files:**

- Create: `packages/runtime/src/file-context-render.ts`, `packages/runtime/test/file-context-render.test.ts`, `packages/runtime/test/agent-file-context.test.ts`
- Modify: `packages/runtime/src/agent-types.ts`, `packages/runtime/src/agent-runner.ts`
- Regression: `packages/runtime/test/build-context.test.ts`, `packages/runtime/test/agent-runner.test.ts`（现有 final middleware budget tests）

**Interfaces:** Produces pure `renderFileContextMessage(message:Message, context:CapturedFileContext):Message` and `renderSessionModelHistory(messages:readonly SessionMessage[], contexts:ReadonlyMap<string,CapturedFileContext>):readonly Message[]`. Runner files refs are logical only. In `startTurn` inside the existing `turnAdmission` callback, use the same initial `storedEvents` read to guard requests that contain `files` or whose execution, Turn or user-message identity component resolves to a captured acceptance. Before any new message/Turn append, require a captured acceptance in durable claimed phase, exact executionId/turnId/userMessageId, original user message and ordered refs equal to effective `runInput ?? input`, and no existing exact Turn. Current `SessionExecution.status === 'accepted'` means claimed; queued and terminal statuses fail. Omitting `files` cannot bypass the guard. Only requests without files and without a corresponding capture use the legacy direct Runner path.

- [x] Write failing pure test that renderer adds the exact v1 JSON from spec, original user message remains byte/text/image-identical, and unchanged tool message object identity is preserved:

```ts
const user = {
  role: "user",
  content: [{ type: "text", text: "review" }],
} as const;
const rendered = renderFileContextMessage(user, capture);
expect(user.content).toEqual([{ type: "text", text: "review" }]);
const added = rendered.content.at(-1);
expect(added?.type).toBe("text");
if (added?.type !== "text") throw new Error("Expected rendered snapshot");
const json = added.text.slice(added.text.indexOf("\n") + 1);
expect(JSON.parse(json).files[0].content).toBe(capture.files[0].content);
expect(added.text).not.toContain(capture.rootIdentity);
```

- [x] Run to prove missing renderer. Implement spec JSON framing verbatim, with explicit property ordering and no host identities. Only user messages with joined context are cloned; return original other Messages for toolResultStatuses key identity.
- [x] Introduce one Runner history-load routine that reads store events once per refresh, gets `projectSession(events)` and `projectMessageFileContexts(events)`, then renders. Replace both current plain maps at initial read and after tools; reuse projected tool objects for status tracking. No filesystem reads or copies into message.created.
- [x] Add guard behavior tests before implementation: valid claimed capture with exact input/identity and absent Turn is allowed; queued and finished captures, an already existing exact Turn, executionId/turnId/userMessageId mismatches, altered user message and changed/reordered refs are rejected. Include request.files omitted with matching captured identity for both queued and claimed facts (and terminal capture), proving omission cannot bypass phase or input checks; include files without capture. Every rejection asserts zero new message/Turn appends and zero provider calls. A legacy direct request with neither files nor corresponding capture still works.
- [x] Implement the guard using `storedEvents` from the initial store read already inside `startTurn` and its `turnAdmission` critical section. Resolve acceptance by executionId, validate the full identity triple and effective input, derive the current phase from the same projected events, and check exact Turn absence before appending. Do not add a separate preflight read or infer claimed merely from the accepted event. Queue `status:'accepted'` is the existing representation of claimed; `status:'queued'` and all terminal states fail.
- [x] Add provider-recording integration tests: captured file appears on first model call, after one tool result, and a new Turn after original file deletion. A queued-but-unclaimed accepted file is absent from rendered history.
- [x] Add small context-window test where prose alone fits but rendered capture does not: emitted context breakdown includes body cost, terminal reason is agent-context-overflow and fake LLM `stream` call count is zero. Add LLM middleware appending text beyond final budget; ensure final gate sees actual request. Preserve user snapshot whole; no truncation assertions.
- [x] Run focused renderer/runner tests and existing build-context.test.ts and agent-runner.test.ts. Suggested checkpoint: `feat: 在模型预算前渲染历史文件快照`.

### Task 5: Compose trusted Server capture and summary-only HTTP output

**Files:**

- Create: `apps/server/src/agent-file-context.ts`, `apps/server/test/agent-file-context.test.ts`, `apps/server/test/agent-file-context-integration.test.ts`
- Modify: `apps/server/src/main.ts`, `apps/server/src/agent-execution-api.ts`, `apps/server/src/session-service.ts`
- Reuse: `apps/server/src/workspace-root.ts`, `apps/server/src/agent-execution-guard.ts`, ProjectStore/SessionStore APIs
- Regression: `apps/server/test/agent-execution-api.test.ts`, `apps/server/test/agent-queue-integration.test.ts`, local guard tests.

**Interfaces:** Produces `createFileContextCapture(projects:ProjectStore):CaptureFiles` exported by `agent-file-context.ts` (CaptureFiles from Runtime). `main` passes it as core `captureFiles`. SessionMessage HTTP adds optional summaries. No new routes or browser content capture endpoint.

- [x] Write failing actual Server + SQLite test by adapting the existing agent-queue-integration fixture's `startServer({fetch:fakeFetch})`. Create mkdtemp project folder; create Project and Session by real API; launch refs; record upstream request JSON. Modify/delete file after accepted queued receipt, release first fake provider and assert second model request still contains original capture. Always stop server/delete DB/temp root.
- [x] Write unit relation tests for zero/multiple owning Projects, no folder, removed Session ref and folderPath changed between capture pre/post reads. Capture callback holds initial projectId/folderPath and rechecks exact relation; trusted metadata failure maps to safe code.
- [x] Implement Server helper: resolve unique relation/root, invoke Runtime helper, recheck relation/root config, return validated projectId bundle. Add only composition in main. Do not call runtime files directly from Hono handler or expose root through HTTP.
- [x] Map new codes to exact HTTP statuses in design; preserve existing 202/guards/query/body/uncertain-acceptance rules. Add tests forging fileContext/content/root fields in outer and nested refs; strict launch rejects before capture. Existing legacy `/agent` path rejects `files` whenever it cannot provide durable acceptance, even in compatibility fixtures; never silently run refs without capture.
- [x] Extend Session detail explicit mapping with fileAttachments summary. Runtime single-item snapshots expose summaries; queue entry exposes count; HTTP/SSE JSON assertions use unique captured sentinel and root digest, proving neither leaked through spreads. `input.files` remains visible for copy/retry.
- [x] Run:

```bash
pnpm --filter @weave/server... build
pnpm exec vitest run apps/server/test/agent-file-context.test.ts apps/server/test/agent-file-context-integration.test.ts apps/server/test/agent-execution-api.test.ts apps/server/test/agent-queue-integration.test.ts --maxWorkers=4
```

Expected: actual local Server captures files, queue promotion never recaptures and guards unchanged. Suggested checkpoint: `feat: 为项目消息接入文件快照捕获`.

### Task 6: Add logical refs to Studio schemas and exact draft ownership

**Files:**

- Create: `apps/studio/src/features/file-context/file-context-types.ts`, `apps/studio/test/file-context-types.test.ts`
- Modify: `apps/studio/src/features/composer/use-composer-draft.ts`, `apps/studio/src/features/agent/agent-types.ts`, `apps/studio/src/features/agent/agent-execution-types.ts`, `apps/studio/src/features/agent/agent-execution-client.ts`, `apps/studio/src/features/workspace/workspace-types.ts`
- Extend: `apps/studio/test/composer-draft.test.tsx`, `apps/studio/test/agent-execution-client.test.ts`

**Interfaces:** Mirrored strict schemas `fileReferenceSchema/fileReferencesSchema/fileAttachmentSummarySchema`; Draft `files:readonly FileReference[]`, root binding; hook `addFile(owner:ComposerOwner,path:string):'added'|'duplicate'|'full'|'stale'`, `removeFile(path:string):void`, `setFiles(files:readonly FileReference[]):void`. `addFile` validates owner and increments revision only for actual add. Pending request captures refs in frozen body.

- [x] Write failing schema parity cases (same path restrictions/count/unknown fields as Task 1) using no backend package import. Extend draft tests with Session A file add, switch B, stale A add rejected, return A via new epoch, file preserved, accepted old revision cannot clear newly added file, and provisional migration carries refs.
- [x] Extend root-change tests: same Session different root clears only file refs and advances revision; old picker/tree owner becomes stale. Restoring earlier Session for same root preserves refs. No unbounded separate draft file map.
- [x] Run tests before implementation. Implement fields/operations using existing owner/epoch/bucket logic. clearSubmitted uses the same snapshot revision as text/images, so no independent cleanup with a stale callback.
- [x] Add refs to browser request schema/type and serialization, fileAttachments to receipt/Session message schema, fileCount to queue mirror. Assert request body contains relative refs and no captured bytes. Retry transport uses the exact serialized body/requestId rather than reselecting current draft. In requestExecutionJson, extend the typed definite-error classification for execution-file-capture-timeout (503) and execution-file-capture-failed (500); do not convert these known pre-append rejections to TypeError. Add a fetch-count=1 regression and editable-draft assertion, while keeping execution-admission-uncertain and unknown transport failures on exact-body retry.
- [x] Run:

```bash
pnpm exec vitest run apps/studio/test/file-context-types.test.ts apps/studio/test/composer-draft.test.tsx apps/studio/test/agent-execution-client.test.ts --maxWorkers=4
pnpm --filter @weave/studio typecheck
```

Expected: ownership/revision and mirrored schemas pass. Suggested checkpoint: `feat: 在会话草稿中管理文件引用`.

### Task 7: Implement core `@` picker and file-tree addition

**Files:**

- Create: `apps/studio/src/features/file-context/file-mention.ts`, `use-file-picker.ts`, `file-picker.tsx`, `file-attachments.tsx`
- Create: `apps/studio/test/file-mention.test.ts`, `file-picker.test.tsx`, `file-picker-owner.test.tsx`
- Modify: `apps/studio/src/features/files-tree/file-tree-api.ts`, `file-tree-panel.tsx`, `apps/studio/src/features/panel/panel-data.ts`, `panel-registry.tsx`, `apps/studio/src/app/App.tsx`, `app.css`
- Extend: `apps/studio/test/file-tree-panel.test.tsx`, `apps/studio/test/App.test.tsx`

**Interfaces:** `findFileMention(text:string,start:number,end:number):{start:number;end:number;query:string}|undefined`, `rankFileCandidates(paths:readonly string[],query:string):readonly string[]` (<=20). `useFilePicker` takes `owner`, textarea ref/text, projectId/rootKey, `onSelect(path,owner)`, and has `open/query/items/activeIndex/openFromButton/handleKeyDown/close`. `FileTreePanel` gains optional `onAddFile(path:string)` and selected-path disabled/added state supplied via PanelContext.

- [x] Write failing parser tests for start/whitespace `@`, email not matched, caret mid-token/full token replacement range, collapsed selection only, Unicode and IME handled by caller. Rank tests fix ordering and top20, including spaces/case and duplicate candidates. Use a token implementation based on caret slices, not global replacement:

```ts
const before = text.slice(0, start);
const match = /(?:^|\s)@([^\s@]*)$/u.exec(before);
if (start !== end || match === null) return undefined;
const tokenStart = before.length - match[1]!.length - 1;
const suffix = /^[^\s@]*/u.exec(text.slice(start))?.[0] ?? "";
return { start: tokenStart, end: start + suffix.length, query: match[1]! };
```

- [x] Run tests, implement parsing/ranking with no dependency. Query is at most256; paths invalid for refs are not selectable. Ranking compare uses raw string tie-break, not host locale.
- [x] Extend `fetchFileTree` optional `{signal}` and requestJson GET cancellation; keep existing callers compatible. `useFilePicker` loads paths lazily for active Project/root, uses AbortController + request epoch/full owner equality, discards stale results and closes on owner/root change. It fetches no file content. Loading/error/truncated/no-root/empty states are visible.
- [x] Implement listbox semantics and textarea aria-controls/activedescendant. Arrow/Enter/Tab/Escape are handled before send only while open, IME does not intercept Enter, selecting removes just active token and adds chip through Task 6. Candidate mousedown retains textarea focus. Toolbar opens same menu; slash/skills menus remain mutually exclusive.
- [x] Add removable DraftFileAttachments and selected viewer-header “添加到消息” button. Avoid nested buttons in existing tree rows: action lives in viewer header. App callback captures current owner; stale view additions reject; already-added/full state uses draft paths. Existing view/diff actions continue.
- [x] Test @ selection and tree addition both produce one identical logical ref; duplicate no extra revision; 9th cannot add; arbitrary plain text `@a` and plugin prepared literal text alone do not capture; only refs allow file-only Send. Test A→B→A pending list response cannot select into wrong draft, and keyboard choice cannot submit form.
- [x] Run new picker tests, App/file-tree/command/skill regressions and Studio typecheck. Suggested checkpoint: `feat: 支持搜索与文件树添加消息文件`.

### Task 8: Complete queue copy, retry and timeline summary display

**Files:**

- Modify: `apps/studio/src/app/App.tsx`, `apps/studio/src/features/agent/agent-execution-view.ts`, `execution-history.ts`, `execution-queue-list.tsx`, workspace types as needed
- Reuse: `file-attachments.tsx` with readonly summary mode
- Create: `apps/studio/test/file-context-flow.test.tsx`
- Extend: `apps/studio/test/execution-history.test.ts`, `execution-queue-list.test.tsx`, `App.test.tsx`

**Interfaces:** live overlay user message gets `fileAttachments` from receipt, persisted history gets same summary field. `AgentSubmissionSnapshot.files?` carries logical refs for explicit new-turn retry. After a history refresh, `submissionForTurn` maps the original userMessage.fileAttachments in their stored order to `{path}` refs; `TurnRequestMetadata` gains no field. Queue copy restores refs into draft through `setFiles`, preserving append/replace choice and count limit; no captured content is requested.

- [x] Write failing flow tests: file-only input sends; receipt while user edits a new ref does not clear new revision; accepted queue SSE before receipt preserves draft ownership; unique queued fileCount shown; overlay followed by durable history refresh yields one user row with stable summary.
- [x] Implement summary chips labeled “发送时快照” with path and actual byteLength. No clickable claim that live viewer is old content, no hidden fetch for captured body. Existing original message remains title/preview.
- [x] Update copy occupancy check to include files and selected skills; append deduplicates first appearance and fails atomically over8. Replace restores exact logical refs/settings/images/skills. Use current owner guards around asynchronous snapshot fetch. Show exact copy notice from design stating new send rereads current project files and original queue item remains.
- [x] Update new-turn retry snapshot to carry logical refs. For refreshed history, derive `submissionForTurn.files` from the exact original user message's `fileAttachments.map(({path}) => ({path}))`, preserving order and omitting files only when no summaries exist; do not add a `TurnRequestMetadata` field. Retry failed/cancelled file-only Turns through the normal new submission path with a new requestId/execution identity so current file contents are captured again. Transport retry remains unchanged exact request/body.
- [x] Add refresh-then-retry tests for both failed and cancelled file-only Turns: discard the live submission snapshot, load durable userMessage summaries, assert outgoing refs preserve the original order and contain no captured body, assert requestId is new, and use a changed-file capture fixture to prove a fresh capture rather than replay of the previous acceptance. Include the existing no-files history retry case. Map capture errors to actionable message while keeping draft/ref set; never label it accepted before 202.
- [x] Run new flow tests plus queue/history/App and composer regressions. Suggested checkpoint: `feat: 展示文件快照并保持队列草稿一致`.

### Task 9: Verify real browser flow, boundaries and reviewable PR

**Files:**

- Create: `docs/learning/2026-11-23-file-context.md`
- Update: spec/foundation with final implemented choices and checked reference pins
- Optional test-only fixture: `apps/server/test/fixtures/file-context-studio.mjs` exporting `startFileContextStudioFixture({directory,databaseFile}):Promise<{baseUrl,projectId,sessionId,requests,release(index),stop()}>`; uses real startServer/SQLite and deterministic fakeFetch, not custom imitation execution routes.
- Production code changes from earlier tasks only; no performance fixture feature rewrite.

**Interfaces:** Consumes complete feature. Produces verified screenshots/observed receipts/test evidence and one PR for this feature.

- [x] Run all new focused tests together. No arbitrary repeat once green; broaden because integration/compiled boundaries were changed:

```bash
pnpm build
pnpm exec vitest run packages/protocol/test/file-context.test.ts packages/session/test/file-context.test.ts packages/runtime/test/workspace-file-capture.test.ts packages/runtime/test/agent-execution-file-context.test.ts packages/runtime/test/file-context-render.test.ts packages/runtime/test/agent-file-context.test.ts apps/server/test/agent-file-context.test.ts apps/server/test/agent-file-context-integration.test.ts apps/studio/test/file-context-types.test.ts apps/studio/test/file-mention.test.ts apps/studio/test/file-picker.test.tsx apps/studio/test/file-picker-owner.test.tsx apps/studio/test/file-context-flow.test.tsx --maxWorkers=4
```

- [x] Use existing official browser automation capability against actual built Studio and startServer composition. Create temp root with `a.txt=before`, `src/中文 file.ts`, 65,537-byte text and invalid UTF8 fixture. Observe the following sequence with unique request/message IDs:

  1. Add a.txt via @ and second file via file tree, remove/readd once, confirm chips/order; send and inspect only refs in launch JSON and summary receipt.
  2. Hold first model request, queue second file message, change a.txt to after before release, verify second provider JSON still contains its accepted before bytes; refresh and observe one history user/assistant pair per started item.
  3. Stop active item with a later queued file message; verify next starts with saved snapshot. Copy queued message to draft, confirm original queued entry remains and new send captures current bytes. Nonempty-draft append/replace and overflow are covered by focused App tests.
  4. Submit one valid plus oversize/invalid file, verify whole request rejects, no accepted/Turn, draft intact. Root-change/Session ownership and IME keyboard paths are covered by focused UI tests; the real browser run verifies the integrated capture/queue paths above.
  5. Inspect public queue and Session detail: only fileCount/summaries, no capture sentinel/rootIdentity; the shared metadata view and SSE transport are covered by integration tests. Capture exact acceptance record/provider request through test-owned fixture logs, not production debug endpoint.

- [x] Run `pnpm check`, `pnpm marketplace:check`, `git diff --check`. Fix actual failures without weakening tests or architectural boundaries. Docs explain co-operative fs signal, residual parent-path TOCTOU, no atomic cross-file instant, current root tools vs accepted snapshot provenance, and actual validation rather than unproven guarantees.
- [x] Independent review: one reviewer for spec/Session/Runtime/idempotency/budget, another for Server boundary/Studio ownership/real UI. Resolve actionable findings, rerun only affected checks then required complete chain after final code edits.
- [ ] Under the explicitly authorized PR workflow, commit remaining task files with Conventional Chinese messages, push `feat/file-context`, create one PR titled `feat: 支持项目文件引用与上下文快照`. PR description leads with choosing files before queue acceptance and immutable future model input, gives changed behavior/limits/validation; link official pins and final design. Attach PR to chat, watch exact final commit CI, squash only after all required checks pass, delete remote branch. No next feature is mixed into this PR.

## Self-review coverage

Task1 covers strict values/durable invariant/summary leakage and old logs; Task2 covers rooted exact UTF8/limits/observable races; Task3 covers one admission/capacity/uncertain append/queue; Task4 covers same-read claimed-capture admission and all-history render/budget; Task5 covers trusted composition/HTTP; Task6 covers independent schemas/draft identity; Task7 covers @/tree/keyboard; Task8 covers queue copy/live/history and refreshed failed/cancelled file-only new-turn retry; Task9 covers actual browser, complete checks and single-topic PR. No task creates a new plugin port, network retrieval service, filesystem sandbox claim or dependency.
