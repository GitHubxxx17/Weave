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

## Branch and PR workflow

- 每个功能、问题修复、文档主题或工程配置都必须使用独立分支。
- 新分支必须从最新的 `origin/main` 创建，不要继续复用已经合并的功能分支。
- 分支名使用清晰的 Conventional 前缀：
  - `feat/<feature-name>`：新增功能；
  - `fix/<bug-name>`：问题修复；
  - `docs/<topic>`：文档变更；
  - `chore/<topic>`：工程配置或维护工作。
- 一个分支只解决一个主题，一个分支只对应一个 Pull Request；不要把多个无关功能
  合并到同一个分支或 PR。
- PR 合并前必须通过 CI，并确认 PR 描述、测试和架构文档已经同步。
- 默认使用 squash merge 合入 `main`。合并后删除远程功能分支，下一项工作重新从
  最新 `main` 创建分支。
- 提交信息使用 Conventional Commits，描述使用中文，例如
  `feat: 增加会话事件存储`、`fix: 修复工具审批状态`、`docs: 补充插件开发说明`。

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
Internal dependencies follow `protocol -> {llm, session} -> runtime -> plugin -> server -> desktop`;
`workspace` has no internal dependencies and is consumed only by `server`.
`studio` imports no `@weave/*` package and no Node or Electron module; it
reaches the Runtime only through the Server HTTP/SSE contract. Lower layers
must not import higher layers. Any cross-package change must update the
design document before implementation so the affected contracts are explicit.
The root ESLint boundary rule also requires workspace dependencies to be
declared in the importing package, rejects relative imports into another
workspace unit's source tree, keeps `runtime` independent of Hono, React,
and Node HTTP server modules, and keeps `studio` free of `node:*` and
`electron` imports. Use package names for valid cross-package imports.
Each package's `test` script runs only that package's `test/` directory.

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
