# Local Plugin Artifact Store

Stage 6.1 provides a filesystem foundation for installing bundled local ESM
plugins. It copies and validates content without running it. Server installation
records, selected versions and Studio installation controls are subsequent slices;
publishing an artifact alone does not make it visible to the running agent.

## API and paths

```ts
import { createPluginArtifactStore } from '@weave/plugin-host';

const artifacts = createPluginArtifactStore({
  directory: '/absolute/plugins/.weave-store',
  hostVersion: '0.0.0',
});
const candidate = await artifacts.stage({
  sourceDirectory: '/absolute/already-bundled-plugin',
});
const checked = await artifacts.read(candidate.digest);
```

The store directory is the hidden managed root, not the parent plugins directory.
Each complete payload has a fixed path:
`<store>/artifacts/<whole-directory-sha256>/payload`. The returned descriptor,
digest, file count, byte count and concrete directory describe the copied content.
`read` validates it again before returning. A source directory can subsequently
change without modifying the installed copy.

The payload requires `weave-plugin.json` and its already bundled `.js`/`.mjs`
entry. Descriptor, compatibility and entry rules are shared with local discovery.
`.git`, `.DS_Store` and `Thumbs.db` are omitted at every depth, as in the existing
directory digest algorithm. Other dotfiles remain part of the copied payload.

## Publication and trust

The store copies into private staging, checks the actual copy and publishes the
complete object using a same-filesystem rename. Installation performs no dynamic
import, factory/setup call, package-manager command, build or install script. A
`package.json` is ordinary data. The hidden store is outside automatic manual
plugin discovery.

Published, installed, selected, trusted and loaded are different states. This API
only publishes files. The later Server authority slice records installed
candidates and makes activation a separate reviewed decision. An update candidate
will leave the selected healthy version unchanged until that activation.

The host never overwrites an existing published artifact. Reusing its digest
requires full integrity validation; corrupt content must be reported, not silently
repaired. Fixed paths let old turns keep accessing old files when a future
Generation selects a different version. Filesystem permissions and a digest do
not provide an OS sandbox or stop a process with the same user's privileges.

## Bounds and retention

| Bound                                               | Value  |
| --------------------------------------------------- | ------ |
| Regular payload files                               | 1,000  |
| Actual payload bytes                                | 20 MiB |
| Descriptor                                          | 64 KiB |
| Descendant directory levels                         | 64     |
| File/directory entries, including empty directories | 2,000  |
| Distinct published artifacts across the whole store | 64     |
| In-progress staging payloads per instance           | 1      |

The depth and entry limits apply to integrity reads and pre/post-copy hashing as
well as copying. Source-root/payload links and special files are rejected; linked
ancestors are normalized through realpath. Managed store paths cannot be links.
Source and managed store must not contain one another. Copying uses independent
regular files, not hard links back to the source.

First delivery retains all published artifacts, including unrecorded objects left
by an interrupted later registration. Uninstall and restart do not reclaim this
quota. At capacity, an exact validated digest can still be reused; a new digest
is refused. The 1.25 GiB maximum published logical payload bytes excludes
filesystem allocation overhead and the bounded staging payload.

## Cancellation, recovery and ownership

Pass an `AbortSignal` to cancel a queued or copying operation. A failed operation
cleans its own staging files; cleanup failure remains visible alongside the
original failure. Abandoned staging is cleaned before a subsequent stage, with at
most 64 operation directories and bounded traversal per operation. Unexpected or
over-limit recovery content is retained and reported instead of recursively
deleting an unbounded tree. An object already published at cancellation is inert
and may remain retained.

Use one store instance and one live owning process for each store directory.
The API serializes its operations; it does not coordinate independent instances
or processes. Server must add an ownership guard before exposing installation
over HTTP. Ordinary interrupted-copy recovery does not claim universal sudden-
power-loss durability on every filesystem.

Reference contracts and delivery scope are recorded in
[ADR 0005](../adr/0005-plugin-installation-and-distribution.md) and the
[Stage 6 design](../superpowers/specs/2026-11-21-plugin-installation-design.md).
