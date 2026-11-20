# Server Local Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver Stage 4.4b persistent user trust and guarded local plugin management through Server and Desktop.

**Architecture:** Server starts a host-only baseline and injects the exact existing controller facade/publication port into PluginHost. SQLite stores append-only trust facts; thin guarded routes project local desired state and active membership; Desktop supplies its data directory.

**Tech Stack:** TypeScript strict ESM, Node SQLite, Zod, Vitest, existing Hono/Electron. No new dependencies.

**Spec:** local-plugin design §8.6 and §10.5, foundation architecture, ADR 0003.

## Global Constraints

- Branch feat/server-local-plugins from latest origin/main after PR #74 (7985494). One PR, Chinese Conventional Commits, squash after CI.
- Reuse one stable Runner/controller; publication validates and commits synchronously before awaiting retirement. No model-facing management tools.
- Durable trust facts append only, external input/readback validated with Zod, test behavior before implementation. Tests under test/.
- No Studio code in this slice. Preserve existing GET without manager and commands/current catalogs.

### Task 1: SQLite trust, paths and product version

**Files:** new apps/server/src/plugin-trust-store.ts,plugin-path.ts,host-version.ts and matching test files.
**Interfaces:** createSqlitePluginTrustStore({filename,now?}) returns PluginTrustStore & close():Promise<void>; PluginTrustStoreError codes plugin-trust-invalid/storage/closed/protocol. resolvePluginsDirectory(options:{pluginsDirectory?:string|false;databaseFile?:string;dataDirectory?:string;environment?:ProcessEnv;platform?:Platform;homeDirectory?:string}):string|false. serverHostVersion reads validated Server package version once.

- [x] Tests RED for schema-validated append/reopen/contiguous sequence/corruption/envelope mismatch/append rollback/close; preserve other DB stores/user_version.
- [x] Implement transaction MAX+1 insert, readback schema/envelope/sequence validation, typed sanitized errors, idempotent close.
- [x] Tests RED then GREEN for exact config precedence, explicit database isolation, env override and platform paths without real user dirs; version source matches package.
- [x] Focused tests/lint/typecheck and independent review; report evidence, no agent commit.

### Task 2: Catalog projection and guarded API

**Files:** plugin-management-types.ts,plugin-catalog.ts,plugin-api.ts,plugin-write-guard.ts and related tests.
**Interfaces:** ServerPluginManager snapshot/reload/trust/revoke/setEnabled returns PluginHostSnapshot/ReloadResult (type imports only). PluginAppOptions adds pluginManager and studioOrigin; projectPluginCatalog(currentCatalog,snapshot) returns PluginListItem[]. Exact wire §10.5.

- [x] Tests RED: desired local row states/duplicate invalid ids/empty provides/retained active metadata/no duplicate local rows/malformed manifest fallbacks, old no-manager response.
- [x] Implement browser wire Zod schemas and detached public projections; use current synchronous snapshot+catalog after await management result.
- [x] Tests RED common guard matrix across all writes: JSON media type, loopback Host, configured/dev Origin, cross-site rejection, invalid duplicate immediate, strict digest/body, off/notfound/conflict/storage statuses.
- [x] Implement thin routes through one shared guard; no internal causes, functions or loader entry paths. Successful assembly error returns result.error; discovery/storage reject envelope.
- [x] Focused tests/lint/typecheck and independent review; no commit.

### Task 3: Server and Desktop composition

**Files:** main.ts,runtime.ts,agent-kernel.ts, new local-plugin-host.ts, Desktop main.ts, corresponding integration/desktop tests. Root integrates app.ts only if needed.
**Consumes:** Task1 paths/version/store; Task2 structural manager. Reuse existing ServerHost controller.

- [x] Tests RED for trusted fixture startup/reload/nextturn/command persistence after restart, bad-plugin isolation, engine version accept/reject, reserved empty-contribution ids and no duplicate catalog, missingdir not created and explicit off/config precedence.
- [x] Add hostVersion through Runner/Kernel assembly consistently. Create baseline then host port using controller.current/runner/block/abort/dispose and ServerHost.publish; assembler appends fresh local wrappers, creates configured kernel plugins from per-generation factories and never shares disposable instances.
- [x] Wire trust SQLite and guarded manager to createApp, current plugin/command catalogs, return optional pluginHost for tests; close host operations/generations before shared stores and trustStore. Validate options before filesystem access.
- [x] Desktop passes dataDirectory:userDataDirectory, preserving current DB and environment plugin override; tests prove default host enabled in Desktop.
- [x] Actual Electron main ESM smoke built Server + temp local plugin trust/reload; avoid top-level await app.whenReady deadlock, use promise callback. Report current tsc output verification, no distribution packager exists.
- [x] Focused integration/desktop tests and independent review, no commit.

### Task 4: Final verification and integration

- [ ] Review complete diff against boundaries/security/ownership/shutdown/spec, fix concrete findings with regressions, whole-branch independent review.
- [x] Complete pnpm check, git diff --check and formatcheck; exact task-only index.
- [ ] Commit/push explicit same-name branch, open/attach PR, wait CI then squash/delete remote branch.
- [ ] Start Stage4.5 from latest origin/main, reconcile actual wire contract with ignored studio-plan-draft before tracked plan.

## Verification record

- `pnpm check`: exit 0, 1,694 tests passed, including 388 Server tests and 21 Desktop tests.
- Actual Electron 39.8.10 / Node 22.22.1 ESM main process: built Server discovered an external fixture without executing it, trusted the exact digest, loaded its command and restored trust after restart. No distribution packager exists in this repository.
- Independent task reviews approved persistence/configuration, route/catalog/guard and startup/cleanup contracts.

Final review identified and corrected a lifecycle ownership regression in the embedded configured kernel-plugin path. Per-generation factories now replace raw instance reuse, raw instance options are stripped at runtime, and regressions cover successful retirement, retries, partial factory failure and failed-candidate cleanup. Full checks and the Electron smoke passed again after the correction.
