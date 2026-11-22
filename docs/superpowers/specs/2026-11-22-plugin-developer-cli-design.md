# Plugin developer CLI

Date: 2026-11-22. Follows merged declarative Skills PR #94 at `10a3adb`.
Foundation, ADR 0008 and this contract are written before implementation on the
independent `feat/plugin-developer-cli` branch.

## Outcome and package boundary

A developer can create a Tool, Command or Skills project, check real source types,
build a payload and pack a verified directory for the existing installer and
fixed-GitHub marketplace submission. Main plugin management stays in Studio's
left navigation. Custom right-side panels and maintained official releases follow
as separate topics. No account, registry, npm publication, trust client, automatic
Git/PR action or execution runner is added.

`@weave/plugin-cli` is a private repository-local leaf. Its internal imports are
only `@weave/plugin` and `@weave/plugin-host`; it imports no Runtime, Session,
Protocol, Server, Studio or MCP package. Root ESLint declares this exact boundary.
The bin is `weave-plugin` at `dist/cli.js`; a small public API is exported from
`dist/index.js`. Repository commands build the CLI dependency graph before invoking
`plugin:create`, `plugin:validate`, `plugin:build`, `plugin:pack`. Do not advertise
an unpublished npm SDK or CLI. Root verification includes this package normally.

Direct runtime dependencies and reasons:

| Dependency | Reason |
| --- | --- |
| Plugin / Plugin-host workspace packages | Actual public SDK/manifest and inert payload inspector |
| TypeScript 5.9.3 | Real strict checking and AST analysis without author installs |
| esbuild 0.28.2 | One in-memory Node ESM bundle without author build configuration |
| @types/node 24.10.1 | Node declarations used by compiler at CLI runtime in clean external directories |
| Zod 4.6.7 | Strict command/program options and receipt validation |

## Commands and concrete layout

```sh
pnpm plugin:create --template tool --id hello-tool --directory /tmp/hello-tool
pnpm plugin:validate --source /tmp/hello-tool
pnpm plugin:build --source /tmp/hello-tool --out /tmp/hello-build
pnpm plugin:validate --artifact /tmp/hello-build/payload
pnpm plugin:pack --artifact /tmp/hello-build/payload --out /tmp/hello-release
```

ESM source contains a strict schema-1 `weave-plugin.json` with eventual
`entry:"index.mjs"`, `package.json` with `type:"module"`, `src/index.ts` and
optional editor `tsconfig.json` and root documentation. No placeholder index.mjs
is created in source. Source validation distinguishes it from an artifact and
reports no installable digest. Templates export a real `PluginFactory`, using
injected `sdk.z` and extension references; `definePlugin` is called by the Host,
not an invented SDK method. Command templates contribute prompt strings, not an
executable command callback. Tool templates register tools without calling them.

Skills template is the existing schema-2 descriptor plus actual SKILL.md and a
referenced text checklist. It needs no package.json, SDK or compiler. Source
validation returns an actual Skills artifact rather than pretending it is code.

Create requires `--template tool|command|skills`, a valid `--id` and a new absolute
`--directory`; optional `--name` defaults from the ID. Version defaults to 0.1.0.
Build requires source and a new output container. Pack requires an actual artifact
and another new output container; it never implicitly builds. Exactly one source
or artifact mode is required for validate. Unknown, repeated or contradictory
options fail. Program API paths are absolute and Zod-validated; the bin resolves
paths once against captured invocation cwd. `--json` emits one JSON result;
diagnostics go to stderr. Exit 0 succeeds, 1 reports operation failure, 2 usage,
130 cooperative cancellation after cleanup.

`--sdk-directory` selects an actual built local public SDK for ESM create/source
validate/build. Otherwise resolve the CLI's declared dependency, not cwd. Reject
this option for Skills or artifact-only modes. `--host-version` on validate/build/
pack requests actual engine checking; omission means offline API/host/payload
checks, never a guessed Weave product version.

```text
chosen-output/              # exclusive, previously nonexistent container
  payload/                  # exact installer/GitHub directory
    weave-plugin.json
    index.mjs               # ESM only
    README.md               # optional
    LICENSE                 # optional
    NOTICE                  # optional
    skills/...              # Skills only
  receipt.json              # pack only, outside payload digest
```

## Supported source, SDK and ESM compatibility profile

ESM source roots are descriptor, package.json, optional tsconfig.json,
README.md/LICENSE/NOTICE, and src/. Only regular .ts source files (not .d.ts) live
under src. Standard Host ignored names (.git/.DS_Store/Thumbs.db) remain ignored;
other roots fail the explicit profile rather than entering the payload. Source
bounds: 128 files, 4 MiB total, 256 KiB/file, depth 16, 512 entries. General
artifact snapshot bounds follow Host: 1000 files, 20 MiB, depth 64, 2000 entries;
Skills retains its stricter aggregate text bounds. Root docs are at most64 KiB.

SDK resolution checks real package.json name/exports and dist/index.d.ts. Use
CLI-owned strict TypeScript 5.9.3, noEmit, ES2022, NodeNext, exact optional fields,
noUncheckedIndexedAccess, verbatimModuleSyntax and skipLibCheck:false. Map the
exact @weave/plugin type entry to that genuine public declaration and resolve its
real transitive declarations; use CLI-owned Node typeRoots/types. Missing SDK
builds or declarations fail clearly. Generated tsconfig is an editor aid; CLI
never executes or loads author configs, extends, plugins or transformers.

A host-owned virtual source assigns the default export to the real PluginFactory,
so missing/default-invalid factories fail even without an author annotation.
Read source from the captured byte snapshot; SDK/TypeScript/declared type graph
may be read externally. Do not depend on author node_modules or substitute fake
handwritten SDK interfaces. Reject author triple-slash references and declaration
shims. Test a clean external directory and actual SDK type errors.

The first source profile supports src-contained relative TS modules (including
standard .js-to-.ts NodeNext resolution), actual Node builtin imports and erased
SDK type-only imports. It deliberately does not bundle npm packages. This narrows
the earlier proposal's optional dependency bundling until dependency/lock/license
contracts exist; authors may vendor reviewed local source.

Validate every source AST before bundling. Reject nonliteral dynamic import,
import attributes outside this profile, direct require/require.resolve/import=
and createRequire forms, URL/absolute/escaping imports, unknown node: modules,
runtime @weave imports and other bare packages. Type-only SDK imports are allowed
and must disappear. Detect policy violations even if tree-shaking removes them.

Use fixed CLI-owned esbuild settings: bundle:true, platform:node, target:node24,
format:esm, one entry/output, no splitting/maps/assets, write:false and metafile.
Serve checked source bytes through host-owned callbacks; load no author plugins.
Every actual input must be in the checked snapshot and remaining output imports
must be actual Node builtins. Parse emitted/imported ESM too: metafile alone misses
nonliteral imports and CommonJS builtin require may produce a broken ESM helper.
Do not approve that output merely because its import is a builtin.

Host inspector alone validates general payloads, not this single-file compatibility
profile. CLI artifact validation and pack require both; a foreign Host-valid
entry name or extra-file payload gets a precise unsupported-CLI-profile error.
Lexical checks do not prove arbitrary JS cannot eval, load indirectly, access
files or processes. Trusted Node execution and OS privileges remain unchanged.

## Snapshots, output publication and packing

Capture raw bounded bytes with no-follow regular-file opens, identity/metadata
checks before/after reads and directory/path inventory checks. Reject symlink
roots, links inside traversed trees, special files, unsafe portable payload paths
and collisions. Normalize real ancestor paths consistently with macOS aliases.
Check input/output ancestor relationships both lexically and canonically.
Reverify the input snapshot before final publication; source mutation aborts.

Create output exclusively, including a private .payload-building child. Write only
positive checked bytes, inspect this child through public inspectPluginPayload,
recheck directory ownership and rename to an absent payload child. Reinspect the
published payload before success. Pack writes receipt exclusively afterward.
Do not recursively copy a project then remove unwanted files.

ESM payload permits exactly descriptor, index.mjs and optional root docs. Data
payload retains every declared Skill raw document/resource; do not reconstruct
normalized SkillContribution text or silently drop a reference. Publish hygiene
rejects .env/.env.* files, source maps ending .map, node_modules and coverage path
components in resources. Other valid code/script examples remain inert text.
These names do not prove absence of secret content. Standard Host ignored entries
stay omitted consistently with the existing digest recipe.

Pack compares full descriptor, kind, semantic Host digest, file count and bytes
before/after copying. Entry comparison is relative index.mjs across directories.
No digest framing changes or cross-source private Host imports are introduced.
The CLI owns its bounded byte copier and uses public inspector verification.
Receipt schema1 contains full manifest, entry|skills variant, digest, files, bytes
and absolute outputPath. It is local metadata: not a signature, publisher proof,
trust decision or sandbox attestation. Actual validation always reads payload.

Every API supports AbortSignal. Check around bounded IO, before/after synchronous
TypeScript phases and await/dispose esbuild activity. No instant synchronous
compiler interruption is promised. Rejection/return drains all work. Clean only
entries allocated by this invocation whose identity remains owned; preserve
replacements/unexpected files and report primary+cleanup errors together. A killed
process may leave staging or a validated payload without receipt. Node path APIs
do not provide universal malicious-same-user namespace confinement; document the
actual detection/ownership boundary without making a sandbox claim.

## Shared interfaces and ownership

Public types and the exact DirectorySnapshot/SDK/output callback seams are
recorded in packages/plugin-cli/src/types.ts before worker implementation.
These callbacks are authored by CLI only, never a user build config.

| Owner | Files and contract |
| --- | --- |
| Root | package/scripts/deps, types/errors/index/api orchestration, docs/examples and integrated acceptance |
| Compiler | sdk.ts, compiler.ts, import-policy.ts, bundle.ts; resolvePluginSdk, checkPluginSource, bundlePluginSource, validateEsmArtifact |
| Filesystem | snapshot.ts, output.ts, payload-profile.ts; captureSnapshot, verifySnapshot, writeProject, publishOutput, inspectCliArtifact, assertSourceProfile |
| Templates/bin | templates.ts, scaffold.ts, cli.ts; createPluginProject and strict argv dispatch to api.ts |

Internal snapshot is canonical directory + readonly map of original Uint8Array
files + directory inventory. Readonly maps/bytes are an internal trusted contract;
public options never accept author callbacks or an executable configuration.
Publishing receives exact source/output paths, checked files, verifyInput and
validatePayload callbacks, and optional receipt builder. It returns final checked
value, payloadDirectory and optional receiptPath. The filesystem module owns all
writes and identity-safe cleanup; root owns lifecycle orchestration.

## Verification and references

Tests belong in packages/plugin-cli/test. Use real temporary files, clean external
cwd child processes, real public SDK types and no top-level author execution.
Exercise each template, type errors/default export guard, checked relative/builtin
imports, unsupported syntax/extra payload, single output, source/input changes,
existing/symlink/overlap paths, concurrent output, cancellation and failed cleanup.
Verify copied digest/manifest/counts equal ordinary Host installation previews.

Root acceptance explicitly builds CLI and Server, invokes the actual CLI bin and
uses real loopback HTTP/SSE/SQLite. Import stays inert until separate activation;
Agent executes built Tool via Pipeline, command catalog exposes exact prompt,
Skill/resource reads record provenance, restart survives source deletion, stale
preview rejects changed bytes. Keep Server out of CLI imports and avoid relying
on parallel package tests to build another leaf's dist. Run focused tests,
pnpm check, marketplace:check and independent review before authorized PR/CI.

Product principles reuse the pinned Codex/Harness/Kimi reference audit and Kiro
requirements/design/tasks discipline: controlled authoring, static release data,
discovery/install/use separated, exact version evidence. No new unsupported claim
about their CLI APIs or copied architecture is made. Official releases wait for
real merged payload commits; custom panels remain the next separate contract.
