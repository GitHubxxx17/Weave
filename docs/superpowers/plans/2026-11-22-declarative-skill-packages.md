# Declarative Skill packages implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the independent implementation units and cross-review before integration.

**Goal:** Install, review and activate a pure Skills text package through the existing managed plugin lifecycle without importing publisher code.

**Architecture:** A strict schema-2 data descriptor maps to bounded, frozen Skill contributions through a host-owned adapter. Existing immutable artifacts, exact authority, Generation retention, HTTP/SSE, Skill tools and Session facts remain the lifecycle boundaries.

**Tech stack:** TypeScript ESM, Zod, Node filesystem APIs, SQLite, Hono, React, Vitest and the existing workspace toolchain. No new dependency.

**Spec:** [Declarative Skill packages](../specs/2026-11-22-declarative-skill-packages-design.md), [ADR 0007](../../adr/0007-declarative-skill-packages.md).

## Global constraints

Keep schema-1 ESM read/digest/replay semantics unchanged. The schema-2 package has only `host:declarative`, capability `skill`, explicit 1–16 Skill names and no permissions or entry. Resources are strict UTF-8 text: 64 resources and 2 MiB aggregate, 256 KiB per resource; complete SKILL.md/frontmatter bounds are 64/8 KiB. Package inspection runs no author module or script. Install is inert and activation requires a separate review. Do not add durable type defaults, an index version, authority migration, Runtime behavior, CLI or panel SDK to this topic.

## Task 1: Payload and governed data adapter

Files: Plugin `manifest.ts`; Plugin-host `descriptor.ts`, `payload-inspector.ts`, artifact types/copy/store, discovery, loader and explicit local selection. Tests: Plugin `test/skills.test.ts` and Plugin-host `test/declarative-skills.test.ts` alongside existing ESM suites.

Contract: `inspectPluginPayload(directory, {hostVersion?, signal?, limits?})` returns `PluginArtifact`. Payload variants are `{kind?:'entry',entry:string}` and `{kind:'skills',skills:readonly SkillContribution[]}`. Offline inspection does not guess an engine version; actual admission retains compatibility checks. A host-owned `definePlugin` adapter contributes frozen data via `skillsExtensionPoint`.

- [x] Add failing strict descriptor and no-entry inspection/loading tests.
- [x] Implement bounded text validation and variant narrowing without a fake entry.
- [x] Verify no import, strict paths/text/layout/limits, mutation, cancellation, engine checks, frozen owner attribution and retained old data.
- [x] Cross-review the final Host diff and resolve actionable findings.

## Task 2: Managed Server and marketplace

Files: `apps/server/src/{managed-plugin-composition,plugin-catalog,plugin-marketplace,marketplace-tooling}.ts`. Tests: `declarative-skill-packages.test.ts`, support fixture, marketplace tooling/catalog tests and existing authority/installer suites.

Contract: compare exact manifest, digest, directory, counts and entry-or-Skills evidence. Preserve saved lookup before source IO, authority heads, namespace, ownership and independent activation. Schema-1 marketplace metadata keeps the complete additive manifest.

- [x] Reproduce no-entry rejection through the real installer fixture.
- [x] Narrow managed identity and verifier evidence by variant; reuse the inert inspector in entry generation.
- [x] Verify inert import, real Agent/Pipeline resource reads, SQLite restart, pinned update, rollback/disable/revoke, GitHub callback acquisition, namespace conflicts and legacy offline replay.
- [x] Independently review Server behavior and targeted legacy tests.

## Task 3: Studio review and selection

Files: `apps/studio/src/features/plugins/` managed types/dialog/history, marketplace page, trust dialog and payload description. Tests: declarative type/dialog fixtures, market/history regression cases.

Contract: strict validated declarative manifests alone earn the text-package disclosure. ESM keeps code execution wording. Existing left marketplace, source preview/import, separate activation and exact Skill refs remain the user flow.

- [x] Reproduce old closed-host rejection and missing text-only disclosure.
- [x] Add strict mirrors and review/history labels without wire defaults.
- [x] Verify desktop 1440×1000 and mobile 390×844 fixture UI through import, independent activation, picker/preview, exact send and restored history.
- [x] Independently review the final Studio diff.

## Task 4: Maintained example and integration

Files: `examples/plugins/weave-coding-skills/`, README, Foundation, publishing/Skills usage guides and the text-package guide. Example content is Weave-authored review and verification guidance with actual referenced checklists; it is not a published release claim.

- [x] Create the no-build example and document real layout, limits and lifecycle.
- [x] Run real loopback HTTP/SSE using this exact example, actual shared Pipeline and SQLite restart; verify update/rollback/revoke.
- [x] Run `pnpm check` and `pnpm marketplace:check` after implementation freezes.
- [ ] Inspect staged new files and complete independent review.
- [ ] Follow the authorized feature commit, explicit push, PR, passing CI and squash workflow; start the next independent CLI topic from latest main.

Evidence and the exact validation results are maintained in the [usage guide](../../learning/2026-11-22-declarative-skill-packages.md); temporary development logs do not become product dependencies.
