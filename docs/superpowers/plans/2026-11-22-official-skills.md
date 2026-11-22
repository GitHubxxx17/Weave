# Weave official Skills and maintained marketplace identity

**Goal:** Ship four useful, self-contained original Weave Skills and identify exact Weave-maintained GitHub releases without granting installation or runtime privileges.

**Spec:** `docs/superpowers/specs/2026-11-22-official-skills-design.md`.

**Architecture:** Schema-2 inert text payload in `plugins/official/weave-official-skills`; Server code owns protected release families and exact source/full-manifest identity; Studio mirrors host-derived categories and routes every GitHub entry through existing preview/import/activate. Runtime, Plugin-host and trust contracts remain unchanged.

**Execution:** User authorized the complete plugin sequence and PR/CI/squash workflow. Continue without new permission. Independent tasks use exclusive ownership. Root owns docs, Git and real acceptance. No dependency changes, fake pins, direct main pushes or unrelated edits.

## Task 0 — architecture before implementation

- [x] Start fresh `feat/official-weave-skills` from latest `origin/main` after panel #97 merge, preserving old dirty checkout.
- [x] Record full spec, this plan and Foundation contract before crosspackage edits. Inspect the preparation mechanism review and resolve its ordering/source identity/UI status findings.
- [x] Establish ledger with per-task and shared-interface scan. Lock worker file ownership and actual DTO shape.

## Task 1 — original self-contained content

Exclusive worker paths: `plugins/official/weave-official-skills/**`; report in this plan workspace. Root maintains general docs.

- [x] Copy reviewed preparation payload from `/tmp/weave-official-skills-payload`; keep schema2/kindskills/hostdeclarative, four Skills, no entry/permissions/executable assets.
- [x] Fix content review findings and stale Panel status using actual merged panel SDK. Replace readiness resource with useful supported closed JSON/source/form/prepare guide and link real quality-report source as provenance; provide self-contained example only if actually compiled/validated. Include Panel in author trigger without broad generic-plugin matching.
- [x] Record actual already-known panel squash/source SHA in all source notes, not the future self-referential content SHA. Distinguish original Weave text, upstream reference versions and security limitations.
- [x] Check every relative reference within the same bundle, actual Host/CLI artifact/source validation, Tool/Command examples via actual CLI build, Skill example via inspector, MCP JSON via actual Server schema. No resource execution or dependency installation.
- [x] Independent 23-scenario content review with actual behavior/limitations, then targeted updates/review. Do not equate scripted provider host tests with arbitrary model adherence.

## Task 2 — Server exact official release identity

Exclusive worker paths: new `apps/server/src/official-marketplace-releases.ts`, `apps/server/src/plugin-marketplace.ts`, relevant new/existing Server marketplace/tooling tests only. No Studio/content/docs edits.

- [x] Add code-owned family for protected distributed ID `weave-official-skills`, host display metadata and **empty initial releases**. Do not add it to startup/installer builtin-reserved IDs. Full source tuple + full parsed manifest comparison, immutable records; no marketplace module cycle.
- [x] Write RED/GREEN tests for exact pure fixture family, wrong repo/SHA/path/version/full manifest, mixed releases, unknown protected release, spoofed publisher/author/index name/weave prefix. Fixture identities never enter production table/index.
- [x] Shared index admission rejects protected unknown releases, retains strict no-category input. Verify local loader, fetched-index manager and submission/generate/check all use that admission. Helper prepare validation is intentionally blocked until exact production tuple exists.
- [x] Project exact known official GitHub entries with code-owned name/description/publisher/tags, unchanged releases and compatibility. Fail closed for typed projection callers bypassing admission. GitHub category enum official/community, builtins retain literalofficial/kindbuiltin. Index provenance stays separate.
- [x] Run relevant tests RED/GREEN and Server typecheck/lint/build. Root runs broad gates after integration.

## Task 3 — Studio official GitHub install semantics

Exclusive worker paths: `apps/studio/src/features/plugins/plugin-marketplace-types.ts`, `plugin-marketplace-page.tsx`, matching tests and only necessary styles.

- [x] Independently mirror GitHub category official/community, strict unknown-category rejection, unchanged builtin schema.
- [x] Official GitHub detail/card clearly says Weave维护 and 需要安装; kindgithub selects pinnedrelease and existing install flow, never builtin branch. Show source independently; selected/active versions stay actual managed authority.
- [x] Generic index-unavailable/unconfigured notice visible also in official tab; wording no longer falsely community-only.
- [x] Tests actual official GitHub install selection, disabled management/incompatible release, custom source provenance, builtin unchanged, spoofed metadata not creating category, status notice on official tab. No fabricated production release.
- [x] Run Studio focusedtests/typecheck/lint/build.

## Task 4 — real payload delivery acceptance and documentation

Root owns the real HTTP/SSE acceptance in `apps/server/test/official-skills.test.ts`, actual HTTP/SSE/SQLite scripts, docs and package root verification script only if useful. Do not duplicate existing synthetic lifecycle suite.

- [x] Actual payload inspector loads all four instructions and all referenced resources with exact hashes. Reject missing ref/invalid source examples; validate original payload against real schemas, not keyword assertions.
- [x] Real temp Server managed import remains inert with no trust; explicit reviewed activation yields four exact plugin IDs. Session project same shortname remains separate source.
- [x] Scripted Provider via real HTTP/SSE/shared Pipeline reads actual selected instructions to EOF and meaningful matching resource; assert requested/prepared/delivered durable facts, exact content/hash, no unexecuted-resource side effects. Use actual selected Skill ref, not provider echo alone.
- [x] Modify only source resource -> new digest/bundle; old exact ref stale after activation while held old turn retains old resource; disable/revoke newturn unavailable; rollback restores old identity. Restart after deleting source keeps immutable content/history. Reuse actual public management helpers; no DB/authority bypass.
- [x] Update official guide, Foundation, marketplace design and old MCP/declarative CLI usage docs. Record source references, exact evidence and first release still pending until real content commit exists.
- [x] Independent whole-branch review plus focused fixloops, then pnpmcheck and marketplacecheck. Browser verification uses the actual first release in Task5; earlier UI tests use explicitly marked fixtures.
- [ ] Commit/push exact topic, PRattach, CI, SHA-guarded squashmerge and remote branch deletion. No user-facing stop between sequence tasks.

## Task 5 — separate real pinned release

Fresh `feat/official-skills-marketplace-release` from actual latestmain after content merge. Root-owned, distinct PR.

- [ ] Read actual full main squash SHA and descriptor from committed `plugins/official/weave-official-skills`. This SHA is the payload pin; not the future index PR SHA.
- [ ] Register reviewed exact source+full parsed manifest in protected host family FIRST. Shared admission otherwise rejects marketplace:entry. This creates no acquisition bypass and no indexed card yet.
- [ ] Run real `pnpm marketplace:entry` using canonical repo/full SHA/subdir and actual GitHub acquirer; inspect output and exact pinned content. On transient rate limit use authenticated existing source tools if available without leaking tokens or persistently changing auth; never fake success.
- [ ] Add derived submission, deterministic index; `marketplace:generate`, `marketplace:check`, focused identity tests, fullcheck as affected. Actual browser default officialcard needs install, preview/import remains inert, independent activation, Skillpicker fourentries. Record real network evidence separate from offline fixtures.
- [ ] Review, commit/push/PR/CI/squash. Report content mergeSHA, payload pin, index mergeSHA, real installation/delivery evidence and limitations. Packaged index is not an external deployedmarketplace.

## Shared-interface and self-consistency scan

| Tasks | Interface / overlap | Ruling |
| --- | --- | --- |
| 0 / 1-4 | Foundation and design before code | Root writes docs first; workers own disjoint paths. |
| 1 / 4 | Actual payload read by acceptance | Content worker hands final files/hash, root waits before exact acceptance. |
| 2 / 3 | category official/community | Fixed independent DTO enum, existing kind discriminant authoritative. |
| 2 / 5 | Protected ID exact release admission | Empty initially; register real existing tuple before acquisition helper, no fake source. |
| 1 / 5 | Versioned snapshot source notes | Cite known product SDK SHA; release source uses later content SHA without self-reference. |
| 3 / 5 | Official package downloadable | UI testfixtures only until realrelease; release branch browser verifies actual source. |
| 4 / 5 | Local validation vs network release | Local acceptance cannot stand in for actual pinned acquisition. |
| 0-5 each | Own tests match behavior and no privilege change | Meaningful behavior assertions; shared pipeline/trust remain existing boundaries. |
