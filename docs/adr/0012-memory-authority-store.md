# ADR 0012: Explicit memory with append-only authority and reviewed revisions

## Status

Accepted for the long-term-memory implementation on 2026-11-23.

## Context

Weave needs explicit cross-Session project and opt-in personal memories while
keeping Session facts, Agent behavior and plugin authority separate. Pipeline
approval permits an operation; it cannot prove that a person reviewed the saved
content. SQLite uncertainty and multiple owners must not allow duplicate writes
or stale authorization.

## Decision

Add the `@weave/memory` leaf depending only on protocol and consumed by Server.
Runtime defines ports for synchronous guarded writes, bounded reads, caller/scope
evidence and exact reviewed-source capture. Server composes the independently
versioned SQLite WAL sidecar and a separate rollback-journal ownership connection.
Only one supported writer can acquire its lifetime `BEGIN EXCLUSIVE` lease.

Append-only record/access facts carry stable idempotent receipts; projections
can be rebuilt. Exact replay follows live authorization and precedes new-mutation
CAS. Unknown commit outcomes fence the scope and original Agent invocation until
readback confirms committed or absent. Shutdown preserves owners and stores when
a writer or worker has not drained, allowing the same cleanup to retry.
A constructor that cannot clean up a partially acquired data/owner pair throws
an exact branded `MemoryStoreStartupError` with its retained cleanup port.
Server registers this trusted resource before rethrowing so failed-startup retry
keeps Session/Project dependencies alive. Cleanup observes actual connection
state and closes data before owner; a close acknowledgement failure retains
ownership until the same resource is retried. Ordinary errors or JSON-shaped
cleanup objects do not grant resource registration authority.

Each Memory write Pipeline attempt binds its exact normalized preview, scope,
setting revision and target ref through private capabilities. Child tool views
exclude root-only write definitions; live Service checks also deny child writes
and personal access. Agent saves are agent-authored, including after human
Approval. User edits and explicit exact-ref review create user-reviewed revisions.
Deletion is a tombstone and does not erase prior revisions or Session results.

## Consequences

Memory is inspectable and editable through a dedicated Studio page. Search is
bounded deterministic local matching in read-only workers. Cursors bind query,
scopes and committed heads; synchronous live epochs revoke captures before a
mutation. The retrieval port exposes only current exact reviewed Project refs.
No automatic learning, prompt injection, semantic search or third-party dependency
is added. Shared local files and cooperative cancellation retain their existing
limits. Detailed interfaces and acceptance cases are in the memory design.
