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
- Do not commit or push unless explicitly requested.

## Before implementation

Read the Weave architecture documents in the Feishu project folder. For a
cross-package change, write down the affected contracts and update the design
before editing implementation code.
