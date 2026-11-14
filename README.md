# Weave

Weave is a local-first, plugin-native agent workspace and runtime.

The project is developed in three stages:

1. Weave Studio: a local coding-agent workspace.
2. Weave Runtime: a composable agent runtime and SDK.
3. Weave Crew: multi-agent task orchestration.

This repository starts as a clean implementation. The former Orbit prototype
remains a separate reference project and is not copied into this repository.

## Status

Architecture and learning documents are maintained in the Weave Feishu folder.
Implementation begins after the Session, Agent, Tool, and Plugin contracts are
reviewed.

## Planned stack

- TypeScript and Node.js
- pnpm workspace and Turborepo
- Zod
- SQLite
- Hono
- React and Vite
- Vitest

## Development principle

The runtime is the source of truth. Web, CLI, SDK, and Desktop surfaces should
consume the same runtime instead of implementing separate agent loops.
