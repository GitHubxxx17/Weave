# Safe turn file undo

Status: approved scope, implementation design. Supersedes the unsafe restore
semantics in the 2026-11-19 draft while preserving its legacy event reads.

## Contract

Only a terminal turn of a live Session attached to the requested Project can be
reviewed or undone. Server resolves that relation before reading file contents or
mutating files. A changed Project root is rejected by a persisted root identity
(canonical root, device and inode digest). Restores cover built-in edit_file and
write_file only; shell, MCP, plugin side effects and directories are outside scope.

Runtime writes retain the optional best-effort pre-write hook. A new required
write-intent hook resolves a canonical root-relative target path and must append
a minimal durable intent before any mutation; failure
rejects that write. Thus missing before/outcome records taint a visible intent
instead of allowing a later write to masquerade as the turn original. New snapshots carry
snapshotId, turnId, toolCallId, rootIdentity and beforeDigest. A separate write
outcome records the same identity, success/failure, capture status, afterContent
and afterDigest on success. Missing capture or outcome is unavailable, including
all old before-only events. Failures are explanatory; a failed audit hook cannot
claim recoverability. Content is bounded to the existing one-megabyte tool limit.

Session projection keeps the earliest before state and latest successful after
state for each turn/path only when all intervening writes form a complete chain.
Legacy and incomplete chains remain visible with unavailable reasons. Durable
operation-started, per-file-result and operation-completed facts are append-only.
operationId/requestId are explicit client IDs; reusing either with different
turn/project/operation parameters is a conflict. Replaying a completed request
returns saved results without filesystem writes. An interrupted operation resumes
only unfinished items; restored/already-restored items are never reapplied.

## Runtime and Server

The AgentRunner adds an optional `turnAdmission(sessionId, start)` port. Server
executes the initial Session read and durable turn-start batch inside the same
root queue used by undo. It releases that gate before model or tools run. Undo
rechecks terminal admission inside that queue, so a new turn cannot cross the
check/write interval; no root lock is held for an entire turn.

Runtime owns guarded restore and the undo operation service using a Session store
port. Server owns Project admission and HTTP validation, then invokes that service.
Built-in writes and restore share a canonical-root process queue. Comparison and
write are serialized against these cooperating operations; external processes can
still race, so this is neither OS compare-and-swap nor a multi-file transaction.
Restore validates the root, lexical path, every path component, regular-file kind,
snapshot digests, required successful file identity and current content. Different
lexical paths sharing one successful file identity fail closed as a group (including
case/Unicode aliases on filesystems that resolve them to one inode). Newly
captured intents already use the actual canonical target path, including when
an earlier attempt lost its complete content audit. A symlink, replaced target or current digest
different from the captured after state is conflict and is never overwritten.
Current before state yields already-restored. Other I/O failures yield failed;
incomplete evidence yields unavailable. New files are deleted only when their
current bytes still match the successful write. Existing files missing at restore
are conflict. Per-file results include restored, already-restored, conflict,
failed and unavailable with safe reason codes. No raw host paths enter HTTP.

Both endpoints require a literal loopback Host and trusted local Origin. POST
requires application/json, no query parameters and a bounded 4096-byte UTF-8 body.
Guards run before global CORS, including OPTIONS and HEAD.

GET /projects/:projectId/sessions/:sessionId/file-undo?turnId=… returns a terminal
turn's before/after review and latest operation results. POST on the existing
/undo path takes strict {turnId, operationId, requestId}. No legacy unsafe POST is
accepted. The operation is recorded before mutations and each result immediately
after its attempt. A crash between filesystem write and its fact is reconciled by
recognizing the before state on resume. A recorded completed request is immutable.

## Studio

Studio remains an independent Zod-validated HTTP client. Each terminal assistant
turn has a file-review entry. Review lazily fetches exact captured before/after
content, presents a per-file diff and availability reason, and requires explicit
confirmation to undo. It retains operation/request identity for transport retries,
shows each file result, and reloads durable review after completion. Files with
conflicts or failures can be explicitly retried with a new request under the same
operation; recorded successful files stay successful. No general cancellation,
permission, filesystem or tool execution authority is added to Studio.

## Validation

Regression tests prove foreign-project rejection, nonterminal rejection, legacy
unavailability, incomplete audit chains, digest corruption, modified current
content, new-file deletion, repeated writes, root changes, symlink/path boundaries,
partial failure, exact replay, parameter collision, restart resume and shared-root
serialization. Studio tests prove confirmation, HTTP schemas, retry identity and
per-file outcomes. Run focused tests followed by pnpm check. No new dependencies.
