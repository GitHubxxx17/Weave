# Background executions and recoverable SSE

## Goal and scope

A browser connection observes an execution; it does not own its lifetime. Sending is durably accepted once, refresh restores that execution, and Stop explicitly cancels it. This PR permits one accepted/running execution per Session; durable message queue admission/reorder is the next independent PR. No dependency is added.

## References and choices

Read the official Codex app-server README at commit `bfe3c825702e9235a631a1db58f291bed7a44cfe` (thread reconnect, stable item history anchors). Adopt stable identities, read-state recovery and explicit control operations. Weave retains its Session event log, AgentRunner, shared Tool Pipeline and pinned Generation facade. This is not a copy of Codex process or sandbox architecture.

Source: https://github.com/openai/codex/blob/bfe3c825702e9235a631a1db58f291bed7a44cfe/codex-rs/app-server/README.md

## Package contracts

Session adds validated append-only `execution.accepted` and `execution.finished` facts. Accepted payload is `{executionId,requestId,requestDigest,turnId,userMessageId,input}`; input is a strict JSON snapshot of userMessage, provider, model, sampling options, permissionMode and skills. Request digest hashes canonical logical input, before provider defaults or future file capture. Finished payload is `{executionId,status,reason?}`, where status is completed/failed/cancelled/interrupted. Existing Session projection ignores these control facts; an independent projection resolves execution receipts. No Session-to-Runtime import.

Runtime exports `createAgentExecutionService({runner,sessionStore,admit})`. It uniquely consumes the stable Generation AgentRunner with a host-owned AbortController. Its methods are `launch(sessionId,{requestId,input})`, `list(sessionId)`, `get(sessionId,executionId)`, `subscribe(sessionId,executionId,after?)`, `cancel(sessionId,executionId)`, `recover(sessionIds)`, `withSessionIdle(sessionId,operation)`, `closeSync()` and `drain()`. JSON schemas/types are exported for Server. HTTP and Node server objects remain outside Runtime.

AgentRunRequest gains an internal optional `executionIdentity:{executionId,turnId,userMessageId}` validated by Runtime; HTTP strict input never accepts it. Runner uses these identities in its initial durable batch, recording executionId in turn.started. Existing callers retain generated identities and existing AgentRuntimeEvent variants. Cancellation/error persists current partial assistant text and reasoning in the same terminal append, once; prior completed model steps are not written again.

Server composes the service around coordinator.runner, injects lifecycle admission, and handles HTTP validation/project association only. Session archive/delete run under the same Session admission gate and return busy while execution is accepted/running. Existing undo turnAdmission/root serialization is preserved. Server startup recovers every known Session before HTTP admission.

Studio keeps independent Zod HTTP schemas, no @weave imports. It submits one persistent requestId, observes receipt identity and subscribes by executionId. A network retry reuses the identical requestId and input. It never retries through the legacy start endpoint after an ambiguous acceptance.

## Acceptance and recovery

Serialize acceptance and lifecycle mutation per Session. Look up requestId in durable accepted records before admission, provider defaults, or future filesystem capture; same logical digest returns the same receipt, conflicting input returns 409. Only a first request checks runnable lifecycle, checks the one-active limit, clones input, preallocates identity, persists accepted, then starts the owned pump. HTTP abort after acceptance has no cancellation effect. Accepted facts are retained, so retries remain idempotent after process restart.

On startup, an accepted execution without execution.finished is reconciled against its explicitly associated turn.completed. A known terminal Turn supplies the execution terminal fact. An unresolved accepted/running Turn is marked interrupted (close outstanding steps/Turn as failed with server-restarted reason), without executing any model or tool. Accepted but not started also receives interrupted. Failure to persist recovery prevents admitting HTTP work. No claim of surviving process death with in-flight transient bytes: only committed messages survive restart.

Execution terminal status is published only after durable terminal persistence and execution.finished succeed. Persistence failure is surfaced as unknown/persistence-error, retains the Session claim, and is never presented as confirmed cancelled/completed. Stop is idempotent; repeated Stop observes the same eventual terminal state.

## Snapshot and cursor protocol

An execution snapshot is an authoritative replacement view for that entire Turn: `{executionId,requestId,sessionId,turnId,userMessageId,input,status,cursor,events,error?}`. `events` is the full sequence of runtime events from this execution, with consecutive text/reasoning deltas coalesced. It is not a delta to append to already durable assistant steps. While live, Studio removes durable messages/Turn with the exact turnId and replaces them with the execution view. On confirmed terminal status it reads Session detail and replaces that exact Turn. It never guesses identity using timestamps or last-message position.

A cursor is bound to server epoch, execution and monotonically increasing sequence. Every emitted runtime event/status advances sequence. The bounded replay ring retains at most 256 frames / 1 MiB; an absent, stale, old-epoch or foreign cursor receives a replacement snapshot with its atomic current cursor. Valid replay and listener installation happen in one synchronous handoff, so no event falls between snapshot and subscription. Duplicate/non-increasing cursors are ignored by Studio. GET supports `after` query; Last-Event-ID is accepted as an alternative, with conflicting values rejected.

The complete live view is bounded to 8 MiB / 4096 coalesced events; crossing it cancels production and reports explicit execution-output-limit after partial persistence. No silent removal of middle output. Subscriber queues are bounded to 64 frames / 1 MiB; overflow closes only that subscriber, which reconnects/resynchronizes. Server response uses pull-based one-frame delivery so HTTP backpressure cannot block or unboundedly buffer production. A single bounded snapshot is allowed as an initial frame. Producer progress never depends on subscribers.

## HTTP

- POST `/sessions/:sessionId/executions`: strict `{requestId,input}`; 202 receipt/snapshot, 409 busy or request conflict.
- GET `/sessions/:sessionId/executions`: known executions including active one, bounded projected metadata; no output duplication in list.
- GET `/sessions/:sessionId/executions/:executionId`: snapshot.
- GET `/sessions/:sessionId/executions/:executionId/events?after=...`: SSE `snapshot`, `event` (`{cursor,event}`), `status` frames; no-store, periodic comment heartbeat and stream cleanup.
- POST `/sessions/:sessionId/executions/:executionId/cancel`: strict empty JSON; 202 current status; cancellation settles asynchronously.

Reads and streams require existing Project/Session association. Writes additionally require JSON, bounded raw body (20 MiB for existing image input), loopback Host, configured/same Origin and Sec-Fetch-Site guard. External input rejects unknown fields, invalid cursors, arbitrary internal identities and signal. CORS permits Last-Event-ID if that header is used. Legacy POST `/agent/runs/stream` remains available only in legacy-only compositions. A Server with AgentExecutionService rejects legacy start with 409 execution-use-control-api, so the single production admission boundary cannot be bypassed; production Studio uses the execution endpoints. Legacy client tests name that compatibility path explicitly; no production fallback after POST errors.

## Studio behavior

During submit, retain the same frozen submission/requestId through retry. Clear only the submitted draft revision once accepted. Connection loss displays reconnecting while leaving Stop enabled; retry subscribe with bounded backoff and abortable waits. Recovery lists active execution on opening Session/refresh, installs its authoritative snapshot, then subscribes. Switching Sessions never cancels the server execution; stale callbacks are fenced by Session/run identity. Unmount aborts local subscriptions only. Stop calls cancel API, displays stopping, and waits for confirmed server terminal state; it does not immediately invent cancelled state.

Keep streamAgentRun export for existing App mocks, move original POST client to streamLegacyAgentRun, and make production streamAgentRun use the execution client. Add optional receipt/snapshot/status handlers. New behavior has direct client/App tests; existing legacy mocks do not decide production capability. Avoid unrelated App restructuring.

## Shutdown

Close execution admission synchronously first. Begin HTTP close and existing owned/plugin drains. Abort and drain executions while their Generation and Session store remain alive, persist partial/terminal facts, close subscribers, then dispose host, close remaining HTTP sockets and stop Runtime/stores. Failures remain visible through existing shutdown aggregation. Shutdown ordering and reentrancy are tested.

## Validation

Runtime/Session: no-subscriber progress; lost-accept response same-id replay; conflicting input; busy admission; generation pin/order; ring gaps and cursor epochs; snapshot/subscribe race; slow listener isolation; bounded output; cancel retains text/reasoning once; accepted-before-start recovery; restart interrupts without tools; failed terminal append never confirms success; lifecycle admission races; close/drain.

Server: guards/body bound/session association; launch/read/subscribe/Stop; disconnected readers leave execution running; shutdown writes before store close; lifecycle 409 while running. Studio: real request schema, exact retry identity, dropped stream/reconnect and resync replacement without duplicates, refresh/navigation recovery, Stop confirmation, stale callbacks, draft revision. Browser acceptance: real local Server + SQLite + slow mock provider, refresh mid-answer, completed text exactly once, explicit Stop preserving partial text, network disconnect without cancel. Run focused tests, full pnpm check, independent review, feature PR, CI, squash merge before queue branch.

## Review decisions

A snapshot replaces the user row as well as all assistant/tool rows of the owned Turn. Adjacent delta compaction never mutates a previously published ring frame. Input is preflighted against the snapshot byte cap before acceptance; an event that would exceed the cap is not published, production is aborted and drained, and a distinct overflow/snapshot-unavailable status instructs clients to use the durable Turn after terminal confirmation. This avoids presenting a truncated live snapshot as complete. Wire limits allow the one bounded full snapshot frame.

`completed` from legacy AgentRuntimeEvent is buffered by the execution service, not forwarded early as confirmed terminal. Await iterator settlement, inspect durable turn.completed, then append execution.finished. Terminal status includes durableThroughSequence from the append result; Studio's detail read must reach that prefix before dropping its live overlay. Cancel only aborts the host signal; the service continues draining, never calls iterator.return to skip queued deltas, and derives final status from the durable Turn (not from signal.aborted). Interrupted recovery closes every running step and the Turn in the same append batch as execution.finished. Partial buffers live outside the model loop and clear only after successful message persistence, so error/cancel adds the current step once.

A failed terminal append enters transient persistence-error and keeps the Session blocked; no compensating execution.finished failed claims missing Turn facts exist. Restart recovery is the fallback. Session event acceptance must be deep-cloned before storage and runner invocation; caller mutation cannot change frozen input or its logical digest.

### Exact public types

```ts
type AgentExecutionStatus = 'accepted' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'persistence-error';
type AgentExecutionFrame =
  | { type: 'snapshot'; snapshot: AgentExecutionSnapshot }
  | { type: 'event'; cursor: string; event: AgentRuntimeEvent }
  | { type: 'status'; cursor: string; status: AgentExecutionStatus; durableThroughSequence?: number; error?: { code: string; message: string } };
interface AgentExecutionSubscription {
  readonly initial: readonly AgentExecutionFrame[];
  readonly events: AsyncIterable<AgentExecutionFrame>;
  close(): void;
}
```

Snapshot additionally carries createdAt, optional durableThroughSequence and error. launch/get/cancel return Promise<AgentExecutionSnapshot>; list returns Promise<readonly AgentExecutionSummary[]> (snapshot without input/events). subscribe returns Promise<AgentExecutionSubscription>; withSessionIdle is generic over its asynchronous operation. Runtime exports these types, input/snapshot/frame schemas and AgentExecutionError. Error codes: execution-not-found, execution-busy, execution-request-conflict, execution-closed, execution-output-limit, execution-persistence-error and execution-invalid-input.

An initial replay larger than the 64-frame subscriber budget uses a snapshot. After durable lookup, subscription initial frames and listener are captured synchronously without await. List returns at most the newest 100 summaries; durable request-id lookup always checks the complete accepted history. Not-found and foreign-Session IDs yield the same not-found response. Persistence-error blocks withSessionIdle as well as new launch.

Canonical request hashing recursively sorts JSON object keys, retains array/skills order and distinguishes absent optional fields from explicit defaults. Non-JSON/non-finite values are rejected by strict input schema. The 20 MiB transport cap does not imply acceptance: the complete initial snapshot including serialized input and envelope must fit 8 MiB. Terminal/restarted snapshots may contain no transient events; their status and durableThroughSequence direct the client to Session history. Full transient reconstruction applies to a live execution in the same Server epoch. Every stale/replayed frame remains execution/epoch scoped.

### Terminal view handoff

A failed, cancelled or interrupted acceptance may never have started a Turn.
Once Session detail reaches durableThroughSequence, absence of that exact Turn
is valid for these outcomes and the optimistic overlay is removed. A terminal
snapshot with an empty events array must not clear previously visible output
before that durable prefix is read. A newly opened Session reconciles a newer
terminal execution watermark as well as active execution state.
