# Context Budget Bounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject every model request whose final heuristic estimate exceeds its usable context budget while preserving promised user and failure information.

**Architecture:** Runtime owns both deterministic context construction and the existing pre-LLM overflow gate. Estimate exactly the constructed non-reasoning content, system and tools with the shared estimator; reserve skeleton markers before restoring recent full groups. Keep durable history untouched and tool calls/results grouped.

**Tech Stack:** TypeScript ESM, Vitest, pnpm; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-18-agent-context-management-design.md` §4.1–4.4 (2026-11-23 revision).

## Global Constraints

- Work only in `/Users/mi/.codex/worktrees/context-budget/weave` on `fix/context-budget-bounds`, based on latest `origin/main` (`2d5586e`).
- No L3 summarization or new retry behavior. After verified implementation and independent review, the authorized integration workflow commits the task, creates a PR, waits for CI and squash-merges to `main`.
- Preserve complete user content (including images) and failed tool text; insufficient minimum candidates overflow.
- Only promise the shared heuristic estimate; provider tokenization remains independent.
- Tests live in `packages/runtime/test/`; package dependencies and public schemas do not change.

### Task 1: Make final candidate accounting and fidelity budget-aware

**Files:**

- Modify `packages/runtime/src/context/token-estimate.ts` (sent-content estimate).
- Modify `packages/runtime/src/context/build-context.ts` (bounded truncation, grouped candidates and final accounting, optional authoritative `toolResultStatuses?: ReadonlyMap<Message, 'completed' | 'failed'>`).
- Test `packages/runtime/test/token-estimate.test.ts` and `packages/runtime/test/build-context.test.ts`.

**Interfaces:** Existing `estimateMessageTokens(Message): number` and `buildModelContext(BuildContextInput): BuildContextResult` remain stable. `overflow === false` implies final `breakdown.sentTokens <= floor(window*(1-margin))-reserve`.

- [x] Add literal-count regressions for user image (1024 + framing), multiple text blocks and ignored reasoning. Add CJK head/tail cases, marker too small, failed result preservation, huge previous users/images, huge skeleton and whole tool-cycle pairing.
- [x] Correct old 30/40-token skeleton fixtures: those candidates must overflow. Use a longer old answer and a realistic budget for successful compression fixtures.
- [x] Run `pnpm exec vitest run packages/runtime/test/token-estimate.test.ts packages/runtime/test/build-context.test.ts`; verify the expected budget/fidelity failures before editing implementation.
- [x] Use one estimator for non-reasoning text/image/calls. Normalize sent history without mutating durable input. Binary-search code-point head/tail candidates using `estimateTokens(rendered) <= limit`, including their notices; preserve original when the notice cannot fit. Resolve authoritative failure facts before normalization; without metadata retain conservative keyword compatibility.
- [x] Build each older group in full and skeleton forms, keep users/orphans full, select the cheaper faithful minimum, count the explicit marker, and restore recent full groups only within budget. Compute final breakdown from actual messages and derive overflow from its total.
- [x] Rerun focused tests; all assertions must pass without dropping protected content.

### Task 2: Prove Runner fails before invoking the model

**Files:** Modify `packages/runtime/src/agent-runner.ts` to pass projected failure facts by original message reference and turnId, preserving the existing `built.overflow` gate. Test `packages/runtime/test/agent-runner.test.ts`.

**Interfaces:** Context events remain observable and failed Step/Turn states durable; overflow rejects with `agent-context-overflow` and invokes `LlmClient.stream` zero times.

- [x] Add Runner cases for a current image, oversized current text, a large historical skeleton and tools/system/output reserve reducing the usable budget. Assert zero model calls, failed lifecycle, and preserved stored messages.
- [x] Add middleware `next` regressions for added images, added tool definitions, increased maxTokens and omitted maxTokens retaining the resolved Provider output reserve. Reject at the last real-model boundary without changing the builder context event.
- [x] Run the cases against the original implementation first and observe the image/skeleton admission defects; after Task 1 rerun the same cases and the full Runner suite.
- [x] Run `pnpm --filter @weave/runtime test`, followed by `pnpm check`.
- [x] Record focused/package/root verification and known estimate limitations in `.superpowers/sdd/2026-11-23-context-budget-bounds/report.md`; return scope, results and branch details for independent review.
- [x] Resolve independent review: snapshot complete nested middleware requests before the lazy client boundary, validate negative/non-finite reserves before arithmetic, and retain failed skeleton recall IDs. Verify red/green regressions, final full check and independent re-review.
