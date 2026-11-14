# Weave — instructions for AI coding agents

Weave is a local-first, plugin-native agent workspace and runtime.

## Current phase

This repository is an architecture and implementation reset after the Orbit
prototype. Do not copy Orbit's `RunManager` or `runAgent()` as the new runtime
boundary. Preserve useful ideas from Orbit only after checking that they fit
the Session, Agent, Tool Pipeline, and Plugin boundaries defined for Weave.

## Product order

1. Weave Studio: local coding-agent workspace.
2. Weave Runtime: plugin-native runtime and SDK.
3. Weave Crew: multi-agent orchestration.

## Engineering rules

- TypeScript, ESM, and strict typing.
- Validate external input with Zod before use.
- Keep durable facts append-only.
- Separate durable session events from transient live-control state.
- Keep HTTP handlers thin; agent behavior belongs in the runtime.
- Tools must execute through the shared tool pipeline.
- Plugins must not bypass workspace, approval, or security boundaries.
- Do not add dependencies without documenting why.
- Write tests for behavior changes.
- Do not commit or push unless explicitly requested by the user or the task
  workflow.

## Root verification commands

- `pnpm format` formats repository files with Prettier.
- `pnpm format:check` verifies repository formatting without changing files.
- `pnpm lint` runs package lint tasks through Turborepo.
- `pnpm typecheck` runs package TypeScript checks through Turborepo.
- `pnpm test` runs package tests through Turborepo.
- `pnpm build` runs package builds in dependency order.
- `pnpm check` runs the complete verification chain.

## Package boundaries

Tests belong in each package's or app's `test/` directory, not in `src/`.
Internal dependencies follow `protocol -> llm -> runtime -> server`; lower
layers must not import higher layers. Any cross-package change must update the
design document before implementation so the affected contracts are explicit.
The root ESLint boundary rule also requires workspace dependencies to be
declared in the importing package, rejects relative imports into another
workspace unit's source tree, and keeps `runtime` independent of Hono, React,
and Node HTTP server modules. Use package names for valid cross-package
imports.

The current Foundation architecture is documented in
`docs/architecture/foundation.md`; the decision record is in
`docs/adr/0001-foundation-vertical-slice.md`. Read those files together with
the detailed first-round design in
`docs/superpowers/specs/2026-11-14-weave-foundation-design.md` before changing
layer contracts.

## Before implementation

Read the Weave architecture documents in the project documentation before
implementation. For a cross-package change, write down the affected contracts
and update the design before editing implementation code.
