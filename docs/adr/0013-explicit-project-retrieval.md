# ADR 0013: Explicit Project Retrieval and Egress Authority

- Status: Accepted
- Date: 2026-11-23

## Context

The explicit Memory slice supplies exact current reviewed project sources and a
synchronous invalidation boundary. Workspace grep remains a bounded on-demand
scan. Studio needs useful persistent project code retrieval, with complete local
operation when no embedding provider is configured. Semantic retrieval requires
real provider vectors and permission to send the exact selected bytes.

## Decision

Add an independent `@weave/retrieval` leaf depending only on Protocol and existing
Zod. It owns deterministic chunks/tokens, SQLite FTS5 and derived generations,
append-only job receipts, bounded cosine workers and rank-based RRF. Runtime
uses structural ports; Server injects leaf, LLM, Memory and Project adapters.
Studio uses only guarded HTTP. No new third-party runtime dependency is needed.

Index only safely captured project UTF-8 files and up to 48 explicitly selected
current user-reviewed project Memory refs. Keep personal Memory, chat, attachments
and tool results outside this corpus. Capture uses existing Workspace identity,
cooperative mutation serialization and bounded no-follow reads; it does not
provide a new OS sandbox or an atomic snapshot of all external filesystem writers.

Build local lexical generations explicitly. Preserve the previous active index
while a bounded background build is running; publish one complete staging
version and the completed job fact in the same transaction. Append accepted,
started and terminal facts with exact request reconciliation. Unknown outcomes
retain admission capacity and ownership; restart interrupts unfinished jobs
without automatic capture, embedding, retry or network recovery.

Use an independent SQLite sidecar and rollback-journal owner lease. Require
single supported writer, exact object identities and retryable partial-startup /
shutdown cleanup, releasing data before ownership and Retrieval before its
Memory/Project/Session dependencies. FTS5 absence disables retrieval only; owner,
schema and identity errors retain their separate failure semantics.

Real embeddings use an independent closed OpenAI adapter, fixed endpoint/model /
dimensions, bounded requests and one shared two-request semaphore. The operator
configures a separate embedding key. Configuration enables capability; each
hybrid build and each semantic query separately authorizes exact bytes and
destination. The shared Tool Pipeline enforces host ask policy even in yolo and
issues an opaque admission permit only after real approval. A build transfers
that permit into a frozen-manifest job grant; ordinary Pipeline completion cannot
cancel an already accepted job or grant permission to different bytes.

Queries filter project/root/generation and source/path before both rankers,
verify current source identity before returning excerpts, and preserve exact
citations. Memory mutations conservatively fence all consuming work in that
project scope before commit. Stable source hashes, reviewed captures and private
live epochs remain distinct from serializable result metadata. Successful tool
JSON satisfies both the actual Pipeline bytes and Runner estimated-token budget.

## Consequences

Local symbol and Chinese text search is useful without network configuration.
Hybrid mode is explicit and independently verifiable through real cosine and RRF
fixtures; it cannot silently fall back while reporting semantic success.
Bounds suit small and medium local projects, with no ANN dependency or large
monorepo throughput guarantee. Old derived text and durable history can remain
after deletion; current authority checks hide stale or revoked sources, without
a physical erasure promise. Live provider quality and billing remain separate
from offline protocol/ranking fixtures.

The binding contract and implementation plan are recorded in
`docs/superpowers/specs/2026-11-23-hybrid-retrieval-design.md` and
`docs/superpowers/plans/2026-11-23-hybrid-retrieval.md` before implementation.
