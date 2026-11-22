# Declarative Skill packages

Date: 2026-11-22. This independent topic follows merged Skills PR #93. It extends
installation ADR 0005 and Skills ADR 0006. Foundation and this contract are updated
before implementation. The pinned Codex, Harness and Kimi references and authorship
choices remain in `docs/learning/2026-11-22-official-plugin-references.md`.

## Outcome and scope

A package containing only Skills uses the existing local/GitHub/marketplace
preview, immutable import, independent trust review and activation, update,
rollback, disable and revoke flow. It has no executable entry and never imports
author code. An admitted turn sees ordinary plugin-qualified Skill data through
the existing catalog and audited shared Tool Pipeline.

The main marketplace remains in left navigation. Developer CLI, custom panels
and the maintained official content suite follow as separate topics. This change
adds no account service, registry, script runner, OS sandbox claim or permissions.

## Descriptor and compatibility

Legacy schema-1 `{schemaVersion:1,entry,manifest}` keeps its exact read, digest,
canonicalization and saved-request semantics. It cannot claim a declarative host.
A new strict branch is:

```json
{
  "schemaVersion": 2,
  "kind": "skills",
  "manifest": {
    "id": "example-skills",
    "name": "Example Skills",
    "version": "1.0.0",
    "apiVersion": "1.0.0",
    "host": "declarative",
    "capabilities": ["skill"],
    "contributes": { "skills": ["review"] },
    "permissions": []
  }
}
```

The new branch has no `entry` or unknown fields. It requires host `declarative`,
sole capability `skill`, empty permissions and only 1–16 unique Skills in
`contributes`. No secondary contribution keys, callbacks or executable lifecycle
are accepted. Plugin API 1.0 remains valid; the host vocabulary is additive.
An older strict host rejects the new host/descriptor before import.

No redundant durable `artifactType`, authority format or index version is added.
The existing exact full manifest (including host) and whole descriptor digest
already bind the type. The parser enforces agreement between descriptor kind and
host. Existing candidates, reviews, sources and releases preserve that manifest.
Historical omitted fields and fingerprints remain byte-identical: do not add
schema defaults, rewrite old events or change digest framing. An executable ESM
plugin may still contribute Skills and continues to disclose trusted Node code.

Internal artifact, ready, loader and explicit-verifier data distinguish an actual
executable entry from declarative data using a checked union. Narrow every entry
resolution, import, relocation and identity comparison. Never invent an entry
string or silently turn an absent entry into a data package. The host owner locks
the exact union names with the Server owner before downstream implementation.

## Payload and data adapter

Each declared name maps to `skills/<name>/SKILL.md`; YAML `name` must match.
Resources live under that Skill directory. Root files are `weave-plugin.json` and
optional `README.md`, `LICENSE`, `NOTICE` (at most 64 KiB each). Missing or
undeclared Skill directories, extra payload roots, unsafe paths, symlinks,
special files and portable name collisions fail validation.

Reuse the shipped YAML subset, instruction normalization and Skill contribution
schema. Resources are strict UTF-8 without NUL and remain inert, including
scripts. Package limits are 16 Skills, 64 resources in aggregate, 256 KiB per
resource and 2 MiB aggregate resource bytes. Each complete SKILL.md remains at
most 64 KiB with 8 KiB frontmatter. Existing artifact/GitHub traversal bounds also
apply. Do not silently truncate or claim the separate disk source's larger or
binary inventory support.

The host reads and freezes every declared Skill before publication. A host-owned
KernelPlugin adapter registers these data snapshots at `skillsExtensionPoint`
under the original manifest and real plugin ID. It never imports a module or
runs a package script, factory, subprocess or author callback. Any invalid Skill
fails the package with attribution; other packages remain isolated.

Importing a candidate changes no instructions or trust. Reviewed activation uses
the current authority checks and publishes a new Generation. Running turns keep
their existing immutable instruction/resource bytes; subsequent admitted turns
use the new eligible Generation. Ordinary Skill invocation, exact refs, audit,
cursor, resource and permission rules remain authoritative.

## Cross-package contracts

| Unit | Change and responsibility |
| --- | --- |
| Plugin | Recognize `declarative` host, retain API 1.0 and the existing governed Skill seam. |
| Plugin-host | Schema-2 parsing, inert payload inspection, bounded data adapter, variant discovery/artifact/loader and authority rechecks. Internal dependency remains only Plugin. |
| Server | Adapt composition/verifier identity to data packages, preserve managed authority/replay/admin queue/ownership, extend closed manifest mirrors and marketplace validation. |
| Studio | Independently mirror the host vocabulary and display text-only payload review; reuse the existing write gate and separate activation controls. |
| Protocol / Session / Runtime | No behavior change; reuse the merged Skills machinery. |

Plugin-host exports a reusable inert payload inspector accepting an absolute
source directory, optional host version and cancellation signal, and returning
the checked variant artifact with descriptor, directory, digest, files and bytes.
It uses the same bounded validation and digest recipe as the artifact store and
creates no managed store. With `hostVersion` omitted, offline inspection checks
the payload, supported API and host vocabulary without guessing an engine
version. Passing a version also checks engine compatibility. Discovery and managed
store admission retain their existing compatibility checks, including rejecting
an engine-constrained candidate when that admission has no host version. The exact
function/type signature is recorded before Server/next CLI consumers adopt it.

Locked shared signature:
`inspectPluginPayload(directory:string,options?:InspectPluginPayloadOptions):Promise<PluginArtifact>`,
where options accepts `hostVersion`, `signal` and optional partial `DigestLimits`.
`PluginArtifact`, `ReadyLocalPlugin` and verifier evidence share `PluginPayload`:
`{kind?:'entry',entry:string,skills?:never}` or
`{kind:'skills',skills:readonly SkillContribution[],entry?:never}`. Actual inspector
results always have a kind; omitted entry kind supports existing ESM callers.
Explicit verify returns `PluginPayload & {digest:string}`. Data identity is still
bound to the reviewed whole payload; downstream code must narrow by the kind.

Loader checks digest and attempt authority before reading data and again before
setup/publication, analogous to the executable path's import/factory/setup guards.
An injected `importModule` must never be called for data packages. Manual, managed,
ESM, Skills and MCP identifiers share the existing namespace and sticky ownership.

Server compares exact directory, manifest, digest and variant identity; only ESM
compares an executable entry. Saved durable decision lookup still precedes source
IO. Preview/import/activation and rollback retain their existing CAS, trust,
ownership, desired-versus-published and failure-isolation semantics.

Marketplace stays schema version 1 because its existing full manifest safely
carries the additive host vocabulary. Entry generation validates either payload
through the shared inspector at an actual fixed GitHub commit. Actual imported
manifest must match reviewed release metadata. No coercion to ESM, automatic
trust or publisher-supplied official status is introduced.

Studio labels validated declarative manifests as “Skills 文本包 / 无可执行入口”,
shows declared Skills and exact provenance, and uses the normal independent
activation flow. ESM keeps its runtime disclosure. The Skills picker consumes
standard `plugin:<id>/<name>` refs without scanning another installation source.

## Implementation plan and ownership

- [x] Root: record Foundation, ADR and this design/plan on a fresh latest-main branch.
- [x] Host owner: Plugin/Plugin-host union, parser, inspector, adapter, artifact and loader tests; send stable contract to Server.
- [x] Server owner: old replay and new no-entry integration tests, managed composition, closed mirrors, fixed-source marketplace tooling.
- [x] Studio owner: strict mirrors, data-only review, legacy compatibility and browser acceptance.
- [x] Root: examples/usage, real loopback SQLite/SSE acceptance, independent review and final checks.
- [ ] Root: authorized PR/CI/squash workflow.

No worker commits or pushes independently. CLI authoring and panel implementation
do not enter this branch.

## Acceptance

Tests must cover unchanged legacy ESM descriptors, digest, import, trust, index
and offline database replay; strict schema/layout/caps/text/path rejection;
mutation and cancellation; no import/factory execution; frozen owner attribution
and per-package failure isolation.

Real managed flows cover inert import, separate activation, restart, engine
compatibility, update with an old turn pinned, new exact refs, rollback, disable,
revoke and identifier conflicts across manual/managed/MCP/data/ESM sources. A real
scripted Agent reads an installed Skill and resource through the ordinary Pipeline
and restores provenance from SQLite. Fixed GitHub callback fixtures and actual
source validation prove no-entry acquisition without network assumptions in unit
tests. Studio tests and desktop/mobile inspection cover review/activation/selection
while preserving marketplace navigation and drafts.

Run root `pnpm check`, `pnpm marketplace:check`, the real loopback acceptance and
independent host/Server/Studio review. A first-party listing can reference only a
real merged commit with usable files; never invent a future release SHA or list
an unimplemented capability.
