# ADR 0003: Local Plugin Loading and Trust

- Status: Accepted
- Date: 2026-11-20
- Refines: ADR 0002 (Stage 4 and the trust tiers). The detailed design is
  `docs/superpowers/specs/2026-11-20-plugin-host-design.md`.

## Context

ADR 0002 gave Weave a typed plugin kernel and listed Stage 4 as "local plugins
from `~/.weave/plugins/` with workspace trust; reload from the next turn".
Stage 3 has since opened every extension point and hook that a trusted
in-process plugin needs, but plugins still reach the Server only through host
code (`registerServerPlugins`, `kernelPlugins`). Stage 4 lets a user put a
plugin on disk and turn it on. That makes three questions concrete:

1. How is plugin code found and loaded?
2. How does the user decide that this code may run?
3. How does a running Agent move to a new plugin set without disturbing a turn
   in progress?

An in-process plugin runs with Weave's own privileges. It can read and write the
user's files, use the network, read every session, and reach provider
credentials held in memory. The manifest's `permissions` are declarations: the
kernel enforces them only on kernel API paths (service use, contributed names).
Loading this code is a security decision, so it needs its own record.

### Benchmark: DeepSeek Harness

ADR 0002 surveyed Cordis through DeepSeek Harness (`dsh`). For this stage we read
how Harness distributes, loads, manages, trusts and reloads plugins, so that Weave
keeps what it does well and does not repeat what it has had to pay for.

Sources, all read on 2026-11-20. We did not run Harness and did not re-verify the
audit.

- Harness `master`: `docs/architecture.md`,
  `packages/boot/plugin-manager/README.md`, `packages/boot/hmr/README.md` and
  `SAFETY.md`.
- A third-party defensive audit of the plugin model (Harness discussion #454),
  run against commit `47f9438` and `@deepseek-ai/dsh@0.1.0-rc.6`. Harness is a
  developer preview and has changed since, so the audit is a snapshot.

What Harness does:

- **Distribution.** A plugin is an npm package ("bundle") with a `dsh` field in
  its `package.json`. A profile in the Harness home lists bundles and composes
  them with layered YAML patches: bundles, profile patch, home patch, `--patch`.
  The `dsh plugin` CLI, a Web "Plugins" page and an agent tool `plugin_manager`
  call one set of operations, which forward to pnpm.
- **Install.** `inspect` reads package metadata before anything installs.
  Registries are tried in order with fallback. Official installs and updates are
  saved with exact versions, and a git bundle is updatable only when pinned to a
  full commit. A failed install restores the manifest and the lockfile.
  Dependency build scripts need explicit approval in the UI, separately from the
  bundle.
- **Compatibility.** `engines.dsh` and peer ranges are checked when a profile is
  composed, with an exemption file for known-good mismatches.
- **Load.** Same-process ESM `import()`. The docs say installed code "executes
  in-process outside the workspace sandbox". Cordis registrations are effects
  that unwind when their plugin unloads.
- **Reload.** `dsh-hmr` reloads configuration, and optionally module source,
  through Node loader internals and applies the result immediately to every
  session that uses the profile. A replacement that fails to load stays
  inactive and the previous version is not restored. The docs note that a
  reload can change later request prefixes.
- **Safety stance.** `SAFETY.md` says the project loads third-party plugins, has
  not been security audited, and tells users to review plugins before allowing
  them to run. Tool calls, by contrast, go through a strong approval and sandbox
  pipeline.

What the audit reports for plugin code, as of `47f9438`:

- Plugins run in the host process with host privileges. Install, update,
  tamper, persistence and hot-reload paths have no signature, integrity,
  provenance or confirmation gate. There is no install warning and no update
  diff.
- Configuration-as-code (`!!js`) runs host-level code at load and is
  hot-watched, so a write takes effect within seconds. A persisted `!!js` entry
  survived `dsh plugin remove`.
- Harness's Web fence is real: loopback `Host`, same-origin `Origin`,
  `Sec-Fetch-Site: cross-site` rejected, non-JSON requests answered 415,
  privileged RPC pinned to loopback. The audit notes that the `/plugins/*` routes
  sat outside the `/api` fence, which is the failure mode of a fence applied
  route by route.
- The audit's roadmap asks for supply-chain pinning, install and update
  confirmation gates, and a declarative permission layer.

The audit's summary is the lesson: Harness spends its security budget on model
behavior and treats plugin code as trusted by construction. Weave already treats
model behavior as untrusted (Tool Pipeline, Approval, workspace policy). Stage 4
has to give plugin code the same attention.

## Decision

Weave loads local plugins in-process, behind an explicit user confirmation that is
bound to the plugin's content, and switches plugin sets between turns. The ten
decisions below are the ones that are hard to change later. The design spec has
the details.

1. **Location.** Local plugins live in `<data directory>/plugins/`, resolved like
   `weave.sqlite` (`WEAVE_DATA_DIR`, platform default). `WEAVE_PLUGINS_DIR`
   overrides it. This replaces ADR 0002's `~/.weave/plugins/`: Weave already has a
   platform data directory, and a second root would need explaining.
2. **Package shape.** A plugin is a directory with a `weave-plugin.json` (schema
   version, entry path, `PluginManifest`) and one bundled ESM entry file. The host
   injects a `PluginSdk` into the factory the entry exports by default. Plugins do
   not import `@weave/plugin`. There is one copy of the kernel vocabulary, and "the
   SDK is everything the host hands a plugin" becomes a boundary that can be
   reviewed. Node module-resolution hooks were not chosen because they are
   unproven under Electron and vitest.
3. **Closed declarations.** The manifest is read as data before any plugin code
   runs. Local plugins must declare `contributes` and `permissions` (either may be
   empty), and `contributes` gains `hooks`. The kernel already enforces declared
   lists on its own API paths, so a closed list makes the trust prompt truthful for
   those paths.
4. **Content-bound trust.** Trust names a plugin id and the SHA-256 digest of its
   whole directory. Any change returns the plugin to `changed`, shows a diff of its
   declarations against the trusted ones, and asks again. The digest is checked at
   discovery and again immediately before `import()`.
5. **Scope.** Stage 4 covers user-level plugins: trust, enable, disable, revoke.
   Project-level selection (`.weave/plugins.json`) and project-bundled code move to
   4b, because they need workspace trust and several generations at once. The trust
   record already carries a `scope`.
6. **Failure isolation.** A plugin that fails to load or `setup` is skipped and
   reported. An assembly error that can be attributed to one plugin
   (`PluginError.pluginId`) is handled the same way. An error that cannot be
   attributed keeps the running generation and, at startup, falls back to host
   plugins only.
7. **Reload semantics.** A reload follows trust, enable, disable and revoke, and an
   explicit "reload". It builds a new generation that takes effect from the next
   turn. A turn stays pinned to the generation it started on, and the old
   generation is disposed after its last turn ends. Revoke and disable can opt in
   to cancelling the turns still running on the old generation.
8. **Trust storage.** Trust decisions are an append-only event log
   (`plugin_trust_events` in `weave.sqlite`) folded to current state. It lives in
   user data, outside any workspace, so a repository cannot ship its own trust.
9. **Local API hardening.** State-changing plugin routes require
   `application/json`, a loopback `Host`, and an `Origin` equal to the configured
   Studio origin (loopback origins when none is configured). Trust additionally
   requires the digest the user reviewed.
10. **Restricted service views.** Third-party plugins receive the approval broker as
    `request`, `get`, `list` and `subscribe` only. They cannot approve, reject,
    cancel or expire approvals. The session store was already restricted in
    Stage 3.7.

### Adjustments from the Harness benchmark

These sit on top of the ten decisions.

- **B1 (extends 9).** The guard also rejects `Sec-Fetch-Site: cross-site`, and every
  state-changing plugin route is registered through it, so no route can be left
  outside. A global fence for the whole local API is a separate follow-up.
- **B2 (invariant).** No model-facing tool can trust, enable, disable or reload a
  plugin. Plugin management is reachable only through Studio and the guarded HTTP
  routes. Harness gives agents a `plugin_manager` tool and gates it with per-call
  approval. Weave does not give prompt injection a path to new code.
- **B3 (invariant).** There is no configuration-as-code, and nothing reloads plugin
  code because a file changed. The plugin set changes only through an explicit user
  action.
- **B4 (invariant).** Revoking trust leaves no other path that loads the plugin.
  What loads is decided only by the trust log and the plugin directory.
- **B5 (limit, stated openly).** Digests cover the plugin directory at load time. A
  loaded plugin that later `import()`s another file from its directory is not
  re-verified. Plugins are therefore required to ship as one bundled file, so the
  entry's digest covers all of their code.

## Benchmark verdicts

| Area                        | DeepSeek Harness                                                                  | Weave Stage 4                                                                             | Verdict                                            |
| --------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Architecture                | Everything is a plugin, no privileged kernel                                      | Typed kernel plus protected core invariants (ADR 0002)                                    | Differ by design                                   |
| Package                     | npm bundle with a `dsh` field, installed by pnpm into a profile                   | Directory, `weave-plugin.json`, one bundled ESM file                                      | Adapt: no package manager at runtime until Stage 6 |
| Composition                 | Cordis config rows, layered YAML patches                                          | User-level enable and disable from the trust log; project level in 4b                     | Adapt, defer                                       |
| Look before running         | `inspect` reads package metadata before install                                   | Manifest read as data before any code, declarations shown in Studio                       | Adopt, stronger: nothing runs                      |
| Install flow                | pnpm, registry fallback, exact pins, cancel, logs, restore on failure             | Manual placement; installer in Stage 6                                                    | Defer                                              |
| Compatibility               | `engines.dsh`, peers, exemption file, platform checks                             | `apiVersion`, `engines.weave`, state `incompatible`                                       | Adopt, without exemptions                          |
| Trust gate                  | None. Installing is trust; docs warn. Build-script approval only                  | Digest-bound confirmation, update diff, revoke                                            | Exceed                                             |
| Declared permissions        | None (audit: no manifest permissions)                                             | Closed `contributes`, `permissions`, `hooks`; service permission checks; restricted views | Exceed, enforced on kernel paths only              |
| Integrity                   | pnpm registry integrity                                                           | SHA-256 of the directory, checked twice; signatures in Stage 6                            | Exceed, defer signatures                           |
| Config as code              | `!!js` and `.ts` config includes                                                  | None                                                                                      | Reject                                             |
| Reload trigger              | File watch and config hot reload                                                  | Explicit user action only                                                                 | Reject                                             |
| Reload effect               | Immediate for every session; failed replacement not restored; prefixes may change | Next turn; running turns stay pinned; failed reload keeps the old generation              | Differ, safer                                      |
| Unwind on unload            | Cordis effects                                                                    | Disposers per plugin, generation disposal                                                 | Adopt                                              |
| Agent-facing management     | `plugin_manager` tool, approval-gated                                             | Not exposed to models                                                                     | Reject                                             |
| Management UI               | Web Plugins page: install, remove, toggle rows                                    | Studio panel: trust, enable, disable, revoke, reload                                      | Adopt, smaller                                     |
| Toggle granularity          | Individual plugin rows inside a bundle                                            | Whole plugin                                                                              | Differ                                             |
| Marketplace                 | Official offline catalog and community catalogs                                   | Stage 6                                                                                   | Defer                                              |
| Per-session capability sets | Agent presets with `isolate` realms                                               | Project-level generations in 4b                                                           | Defer                                              |
| Local API protection        | Fence on the API: loopback `Host`, `Origin`, `Sec-Fetch-Site`, JSON-only          | Same checks on plugin write routes now; whole API as follow-up                            | Adopt, scoped                                      |
| Code isolation              | None, same process                                                                | None in Stage 4. MCP in Stage 5, process isolation in Stage 6                             | Same limit                                         |
| Markdown skills             | Auto-trusted, hot reloaded                                                        | Commands and prompt sections are plugin contributions and need confirmation               | Differ                                             |
| UI plugins                  | Client plugins run in the page                                                    | Declarative only; sandboxed iframe later                                                  | Differ, safer                                      |
| Audit                       | Append-only session audit; no change detection                                    | Append-only trust log; `changed` state flags modified plugins                             | Adopt, plus detection                              |

Where Harness is ahead, and Weave defers on purpose: the install and update
experience (registry fallback, version listing, cancel, build-script approvals),
hot reload for plugin authors, an ecosystem with catalogs, per-session capability
presets, and agent-driven management. None of these is needed to run a plugin the
user placed on disk and chose to trust, and each one adds attack surface that the
trust model above has to cover first.

## Alternatives Considered

### Follow Harness: packages are trusted when installed, reload on change

Installing is the only gate, with documentation telling the user to review code.
HMR applies changes immediately. This gives the best author experience and the
shortest path to an ecosystem. It also leaves two of the audit's findings open:
nothing stops a changed plugin from running, and hot reload is an injection path.
Add a management route that a web page or a model can reach, and one forged
request installs code. Rejected. Adopted from it: reading metadata before running,
compatibility checks, exact pinning, and unwinding registrations.

### Resolve `@weave/plugin` for plugins with Node module hooks

Lets plugins write ordinary imports. Hooks run off-thread, are unverified under
Electron's main process and under vitest, and would still leave plugins free to
bring their own copy. Rejected for Stage 4. SDK injection can be replaced by this
later without changing the on-disk format.

### Trust by version, or by directory path

Version binding misses changes under the same version number. Path binding makes
every later change trusted. Both are weaker than content binding. A path-bound
"development mode" may come later, clearly marked.

### A mutable trust table

Simpler, but loses history and conflicts with Weave's rule that durable facts are
append-only. The event log also gives an audit trail for free.

### Run local plugins out of process now

Right for third-party code, and the direction of ADR 0002 decision 4 (MCP first).
It needs a permission proxy and a hosting protocol, which is Stage 5 and 6. Stage 4
serves plugins the user wrote or has read, and says so in the trust prompt.

### Watch the plugin directory and reload on change

Good for authors. It also silently replaces code, and the audit shows hot reload
as an injection route. Rejected for Stage 4; a development mode can add it later
with its own warning.

### Expose plugin management to the model

Convenient, and Harness approval-gates it. A model that reads untrusted text can be
steered to ask for it, and an approval prompt is then the only barrier. Rejected.

## Consequences

- A new package, `@weave/plugin-host`, holds discovery, digests, trust, the loader,
  reload orchestration and the generation switch. The server keeps the routes, the
  SQLite trust store and the assembly of a generation. Dependency direction becomes
  `protocol -> {llm, session} -> runtime -> plugin -> {plugin-builtins, plugin-host} -> server -> desktop`.
- Reload needs per-generation isolation that the Server does not have today:
  separate Tool Registries, provider ids owned by a generation, and per-session
  ordering across generations (each Agent Runner has its own queue today). This is
  the riskiest part, so it ships alone and without changing behavior (4.3).
- Stage 4.3 uses a generic stable Runner facade in `plugin-host`, with a
  Session queue spanning generations and cancellation that waits for production
  to settle. Server publishes a fully assembled candidate's resources and
  catalogs together. Environment and Settings Providers remain a shared Runtime
  source, while plugin Providers belong to their generation; each turn captures
  the selected client and descriptor together. Legacy registration resources
  belong to ServerHost and lend contributions to generations. Shutdown drains
  turns before closing shared stores, and retirement failures are reported at
  final disposal without undoing a successful publication.
- Plugin authors bundle to one file, expect `setup` to run more than once, and
  re-confirm trust after each rebuild. A development mode is deferred.
- In-process plugins remain without a security boundary. The trust prompt says that
  trusting a plugin means trusting its author, and shows declarations as the
  plugin's own words, not limits.
- B5 is a known gap: lazy imports from the plugin's own directory are not
  re-verified after load.
- Modules cannot be unloaded, so every new digest leaves one module in memory until
  restart. Module-level state is shared between generations that load the same
  digest.

## Related risk, outside this ADR

The Server puts the first 32 KB of a project's root `AGENTS.md` into the system
prompt without a warning. This is the same class as the audit's instruction
injection finding. Stage 3.7b records plugin-contributed sections only. Project
instructions need their own decision.

## Follow-Up

Delivery follows the spec's slices, one branch and pull request each, from the
latest `main`:

- **4.1** Kernel for third-party plugins: `contributes.hooks`, attributable errors,
  `PluginSdk`, restricted approval view.
- **4.2** `@weave/plugin-host`: manifest file, discovery, digest, trust fold, loader.
- **4.3** Generation switch with no behavior change.
- **4.4** Wire local plugins into the Server: orchestration, trust store, routes,
  hardening, configuration. Verify dynamic `import()` in a real Electron build.
- **4.5** Studio: states, trust dialog, reload. Add `/plugins` and `/commands` to the
  Vite development proxy.
- **Later:** 4b project-level plugins; a fence for the whole local API; Stage 5 MCP
  as sandboxed plugins; Stage 6 installer, signatures and marketplace; a development
  mode; code-free plugins that carry only declarations (still confirmed, because
  prompt sections are an injection surface).
