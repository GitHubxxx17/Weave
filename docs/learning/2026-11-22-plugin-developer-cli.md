# Create, build and package a Weave plugin

The repository-local CLI provides `create`, `validate`, `build` and `pack`. It
creates real Tool/Command TypeScript projects and no-code Skills packages, then
produces the exact directory accepted by the existing local/GitHub installer.
It is a private workspace package; there is no claimed published npm CLI or SDK.

## Start from a template

Run from a built Weave checkout with its pinned dependencies installed:

```sh
pnpm plugin:create --template tool --id hello-tool --directory /tmp/hello-tool
pnpm plugin:validate --source /tmp/hello-tool
pnpm plugin:build --source /tmp/hello-tool --out /tmp/hello-build
pnpm plugin:validate --artifact /tmp/hello-build/payload
pnpm plugin:pack --artifact /tmp/hello-build/payload --out /tmp/hello-release
```

Each root wrapper first builds the real CLI and its upstream SDK. Every target
must be a new directory. Use an output outside the source; source/output overlap,
existing output and symlink payload roots are rejected. `--json` returns one JSON
result suitable for automation. Read stderr for diagnostics; Node's existing
SQLite experimental warning may appear because the current public SDK also
exports runtime/session references. It is separate from the JSON result.

Replace `tool` with `command` for a prompt command or `skills` for a text package.
Use `--name` for a display name. Templates start at version `0.1.0`. Actual source
examples are in `examples/plugin-authoring/hello-tool` and `hello-command`; the
maintained Skills example is `examples/plugins/weave-coding-skills`.

Tool source exports a `PluginFactory` and registers a tool using the SDK supplied
by Host. Input validation uses that SDK's Zod instance. Tool execution remains in
the shared Tool Pipeline. Command source registers a prompt containing
`$ARGUMENTS`; it has no direct executable command callback. Skills creates a strict
schema-2 descriptor, SKILL.md and actual referenced checklist, with no ESM entry.

## Source and payload are different directories

A TypeScript project contains `src/index.ts`, `package.json` with `type:module`,
a full `weave-plugin.json`, optional editor tsconfig and root documentation.
The descriptor's schema-1 `entry:index.mjs` describes the future build output.
The source intentionally has no dummy executable entry and cannot be installed
before build. `validate --source` reports source validation, with no artifact
digest. `validate --artifact` inspects actual installable bytes.

A Skills project is already a real data payload, so source validation can report
its actual artifact identity. Build and pack preserve every accepted raw Skill
file rather than reserializing normalized instructions. Skills needs no SDK,
compiler, package.json or executable build.

Build writes a new container with a `payload` child. Pack accepts a real artifact,
never implicitly builds, and writes another new container:

```text
hello-release/
  payload/               # choose this directory in Studio or GitHub source
    weave-plugin.json
    index.mjs             # only for ESM
    README.md             # optional
  receipt.json            # local pack facts, outside the payload digest
```

Data packages use their declared Skills trees in place of index.mjs. The receipt
records the full manifest, payload kind, actual semantic digest, file/byte counts
and absolute local output path. It is not a signature, official badge or trust
decision. Editing it does not change the payload digest; editing payload makes an
old receipt stale. Validation always reads actual files.

## Genuine SDK and supported build profile

The CLI uses its own TypeScript 5.9.3 and Node declarations to check against the
actual public SDK selected by its workspace dependency. Generated projects work
without author node_modules. Their tsconfig points at the current built checkout
for editor checking; no fake public npm package or copied permissive SDK types
are generated. After moving/checking out another SDK, recreate the editor aid or
use an explicit `--sdk-directory /absolute/path/to/packages/plugin` for ESM create,
source validation and build. The selected SDK and its declaration dependencies
must really be built. This option is rejected for Skills and artifact modes.

Build uses fixed strict compiler settings and a default-export PluginFactory
check. It never executes or loads author tsconfig extensions, build configs,
transformers, lifecycle scripts or source modules. Its esbuild resolver receives
the checked file bytes, then produces one Node ESM file with no chunks/maps/assets.
A source containing top-level work remains inert until normal trusted activation.

Version one supports relative TypeScript modules inside src (including `.js`
specifiers resolving to `.ts`), actual Node builtin imports and erased type-only
imports from `@weave/plugin`. General npm runtime dependency bundling is not yet
supported; use reviewed local source. Runtime SDK imports, unknown bare packages,
URL/absolute/escaping paths, nonliteral import, CommonJS require/createRequire,
import-equals, author declaration shims and unsupported import attributes fail
with an explicit packaging-profile error. Source is limited to 128 files, 4 MiB,
256 KiB/file and depth16/512 entries.

CLI artifact validation checks this narrower single-file ESM profile as well as
the general Host payload contract. Some legacy Host-valid payloads with different
entry names or auxiliary files are outside this first CLI pack profile; the CLI
does not silently rewrite them. Passing static checks does not prove arbitrary
trusted JavaScript safe or prevent eval, indirect loading or normal OS access.

Pack includes only descriptor, one index.mjs and optional README.md/LICENSE/NOTICE
for ESM. A Skills payload retains every declared document/resource under its
existing UTF-8 and size bounds. Publish hygiene rejects .env/.env.* files, .map
files and node_modules/coverage components. Other legitimate code examples stay
inert text; naming checks do not prove that a file contains no secrets.

Optional `--host-version` asks the Host inspector to compare the declared engine
range with that explicit version. Without it, offline validation checks payload,
API and host vocabulary without guessing a product release. Actual Server
admission still checks its engine compatibility independently.

## Import, activate and publish

Open **插件市场** in Studio's left navigation, select **已安装** and import the
reported `payload` directory. Import prepares an immutable candidate. Review the
exact manifest/digest and separately activate it. No CLI command grants trust,
installs dependencies, changes managed selection, executes author scripts or
publishes to a service. A receipt never substitutes for that review.

For marketplace publication, commit the actual payload to your developer-owned
public GitHub repository, obtain its real complete commit and subdirectory, then
follow [the existing marketplace submission workflow](plugin-marketplace-publishing.md).
`marketplace:entry` downloads and validates those committed bytes itself; it does
not accept a local receipt as remote provenance. Do not use a fabricated future
commit or claim that a source example is already a released official plugin.

Snapshots and output writes are bounded, reject observable input changes and use
exclusive output ownership. On failure/cancellation the CLI cleans only entries
it still owns; replacement/unexpected data is preserved with an error. Cancellation
is cooperative around synchronous compiler work. A killed process can leave
staging or a validated payload without receipt; these filesystem checks are not
an OS sandbox against arbitrary same-user namespace attacks.

## Verification

On 2026-11-22, `pnpm check` passed all formatting, lint, type, test and build
checks: **3,880 tests**, including **119 CLI behavior tests**.
`pnpm marketplace:check` confirmed the generated index is current. The maintained
hello-tool and hello-command examples also passed actual external-cwd source
validation, build and pack with matching receipt identities.

Run `pnpm plugin:verify` to build the CLI and Server, then exercise the real built
bin from a clean external directory against a listening loopback Server and
SQLite. It creates Tool, Command and Skills projects; validates/builds/packs them;
compares the receipt with installer previews; confirms top-level author work is
inert until separate activation; invokes the Tool through the Agent/Pipeline;
checks the command prompt; and verifies exact Skill instruction/resource tool
results and durable delivered state. It rejects a payload changed after preview,
restarts after deleting all source/build/release directories, repeats Tool and
Skill reads from managed storage, and replays an import offline. No live model or
third-party service is involved. A fault-injected model-only reply containing
Verify but no Skill tool calls is rejected by this acceptance.

Cross-reviews reproduced and repaired SDK metadata FIFO blocking, missing public
SDK declarations, ambient SDK augmentation, and missing retained-path diagnostics
after initial output observation failure. Cancellation and cleanup have actual
subprocess/read/write regressions. CPU-heavy tests use explicit per-test time
budgets; no validation or global timeout was weakened. The existing Node SQLite
experimental warning and Vite chunk-size advisory remain informational.

The architecture and exact dependency reasons are in
[ADR 0008](../adr/0008-plugin-developer-tooling.md) and the
[developer tooling design](../superpowers/specs/2026-11-22-plugin-developer-cli-design.md).
