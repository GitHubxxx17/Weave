# ADR 0002: Typed Plugin Kernel

- Status: Accepted
- Date: 2026-11-19

## Context

`AGENTS.md` positions Weave as a "plugin-native runtime". Today the plugin
surface is a minimal baseline: `@weave/plugin` (`createPluginRegistry`,
`createPluginContext`) lets a trusted in-process plugin register **tools** and
**LLM providers** through a capability-gated manifest, with a staged context,
a secret-free snapshot, a serial registration queue and reverse-order dispose.
Everything else — the Agent loop, Tool Pipeline, Approval, Workspace policy,
Session store, prompt assembly — is wired by the server composition root, not
contributed by plugins.

Three concrete limits in the current code motivate a larger kernel:

1. **Services cannot declare dependencies on each other.** `RuntimeService<T>`
   (`packages/runtime/src/types.ts`) exposes only `create(context)` with no way
   to look up another service, so `apps/server/src/runtime.ts` hand-assembles
   the Agent Runner after startup using four `WeakMap`s and three `WeakSet`s.
   The file's own comment records this as a known workaround.
2. **Durable event types are a closed set.** `packages/session/src/events.ts`
   is a fixed `z.discriminatedUnion('type', …)` (duplicated across the new and
   persisted unions). A plugin cannot add a durable event type or projection.
3. **Agent behaviour lives in the server.** `apps/server/src/agent-instructions.ts`
   builds the system prompt and is injected into the runtime Agent Runner, which
   conflicts with `AGENTS.md` ("agent behavior belongs in the runtime").

We surveyed Cordis (DeepSeek Harness), Backstage's backend system, VS Code's
extension model, MCP/LSP, Tapable, Zed (WASM), and Pi/OpenCode. No single model
fits: Cordis is strongest on replaceability and hot reload but types
dependencies as strings, hands plugins the whole `ctx`, runs them in-process
outside the workspace sandbox, and its guard/waterfall lets an early listener
short-circuit before the approval policy; Backstage is strongest on typed
dependencies and start-up validation but assumes network isolation and no
security model; VS Code is strongest on declarative manifests, lazy activation
and host isolation but fixes its API surface; MCP is strongest on ecosystem and
process isolation but cannot replace core parts like provider access or session
storage.

## Decision

Build Weave's **own typed plugin kernel** inside `@weave/plugin`, on top of the
existing baseline, combining the best parts of those models and adding Weave's
own security and persistence invariants. Two properties must both hold:
**everything is a plugin** (model access, tools, session storage, agent loop,
prompt, commands, UI panels are all contributed and can be added, disabled or
replaced), and **plugins cannot bypass the guardrails** (approval, workspace
boundary, append-only events are enforced by protected core plugins).

### Kernel mechanisms (the kernel ships no product behaviour)

| Mechanism                           | Purpose                                                                                                                                                                 | Borrowed from                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Service `ServiceRef<T>`             | Typed reference + factory + declared deps; scopes `root`/`workspace`/`session`; single implementation by default                                                        | Backstage                              |
| Extension point `ExtensionPoint<T>` | Owned by one plugin, others contribute into it; accumulating or single-slot; owner initialises after all contributions                                                  | Backstage                              |
| Hook                                | Three modes only: `observe` (read-only, isolated failures), `wrap` (middleware via `next()`), `decide` (security; results merge strictly tighter: deny > ask > abstain) | Tapable, Cordis                        |
| Scope + reclaim                     | Every registration returns a disposer bound to the plugin's scope; unloading a plugin removes all it registered                                                         | Cordis, VS Code                        |
| Generation (snapshot)               | Immutable snapshot of the active plugin set; a turn is pinned to one generation; reload creates a new generation effective from the next turn                           | New                                    |
| Manifest + trust                    | Manifest declares contributions, permissions and host; kernel checks that actual registrations stay within the manifest                                                 | VS Code + existing manifest validation |

Plugins depend only on `@weave/plugin` and `@weave/protocol`; the libraries
(`llm`, `session`, `workspace`, `runtime`) stay plain libraries that do not know
the kernel exists.

### Invariants plugins cannot bypass

1. **Tools run only through the shared Tool Pipeline.** A tool's `execute` is
   visible only to the pipeline; every caller (including a replaced agent loop)
   calls `pipeline.execute()`.
2. **Approval and workspace boundaries are protected core plugins.** Their
   `decide` results merge strictly tighter; project config cannot disable them.
3. **Events are append-only.** Plugin event types are namespaced
   `<pluginId>/<name>` with a registered Zod schema + projection; after a plugin
   is removed its past events are retained but skipped in projection so a session
   still opens. (Requires opening the closed union in `events.ts`.)
4. **Model-visible means logged.** Plugin-contributed prompt sections and
   injected context are hashed, de-duplicated and written to session events so
   any model request is reconstructable. (This reverses PR #32's "system prompt
   not logged"; see Decision 2.)
5. **Durable facts and transient state are separate.** Stream deltas reach
   plugins only through a `wrap` around the whole stream, never as per-token
   durable events; durable facts are appended only through the session writer.
6. **Studio stays HTTP/SSE-only.** UI extension is declarative first (settings
   forms, commands, typed tool-result renderers); rich panels later use a
   sandboxed iframe, never injected plugin JS.

### Trust tiers

| Tier             | Host                          | Enabled                           | May do                                       |
| ---------------- | ----------------------------- | --------------------------------- | -------------------------------------------- |
| core (protected) | in-process                    | ships with Weave, cannot disable  | maintains the invariants above               |
| builtin          | in-process                    | default on, can disable/replace   | use every extension point                    |
| trusted          | in-process                    | user confirms "trust this plugin" | like builtin, cannot replace core            |
| sandboxed        | MCP / subprocess (later WASM) | user confirms permission manifest | only granted capabilities, all calls proxied |

A project's `.weave/plugins.json` can only enable/disable already-installed
plugins; loading project-bundled plugin code requires trusting the workspace
(VS Code Workspace Trust).

### Recorded decisions (confirmed with the owner)

1. **Agent loop is a replaceable `builtin` plugin**; the invariants live in the
   core services it must call.
2. **Plugin-contributed prompt content is written to session events by hash.**
   This supersedes PR #32's behaviour.
3. **Reload takes effect from the next turn**, not mid-turn (Cordis-style
   immediate reload rejected); a plugin that must drop immediately can cancel
   the running turn.
4. **Third-party plugins arrive over MCP first**, subprocess hosting later.
5. **The plugin API lives in one package, `@weave/plugin`;** libraries stay
   kernel-unaware, so the current layer direction is unchanged.

## Alternatives Considered

### Adopt Cordis directly

Mature, with hot reload, but string-typed dependencies, whole-`ctx` exposure,
no "tighter-only" policy merge, and the Harness itself vendors Cordis source
into its repo — it would bind Weave's architecture to an external library.
Rejected.

### Use a generic DI container (InversifyJS, tsyringe, Effect)

Solves dependency injection only; extension points, hooks, generations and
trust tiers would still be bespoke, and decorators/Effect style would leak into
the whole codebase. Rejected.

### Build on the existing `@weave/plugin` baseline (chosen)

No new runtime dependency, exact fit to Weave's invariants, and the direction
the Foundation design already reserved (minimal Runtime lifecycle + dependency
registration, extended later into scopes, dependencies and plugin
contributions). Cost: we write and test it ourselves.

## Consequences

- `@weave/plugin` grows from "register tools/providers" into the typed service /
  extension-point / hook / generation kernel; the existing `registerTool` /
  `registerProvider` path stays working during migration.
- The server composition root becomes a profile (a chosen set of plugins plus
  config); the `WeakMap`/`WeakSet` hand-assembly in `runtime.ts` is removed once
  services declare dependencies.
- `events.ts` must open its closed union to namespaced plugin events with
  registered schemas and projections — an append-only, backward-compatible
  change.
- The system prompt moves from `apps/server` into a `prompt-core` builtin
  plugin, aligning with `AGENTS.md`.
- Libraries remain independently usable (good for the future SDK); most existing
  tests should not need to change.
- The kernel is in-process for now, so the permission model is not yet a
  security boundary for in-process plugins; its value is a single model reused
  unchanged for out-of-process (MCP/subprocess/WASM) plugins later.

## Follow-Up

Staged delivery, one branch and PR per stage, from latest `main` each time:

- **Stage 0 (this ADR + kernel interface design doc).** No behaviour change.
- **Stage 1 — kernel.** Implement services, scopes, dependency validation,
  reclaim, extension points, hooks and generations in `@weave/plugin`; keep the
  current registration path.
- **Stage 2 — split.** Wrap existing features as builtin plugins; the server
  becomes a profile. Behaviour unchanged; may be 2–3 PRs.
- **Stage 3 — open extension points.** Commands, prompt sections, tool hooks,
  LLM middleware, plugin events/projections, declarative UI; Studio gains a
  "Plugins" page.
- **Stage 4 — local plugins** from `~/.weave/plugins/` with workspace trust;
  reload from the next turn. ADR 0003 refines this stage: the plugin directory is
  `<data directory>/plugins/`, and trust is bound to the plugin's content.
- **Stage 5 — MCP** as sandboxed plugins.
- **Stage 6 (M5, later)** — plugin directory, installer, marketplace, subprocess
  hosting and permission proxy.

The detailed typed interfaces (`ServiceRef`, `ExtensionPoint`, `Hook`,
generations, manifest additions) are specified in the companion design doc
(`docs/superpowers/specs/2026-11-19-plugin-kernel-design.md`) before Stage 1
implementation. The one-way package dependency direction is preserved; this ADR
records the kernel direction reserved by ADR 0001's follow-up.
