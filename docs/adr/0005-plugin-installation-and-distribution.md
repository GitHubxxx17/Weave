# ADR 0005: Managed Plugin Installation

- Status: Accepted direction; delivery is staged below.
- Date: 2026-11-21
- Owner review: 用户同意按 Stage 6 设计、本地安装、Studio、GitHub 固定版本和静态 Catalog 的顺序推进。
- Refines: ADR 0003 and ADR 0004.
- Detailed contracts: [Stage 6 design](../superpowers/specs/2026-11-21-plugin-installation-design.md).

## Context

Stage 4 loads manually placed local ESM plugins. Stage 5 adds local stdio MCP
Tools through the same Generation coordinator. Neither provides plugin acquisition,
version history or installation. An installer must preserve the exact file paths
used by old turns and keep acquisition separate from execution trust.

Current discovery skips hidden directories, rejects symlinks, and rejects duplicate
plugin IDs. Replacing a live directory in place changes files visible through an
old module's `import.meta.url`; two directory renames do not provide an atomic
replacement across a crash. Restoring previously trusted bytes can also silently
restore eligibility under the existing trust fold unless selection is explicit.

## Decision

Use immutable managed artifacts, append-only installation records, and explicit
reviewed activation. Preserve manually placed plugins without silently adopting or
overwriting them. A managed artifact is copied into a hidden store, validated and
addressed by the existing whole-directory SHA-256 digest. Generation preparation
captures its concrete payload path. Published artifacts are retained in the first
delivery; installation has no authority to delete files held by old turns.

Installation only copies already bundled content and validates data. It never
imports the plugin, runs package managers, executes build/install scripts or Git
hooks, or grants trust. This narrows the exploratory dependency/build flow in the
earlier Manifest design §10. A future build service needs a separate execution
design and must not be smuggled into the installer.

Installing an update creates a candidate and leaves the selected healthy version
unchanged. Activating or rolling back to a candidate is a separate human decision
bound to exact content and the observed installation/trust sequences. Selection
and its new trust decision are committed together in SQLite, then the sole Server
coordinator rebuilds the complete ESM/MCP Generation. Uninstall appends removal and
revocation together; old pinned turns can drain from retained files.

`@weave/plugin-host` provides filesystem artifact operations and accepts explicit
selected candidates. It remains independent of Runtime, HTTP, SQLite and Agent
behavior. Server owns provenance, durable selection, combined authority transactions,
administration and HTTP. Studio remains an HTTP/SSE client. No new package or
dependency is required for local-directory acquisition.

## Alternatives

| Approach                                            | Assessment                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Copy over the active plugin directory               | Breaks old paths, exposes partial writes, requires ambiguous backup recovery; rejected. |
| Version directories with a `current` symlink        | Violates existing no-link discovery and makes runtime paths mutable; rejected.          |
| Immutable artifacts with explicit durable selection | Keeps old paths stable and makes incomplete publication an inert orphan; adopted.       |

## Delivery

1. **6.1 filesystem artifacts:** bounded local-directory copying, validation,
   content addressing, idempotent publication and tamper detection. No selection,
   trust, runtime integration or installer UI in this PR.
2. **6.2 Server authority:** append-only installed candidates and selection,
   combined trust transactions, explicit managed discovery and guarded APIs.
3. **6.3 Studio:** import, reviewed activation, update/history/rollback and uninstall
   using the existing App-owned management write gate.
4. **6.4 GitHub:** acquisition pinned to a full commit, with provenance; no builds
   or implicit trust. Its network and archive contract precedes implementation.
5. **6.5 Catalog:** a static discovery index that uses the same installer.

Each topic uses a fresh branch and reviewed PR from current `origin/main`.
Artifact garbage collection requires explicit current/candidate/retired leases and
rollback retention; it is a separate design and is not required for 6.1 correctness.
Signatures, remote MCP, process hosting/permission proxies and OS sandboxing retain
their own future ADRs. A content digest and filesystem modes are not OS isolation.

## Consequences

Initial disk retention is deliberately bounded and conservative. New content can
be refused when the artifact quota is full; uninstall does not yet reclaim it.
An installation response must distinguish file publication, durable decisions and
runtime application. A successful file copy cannot be reported as a loaded plugin.

The first artifact API serializes operations per store instance. One live installer
owns a store; sharing the directory between processes is outside that API's
concurrency contract. Server must acquire and enforce its store ownership before
exposing managed installation. No promise of universal power-loss durability or
protection against another process running as the same OS user is made.
