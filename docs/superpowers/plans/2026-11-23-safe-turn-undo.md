# Safe Turn Undo Implementation Plan

> **For agentic workers:** Execute inline using the approved parent workflow; review is coordinated by the parent agent. Steps use checkboxes for tracking.

**Goal:** Safely review and undo built-in file writes from one terminal turn.

**Architecture:** Session stores immutable capture/outcome/undo facts. Runtime
owns digest verification, shared-root serialization and resumable restore. Thin
Server routes admit Project/Session membership; Studio uses HTTP only.

**Tech Stack:** TypeScript ESM, Zod, Node filesystem, existing React and Vitest.

**Spec:** ../specs/2026-11-23-safe-turn-undo-design.md

## Global Constraints

- No new dependencies. After verified implementation and independent review, the authorized integration workflow commits the task, creates a PR, waits for CI and squash-merges to `main`.
- Legacy before-only captures are unavailable for safe undo.
- Only terminal turns attached to the requested Project are accepted.
- No OS CAS, atomic multi-file transaction, shell or MCP undo claim.
- All tests live in package/app test directories.

### Task 1: Durable evidence and projection

Files: packages/session/src/{events,file-undo,index}.ts and test/file-undo.test.ts.

- [x] Add failing projection cases for complete chains, missing outcomes and legacy snapshots.
- [x] Run `pnpm exec vitest run packages/session/test/file-undo.test.ts` and verify the new failures.
- [x] Add optional capture identity and new write outcome and undo operation event schemas.
- [x] Implement `collectSafeFileUndo(events, turnId)` retaining first before, latest after and explicit unavailable reasons.
- [x] Run focused Session tests and typecheck.

### Task 2: Captured writes and guarded restore

Files: packages/runtime/src/{workspace-file-tools,workspace-file-types,file-undo,index}.ts,
new workspace-mutation.ts and file-undo-service.ts; runtime test/file-undo.test.ts.

- [x] Add failing tests asserting changed-current conflict, root/digest rejection and new-file safe deletion.
- [x] Run focused tests to verify expected failure.
- [x] Implement canonical-root queue, bounded capture, before digest and successful write outcome hook.
- [x] Implement `restoreFileSnapshot(snapshot, workspace)` with five explicit outcomes and boundary checks.
- [x] Add `createFileUndoService({store})` review and undo with operationId/requestId ledger replay.
- [x] Verify restart, partial failure, exact replay, identity collisions and concurrent writes.

### Task 3: Server vertical slice

Files: apps/server/src/{agent-kernel,file-undo-api}.ts and new test/safe-file-undo.test.ts.

- [x] Add foreign-project, running-turn and strict request validation failing tests.
- [x] Wire before/outcome hooks to Session events and replace route-side restore loops with Runtime service calls.
- [x] Mount review GET and admitted POST; map structured domain errors to HTTP.
- [x] Run Server focused tests with actual temporary files and durable store replay.

### Task 4: Studio review and undo

Files: new apps/studio/src/features/file-undo/{file-undo-api,turn-file-review}.tsx/ts,
apps/studio/src/app/App.tsx and Studio tests.

- [x] Add failing tests for lazy review, confirmation and result display.
- [x] Add independent Zod response schemas and stable request identities.
- [x] Render per-file before/after diff, explicit confirmation and result/retry controls on terminal turns.
- [x] Run Studio focused tests and typecheck.

### Task 5: Verification and handoff

- [x] Format changed files and run focused suites.
- [x] Run `pnpm check`; resolve failures and rerun only affected checks as needed.
- [x] Write .superpowers/sdd/2026-11-23-safe-turn-undo/report.md with scope, tests and limitations.
- [x] Return branch, dirty-file scope, verification and risks to the parent for the authorized PR integration workflow.
