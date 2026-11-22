# Plugin Marketplace Indexes Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute
> the approved contract with independent review and behavior verification.

**Goal:** Make marketplace sources configurable and provide an operational local
catalog submission/generation workflow based on fixed GitHub releases.

**Architecture:** Server owns index IO, append-only source settings and cached
discovery; Studio consumes guarded HTTP. Server CLI validates the same strict
catalog format. Plugin installation and runtime trust remain existing workflows.

**Tech Stack:** TypeScript ESM, Zod, Hono, React, Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-22-plugin-marketplace-indexes-design.md`.

## Global constraints

- Preserve original Stage 6.4 tree and the existing Stage 6.5 changes.
- No commit, push, repository creation or external publication in implementation.
- Strict cached GET, explicit remote refresh, bounded data and safe public errors.
- Full pinned manifest/source equality before existing human installation review.
- Tests live in package/app test directories. Cross-package design precedes code.

## Task 1: Server index-source service and routes

- [x] Add failing behavior tests for sources, guarded POST, pure GET, refresh,
  persistence/restart, invalid inputs and close/drain.
- [x] Implement the service, bounded downloader and append-only settings log.
- [x] Extend marketplace projection/DTO and wire startup/shutdown ownership.
- [x] Run focused Server tests, typecheck and review changed contracts.

## Task 2: Studio source management

- [x] Add DTO/API tests and source-management interaction/race tests.
- [x] Implement source picker, add/remove controls, refresh, error/stale states.
- [x] Preserve source attribution and the existing exact install selection.
- [x] Run focused Studio tests and typecheck; review accessibility/layout.

## Task 3: Maintained directory and publication tooling

- [x] Add failing tests for deterministic generation, input validation, drift and
  bounded entry preparation without plugin execution.
- [x] Implement shared-validator CLI, checked-in empty index and submissions path.
- [x] Add root commands, CI validation, developer guide and submission PR template.
- [x] Run tool tests and commands; review generated index and documentation.

## Task 4: Integration and verification

- [x] Verify source-service/Studio/tooling contracts together and correct findings.
- [x] Run full `pnpm check` and `pnpm marketplace:check`.
- [x] Exercise real browser source management and responsive marketplace layout.
- [x] Record delivered capabilities, source comparison, tests and hosting limits.
