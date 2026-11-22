# Background executions verification

The execution service separates durable acceptance, owned production and detachable observation. This feature deliberately permits one accepted/running execution per Session; message queue ordering is the following feature. It reuses the existing stable Generation facade and shared Tool Pipeline.

## Behavior verified

- Acceptance is committed before model production. Exact requestId/input retry returns the same execution before current admission; a conflicting requestId returns 409. Production has one admission API, so its legacy POST SSE endpoint returns execution-use-control-api.
- No subscribers are needed for production. HTTP reader cancel closes only that observer. Explicit Stop aborts the host signal, drains the Runner and confirms terminal state only after the append-only Turn and execution facts commit.
- Whole-Turn live snapshots replace exact identities rather than appending over durable model steps. Replay is bounded; old cursor, ring gaps or slow observers resynchronize. Same-epoch terminal sequence-zero snapshots are accepted only as authoritative durable terminal reconstructions with a watermark.
- Startup recovery never executes accepted input again. It closes unfinished steps/Turns and appends interrupted state. An accepted but unstarted execution has no Turn; durable sequence confirmation is sufficient for Studio to remove its optimistic overlay.
- Snapshot input/output, ring and observer queues have explicit limits. Terminal state releases retained live output. Persistence errors remain visible and retain the Session claim instead of claiming a confirmed cancellation.
- Archive/delete use the same admission gate. Shutdown closes admission and drains execution terminal writes before Generation/Store disposal. Existing safe undo root admission and review UI are preserved.

## Real browser acceptance

Executed in Chrome against the production Studio build, real local Server and SQLite. The provider was a deterministic slow OpenAI-compatible SSE fixture with 60 distinct markers at 250 ms intervals; this validates lifecycle and persistence, not real model throughput or a paid provider.

1. Send and refresh during generation. The recovered reply contained exactly 60 markers with 60 unique values, ending token59, and exactly one user/assistant pair.
2. Send, observe the first marker, navigate the browser to about:blank to detach every subscriber, and return after completion. The reply again contained all 60 markers exactly once; it was not cancelled by leaving the page.
3. Send, stop after token03 became visible, and refresh. The completed cancellation retained exactly five unique markers (token00 through token04) both before and after reload. The extra marker represents the normal race between display and Stop reaching the producer.

The acceptance used an isolated temporary data directory and no external network or credentials. Screenshot: `/tmp/weave-background-stopped.png` (local verification artifact, not a source dependency).

## Review corrections

Independent review identified and reproduced same-epoch terminal cursor reset after live state eviction; the client previously ignored that snapshot and could reconnect indefinitely. Regressions now cover same-epoch and restart terminal handoff before the Session watermark arrives. Self-review additionally fixed stale durable acceptance reads racing completion and output retained by detached subscription closures. A post-main integration regression verified executionId remains linked in turn.started alongside safe undo turnAdmission.

Full repository validation and PR CI must both pass before squash merge. The plan records final check and review status; raw local logs are under `/tmp/weave-background-*`.

## Practical limits

Transient bytes not committed before process death cannot be reconstructed. Restart reports interruption and does not resume model/tool side effects. Plugins retain the project's in-process trust boundaries; this feature adds no OS sandbox guarantee. A long output beyond the configured complete snapshot bound is explicitly stopped, then the durable Session becomes authoritative. Durable accepted input is not an encrypted secret store and never includes provider credentials.

The isolated performance fixture was migrated to the same acceptance/observation
contract using the real execution service and a synthetic bounded Runner. A
single Chrome sample (100 markdown messages, one repeat) passed its existing
assertions for all 100 exact stream markers and 102 final visible messages.
Raw compatibility smoke: `/tmp/weave-background-execution-benchmark-smoke.json`.
The archived 18-sample rendering baseline remains unchanged; this smoke is not
an optimization measurement or a replacement baseline.
