# Weave

Weave is a local-first, plugin-native agent workspace and runtime.

The project is developed in three stages:

1. Weave Studio: a local coding-agent workspace.
2. Weave Runtime: a composable agent runtime and SDK.
3. Weave Crew: multi-agent task orchestration.

This repository starts as a clean implementation. The former Orbit prototype
remains a separate reference project and is not copied into this repository.

## Status

The first Foundation vertical slice is implemented and validated locally:
`@weave/protocol`, `@weave/llm`, `@weave/runtime`, and `@weave/server` form a
working request-to-health path. The full Agent Loop, durable Session events,
Tool Pipeline, Workspace/Sandbox, Plugin loading, and Studio UI remain later
phases.

Start with the [Foundation architecture guide](docs/architecture/foundation.md)
for the request path, package boundaries, and AI editing checklist. The
[vertical-slice ADR](docs/adr/0001-foundation-vertical-slice.md) records why
the repository begins with these four units.

## Planned stack

- TypeScript and Node.js
- pnpm workspace and Turborepo
- Zod
- SQLite
- Hono
- React and Vite
- Vitest

## Getting started

Install Node.js `24.4.0` or newer and pnpm `10.13.1` or newer. Then install
the pinned workspace dependencies:

```bash
pnpm install
pnpm check
```

`pnpm check` runs formatting, linting, type checking, package tests, and
package builds through the root toolchain. A package can be targeted directly,
for example `pnpm --filter @weave/protocol test`.

The Turbo typecheck and test tasks build their upstream workspace packages
first. This keeps a clean checkout independent of ignored `dist/` artifacts
and makes the same validation sequence work locally and in GitHub Actions.

## First-round layout

```text
weave/
├── apps/
│   └── server/       # HTTP control-plane entry point
├── packages/
│   ├── protocol/     # Shared data types and Zod schemas
│   ├── llm/          # Model client interface and provider adapters
│   └── runtime/      # Service assembly and lifecycle
├── docs/              # Architecture, ADR, and learning material
└── root tooling       # pnpm, Turbo, TypeScript, ESLint, Prettier, Vitest
```

The package dependency direction is `protocol -> llm -> runtime -> server`.
`protocol` owns stable public contracts, `llm` isolates provider differences,
`runtime` assembles services and lifecycle state, and `server` exposes the
control plane. ESLint rejects undeclared workspace dependencies, reverse layer
imports, cross-package relative source imports, and HTTP/UI imports from
`runtime`.

Server does not contain the Agent Loop because HTTP should remain a thin
control-plane boundary while agent behavior belongs in the runtime.

## Development principle

The runtime is the source of truth. Web, CLI, SDK, and Desktop surfaces should
consume the same runtime instead of implementing separate agent loops.

## Documentation

- [Foundation architecture](docs/architecture/foundation.md): request flow,
  boundaries, examples, and interview explanation.
- [ADR 0001](docs/adr/0001-foundation-vertical-slice.md): the decision and
  consequences behind the first vertical slice.
- [Foundation design](docs/superpowers/specs/2026-11-14-weave-foundation-design.md):
  detailed first-round contracts and exclusions.
