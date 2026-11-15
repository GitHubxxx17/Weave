# Weave

Weave is a local-first, plugin-native agent workspace and runtime.

The project is developed in three stages:

1. Weave Studio: a local coding-agent workspace.
2. Weave Runtime: a composable agent runtime and SDK.
3. Weave Crew: multi-agent task orchestration.

This repository starts as a clean implementation. The former Orbit prototype
remains a separate reference project and is not copied into this repository.

## Status

The Foundation vertical slice, Session persistence, the first headless Agent
Loop, and the shared Tool Pipeline are implemented. `@weave/protocol`,
`@weave/llm`, `@weave/session`, `@weave/runtime`, and `@weave/server` form the
current architecture. Workspace/Sandbox, Approval, HTTP/SSE adapters, Plugin
loading, and Studio UI remain later phases.

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
│   ├── session/      # Append-only Session events and projections
│   └── runtime/      # Service assembly, Agent Runner, and Tool Pipeline
├── docs/              # Architecture, ADR, and learning material
└── root tooling       # pnpm, Turbo, TypeScript, ESLint, Prettier, Vitest
```

The package dependency direction is
`protocol -> {llm, session} -> runtime -> server`. `protocol` owns stable
public contracts, `llm` isolates provider differences, `session` stores
durable facts and rebuilds read models, `runtime` assembles services and
lifecycle state, and `server` exposes the control plane. ESLint rejects
undeclared workspace dependencies, reverse layer imports, cross-package
relative source imports, and HTTP/UI imports from `runtime`.

Server does not contain the Agent Loop because HTTP should remain a thin
control-plane boundary while agent behavior belongs in the runtime. Server
currently exposes only `GET /health`; there is no HTTP `/run` or SSE adapter.

## Agent Runner

`createAgentRunner()` is the Runtime boundary for one no-tool model turn. It
validates the request, recovers the Session through `projectSession()`, calls
`LlmClient.stream()`, yields transient `AgentRuntimeEvent` values, and appends
durable Session events for the completed, failed, or cancelled lifecycle.
Runs for the same Session are serialized within one `AgentRunner` instance so
Session reads, appends, and model context construction do not interleave.
Separate Runner instances and processes are not coordinated by the current
`SessionEventStore` contract; cross-instance leasing or compare-and-swap
belongs to a future Session concurrency slice.

```ts
import { createMockLlmClient } from '@weave/llm';
import { createInMemorySessionEventStore } from '@weave/session';
import { createAgentRunner } from '@weave/runtime';

const runner = createAgentRunner({
  llm: createMockLlmClient([
    { type: 'text-delta', text: 'Hello' },
    { type: 'finish', reason: 'stop' },
  ]),
  sessionStore: createInMemorySessionEventStore(),
});

for await (const event of runner.run({
  sessionId: 'session-1',
  userMessage: {
    role: 'user',
    content: [{ type: 'text', text: 'Say hello' }],
  },
  provider: 'mock',
  model: 'test-model',
})) {
  console.log(event);
}
```

The current Runner does not execute tools or expose HTTP `/run`. Before
`finish`, `tool-call-start` and `tool-call-delta` return
`agent-tool-call-unsupported`; after `finish`, any event, including a tool
event, returns `agent-stream-protocol`. HTTP/SSE will be a later adapter over
the Runtime event stream.

Run the focused Agent Runner tests with:

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
```

## Tool Pipeline

`createToolRegistry()` stores executable definitions by stable name, while
`createToolPipeline()` is the only boundary allowed to invoke them. The
Pipeline parses JSON arguments, validates them with the tool's Zod schema,
passes a cooperative `AbortSignal`, maps cancellation and timeout failures to
stable error codes, and limits returned content by UTF-8 byte length.

The Pipeline does not access files, run Shell commands, request approval, or
write Session events. Those responsibilities belong to the later
Workspace/Sandbox, Approval, and Agent Loop integration slices.

```ts
import { z } from 'zod';
import { createToolPipeline, createToolRegistry } from '@weave/runtime';

const registry = createToolRegistry();
registry.register({
  name: 'echo',
  description: 'Returns the input text',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  inputSchema: z.object({ text: z.string() }),
  execute: ({ text }) => text,
});

const pipeline = createToolPipeline({ registry });
const result = await pipeline.execute({
  toolCallId: 'call-1',
  name: 'echo',
  arguments: '{"text":"hello"}',
});
```

Run the focused Tool Pipeline tests with:

```bash
pnpm exec vitest run packages/runtime/test/tool-pipeline.test.ts --config vitest.config.ts
```

## Session Event Store

`@weave/session` stores facts instead of repeatedly mutating a serialized
Session object. A caller submits a `NewSessionEvent`; the Store assigns the
event ID, per-Session sequence, and timestamp, then appends the event. The
first slice supports both an In-Memory Store for fast tests and a SQLite Store
for local persistence.

```text
NewSessionEvent[]
  -> SessionEventStore.append()
  -> durable SessionEvent[]
  -> projectSession()
  -> SessionProjection
```

`@weave/llm` `StreamEvent` values are temporary provider-stream transport
events. They can contain multiple text deltas for one eventual message and
must not be written directly as durable Session events. The Agent/Turn layer
will later decide which completed facts become `message.created`,
`turn.completed`, or other Session events.

The SQLite recovery path can be checked with:

```bash
pnpm --filter @weave/session test -- sqlite-store
```

The test writes events to a temporary database, closes the Store, reopens the
same file, and verifies that sequence order and payloads are still available.

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
- [Session Event Store design](docs/superpowers/specs/2026-11-15-session-event-store-design.md):
  durable event contracts, SQLite transactions, Projection rules, and the
  reasons behind the Session boundary.
- [Agent Loop design](docs/superpowers/specs/2026-11-15-agent-loop-design.md):
  Agent Runner API, Session recovery, transient versus durable events, and
  failure/cancellation semantics.
- [Tool Pipeline design](docs/superpowers/specs/2026-11-15-tool-pipeline-design.md):
  Tool Registry, Zod input validation, cancellation, timeout, error
  normalization, and result limits.
