# Plugin developer CLI implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development with independent implementation ownership and cross-review.

**Goal:** Deliver real repository-local create/validate/build/pack commands for Tool, Command and Skills authors.

**Architecture:** A private leaf imports Plugin and Plugin-host only. Snapshot files and controlled real SDK compilation produce a positively listed payload; immutable installation/trust remains outside the CLI.

**Tech stack:** TypeScript ESM, Node24.4+, TypeScript5.9.3, esbuild0.28.2, @types/node24.10.1, Zod4.6.7, Vitest and existing workspace tooling.

**Spec:** [Plugin developer CLI](../specs/2026-11-22-plugin-developer-cli-design.md), [ADR 0008](../../adr/0008-plugin-developer-tooling.md).

## Global constraints

Use actual public PluginFactory types and injected SDK. No author module/config/script/install executes. First profile is relative local TS + actual Node builtins + erased SDK types; general npm bundling is deferred. Schema1 source declares final index.mjs but has no dummy entry; schema2 is data-only. Exclusive output contains payload and pack receipt outside the digest. Keep all snapshots, publication, cleanup and cancellation boundaries from the spec; no sandbox or signature claims. Tests stay in the CLI test directory; Server enters only a separate root acceptance harness.

## Task 1: Shared contracts and package graph — root

Files: CLI package/tsconfig, types.ts/errors.ts/index.ts/api.ts, root package/scripts/lock and ESLint, Foundation/AGENTS/ADR/spec.

- [x] Record cross-package design, dependency reasons and exact public/internal types before implementation.
- [x] Write failing API tests for source/artifact distinction, output layout, pack identity and forbidden option combinations.
- [x] Implement orchestration using shared snapshot/compiler/Host services; keep public options Zod-validated.
- [x] Verify real API behavior and package graph; do not add a Runtime or HTTP dependency.

## Task 2: Bounded filesystem and positive payload profile — filesystem owner

Create snapshot.ts, output.ts, payload-profile.ts and focused test files.

Consumes types.ts. Produces captureSnapshot/verifySnapshot, writeProject, publishOutput, inspectCliArtifact and assertSourceProfile. Publishing takes trusted verify/validation callbacks, exact files and optional receipt builder; all writes and cleanup belong to this unit.

- [x] Add RED tests for existing/overlapping/linked paths, changed inputs, cancellation and ownership-preserving cleanup.
- [x] Implement bounded no-follow byte capture and exact source recheck.
- [x] Implement exclusive staging, verified payload publication and external receipt with cleanup of only owned entries.
- [x] Enforce source/ESM/data payload positive profile without silently dropping references; verify focused tests.

## Task 3: Real SDK compiler and single ESM — compiler owner

Create sdk.ts/compiler.ts/import-policy.ts/bundle.ts and tests.

Consumes DirectorySnapshot/ResolvedPluginSdk. Produces resolvePluginSdk(sdkDirectory?,signal?), checkPluginSource(snapshot,sdk,signal?), bundlePluginSource(snapshot,sdk,signal?) returning bytes, and validateEsmArtifact(bytes).

- [x] Verify RED for wrong real SDK types, missing default export, unsupported import forms and source top-level side-effect markers.
- [x] Resolve actual public SDK and CLI Node types; typecheck captured sources plus a virtual PluginFactory assignment with strict controlled options.
- [x] Supply exact snapshot bytes to esbuild, inspect all input/output imports and dispose bounded work.
- [x] Verify external directory without author node_modules and legacy Host accepts final output; never import author source during build.

## Task 4: Templates and actual bin — templates owner

Create templates.ts/scaffold.ts/cli.ts and tests. Own createPluginProject; bin dispatches root api functions.

- [x] Add RED behavior tests for all three templates, strict arguments/JSON/stdout and exclusive creation.
- [x] Generate actual Tool/Command PluginFactory source using SDK injection, and no-code Skills with referenced checklist.
- [x] Generate truthful editor config/README for this checkout's SDK; parse CLI options strictly and clean up signal handlers.
- [x] Verify the built bin from a clean external cwd and no implicit installs, Git, publication or author execution.

## Task 5: Examples, integration, review and delivery — root

Create maintained hello-tool/hello-command source examples and CLI usage guide; update README and marketplace publishing guide.

- [x] Exercise create/validate/build/pack as actual subprocesses and compare receipt/payload against Host previews.
- [x] Run explicit root harness with real loopback HTTP/SSE, SQLite restart and scripted Agent/Pipeline for Tool/Skill; verify inert import before separate activation and stale preview rejection.
- [x] Cross-review compiler, filesystem and bin units; repair actionable findings.
- [x] Run pnpm check and marketplace:check after freeze.
- [ ] Stage task-owned changes, commit in Chinese, push independent feature, create PR, await CI and squash; continue panels from latest main.
