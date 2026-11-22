# GitHub Plugin Acquisition Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement
> and review the tasks. Do not commit or push without explicit owner authorization.

**Goal:** Import a public GitHub plugin at a complete commit through the existing
candidate and activation flow.

**Architecture:** plugin-host owns bounded Git tree/raw acquisition in callback-scoped
scratch storage. Server owns remote provenance and reviewed import; Studio uses
HTTP and the existing management gate. No Runtime or activation change.

**Tech Stack:** TypeScript ESM, Zod, Node fetch/crypto/fs, Hono, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-github-plugin-acquisition-design.md`.

## Global constraints

Use all source, network, filesystem, limit, error and lifecycle values from the
spec verbatim. No added dependencies, package execution, implicit trust or Catalog.
Tests live in package/app `test/`. Work from latest main on the dedicated feature
branch. Do not commit, push, merge or modify another task's owned implementation.

## Task 1: Callback-scoped GitHub acquisition

Files: create focused `packages/plugin-host/src/github-*.ts`; export from
`packages/plugin-host/src/index.ts`; tests in `packages/plugin-host/test/github-*.test.ts`.

Produces `GithubPluginSource`, `githubPluginSourceSchema`, `GithubPluginAcquirer`,
`createGithubPluginAcquirer({directory, fetch?})`, `GithubAcquisitionError` with the
spec's error codes. Acquirer method:

```ts
withSource<T>(source: GithubPluginSource,
  use: (directory: string, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>
```

- [x] Write failing schema/transport/filesystem behavior tests with fixture tree
      and blob hashes (`sha1('blob ' + size + '\0' + bytes)`). Run focused Vitest.
- [x] Implement normalized source validation, bounded response reader, generated
      tree/raw URLs, modes/path validation, workers and blob verification.
- [x] Implement serialized private scratch recovery/callback/cleanup and abort
      propagation. Run package tests, lint, typecheck and build.

## Task 2: Server provenance and reviewed remote imports

Files: `apps/server/src/plugin-authority-types.ts`, `managed-plugin-installer.ts`,
`managed-plugin-api.ts`, `managed-plugin-catalog.ts`, `local-plugin-host.ts` and
related setup/tests. Consume Task 1 exports and produce guarded
`POST /plugins/managed/github/preview` and normal `/import` behavior.

The acquirer can be injected into installer tests. Production creates it with
the hidden sibling scratch-root rule in the spec. Avoid requiring
binding on existing minimal test doubles; GitHub acquisition is available when a
real store binding or explicit acquirer exists.

- [x] Write failing authority provenance/reopen/no-op and preview/import/replay
      tests. Keep local stored JSON and local HTTP DTOs unchanged.
- [x] Add strict GitHub provenance, preview source echo and catalog source
      projection. Add the new fixed public acquisition error mappings.
- [x] Extend existing installer preview helper and remote stage callback; finish
      cleanup before token issue or durable commit. Keep request fingerprint and
      activation unchanged. Test no execution/trust/rebuild and saved replay offline.
- [x] Track and drain full preview acquisition before lease release in normal
      shutdown and unpublished-host cleanup; test a delayed abort/cleanup barrier.
- [x] Run Server tests/types/lint, including existing local importer integration.

## Task 3: Studio GitHub source and review

Files: `apps/studio/src/features/plugins/managed-plugin-{types,api,dialog}.tsx`
(actual existing extensions), `managed-plugins-section.tsx`,
`plugin-catalog-store.ts`, CSS and tests. Consume Task 2 HTTP contract using
Studio-owned schemas, without importing `@weave/*` or Node modules.

GitHub source is `{repository, commit, subdirectory}`. Preview uses the strict
source JSON body and normal preview plus `github` source. Catalog candidates use
`provenance: 'github'` and `github` source, or existing local provenance.

- [x] Write failing API/panel tests for canonical input/source echo, history,
      shared gate, cancellation and late responses; ensure local import tests pass.
- [x] Add local/GitHub source choice and fields, loading/cancel, remote preview
      method on the catalog store, and source-aware import review/history display.
- [x] Preserve immutable durable retry body, explicit activation and focus
      behavior. Run Studio tests/types/lint.

## Task 4: Integrated verification and review

- [x] Review each task against the spec and fix actionable findings.
- [x] Format task files and run root `pnpm check`; capture test totals.
- [x] Verify a public GitHub fixed-commit source and real Studio loopback flow.
      Record limitations separately from deterministic test evidence.
- [x] Update documentation with final behavior and verification. Review the
      whole branch and report exact remaining scope and Git state.

Validation note: public fixed-commit retrieval was attempted and returned the anonymous GitHub rate-limit error; full live retrieval is not claimed. See the learning document for the completed deterministic, loopback/browser and root checks.
