# ADR 0010: Declarative Plugin Panels

- Status: Accepted
- Date: 2026-11-22

## Context

The main plugin marketplace lives in Studio’s left navigation. Trusted active
plugins also need useful Session-specific displays in the right tab system.
Contribution and service ownership is enforced by ADR 0009, but that logical SDK
boundary does not isolate arbitrary renderer code or attest historical events.

## Decision

Add a governed `panel` capability and `weave.studio.panels` extension point in
Plugin. Plugins contribute bounded closed JSON definitions, including text,
status, metric, key-value, table and native form blocks. Server binds sources and
commands to actual accepted contributions of the same owner, snapshots immutable
host JSON and projects only selected fields of the latest own durable event.
Runtime receives no panel vocabulary, and Studio uses independently validated
HTTP schemas without importing internal packages.

Panel authority is current-only. Explicit host baseline and exact observed source
membership bind the actually current Generation to rotating opaque refs. Reads
call no plugin schemas, projectors, services or callbacks and never pin a
Generation. Publication and invalidation check actual current IDs even under
synchronous reentrant publication. An ordinary failed candidate preserves valid
current refs; observed withdrawal does not restore them after failure.

Native forms prepare a frozen same-owner command’s fully expanded text into the
visible current draft. They never execute a tool or send a message. App-owned
owner epochs, interaction tokens and revision checks reject stale responses while
preserving concurrent edits, images and Skills. Prepared drafts send literally.
Stable plugin tab IDs survive catalog absence and restart alongside existing
preview and terminal instances.

Session lifecycle uses the durable prefix returned by the underlying store.
Concurrent archive/delete after that prefix does not create a stronger atomic
fence. Explicit projection/cache/concurrency/JSON-byte budgets limit retained data
and admitted work; the existing store can still materialize unbounded cold
history. Shutdown invalidates admission first and drains actual store reads before
closing Session persistence.

## Consequences

This slice provides useful custom panels without arbitrary HTML, CSS, Markdown,
URLs, webviews, React callbacks, RPC or direct execution actions. Rich UI and a
renderer sandbox remain separate future designs. Schema-2 declarative artifacts
remain Skills-only. API 1.0.0 gains optional vocabulary; older strict hosts reject
unsupported vocabulary before import. In-process trusted plugin code and Proxy
reflection during assembly remain outside isolation guarantees.

Exact contracts, budgets, lifecycle and acceptance are specified in the
[design](../superpowers/specs/2026-11-22-plugin-panels-design.md) and
[implementation plan](../superpowers/plans/2026-11-22-plugin-panels.md).
Verified upstream references motivate discovery/activation and authority
separation; no verified upstream custom-panel SDK or inherited sandbox is claimed.
