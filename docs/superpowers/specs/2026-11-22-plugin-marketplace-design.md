# Stage 6.5: Studio Plugin Marketplace

Date: 2026-11-22. The owner requested continuing Stage 6 and explicitly placed
the primary plugin marketplace in the left navigation as a dedicated page.

The subsequently approved [index extension](2026-11-22-plugin-marketplace-indexes-design.md)
supersedes this document's initial local-only directory scope. It adds a default
repository directory, configurable HTTPS indexes and developer submission tooling;
the installation and navigation invariants below continue to apply.

## Product and references

The page has Discover and Installed views. Discover supports search and
All / Official / Community filters, plugin details and version selection.
Installed reuses local plugins, immutable managed versions, GitHub import,
MCP, trust, activation, rollback and unresolved-request recovery.

The primary Plugins entry is removed from the right-panel registry. A future
plugin UI contribution may add custom right panels through a separately designed
SDK; this delivery does not expose arbitrary plugin components or browser code.

DeepSeek Harness `plugin-market`, `plugin-market-index` and `plugin-manager` at
`2e39e70496aa02986ca6a820c5d497e816b69d7e` separate discovery, fixed versions and
installation (links and inspection evidence in the Stage 6.4 design). We adopt
that separation, with an initially static community index and Weave's existing
installer. Existing Codex generation/approval and Kiro configuration references in
Foundation still govern activation and shared tool policy. They do not establish
Weave publisher verification or sandbox guarantees. The requested left navigation
is Weave's product decision, not an asserted clone of another product's UI.

## Server / Studio HTTP contract

Add read-only `GET /plugins/marketplace`, `Cache-Control: no-store`:

```text
{ schemaVersion: 1, hostVersion: string,
  communityStatus: 'unconfigured' | 'ready' | 'unavailable',
  entries: (BuiltinEntry | GithubEntry)[] }
BuiltinEntry = { kind:'builtin', category:'official', id, name, description,
                 publisher:'Weave', tags:string[], version:string }
GithubEntry = { kind:'github', category:'community', id, name, description,
                publisher:string, tags:string[], releases:
                { manifest: ManagedManifest, source: GithubPluginSource,
                  compatibility:'compatible'|'incompatible' }[] }
```

The official entries are a code-owned allowlist of actual Weave builtins, shown
only when those builtins are in the host catalog. They are labelled bundled and
are not downloadable marketplace releases. Runtime origin alone never grants an
official label. No fabricated community authors, published plugins, installs,
ratings or verification badges are seeded.

Community data is a local static JSON index selected by an absolute
`WEAVE_PLUGIN_MARKETPLACE_CATALOG` path (or `StartServerOptions.pluginMarketplaceCatalogFile`,
with `false` disabling it). Read once at startup, at most 512 KiB. Strict Zod
schema: `{schemaVersion:1, plugins: CommunityPlugin[]}`. A community plugin has
`id`, `name`, `description`, `publisher`, `tags` and `releases`; each release has
the full managed-artifact `manifest` and canonical fixed-commit `source`, without
server-generated kind/category/compatibility. Bound 100 plugins, 20 releases per
plugin, 10 tags, bounded strings; reject duplicate IDs, duplicate versions and
entry/manifest ID mismatches. Official/reserved IDs cannot be claimed by community
entries. Full manifest validation and the existing engine/API/host rules determine
compatibility. Sort releases by numeric version descending, without resolving refs.

Invalid/unreadable/oversized indexes produce `communityStatus:'unavailable'` and
no community entries, while builtins and agent work remain available. Never expose
filesystem paths or parse errors. An absent index is an honest empty state.
Index configuration is operator-maintained in this delivery; developer publication
is submission of a fixed-source entry, not a publishing account service. No remote
index fetching, credentials, ratings, payment, signatures or new dependencies.

Server owns index IO/projection. Studio independently validates the HTTP DTO with
Zod and imports no workspace or Node packages. Plugin-host, Runtime, append-only
authority and the shared tool pipeline contracts do not change.

## Installation and review

Selecting an installable release passes its frozen manifest and GitHub source to
the existing managed import form. It must not automatically fetch or import on
page/tab mount. The user explicitly requests preview. Preview uses only
`store.previewGithubManaged`; validate the returned source and full actual manifest
against the selected release. A mismatch blocks the review/import handoff. Show
the marketplace publisher as index attribution, separately from actual manifest,
source, full commit, digest and permissions in the existing review.

Use the same `ManagedReview` / `submitManaged` / immutable-candidate / separate
activation path. Page navigation or changing source discards/aborts pending
previews; late completions cannot open a portal. No marketplace text, classification
or preview grants trust. Show version availability and imported/selected/published
states precisely; ID or version equality alone cannot prove byte identity.

## Navigation, state and migration

Keep the App-owned `PluginCatalogStore`. Move the pending-review badge and fallback
focus target to the left marketplace navigation button. Entering/re-entering the
page may refresh observation through GET only. Extension reload remains explicit.
Unresolved immutable request bodies and the shared management gate survive leaving
the page; management/dialog components unmount so portals and previews clean up.

Keep the chat and right PanelContainer mounted but hidden/inert outside Studio.
Do not cancel active runs, change session/draft, dispose terminal PTYs, replace
preview iframes, reset tab layout/width or change panel collapse preference on
market navigation. Hide the project/session rail on the marketplace page and use
all width after the left nav, including desktop inset and responsive layouts.

Migrate persisted v2 panel layouts by parsing bounded string kinds and filtering
unsupported entries individually. Remove the old `plugins` entry while preserving
terminal/preview IDs, order and pins. Repair a removed active tab to the first
survivor, or use defaults if no tabs remain. Unknown future kinds follow the same
rule instead of resetting the entire saved layout.

## Verification and delivery

Behavior tests cover bounded/strict catalog loading, official provenance and
reserved IDs, version compatibility/order, no IO from GET, unavailable indexes,
Studio response validation/search/filter/detail, explicit fixed-release handoff,
manifest mismatch and shared gating, cancellation, unresolved exact-request replay,
legacy panel migration, GET-only entry and chat/terminal/preview survival.
Run focused suites, root `pnpm check`, independent review and real browser smoke.

The previous Stage 6.4 work remains uncommitted on `feat/github-plugin-acquisition`.
This feature starts from fresh `origin/main` in a separate managed worktree with a
review-only copy of that dependency. Preserve the original tree. Keep a Stage 6.4
baseline and export a Stage 6.5-only patch for ordered review; do not commit, push
or integrate either topic without the repository's required authorization/workflow.
