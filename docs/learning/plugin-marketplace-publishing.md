# Publishing a Weave marketplace entry

Weave separates plugin code, discovery indexes and user installation. Developers
keep their plugin in their own GitHub repository. This repository maintains the
community collection in `marketplace/submissions/` and generates
`marketplace/index.json`. Studio's built-in Weave source reads the packaged copy.
The collection starts empty: the built-in official runtime entries do not imply
that any third-party plugin has been published or reviewed.

This implements the static-index principle from [DeepSeek Harness at
`d98f5d6`](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/apps/plugin-market-generator/README.zh.md).
Harness supports npm and Git sources; Weave currently accepts public GitHub
payloads at exact commits. Weave retains its own immutable candidate store,
explicit source review and separate trust/activation flow.

## Prepare the plugin

Use the repository-local [developer CLI](2026-11-22-plugin-developer-cli.md)
for Tool/Command/Skills scaffolding and verified build/pack directories. Choose
the reported `payload` child as the GitHub subdirectory; the external local receipt
is not part of the payload and does not establish remote provenance.

Build the plugin in the developer repository before requesting collection. The
selected directory must contain a strict `weave-plugin.json` and either an already
bundled schema-1 `.js`/`.mjs` entry or a schema-2 declarative Skills payload with
no entry. See [Skills text packages](2026-11-22-declarative-skill-packages.md)
for its layout, data bounds and example. The descriptor must include the full manifest,
including `contributes` and `permissions`, even when either is empty. Installation
never installs npm dependencies, builds source code or runs lifecycle scripts.
Follow [local plugin design](../superpowers/specs/2026-11-20-plugin-host-design.md) and the existing
[GitHub acquisition guide](2026-11-22-github-plugin-acquisition.md) for the runtime
SDK and payload restrictions.

Push the prepared payload to a public GitHub repository and record its full
lowercase 40-character commit. A branch or release tag may help people browse the
repository, but it cannot serve as a marketplace installation target. For a
monorepo, record the exact directory containing `weave-plugin.json`.

## Generate a submission from the real descriptor

Use Node.js 24.4 or newer and the repository's pnpm version. Install the Weave
workspace dependencies using `pnpm install --frozen-lockfile`. The commands below
build the required local packages, without executing the plugin being submitted.

Write a request JSON file outside `marketplace/submissions/`:

```json
{
  "name": "Workspace Notes",
  "description": "Read and organize workspace notes",
  "publisher": "Your public developer name",
  "tags": ["notes"],
  "source": {
    "repository": "https://github.com/your-account/your-plugin",
    "commit": "0123456789abcdef0123456789abcdef01234567",
    "subdirectory": "plugin"
  }
}
```

The address and commit above illustrate the format; they are not a published
plugin. Use your own existing repository and actual commit. Repository URLs must
be canonical lowercase `https://github.com/owner/repository`, without `.git`,
credentials, queries or fragments. Set `subdirectory` to `""` for a root payload.

Run this from the Weave repository root:

```sh
pnpm marketplace:entry --input /absolute/path/to/request.json --output marketplace/submissions/your-plugin-id.json
```

The helper downloads only the explicit pinned source through Weave's bounded
GitHub acquirer. It validates the actual descriptor and compatible payload,
including a real entry for ESM or all declared Skill text bundles. It does not
import an entry, run the plugin, install it or grant trust.
The manifest ID determines the submission filename; choose the output name to
match that ID. Existing output files are never overwritten. A GitHub API limit or
network failure produces an error and no submission. No Git credentials or API
token are read by this helper.

For an update to an existing submission, write the prepared entry to a temporary
file first, then copy its new release into the existing `releases` array. Preserve
earlier versions, manifests and pinned sources. Every listed version must be
unique. A corrected payload needs a new plugin version and a new commit; do not
silently move a previously reviewed version to different code.

The resulting submission has this structure:

```json
{
  "id": "your-plugin-id",
  "name": "Workspace Notes",
  "description": "Read and organize workspace notes",
  "publisher": "Your public developer name",
  "tags": ["notes"],
  "releases": [
    {
      "manifest": {
        "id": "your-plugin-id",
        "name": "Workspace Notes",
        "version": "1.0.0",
        "apiVersion": "1.0.0",
        "capabilities": ["tool"],
        "contributes": { "tools": ["notes.read"] },
        "permissions": ["workspace:read"]
      },
      "source": {
        "repository": "https://github.com/your-account/your-plugin",
        "commit": "0123456789abcdef0123456789abcdef01234567",
        "subdirectory": "plugin"
      }
    }
  ]
}
```

Copy the complete actual descriptor manifest, including any engines, host,
commands, hooks or other declarations it contains. The example manifest is not a
substitute for your plugin's declaration. Publisher and descriptive text are
index attribution, not proof of repository ownership or author certification.
Entries cannot assign their own official category or compatibility status.

## Generate and verify the directory

```sh
pnpm marketplace:generate
pnpm marketplace:check
```

Generation is offline. It reads ordinary `<plugin-id>.json` submission files,
validates all entries before writing anything, rejects reserved IDs and duplicate
identities or versions, sorts plugins by ID and releases by descending numeric
version, and writes a deterministic index. It ignores only the submissions
`README.md` and `.gitkeep`. Symlinks, nested directories and unrelated files are
rejected. It does not fetch source repositories or verify that their remote
contents still exist; that verification belongs to entry preparation and review.

Limits match Server discovery: 512 KiB per submission and final index, 100
plugins, 20 releases per plugin and 10 bounded tags. The index includes the entire
manifest, so capabilities and permissions are available before acquisition.

Check fails if submissions are invalid or the generated index differs from the
checked-in bytes. It never rewrites the output. CI runs this check after the
normal `pnpm check`. The generated index is excluded from Prettier because its
exact formatting is owned by the generator.

Custom directory tooling is also available:

```sh
pnpm marketplace:generate --submissions /absolute/path/to/submissions --output /absolute/path/to/index.json
pnpm marketplace:check --submissions /absolute/path/to/submissions --output /absolute/path/to/index.json
```

## Submit and review

Submit a pull request against `main` in this
[Weave repository](https://github.com/GitHubxxx17/Weave). Include the submission,
generated index change, plugin purpose, publisher/source relationship and an
explanation of every permission and contribution. Use the
[plugin submission PR template](../../.github/PULL_REQUEST_TEMPLATE/plugin-submission.md).
The CLI prepares local files; it does not open, approve or merge the PR.

Reviewers compare the listed manifests with the exact source commit, inspect the
bundled code and requested capabilities, check identity conflicts and preserve
previous immutable release records. Offline CI confirms shape and deterministic
output; it cannot certify authorship or establish that plugin code is safe.
Repository review and CI requirements apply before merging.

After an accepted PR is included in a Weave build, that build's packaged default
source includes the new entry. A running installation can also explicitly refresh
an operator or HTTPS source. Discovering or refreshing a listing never installs,
trusts, enables, disables or removes a plugin. Users still review the real source,
manifest and digest before importing an inert candidate and separately activating
it.

## Hosting a separate directory

The generated `index.json` can be served from an HTTPS static host or read from a
GitHub file URL through Studio's source manager. It contains fixed GitHub release
sources and needs no account server. Add the index source, then explicitly
refresh it to fetch its contents. Source configuration and prior plugin trust are
independent; removing a source does not uninstall plugins.

This implementation does not deploy GitHub Pages, create an external directory
repository or claim that a public catalog endpoint is already hosted. The
checked-in collection, CLI, PR workflow and packaged default source work before
an operator chooses and deploys such hosting.
