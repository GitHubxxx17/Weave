# Durable message queue

## Goal and choices

Extend the background execution service with one authoritative FIFO per Session. A running Session accepts later messages without tying their execution to a browser. Each feature remains an independent PR. This design changes Session, Runtime, Server and Studio contracts before implementation; it adds no dependency and preserves AgentRunner, Generation ownership and the shared Tool Pipeline.

Choose Runtime scheduling over a browser buffer because disconnected clients must not stop progress or resend queued work. Choose immutable queued inputs over in-place editing so durable request identity remains stable. Queue and steer are different operations; this PR implements queue only. Stop cancels only the exact current execution, preserves waiting entries and advances after actual durable settlement. Normal failure also advances; persistence uncertainty blocks the Session.

The waiting limit is 10 per Session and 100 across this service, excluding claimed active executions. Input/output caps from the background execution design remain. A queue stores durable input on disk, not ten complete live execution buffers. An idle Session may append accepted and claimed in one batch and start directly even when all waiting slots are occupied elsewhere; it does not consume waiting capacity. Global capacity must be reserved atomically across Sessions; per-Session locks alone are insufficient.

## Verified references

- Codex `a0995c2b2b68248960c69cb812b5f4898dac7e4c`: [queue processor](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/app-server/src/request_processors/thread_queue_processor.rs), [queue service](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/ext/queue/src/service.rs), [queue tests](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/ext/queue/tests/queue_service.rs). Adopt stable identities, separate queue controls, revision checks and serialized dispatch. Its interrupted execution pauses queued work; Weave deliberately continues after current Stop settles.
- [Kiro CLI Queue steering](https://kiro.dev/docs/cli/chat/queue-steering/) (reviewed 2026-11-23, page updated 2026-08-04): adopt the visible queue count and distinction between a next prompt and steering the current turn. Its documented local buffer does not establish durable queue semantics.
- DeepSeek Harness `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`: [Stop preserves queue](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/.agents/notes/archived/bug-fix/2026-07-31-web-stop-preserves-queue.md), [inbox](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/core/agent-loop/src/inbox.ts), [queue actions tests](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/apps/web/tests/queue-actions.e2e.ts), [persistence](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/subsystems/persistence.md). Adopt Host-owned append-only intent, request replay after removal, separate Stop/removal and waiting for cancellation quiescence before FIFO advancement. Its buffered append/flush and sandbox guarantees are not Weave guarantees.

Weave's plugin Generation is selected only when the stable Generation Runner starts the claimed item. None of these references establishes external-tool exactly-once effects. Server restart interrupts all unresolved entries, including queued ones; it never silently re-executes accepted work. Browser refresh only detaches/re-attaches observation and preserves scheduling. Persisted interrupted receipts remain inspectable/replayable; a new execution requires a new submission.

## Session contracts

`execution.accepted` keeps logical `input` and `requestDigest`, adding optional `dispatch:'queued'` and optional `runInput:AgentExecutionInput`. All new admissions use queued dispatch and a frozen effective runInput. A queued dispatch fact requires runInput, useProviderDefaults:false, equal non-sampling fields, and unchanged explicitly supplied sampling values; schema/projection validation rejects malformed frozen facts. Optional omission remains only for legacy dispatch-absent facts. Old records without dispatch are interpreted as implicitly claimed for backward compatibility.

Add `execution.claimed {executionId}`. Add `execution.queue-reordered {requestId,requestDigest,expectedRevision,executionIds}`. Extend `execution.finished` with optional `queueRequest:{requestId,requestDigest,expectedRevision}` for idempotent queued cancellation; its status is cancelled and reason is queue-cancelled. All identifiers and input remain strict Zod JSON schemas. Queue control request IDs share a per-Session control namespace; operation kind and target are included in the canonical digest, distinct from admission request IDs.

Projection distinguishes queued versus claimed unfinished items; claimed plus finished is terminal. Invalid claims, duplicate controls, invalid reorder membership/permutations, double finish and unknown references fail validation. Queued cancellation creates no user message, Turn, model request or tool event. Acceptance is not projected into conversation history. Queue revision is the last sequence of acceptance, claim, finish or reorder (zero for no queue facts), not an unrelated message/step event sequence. Reorder does not change acceptance identity or input. Existing event logs and projections remain readable.

## Runtime contracts

Extend AgentExecutionStatus with queued. launch still returns an AgentExecutionSnapshot receipt; queued snapshots have empty events. Snapshot adds optional effectiveSettings:{useProviderDefaults:false,temperature?:number,maxTokens?:number} derived from persisted runInput, so explicit copying reproduces acceptance-time sampling without duplicating image/content bytes. Legacy snapshots may omit this field. Only claimed active items have a live output buffer. Direct subscribe to a queued execution returns one queued replacement snapshot and closes; Session queue SSE reports promotion, after which Studio attaches to the active execution. Waiting entries do not allocate output buffers/listeners. `list` stays newest 100 summaries; request replay scans complete accepted history.

```ts
interface AgentExecutionQueueEntry extends AgentExecutionSummary {
  preview: string; // at most 240 Unicode code points
  provider: string; // metadata display capped at 240 Unicode code points
  model: string; // complete values remain in single-item input
  imageCount: number;
  skillCount: number;
}
interface AgentExecutionQueueSnapshot {
  sessionId: string;
  revision: number;
  cursor: string; // epoch:encodeURIComponent(sessionId):sequence; independent execution cursor
  active: AgentExecutionSummary | null;
  queued: readonly AgentExecutionQueueEntry[];
  scheduler: 'ready' | 'closing' | 'blocked';
  limits: {sessionQueued: 10; globalQueued: 100};
  error?: {code: string; message: string};
}
interface AgentExecutionQueueSubscription {
  initial: readonly AgentExecutionQueueSnapshot[];
  events: AsyncIterable<AgentExecutionQueueSnapshot>;
  close(): void;
}
interface AgentExecutionQueueReorder {
  requestId: string;
  expectedRevision: number;
  executionIds: readonly string[];
}
interface AgentExecutionQueuedCancel {
  requestId: string;
  expectedRevision: number;
}
```

Service adds `queue(sessionId):Promise<AgentExecutionQueueSnapshot>`, `subscribeQueue(sessionId):Promise<AgentExecutionQueueSubscription>`, `reorderQueue(sessionId,request):Promise<AgentExecutionQueueSnapshot>` and `cancelQueued(sessionId,executionId,request):Promise<AgentExecutionQueueSnapshot>`. Export strict schemas and types for all. Extend options with optional `resolveInput(sessionId,input):Promise<AgentExecutionInput>`; no callback means clone input with useProviderDefaults:false. Production Server callback freezes current temperature/maxTokens defaults, respecting explicit fields and useProviderDefaults:false. Never serialize credentials, private clients, context window or Generation into input. Validate returned effective input; only sampling defaults/useProviderDefaults may differ, never message/provider/model/permission/skills.

Canonical admission digest hashes logical input. Lookup same requestId before lifecycle, defaults or capacity. Replay returns the same receipt without recapture or rescheduling, even after cancellation/reorder/restart. First admission checks lifecycle and capacity, freezes defaults and input, preflights bounded snapshot, durably appends accepted, then kicks scheduling. A confirmed non-commit releases its capacity reservation. Session append can commit and then throw: on any acceptance/claim/control/terminal append exception, reconcile the durable prefix and exact request/operation identity under the same mutation gate before deciding. A confirmed committed acceptance installs its one scheduler ownership and kicks once; a confirmed committed control/terminal is observed, never appended again. If reread cannot establish the outcome, retain capacity/ownership and block that Session with persistence-error until recovery; a transport throw is not proof of rollback. An unresolved acceptance returns execution-admission-uncertain (503), distinct from a confirmed persistence-blocked Session. Studio retains/retries its exact logical body/requestId for that code. Same-id retry may reconcile a previously ambiguous acceptance, but never create or execute a second occurrence.

Under the same Session mutation gate, if no active or blocked execution, claim FIFO head durably, release its waiting capacity, allocate one live state, and only then invoke runner. Promotion, queued cancellation, reorder and lifecycle mutation serialize through this gate. Different Sessions may run concurrently. Do not hold the global capacity gate across model/tool execution. A claimed item that cannot start is durably failed and allows the next item; terminal append/claim persistence uncertainty blocks, never invents success. Preserve the existing durableThroughSequence handoff, bounded snapshots/ring/subscribers and cancellation partial persistence. Next claim follows confirmed execution.finished and actual iterator settlement, never the legacy completed event alone.

Queued cancellation checks successful control replay before revision, then requires exact queued membership. A concurrently claimed item yields execution-not-queued (409) and is never converted into active Stop. Reorder checks replay before revision and requires a duplicate-free exact permutation of every current queued ID. Stale revisions yield execution-queue-conflict (409), capacity yields execution-queue-full (409), changed replay body yields execution-request-conflict (409). Controls return current authoritative queue state after replay without applying the operation again.

Active cancel keeps the existing empty-body endpoint and only affects claimed live items; supplying a queued ID yields execution-not-active (409). Stop target identity never changes during retry. withSessionIdle rejects any queued, active or persistence-error state. closeSync stops admission and advancement immediately; drain cancels/settles active entries and durably cancels queued ones without invoking Runner, before stores/Generations close. Recovery never starts Runner. Queued/no-Turn entries become interrupted. Claimed entries with a running exact Turn close its running Steps and Turn together with interrupted execution settlement. If the exact associated Turn is already durably completed/failed/cancelled but execution.finished is missing, derive its existing terminal status/reason rather than overwriting it with interrupted; preserve the background service crash-window behavior. No hidden pause/resume feature.

Queue SSE sends bounded full metadata replacement snapshots on durable queue changes and relevant scheduler/active status changes, not token deltas. Capture initial view and subscriber installation under the Session gate to avoid missed transitions. Queue cursors have a separate maximum 2500 characters to accommodate percent-encoded valid Unicode Session IDs (execution cursors retain their 600-character limit). Independent epoch+sequence cursors let Studio discard stale views and replace after reconnection. No replay log is required: reconnect returns the current complete view. Slow subscribers keep only the latest replacement or close; no unbounded queues, full inputs or completed output are retained by queue listeners. Use one service-wide monotonic queue publication counter so a same-epoch initial snapshot after idle state eviction never regresses. Do not retain per-Session sequence tombstones. Idle Sessions with no listeners/work must not accumulate retained service state. Verify finish/close/evict/reopen/new-admission cursors remain ordered.

Every published queue view must be internally consistent: active is null or a claimed nonterminal execution. After execution.finished commits, synchronize the durable queue projection before publishing the terminal execution status or its queue notification. A pending queue reader must never receive the finished execution as active, including the transition before claiming the next item; latest-only buffering must not hide this invariant in tests.

## Server HTTP

Keep existing launch, execution read/SSE and active cancel routes. Add routes before dynamic executionId routes:

- GET `/sessions/:sessionId/executions/queue`: queue snapshot.
- GET `/sessions/:sessionId/executions/queue/events`: SSE event queue, data is queue snapshot, id is queue cursor; no query accepted, reconnect replaces state.
- POST `/sessions/:sessionId/executions/queue/reorder`: strict AgentExecutionQueueReorder, maximum 10 IDs, body 16 KiB.
- POST `/sessions/:sessionId/executions/:executionId/cancel-queued`: strict AgentExecutionQueuedCancel, body 4 KiB.

Reuse loopback Host, JSON, Origin, Sec-Fetch-Site and Project/Session guards. Generic bounded SSE transport may serve execution and queue subscriptions without weakening either shape. HTTP owns validation, error mapping and subscription cleanup only. 202 for launch/active cancel, 200 for queue controls. Every service composition/test fixture adopts FIFO; tests that previously expected busy on second input now assert queued with only the first runner started. Legacy start remains unavailable when execution service is configured.

## Studio behavior

Separate pending admission (frozen requestId/body, owned draft capture and skill revision) from active observation. One unconfirmed admission per Session; editing remains possible. Production launch returns on receipt, not after the execution ends. Retry ambiguous network outcomes with the same exact body and identity; definite capacity/validation rejection preserves draft. Accepted clears only the captured owner/revision and skills revision, even if queue SSE precedes receipt or the user switches Sessions. Keep explicit legacy-only client support for fixtures; production never falls back after ambiguous acceptance.

Queue state has its own observer per opened Session, reconnecting to current replacement views. Show an accessible Composer queue list, count n/10, bounded preview, image/skill counts and model; allow cancel, move one position earlier and copy to draft. Fetch full input only for explicit copy. Copy text/images/settings (including snapshot effectiveSettings when present) to the owned draft with an explicit replace/append choice if it is nonempty, and state that the original remains queued. Queue items do not appear as premature conversation messages. Claimed snapshots use exact Turn/user identity.

Running Composer accepts Enter/Send as Add to queue, with a separate Stop button bound to clicked active executionId. During unconfirmed admission duplicate submission is disabled, but typing remains enabled. Queue limit/conflict messages are explicit and refresh state; stale cancel is never retried as Stop. Successful control replay survives changed revision; ambiguous network retry retains its exact control body/requestId.

Track execution observation/terminal reconciliation by executionId. When one terminal watermark read overlaps the next active execution, merge the durable exact Turn and reapply all still-live overlays; do not replace the whole Session and erase the next run. A stale previous completion cannot clear the next active observer, Stop target or connection status. Existing undo stays disabled while Session has active/queued/reconciling work. Session navigation/unmount detaches observers only; no browser promotion/resend.

Applied durable Session sequence and settled execution watermark remain monotonic across navigation. A late older Session read cannot replace newer history, including after the newer execution has already reconciled and released its handle. A newer detail can confirm older exact terminal Turns; only unconfirmed overlays retain their canonical positions. Late reads settle their own handles without applying an older prefix or changing a newer failed/cancelled status. Late admission receipts still clear only their owned draft but must not reattach an inactive Session observer.

## Validation

Session tests cover old compatibility, FIFO projection, exact reorder, invalid facts, queued cancellation without Turn and control replay. Runtime tests use real event stores and controlled runners to prove no-subscriber FIFO, only one active per Session, cross-Session concurrency, current Generation selected at claim, frozen defaults, duplicate admission/control replay, full/stale queues, global capacity races, commit-then-throw and unreadable ambiguous appends, cancel-versus-claim, Stop preserved queue, failure advances, terminal persistence blocks, bounded subscriber state, shutdown and restart without tools. Existing background/undo/context regressions remain.

Server tests cover real composition, new routes/guards/input bounds/errors/SSE, association, no legacy bypass and updated second-submission behavior. Studio tests cover accepted draft revision, repeated queueing, queue-before-receipt, refresh/navigation, disconnected progression, cancel/reorder races, copy draft, capacity preservation, exact Stop and overlapping terminal handoff. Real browser acceptance uses production Studio + Server SQLite + a deterministic slow local provider: enqueue multiple unique messages, reorder and remove exact items, refresh during processing, verify executed order and one user/assistant pair per started entry, Stop first while preserving next, copy an entry and verify original remains. Fixture validation is not real model throughput evidence.

Run focused checks, independent architecture/code review, pnpm check and pnpm marketplace:check, create one feature PR, wait CI green, squash merge and delete remote branch. Continue @file from latest main.
