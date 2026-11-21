# Stage 6 — Managed Plugin Installation

状态：用户已确认按设计 → 本地安装 → Studio → GitHub 固定版本 → 静态 Catalog 推进。
基线：`origin/main` `7ee1a00`，Stage 5 local stdio MCP 已合入。
决策：[ADR 0005](../../adr/0005-plugin-installation-and-distribution.md)。

## 1. Product behavior and stages

The current local ESM host loads directories manually placed under the plugins
root. Stage 6 adds acquisition and version management while preserving its trust
and turn boundaries. Stage 6.1 is a standalone filesystem artifact API; Stage 6.2
integrates durable installation and activation; Stage 6.3 adds Studio. The later
GitHub and Catalog slices extend acquisition after their own detailed contracts.

A user imports an already bundled local directory. Weave copies and validates it
without executing anything, then records an installed candidate. Installing a new
version does not change the selected version or interrupt existing turns. The user
reviews the precise candidate and chooses activation. New turns use the new
Generation; old turns retain the prior artifact path. Rollback is another explicit
reviewed activation. Uninstall removes future selection and revokes authority,
while old-turn files remain available until a future lease-aware cleanup policy.

## 2. Design choice and package boundaries

| Approach | Result |
| --- | --- |
| Replace `<plugins>/<id>` in place | Rejected: old turns can read new content, and copy/rename recovery is ambiguous. |
| Revision directories with symlink selection | Rejected: current discovery refuses links; mutable aliases do not pin files. |
| Hidden immutable artifacts and explicit selection | Adopted: old paths remain stable; only complete, recorded candidates can be selected. |

`plugin-host` owns descriptor validation, bounded copying, whole-directory digests
and immutable artifact publication. It depends only on `plugin` and existing Zod.
It has no database, HTTP, Runtime or Agent dependency. Server owns provenance and
installation/selection facts and uses the single ExtensionCoordinator write queue.
Studio uses only HTTP; the kernel remains unaware of installation. The package
direction and dependency declarations stay unchanged for 6.1.

## 3. Artifact layout and identity

```text
<pluginsRoot>/
  a-manual-plugin/                 # Existing manual discovery is unchanged.
  .weave-store/
    staging/<random-operation>/payload/
    artifacts/<64-lowercase-hex-digest>/payload/

<Server database>
  plugin_install_events           # Added by 6.2, append-only.
  plugin_trust_events             # Existing trust facts; combined commits in 6.2.
```

Store paths use random operation names and digests, never arbitrary manifest IDs.
Metadata lives outside `payload`; source path and install timestamps cannot change
the content digest. The artifact digest uses the existing `computeDirectoryDigest`
algorithm. `.git`, `.DS_Store` and `Thumbs.db` are omitted at every depth, matching
that algorithm; other dotfiles are copied. Empty directories do not affect the
digest. Nothing inside `.weave-store` enters automatic manual discovery.

Published means that a complete payload has been renamed into its final digest
directory. It does not mean installed, selected, trusted, enabled or loaded.
The first delivery never overwrites or physically deletes a published artifact,
including orphans. An existing digest is reused only after validating its content.
Same-name corrupt content produces an error; it is never repaired silently.

## 4. Stage 6.1 filesystem contract

The public API is asynchronous and exported by `@weave/plugin-host`:

```ts
interface PluginArtifact {
  readonly digest: string;
  readonly directory: string;       // Concrete payload path.
  readonly descriptor: PluginDescriptor;
  readonly files: number;
  readonly bytes: number;
}

interface StagePluginArtifactOptions {
  readonly sourceDirectory: string; // Absolute local directory.
  readonly signal?: AbortSignal;
}

interface PluginArtifactStore {
  stage(options: StagePluginArtifactOptions): Promise<PluginArtifact>;
  read(digest: string, options?: { readonly signal?: AbortSignal }): Promise<PluginArtifact>;
}

function createPluginArtifactStore(options: {
  readonly directory: string;       // `.weave-store`, an absolute path.
  readonly hostVersion?: string;
  readonly reservedIds?: readonly string[];
}): PluginArtifactStore;
```

`stage` publishes a complete validated artifact and returns its fixed path. It does
not retain the original source as a future load path. `read` recalculates content,
parses the descriptor, checks compatibility and entry containment, and requires the
digest to match the directory name. Returned values are immutable snapshots.
Options and external descriptors are validated before use with Zod. The source
must be absolute, a real directory, and not itself a symlink. A path with a linked
ancestor is normalized by realpath; payload descendants may not be links.

One instance serializes stage/read operations. Callers must use one instance per
store and one live owning process. The API makes no cross-process locking claim.
The Stage 6.2 Server ownership guard must be implemented before any HTTP exposure.

### 4.1 Limits

- 1,000 regular payload files and 20 MiB of actual file bytes per artifact.
- 64 KiB maximum descriptor, using the existing descriptor limit.
- 64 descendant directory levels and 2,000 total copied file/directory entries,
  including empty directories; ignored names do not count.
- At most 64 published digest directories globally, including unrecorded orphans.
  Same-digest reuse is allowed at capacity after full integrity validation.
- At most one in-progress staging payload per instance. Abandoned staging is
  cleaned by the owning instance before its next stage operation. Published files
  are retained across failure, uninstall and restart in the first delivery.

Depth and entry bounds apply to every source/staging/artifact traversal, including
all pre-copy, post-copy and existing-artifact digest checks. Validate with the
bounded walker before invoking the existing digest algorithm; its bytes and
ordering remain unchanged. A tree mutation cannot exempt a later pass from bounds.

The payload logical-byte bound is 1.25 GiB for 64 full artifacts, plus one bounded
staging payload. This is not a total filesystem allocation limit. There is no
automatic eviction. Limit errors identify the bound and explain retention.

### 4.2 Copy, validation and publication

1. Validate options and cancellation before creating files. Normalize the source
   and store, reject overlap in either direction, and reject linked/special store
   paths. The store's managed directories and staging children are real directories.
2. Serialize, clean abandoned staging, create a private random staging directory
   with exclusive creation, and traverse the source in a bounded manner.
3. Reject symbolic links, junctions and special files. Never hard-link source
   content. Open a source file without following its final symlink when supported;
   compare its descriptor metadata before/after copying, and reject a changing
   file. Copy bounded bytes to exclusively created regular destination files.
4. Do not import or execute files, run a package manager, invoke a shell, build
   code, follow Git hooks or install dependencies. A `package.json` is data.
5. Validate the actual staging payload with the same descriptor, compatibility,
   entry containment and whole-directory digest rules used by discovery. Compute
   source digests before and after copying and require them to equal the staged
   digest. Changes produce a stable source-changed error and require a new request.
   This detects ordinary concurrent edits; it is not a defense against a hostile
   process with the same OS privileges manipulating files between observations.
6. Validate the artifact count and any existing matching object. Recheck staged
   content before renaming its container to `artifacts/<digest>`. The rename stays
   within the managed filesystem. Do not replace an existing artifact.
7. Return the artifact. On a failed/cancelled stage, remove only that operation's
   staging files. Preserve the primary error and any cleanup failure together;
   cancellation must not hide failed cleanup. Once rename has published content, a late cancellation may leave
   an inert artifact; it never selects or executes it. Cleanup errors must not be
   reported as successful cleanup.

Interrupted staging never becomes loadable. A process crash after publication but
before a later Server record leaves an unselected artifact counted by the quota.
No record may point at a partially copied payload. Ordinary process-crash recovery
is supported; universal cross-platform sudden-power-loss durability is not claimed.

### 4.3 Errors

Use `PluginArtifactError` with stable codes: `plugin-artifact-invalid`,
`plugin-artifact-source-changed`, `plugin-artifact-unsupported-file`,
`plugin-artifact-too-large`, `plugin-artifact-capacity`, `plugin-artifact-conflict`,
`plugin-artifact-not-found`, `plugin-artifact-corrupt`, and `plugin-artifact-io`.
Abort uses the signal's reason. Preserve internal causes without adding payload
contents to public messages. `read` never returns a partially validated artifact.

## 5. Stage 6.2 authority and selection contracts

Installation records add local provenance (normalized source path, content digest,
manifest/version, request ID and time) without granting execution authority.
Installation and trust each have a contiguous append-only sequence. A combined
SQLite transaction verifies both expected sequences and appends selection plus
its exact `trusted` decision, or removal plus `revoked`. File publication happens
first; a failed DB transaction leaves only inert content. A committed DB decision
is not rolled back merely because Generation assembly later fails.

Activation is a separate explicit reviewed action with captured artifact digest,
manifest, installation sequence, trust sequence and previous selection. It always
adds a new decision, including rollback to previously trusted bytes. Latest
revocation cannot be bypassed through old artifacts. The existing digest-only
manual trust route rejects every managed-owned plugin ID, even when its digest
matches selection; every managed grant of trust uses the combined reviewed
activation transaction. Existing enable, disable and revoke operations still obey
the selected exact digest and the authority checks defined before 6.2 code.

The source reads only explicitly selected artifact paths, verifies their recorded
identity, and merges them with manual candidates before shared reserved/duplicate
ID validation. A manual and managed plugin with the same ID conflict; neither is
silently adopted. Missing or corrupt selected content fails closed, without
searching disk for a replacement. No automatic migration of manual directories.

Selection mutation runs in the sole coordinator queue and updates the local source
snapshot before assembly: `coordinator.mutate` intentionally skips refreshing its
mutated source. It must not call the queued public facade recursively. Authority
notification occurs after durable commit before another await. Publication uses
the existing complete ESM/MCP candidate recheck and synchronous commit.

Installing a candidate leaves healthy selection and admission unchanged. Activation
changes desired authority; if assembly fails, report saved selection versus actual
Generation separately and retain fail-closed admission. Do not silently re-trust
or select the prior version. Old pinned turns continue by default; explicit
immediate removal cancels all current and retired turns using existing semantics.

Guarded JSON POSTs for preview/import, activation and uninstall carry immutable
review identities and expected sequences. Reads do not copy, discover or launch.
The management response separately preserves durable installation outcome and
actual Generation outcome. Request IDs are durably deduplicated before retry
validation; a conflict invalidates review and never substitutes a new token.
The exact route DTOs and store-ownership/recovery protocol are refined in the 6.2
implementation design before code, rather than invented inside thin HTTP handlers.

## 6. Stage 6.3 Studio

Use the current App-owned catalog Store and management write gate. Provide local
directory import, installed candidate/history rows, source/version/digest display,
independent reviewed activation, rollback and uninstall. Installing an update must
not imply activation. The interface displays durable decisions and actual loaded
versions separately. Panel activation remains GET-only; closing a panel does not
cancel a durable request. Every 409 invalidates the captured review and requires
explicit review again. The detailed HTTP DTOs travel with the 6.2/6.3 plans.

## 7. Later acquisition and limits

GitHub acquisition pins a complete commit and subdirectory, preserves provenance,
and feeds the same artifact staging and activation path. No branch name is an
installed identity. Safe downloads/archives, cancellation and resource bounds need
their own contract. Static Catalog describes available versions and origins; it
does not install or trust them. `verified` is not execution permission.

Signatures, npm builds, publisher services, automatic updates, remote MCP,
Resources/Prompts, OS isolation and Crew are separate future work. MCP command
configuration is unaffected. The installer cannot download or run MCP programs by
reinterpreting a local ESM package. Published content is immutable by host policy,
not against arbitrary same-user writes or already trusted in-process plugin code.
Existing entry-bundle and delayed-import limitations still apply.

## 8. Verification and references

6.1 behavior tests cover no-execution fixtures; exact digest copies including
dotfiles/ignored names; bad descriptors and compatibility; symlinks/special files;
overlapping roots; depth/entry/file/byte bounds; cancellation and cleanup; source
mutation; same-digest idempotency; corrupt artifacts; 64-object and concurrent-last-
slot capacity; orphan counting and abandoned staging recovery. Tests use temporary
roots. Run package tests, package types/lint and full `pnpm check` before PR.

6.2/6.3 add durable CAS/rollback/corruption tests, paired catalog behavior, old-path
Generation retention, no code before activation, failed application reporting,
real browser and actual Electron import/activation/update/uninstall/restart checks.
No installer/distribution package validation is claimed by development-process QA.

Reference principles reuse the official sources and pinned revisions already
reviewed in [Foundation Product references](../../architecture/foundation.md#product-references):
Codex binds execution to the actual prepared identity; Kiro separates configuration
and activation and traces behavior to tests; DeepSeek Harness separates acquisition
metadata, exact versions and resource ownership. Weave retains explicit trust,
turn pinning and one coordinator; installation never implies trust.
