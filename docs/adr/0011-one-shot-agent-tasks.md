# ADR 0011: One-shot native Agent tasks

- Status: Accepted for implementation
- Date: 2026-11-23

## Context

The existing background Execution Service serializes work within one Session and keeps HTTP observations separate from execution. Parallel delegated work needs independent durable histories, bounded resource ownership and a trustworthy relationship to the actual parent Generation and workspace authority.

## Decision

Use native one-shot child Sessions, with accepted/dispatched/cancel/settled facts in the parent and an immutable origin in the child. Runtime orchestrates bounded admission, exact materialization and cross-log reconciliation through narrow host ports. It reuses AgentRunner, the shared Tool Pipeline and the existing Execution Service; no separate RunManager or Crew executor is introduced.

The host binds each accepted child to a retained lease of the actual running parent Generation before execution installation. Children receive an exact tool-authority subset, default to read-only access, and may explicitly receive workspace access. Project folderRevision and pinned root checks fence obsolete tasks before later tool effects. Approval modes remain ask/trust/yolo and do not grant additional tools or authority. Parent natural completion leaves accepted children running; explicit Stop cascades to the exact Turn's children.

All cross-Session effects use preallocated identities and exact reconciliation. Unknown append outcomes retain conservative fences and capacity. Restart interrupts unfinished work without replaying model or tool side effects. Shutdown drains materializers and actual execution cleanup before closing stores; incomplete cleanup or uncertain durable state remains retryable.

Stop All records an append-only root operation with up to four preallocated task IDs before writing per-task cancellation intents. An empty target list is durable. Retrying the same operation uses its original targets after restart, and the first per-task cause remains authoritative.

## Consequences

The first version has depth one, four live tasks per root, sixteen globally, bounded observation and result JSON, and ten-minute cooperative deadlines. The child Composer is read-only and Runtime permanently enforces one-shot origin across HTTP, host and restart paths. Shared Project files have no automatic worktree or OS isolation; concurrent writes can conflict. This design does not promise hard token/cost limits or arbitrary plugin sandboxing.

Studio remains an HTTP/SSE consumer and plugin-host remains generic lifecycle infrastructure with no Runtime, Session or HTTP dependency. Future Crew can consume the same stable task contracts after this vertical slice is verified.

The detailed contract and implementation order are in [the Agent tasks design](../superpowers/specs/2026-11-23-agent-tasks-design.md) and [plan](../superpowers/plans/2026-11-23-agent-tasks.md).
