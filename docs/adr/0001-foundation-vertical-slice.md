# ADR 0001: Foundation Vertical Slice

- Status: Accepted
- Date: 2026-11-14

## Context

The Orbit prototype organized its runtime boundary around `Run`, including
`RunManager` and `runAgent()`. Weave is an architecture reset for a
local-first, plugin-native workspace. Its future model is based on Session,
Agent, Turn, Step, Tool Pipeline, and Plugin boundaries, so copying the Orbit
runtime boundary would make the old prototype's assumptions durable too early.

The first implementation needs to prove that the new boundaries can be built,
tested, and consumed without implementing the whole product.

## Decision

Implement the first runnable slice in one direction:

```text
protocol -> llm -> runtime -> server
```

- `@weave/protocol` defines shared schemas and stable values.
- `@weave/llm` defines `LlmClient`, provider adapters, SSE parsing, Mock
  Provider behavior, and normalized errors.
- `@weave/runtime` owns service assembly and lifecycle without depending on
  HTTP, React, or Node HTTP server modules.
- `apps/server` owns Hono, the local server entry point, Runtime assembly, and
  `GET /health`.

The default server uses a Mock Provider and binds to `127.0.0.1`. ESLint
enforces declared workspace dependencies, the layer direction, and the
runtime/server boundary.

## Alternatives Considered

### Create the Complete Empty Package Structure

This would create future Session, Tool, Plugin, Studio, and Crew directories
before their contracts exist. It would make the tree look complete while
providing no real dependency or behavior evidence, and it would encourage
agents to fill placeholders with premature abstractions.

### Build a Single-Package Prototype

This would make the first feature fast to start, but it would couple provider
wire shapes, Runtime lifecycle, and HTTP handling. Splitting those concerns
later would require a larger migration and would make the intended boundaries
harder to enforce.

## Consequences

The first round intentionally exposes little behavior: a Runtime lifecycle,
LLM contracts and adapters, and a health endpoint. It does not expose an Agent
Loop or `/run`. In exchange, the package direction is real, tests are
deterministic, provider details stay isolated, and the Runtime can be reused
by non-HTTP surfaces.

The Mock Provider means local verification does not prove live provider
compatibility. That responsibility remains in the OpenAI-compatible adapter's
contract tests and later integration testing.

## Follow-Up

Build the Agent Loop, Session and durable event model, Tool Registry and shared
Tool Pipeline, Workspace/Sandbox and approval boundaries, then Plugin
manifests/loading and Crew orchestration on top of these contracts. Each
addition should preserve the one-way dependency direction or record a new ADR
before changing it.
