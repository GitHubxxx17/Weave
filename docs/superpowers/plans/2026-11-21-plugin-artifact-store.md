# Plugin Artifact Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Provide a bounded, non-executing local-directory artifact store as the independently usable Stage 6.1 filesystem foundation.

**Architecture:** `@weave/plugin-host` copies a source into private staging, validates the actual copy and publishes it under its existing directory digest. Hidden artifacts do not enter discovery or acquire trust. Server selection, SQLite, UI and network acquisition are separate later PRs.

**Tech Stack:** Existing strict TypeScript ESM, Node filesystem/crypto/path, Zod and Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-21-plugin-installation-design.md` §§2–4 and 8; ADR 0005.

## Global Constraints

- Package imports remain `plugin-host -> plugin`; no Runtime, SQLite, HTTP or Agent imports.
- Tests live in `packages/plugin-host/test/`; use temporary roots, never a user's plugin directory.
- Never execute/import a payload, run a package manager/build/shell, hard-link content or follow descendant links.
- Exact public contracts and stable artifact errors are in spec §4; all external inputs use Zod.
- Payload limits: 1,000 files, 20 MiB, descriptor 64 KiB, 64 directory levels, 2,000 entries. Published quota: 64 distinct digest directories including orphans.
- One store instance serializes operations; one live owner per directory. Stage 6.1 does not claim cross-process locking.
- Published artifacts are never overwritten/deleted; staging is bounded and cleaned. No selection, trust or runtime changes.
- Existing ignored names `.git`, `.DS_Store`, `Thumbs.db` at any depth are not copied or counted.
- Every source/staging/artifact prehash/posthash/read uses the depth/entry-bounded walker with the existing pure digest-framing algorithm, not a second unbounded filesystem walk. Preserve primary and cleanup failures together; abort cannot hide cleanup failure.
- No source/store overlap. Sources are real absolute directories; normalized ancestry may traverse links but descendants cannot.
- Do not commit or push in a subagent. Root handles the approved branch/PR/CI/squash workflow.

## File structure

- Create `packages/plugin-host/src/artifact-types.ts`: readonly API, exact bounds and typed errors.
- Create `packages/plugin-host/src/artifact-copy.ts`: bounded filesystem traversal, verified streaming/file copying, safe staging cleanup helpers.
- Create `packages/plugin-host/src/artifact-store.ts`: serial queue, staging lifecycle, validation, capacity, immutable publication and reads.
- Modify `packages/plugin-host/src/index.ts`: public artifact exports.
- Reuse or narrowly extract descriptor/compatibility/entry validation from discovery; existing manual discovery behavior stays identical. Do not duplicate its policy.
- Create `packages/plugin-host/test/artifact-store.test.ts` and optional focused `artifact-copy.test.ts`; fixtures belong in `test/support/`.
- Create `docs/learning/2026-11-21-plugin-artifact-store.md`; update Foundation implementation status when the slice is verified.

### Task 1: Non-executing bounded artifact store

**Interfaces:** Consume existing `PluginDescriptor`, `parseDescriptor`, `computeDirectoryDigest` and discovery validation; produce `createPluginArtifactStore`, `PluginArtifactStore`, `PluginArtifact`, `PluginArtifactError` as in spec §4. The store's configured directory is the actual hidden `.weave-store` root, not the plugins discovery root.

- [x] **Step 1: Write real-filesystem RED tests for initial stage/read.** A valid fixture has `weave-plugin.json`, bundled `index.mjs` with top-level code that would write a marker if evaluated, an ordinary dotfile, and ignored droppings. Verify the marker does not exist, the returned concrete path is below `artifacts/<digest>/payload`, the copied digest equals the source digest, source edits cannot change published bytes, and `read` returns the original immutable descriptor. Example assertion:

```ts
const store = createPluginArtifactStore({ directory: managedRoot, hostVersion: '0.0.0' });
const artifact = await store.stage({ sourceDirectory });
expect(artifact.directory).toBe(path.join(managedRoot, 'artifacts', artifact.digest, 'payload'));
expect((await computeDirectoryDigest(artifact.directory)).digest).toBe(artifact.digest);
await expect(access(executionMarker)).rejects.toMatchObject({ code: 'ENOENT' });
await writeFile(path.join(sourceDirectory, 'index.mjs'), 'throw new Error("edited")');
expect((await store.read(artifact.digest)).digest).toBe(artifact.digest);
```

- [x] **Step 2: Run the targeted test and record the expected missing-feature failure.** Use `pnpm exec vitest run --config vitest.config.ts packages/plugin-host/test/artifact-store.test.ts`. Import a namespace if needed to assert a missing function rather than treating a typo/import resolution failure as RED.
- [x] **Step 3: Implement minimal typed errors/API, safe paths, copy and final-payload validation.** Use the bounded walker with shared digest framing throughout; validate the staged payload with existing discovery rules without executing it. No changed global discovery limits or trust semantics. Fail changing or linked files, and clean only owned staging.
- [x] **Step 4: Add and run RED cases before the matching behavior.** Cover invalid options/relative path, cancellation before/during stage, invalid/missing/oversize descriptor, incompatible API/host/engine, missing entry, symlink root/child/entry, special files on supported platforms, source/store overlap, 65-level depth, entry/file/byte limits and source mutation. Use an fs operation spy only where a deterministic mutation/cancellation boundary is otherwise unavailable; assert real resulting bytes/state, not mock call counts.
- [x] **Step 5: Implement serial stage/read, immutable publication and errors.** Recheck final staged digest before same-filesystem rename. Existing digest is validated and reused, never replaced. A failed stage removes its staging container; an already-published artifact stays inert after late cancellation.
- [x] **Step 6: Add integrity/capacity/recovery RED tests and pass them.** Same digest is idempotent; different versions keep separate fixed paths; corrupt content/name is rejected; missing digest is not-found; 64 published objects reject a 65th unique payload but allow an exact duplicate; two concurrent last-slot stages cannot both publish; orphan objects count; abandoned staging is removed on next stage. Assert no published artifact is removed and original discovery cannot see hidden candidates.
- [x] **Step 7: Run package verification and self-review.** Run `pnpm --filter @weave/plugin-host test`, package typecheck/build/lint, and targeted Prettier checks. Record exact commands/results and any platform skips. Tests cannot falsely claim Windows or sudden-power-loss acceptance. Write the task report and hand off to an independent reviewer.

### Task 2: Usage, architecture and delivery evidence

**Consumes:** Task 1's final exported API and package test report. **Produces:** accurate standalone usage documentation and independently verified topic PR.

- [x] **Step 1: Document the actual API, non-execution, quotas, immutable retention, orphan recovery, one-owner restriction and install/selection/trust differences.** Include this usage with actual imports:

```ts
import { createPluginArtifactStore } from '@weave/plugin-host';
const artifacts = createPluginArtifactStore({
  directory: '/absolute/plugins/.weave-store',
  hostVersion: '0.0.0',
});
const candidate = await artifacts.stage({ sourceDirectory: '/absolute/bundled-plugin' });
// This publishes files only. It does not select, trust, enable or load the plugin.
const checked = await artifacts.read(candidate.digest);
```

- [x] **Step 2: Independent spec/quality review of Task 1 and documentation.** Resolve concrete findings and rerun only affected checks; preserve reports in the plan ledger.
- [ ] **Step 3: Run root `pnpm check`, inspect diff and architecture boundaries, and obtain final whole-branch review.** Source tests plus formatting/lint/types/build must pass. No browser/Electron UI claim for this filesystem-only slice.
- [ ] **Step 4: Root commits explicit task paths, pushes topic branch, creates/attaches PR, waits CI, verifies exact head and squash merges.** Delete remote topic branch, fetch/verify main, and start Server authority on a fresh branch from latest `origin/main`.
