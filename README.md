# Weave

Weave is a local-first, plugin-native agent workspace and runtime.

The project is developed in three stages:

1. Weave Studio: a local coding-agent workspace.
2. Weave Runtime: a composable agent runtime and SDK.
3. Weave Crew: multi-agent task orchestration.

This repository starts as a clean implementation. The former Orbit prototype
remains a separate reference project and is not copied into this repository.

## Status

The Foundation vertical slice, Session persistence, the headless Agent Tool
Loop, the shared Tool Pipeline, the Approval HTTP control plane, the Agent
HTTP/SSE adapter, the first Studio Agent Chat workspace, multi-Provider
routing, the typed Plugin Kernel, local ESM plugin trust/management, and local
stdio MCP tools, immutable GitHub plugin acquisition, multiple marketplace
indexes, the Skills selection/resource/history flow, and no-entry Skills text
packages are implemented. Studio manages local launch configurations,
canonical trust reviews, enable/disable/revoke/remove decisions, and explicit
extension reloads through the Server control plane.
`@weave/protocol`, `@weave/llm`, `@weave/session`, `@weave/runtime`,
`@weave/plugin`, `@weave/server`, and `@weave/studio` form the current
architecture, alongside `@weave/plugin-builtins`, `@weave/plugin-host`,
`@weave/mcp-client`, `@weave/memory`, `@weave/retrieval`, and `@weave/desktop`. OS Sandbox hardening,
remote MCP transports, and the broader Studio product remain later phases. The first
protected Workspace file tools are now available in `@weave/runtime`.

Start with the [Foundation architecture guide](docs/architecture/foundation.md)
for the request path, package boundaries, and AI editing checklist. The
[vertical-slice ADR](docs/adr/0001-foundation-vertical-slice.md) records why
the repository begins with these four units.

See [local MCP setup and lifecycle](docs/learning/2026-11-21-local-mcp.md)
for the Studio workflow, launch configuration format, trust boundaries, and
troubleshooting. See [Skills usage and authoring](docs/learning/2026-11-22-skills.md)
for per-session selection, exact retry, progressive resource reads and supported
`SKILL.md` metadata. See [installable Skills text packages](docs/learning/2026-11-22-declarative-skill-packages.md)
for the no-build format and maintained coding example. The repository-local
[developer CLI](docs/learning/2026-11-22-plugin-developer-cli.md) scaffolds Tool,
Command and Skills projects and validates/builds/packs actual payload directories.
Custom panel SDK and maintained official releases follow as independent topics.

The Stage 6.1 [local plugin artifact store](docs/learning/2026-11-21-plugin-artifact-store.md)
provides bounded, non-executing directory copies at fixed content-addressed paths.
Studio can import these directories as candidates and activate a selected version
after a separate trust review. See [Local plugin installation](#local-plugin-installation).

## Project search

Studio's Search page builds and queries a local project index. The default lexical
mode uses SQLite FTS5 and needs no provider key. A build captures safe project
text files and only the current reviewed project memories you explicitly select;
it does not index chat history, personal memory, or file attachments. Preview the
source list and exact captured text before building. Accepted builds continue in
the background; status and cancellation are available in Studio and through the
Agent's shared Tool Pipeline.

Hybrid mode uses the fixed OpenAI `text-embedding-3-small` model with 512 dimensions.
Configure its separate credential in the Server environment:

```bash
WEAVE_EMBEDDING_PROVIDER=openai
WEAVE_OPENAI_EMBEDDING_API_KEY=<embedding-key>
```

The Server never borrows the chat provider key. Building a hybrid index sends the
approved frozen chunks to `api.openai.com`; each semantic query requires its own
explicit action. Agent calls require approval even in yolo mode. Typing, changing
filters, and reconnecting do not send semantic requests. There are no automatic
embedding retries or resumed embedding jobs after restart.

A generation contains at most 2,000 code files, 48 reviewed memories, and 20,000
chunks. Queries verify current source identity and exact content before returning
citations; changed files and revoked memories are omitted, and opening an old
citation can require a rebuild. Path-based exclusions reduce accidental captures
but do not inspect file bodies for secrets. Old derived generations and durable
job records are retained according to the index lifecycle; removing a source is
not a promise of physical erasure from historical storage.

See the [retrieval design](docs/superpowers/specs/2026-11-23-hybrid-retrieval-design.md)
and [verification results](docs/verification/2026-11-24-hybrid-retrieval.md) for
package boundaries, supported limits, fixed quality fixtures, and measurement
conditions.

## Planned stack

- TypeScript and Node.js
- pnpm workspace and Turborepo
- Zod
- SQLite
- Hono
- React and Vite
- Vitest

## Getting started

Install Node.js `24.4.0` or newer and pnpm `10.13.1` or newer. Then install
the pinned workspace dependencies:

```bash
pnpm install
pnpm check
```

`pnpm check` runs formatting, linting, type checking, package tests, and
package builds through the root toolchain. A package can be targeted directly,
for example `pnpm --filter @weave/protocol test`.

`pnpm studio:benchmark` builds Studio and measures synthetic 100/1000/5000-message
conversations in a fresh local Chrome browser per sample. It requires an installed
`playwright-cli` and Chrome, writes raw observations to `dist/performance/`, and
does not open real projects or call a model. See the
[Studio performance baseline](docs/learning/2026-11-23-studio-performance-baseline.md)
for setup, metric definitions, recorded samples and measurement limits.

The Turbo typecheck and test tasks build their upstream workspace packages
first. This keeps a clean checkout independent of ignored `dist/` artifacts
and makes the same validation sequence work locally and in GitHub Actions.

## First-round layout

```text
weave/
├── apps/
│   ├── server/       # HTTP control-plane entry point
│   ├── studio/       # React + Vite Agent workspace
│   └── desktop/      # Electron desktop composition root
├── packages/
│   ├── protocol/     # Shared data types and Zod schemas
│   ├── llm/          # Model client interface and provider adapters
│   ├── session/      # Append-only Session events and projections
│   ├── workspace/    # Project metadata and Project/Session references
│   ├── runtime/      # Service assembly, Agent Runner, and Tool Pipeline
│   ├── plugin/       # Typed Plugin Kernel, SDK, hooks, and extension points
│   ├── plugin-builtins/ # Built-in plugins and the MCP tool adapter
│   ├── plugin-host/  # ESM/Skills payload discovery, trust, loading, generations
│   ├── plugin-cli/   # Repository-local authoring, SDK check, build and pack
│   └── mcp-client/   # Bounded local stdio MCP transport and frozen catalog
├── docs/              # Architecture, ADR, and learning material
└── root tooling       # pnpm, Turbo, TypeScript, ESLint, Prettier, Vitest
```

The package dependency direction is
`protocol -> {llm, session} -> runtime -> plugin -> {plugin-builtins, plugin-host} -> server -> desktop`.
`mcp-client` is an independent transport package consumed by `plugin-builtins`
and `server`; `workspace` remains independent and is consumed by `server`.
The independent `plugin-cli` leaf consumes only Plugin and Plugin-host for local
authoring and payload validation; it does not import Server or Runtime.
`protocol` owns stable public contracts, `llm` isolates provider differences,
`session` stores durable facts and rebuilds read models, `workspace` stores
Project metadata, `runtime` assembles services and lifecycle state, `plugin`
validates trusted extensions and registers their capabilities, `server`
exposes the control plane, and `desktop` hosts the Server inside Electron.
`studio` depends on no `@weave/*` package and talks to the Server only over
HTTP/SSE. ESLint rejects undeclared workspace dependencies, reverse layer
imports, cross-package relative source imports, HTTP/UI imports from
`runtime`, and Node or Electron imports from `studio`.

The first Plugin phase accepts explicitly provided trusted in-process plugins:

```bash
pnpm --filter @weave/plugin test
pnpm --filter @weave/plugin typecheck
```

The Server composition root can register a `WeavePlugin` before creating the
Agent Runner. A plugin can register a Tool or Provider through `PluginContext`,
but Tool execution still goes through the shared Tool Pipeline and Provider
selection still goes through `LlmProviderRegistry`. GitHub installation accepts
an exact full Commit and optional Monorepo path through an inert preview/import;
reviewed trust and activation remain separate decisions. Marketplace discovery
does not execute a plugin. See [GitHub acquisition](docs/learning/2026-11-22-github-plugin-acquisition.md)
and [marketplace publishing](docs/learning/plugin-marketplace-publishing.md).

Server does not contain the Agent Loop because HTTP should remain a thin
control-plane boundary while agent behavior belongs in the runtime. Server
exposes `GET /health`, the Approval REST/SSE control plane, and a POST + SSE
adapter for one Agent turn. The adapter consumes the same Runtime event stream
used by CLI and tests; it does not implement model calls or tool execution.

## Studio Agent Chat

Start the local demo with one command:

```bash
pnpm dev
```

This starts both the Server and Studio. Open `http://127.0.0.1:5173` after
both processes are ready.

You can also start them in two terminals when debugging one side separately:

```bash
pnpm --filter @weave/server dev
pnpm --filter @weave/studio dev
```

Open `http://127.0.0.1:5173`. Vite serves the React Studio and proxies
`/agent/*`, `/approvals`, `/projects`, `/sessions`, `/settings`, `/plugins`,
`/commands`, and `/mcp` to
`http://127.0.0.1:4317`, so the browser can call the local Server without a
separate CORS setup. The Server `dev` script builds the TypeScript packages
first and then starts `dist/main.js`.

### Serving Studio from the Server and LAN access

After `pnpm --filter @weave/studio build`, the Server can host Studio itself on
the same origin as the API. Set `WEAVE_STUDIO_DIRECTORY` to
`apps/studio/dist` (Desktop does this automatically):

```bash
WEAVE_STUDIO_DIRECTORY=apps/studio/dist pnpm --filter @weave/server dev
```

By default the Server listens on `127.0.0.1` only. To open Weave from another
device on the local network, pass `--host` (or set `WEAVE_HOST`):

```bash
node apps/server/dist/main.js --host 0.0.0.0
```

A non-loopback address turns on an access token. The Server prints
`http://<address>:<port>/?token=<token>` at startup; opening it stores the token
in an `HttpOnly` cookie, and API clients can send `Authorization: Bearer <token>`.
Set `WEAVE_ACCESS_TOKEN` (16 to 256 characters of `A-Za-z0-9._~-`) to keep the
token stable across restarts. Desktop accepts the same `--host` argument and
`WEAVE_HOST`.

**Security:** anyone on the network who has the token can use every Server API
on this computer, including Agent runs that read and write the Project folders.
The connection is plain HTTP, so use it only on a network you trust and do not
share the URL.

Browser acceptance flow:

1. Confirm the Studio workspace is visible in the first viewport.
2. Enter a message and submit it.
3. Observe the user message, streamed assistant text, and `已完成` status.
4. Click `停止运行` during a run to verify the cancellation state.
5. Resize to a narrow viewport and confirm the secondary context panel is
   hidden while the conversation and input area remain usable without
   horizontal overflow.

Studio now persists Projects and Sessions through the Server, so a refresh or
restart restores the project tree and the selected conversation from SQLite.
When a Project is created with a folder (the system dialog on Desktop, or a
typed absolute path in browser mode), the default Agent can call `read_file`
and `write_file` inside that folder; every write waits for an approval card in
Studio. Studio still does not include a file editor, Diff view, Shell tools,
Crew orchestration, a Run Registry, reconnection or
`Last-Event-ID`, or login. An existing Project can be given a folder from the
project menu ("设置文件夹"). In
browser mode Provider configuration is local Server configuration read from
`.env`; only Desktop mode lets the Settings page submit an API Key, and no
mode ever returns a stored key to Studio. The page is an HTTP/SSE surface for
the existing Runtime, not a replacement for the Runtime.

### Explicit long-term memory

Open **记忆** in Studio to manage records for the selected Project or the local
personal scope. Agent use starts disabled for each scope. You can still create,
edit, inspect revisions, review an exact Agent-authored version, and delete
records while use is disabled. Personal use requires its own explicit opt-in.

Agents use `search_memory` and `read_memory` on demand. Root Turns can also call
`save_memory` and `delete_memory` through the shared Tool Pipeline and current
permission mode. Child tasks can only read their verified Project memory.
Agent saves remain **Agent 编写** after approval; an explicit user edit or review
creates an **已审阅** revision. A later Agent edit changes the current state back
to Agent-authored. Conflicting edits retain your draft and require reloading the
current version before another save.

Memory is stored in a separately versioned local SQLite sidecar. Deletion removes
the current record from list/search and retains revision history and existing
Session tool results. The selected deleted record's history remains inspectable;
this release has no separate deleted-record catalog. Memory does not learn
automatically, create embeddings, or inject records into system instructions.
See [the implementation walkthrough](docs/learning/2026-11-23-long-term-memory.md)
for the authority model, recovery behavior and measured limits.

### LLM Provider routing

The Server always registers a deterministic `mock` Provider. Additional
OpenAI-compatible Providers can be configured with the
`WEAVE_LLM_PROVIDERS` environment variable. When at least one external
Provider is configured, the first configured Provider becomes the default
selection in Studio; otherwise Studio uses `mock`:

```json
[
  {
    "id": "deepseek",
    "label": "DeepSeek",
    "type": "openai-compatible",
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "replace-with-your-key",
    "defaultModel": "deepseek-flash"
  }
]
```

Start the local workspace after creating the local environment file:

```bash
cp .env.example .env
# Edit .env and replace the placeholder API key.
pnpm dev
```

The OpenAI-compatible adapter appends `/chat/completions` to `baseUrl`, so
DeepSeek uses `https://api.deepseek.com` in this configuration. The Server
development command loads the root `.env` file with Node's built-in
`--env-file-if-exists` option.

#### Testing tools with the mock Provider

The `mock` Provider (shown as 本地演示 in Studio) can call tools on request, so
Approval cards and tool steps can be tested without a real model. Select it in
a Project that has a folder and send one `/tool <name> <json arguments>` line
per call; several lines start several calls in the same step:

```text
/tool run_command {"command":"echo hello","risk":"low","riskReason":"prints one line"}
/tool write_file {"path":"mock-test.md","content":"mock 测试\n"}
```

Arguments must stay on one line and reach the tool unchanged, so a typo shows
the real error (`tool-invalid-json`, `tool-not-found`). After the tools run, the
mock replies with the first line of each result; any other message gets the
fixed demo answer. The tools really execute: reject the Approval when you only
want to look at the card.

### Desktop development

Use the Electron shell when you want to verify the desktop runtime and local
data boundary:

```bash
pnpm desktop:dev
```

The command starts the Studio Vite server, waits up to 30 seconds for
`WEAVE_STUDIO_URL` (default `http://127.0.0.1:5173`) to become available, and
then starts Electron. Electron starts the local Weave Server on a random
loopback port and stops it when the window closes. The desktop Server stores
SQLite at Electron's `app.getPath('userData')/weave.sqlite`:

- macOS: `~/Library/Application Support/Weave/weave.sqlite`
- Windows: `%APPDATA%/Weave/weave.sqlite`
- Linux: `$XDG_CONFIG_HOME/Weave/weave.sqlite` or
  `~/.config/Weave/weave.sqlite` (Electron's default `userData` location)

On macOS and Windows this is the same file the browser-mode Server uses by
default, so both modes see the same Projects and Sessions. On Linux the browser
Server defaults to `$XDG_DATA_HOME/weave` or `~/.local/share/weave` instead.

The browser command `pnpm dev` remains available. `WEAVE_DATA_DIR` and
`WEAVE_DATABASE_FILE` continue to override the browser Server's storage
location. The old `apps/server/.weave/` directory is kept as-is and is not
automatically deleted or migrated.

Desktop Provider configuration flow:

```text
打开桌面端
  -> 设置
  -> 添加 AI 服务
  -> 保存 API Key
  -> 选择模型
  -> 返回工作台发送消息
```

Browser mode remains read-only for Provider settings. It reads
`WEAVE_LLM_PROVIDERS` from `.env`, while Desktop mode stores the Provider
metadata in the application SQLite file and encrypts API Keys with Electron
`safeStorage` before persistence. The Desktop settings page never renders an
existing API Key back to the user.

The Server validates Provider configuration with Zod, creates one private
`LlmClient` per configured entry, and injects the shared
`LlmProviderRegistry` into the Runtime. Studio reads
`GET /settings/providers`, displays public Provider metadata, and sends the
selected `provider` and `model` with each Agent run. API Keys are excluded from
Provider metadata, Session events, SSE payloads, logs, and error messages.

The detailed learning guide is
[LLM Provider 路由：从配置到 Studio 选择](docs/learning/2026-11-16-llm-provider-routing.md).

### Local plugin installation

Open **插件市场** in Studio's left navigation, then **已安装**, to import a bundled
local ESM plugin or declarative Skills text package into a bound managed store.
Import prepares a candidate. Activation
requires a separate review before Server loads that version.

On Desktop, use the native folder picker to select the bundled directory.
With `WEAVE_PLUGINS_DIR` unset, Desktop uses `<userData>/plugins` and permits
first binding. Set `WEAVE_PLUGINS_DIR` to use a custom directory. Server
resolves a relative value from its working directory and rejects an empty
value at startup. To bind a custom directory for the first time, use the
explicit Server launcher below with `pluginsDirectory` set to that directory's
absolute path and `dataDirectory` set to the Desktop profile. An existing
registration must match the configured root.

In a browser, enter the absolute path to the bundled directory on the machine
running Server. `pnpm dev` can resume a store whose registered root matches the
profile. The installer is disabled for an unbound profile unless its launcher
authorizes first binding.

To test first binding in a browser, run `pnpm --filter @weave/server... build`
from the repository root. Replace `/absolute/isolated/profile` with the
absolute path to a separate test profile and start Server from the same root.

```bash
WEAVE_TEST_PROFILE=/absolute/isolated/profile node --input-type=module -e '
  import { join } from "node:path";
  import { startServer } from "./apps/server/dist/main.js";
  const dataDirectory = process.env.WEAVE_TEST_PROFILE;
  const server = await startServer(4317, {
    dataDirectory,
    databaseFile: join(dataDirectory, "weave.sqlite"),
    pluginsDirectory: join(dataDirectory, "plugins"),
    studioOrigin: "http://127.0.0.1:5173",
    managedPluginStore: { initialBinding: "allow-unbound" },
  });
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, async () => {
    try { await server.stop(); } catch (error) { console.error(error); process.exitCode = 1; }
  });
'
```

Run `pnpm --filter @weave/studio dev` in another terminal and open
`http://127.0.0.1:5173`.

The same bound profile supports public GitHub sources in the marketplace's Installed view.
Choose GitHub and provide `https://github.com/owner/repository`, a complete
40-character lowercase commit SHA and an optional relative plugin subdirectory.
The directory must already contain a bundled Weave plugin. Preview downloads and
validates the fixed content; import saves a candidate and activation remains a
separate review. GitHub API rate limits apply. See
[GitHub acquisition](docs/learning/2026-11-22-github-plugin-acquisition.md) for
source identity, cancellation and installation behavior.

### Plugin marketplace

The left **插件市场** page separates discovery from installed plugin management.
Search and filter official bundled plugins and community releases in **发现插件**;
local/GitHub installation, version history, explicit activation and MCP stay in
**已安装**. The main plugin entry is no longer a right-hand activity tab.
Switching pages retains the active conversation, draft, terminal and preview tabs.

Official entries identify Weave's actual bundled plugins. The default community
directory is maintained in `marketplace/submissions/` and generated into
`marketplace/index.json`; it starts empty rather than listing unpublished plugins.
Use **管理索引源** in Discover to add HTTPS JSON indexes, including GitHub blob
URLs. Switch sources to browse them, then explicitly refresh to fetch current
content. Source settings survive Server restart. Discovery reads cached data;
adding a source does not install or trust its plugins. A failed refresh retains
the last successful catalog and reports its stale state.

Operators can also set `WEAVE_PLUGIN_MARKETPLACE_CATALOG` to an absolute catalog
path or pass `pluginMarketplaceCatalogFile` to `startServer`. Restart Server after
editing this local file. The local directory remains independent of user-added
remote sources. Unreadable or invalid indexes do not stop agent work.

Choosing **准备安装** copies a fixed release into the existing import form. Press
**预览插件** to fetch and compare the actual manifest with the index declaration.
Import creates an inert candidate, and activation requires its own trust review.
The marketplace supports public fixed-commit GitHub bundles. Developers prepare
an entry, submit it through a GitHub PR, and validate the deterministic directory
with `pnpm marketplace:check`; see the
[publishing guide](docs/learning/plugin-marketplace-publishing.md). The checked-in
directory works without a hosted account or upload service. Custom right panels
retain their own future SDK design. See the
[marketplace guide](docs/learning/2026-11-22-plugin-marketplace.md) for the catalog
format, bounds, lifecycle and developer publication workflow.

## Agent Runner

`createAgentRunner()` is the Runtime boundary for one Session turn. It
validates the request, recovers the Session through `projectSession()`, calls
`LlmClient.stream()`, yields transient `AgentRuntimeEvent` values, and appends
durable Session events for the completed, failed, or cancelled lifecycle.
When configured with a `ToolRegistry` and `ToolPipeline`, it assembles
streamed Tool Calls, executes them sequentially through the shared Pipeline,
persists tool messages and tool timeline events, and continues with the next
model step. `maxSteps` defaults to eight to bound the loop.

Runs for the same Session are serialized within one `AgentRunner` instance so
Session reads, appends, and model context construction do not interleave.
Separate Runner instances and processes are not coordinated by the current
`SessionEventStore` contract; cross-instance leasing or compare-and-swap
belongs to a future Session concurrency slice.

```ts
import { createMockLlmClient } from '@weave/llm';
import { createInMemorySessionEventStore } from '@weave/session';
import { createAgentRunner } from '@weave/runtime';

const runner = createAgentRunner({
  llm: createMockLlmClient([
    { type: 'text-delta', text: 'Hello' },
    { type: 'finish', reason: 'stop' },
  ]),
  sessionStore: createInMemorySessionEventStore(),
});

for await (const event of runner.run({
  sessionId: 'session-1',
  userMessage: {
    role: 'user',
    content: [{ type: 'text', text: 'Say hello' }],
  },
  provider: 'mock',
  model: 'test-model',
})) {
  console.log(event);
}
```

Without a paired Registry and Pipeline, Tool Calls return
`agent-tool-call-unsupported`; malformed Tool Call streams return
`agent-tool-call-invalid`. The Server does not expose the Runner directly over
HTTP. Studio starts a turn with `POST /sessions/:id/executions` and observes it
through `GET /sessions/:id/executions/:executionId/events`; the Runtime
execution service owns the Runner call, cancellation and replay.

Run the focused Agent Runner tests with:

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
```

## Tool Pipeline

`createToolRegistry()` stores executable definitions by stable name, while
`createToolPipeline()` is the only boundary allowed to invoke them. The
Pipeline parses JSON arguments, validates them with the tool's Zod schema,
pauses protected tools at an Approval gate, passes a cooperative `AbortSignal`,
maps cancellation, timeout, and Approval failures to stable error codes, and
limits returned content by UTF-8 byte length.

The Pipeline does not itself access files, run Shell commands, or write Session
events. Approval is supplied by the Runtime's transient `ApprovalBroker`, while
file access belongs to Workspace-aware tools. The Pipeline remains the shared
lifecycle boundary around all of them.

```ts
import { z } from 'zod';
import { createToolPipeline, createToolRegistry } from '@weave/runtime';

const registry = createToolRegistry();
registry.register({
  name: 'echo',
  description: 'Returns the input text',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  inputSchema: z.object({ text: z.string() }),
  execute: ({ text }) => text,
});

const pipeline = createToolPipeline({ registry });
const result = await pipeline.execute({
  toolCallId: 'call-1',
  name: 'echo',
  arguments: '{"text":"hello"}',
});
```

Tools that can cause an external side effect declare an Approval requirement.
The declaration must provide a stable operation name, a risk level, and a
redacted summary function. The Pipeline creates a pending request after input
validation and before `execute`; the tool cannot run until the caller approves
the request.

```ts
import { createApprovalBroker, createToolPipeline, createToolRegistry } from '@weave/runtime';

const registry = createToolRegistry();
registry.register({
  name: 'protected_echo',
  description: 'Example protected operation',
  parameters: { type: 'object', properties: { value: { type: 'string' } } },
  inputSchema: z.object({ value: z.string() }),
  approval: {
    operation: 'example.protected_echo',
    risk: 'medium',
    summarize: ({ value }) => ({
      summary: `执行受保护操作 ${value}`,
      inputSummary: { value },
    }),
  },
  execute: ({ value }) => value,
});

const approvalBroker = createApprovalBroker();
const pipeline = createToolPipeline({ registry, approvalBroker });
const execution = pipeline.execute({
  toolCallId: 'call-approval-1',
  name: 'protected_echo',
  arguments: '{"value":"hello"}',
});

const pending = approvalBroker.list()[0];
if (pending?.status === 'pending') {
  approvalBroker.approve(pending.approvalId, '用户确认');
}

const result = await execution;
```

Approval has four terminal outcomes: `approved` continues to the tool,
`rejected` returns `tool-approval-rejected`, and `cancelled` or `expired`
return their corresponding stable errors. A request cancellation also cancels
the pending Approval, so the protected tool is never invoked.

`ApprovalBroker` is intentionally in-memory transient control state in this
phase. It coordinates a live decision in one Runtime process, but it is not a
durable audit log and does not recover pending requests after a restart. Session
events remain append-only durable facts. A later Server/Studio layer can add
durable approval audit events without making the Tool Pipeline depend on HTTP,
SSE, or a particular UI.

Approval also does not replace `WorkspacePolicy`, filesystem checks, or a
future Sandbox. Approval answers “did the caller allow this operation?”;
Workspace and Sandbox boundaries answer “is this operation allowed to touch
this resource at all?”. For example, `write_file` requires high-risk Approval,
but it still rejects traversal, external symlinks, directories, and byte-limit
violations after approval.

Run the focused Tool Pipeline tests with:

```bash
pnpm exec vitest run packages/runtime/test/tool-pipeline.test.ts --config vitest.config.ts
```

## Workspace File Tools

`createWorkspaceFileTools()` adds `read_file` and `write_file` definitions on
top of the lexical Workspace path policy. They must be registered in the
shared Tool Registry and invoked through the Tool Pipeline; callers must not
call a tool's `execute` function directly.

```ts
import {
  createToolPipeline,
  createToolRegistry,
  createWorkspaceFileTools,
  createWorkspacePolicy,
} from '@weave/runtime';

const registry = createToolRegistry();
const fileTools = createWorkspaceFileTools({
  workspace: createWorkspacePolicy({ root: '/Users/mi/project' }),
  maxReadBytes: 1_000_000,
  maxWriteBytes: 1_000_000,
});

registry.register(fileTools.readFile);
registry.register(fileTools.writeFile);

const pipeline = createToolPipeline({ registry });
const result = await pipeline.execute({
  toolCallId: 'call-1',
  name: 'read_file',
  arguments: JSON.stringify({ path: 'README.md' }),
});
```

`read_file` remains unprotected, while `write_file` declares
`workspace.write_file` as a high-risk operation. Its Approval summary contains
only the relative path, UTF-8 byte count, and overwrite flag; it never includes
the complete file content.

The tools currently support UTF-8 text only. Each operation can provide a
smaller `maxBytes` limit; otherwise the factory default is used. `write_file`
does not create parent directories and refuses to overwrite an existing file
unless `overwrite: true` is explicit. The tool checks the real Workspace root,
the real target or parent directory, file type, and UTF-8 byte length before
access. A symlink that resolves outside the Workspace is rejected.
Dangling symlinks are also rejected because their final target cannot be
verified safely.

## Approval HTTP Control Plane

The local Server exposes a thin REST/SSE control plane for the Runtime's
in-memory Approval Broker. A desktop or frontend client can query pending
requests, subscribe to live state changes, and resolve them without
duplicating Approval state or calling tools directly.

```text
GET  /approvals
GET  /approvals/:approvalId
POST /approvals/:approvalId/approve
POST /approvals/:approvalId/reject
POST /approvals/:approvalId/cancel
GET  /approvals/stream
```

Decision endpoints accept an optional JSON body:

```json
{
  "reason": "用户确认"
}
```

An empty body means no reason. The Server validates the body with Zod and
returns stable error responses:

```json
{
  "error": {
    "code": "approval-already-resolved",
    "message": "Approval request is already approved"
  }
}
```

For real-time updates, `GET /approvals/stream` returns an SSE stream. The
connection first sends an `approval.snapshot` event containing the current
Approval list, then sends `approval.created` when a request enters the Broker
and `approval.resolved` when it reaches an approved, rejected, cancelled, or
expired state:

```text
event: approval.snapshot
data: {"approvals":[...]}

event: approval.created
data: {"approvalId":"...","status":"pending",...}

event: approval.resolved
data: {"approvalId":"...","status":"approved",...}
```

The frontend can use the snapshot as its initial view and keep it updated from
the two lifecycle events. The HTTP layer only delegates to the Runtime Broker;
the waiting Tool Pipeline remains the only code allowed to continue protected
tool execution. Approval HTTP is not an authentication or authorization layer.
The SSE subscription is an in-process live-control adapter, not a durable event
log or cross-process replay mechanism. A disconnected client must use a later
snapshot or REST query to rebuild its view.

The stable error codes are exposed through `WorkspaceFileError`. Node errors
remain available through `cause`, which preserves diagnostic details without
making callers depend on platform-specific filesystem messages. This is still
not a complete Sandbox: Approval, stronger OS-level isolation, and all
TOCTOU-resistant operations are future work.

## Workspace Path Policy

`createWorkspacePolicy()` is the first Workspace security boundary. It
normalizes a configured absolute root, resolves relative paths, and rejects
absolute inputs, null bytes, and paths that escape the root after `..`
normalization.

```ts
import { createWorkspacePolicy } from '@weave/runtime';

const workspace = createWorkspacePolicy({ root: '/Users/mi/project' });
const file = workspace.resolve('src/index.ts', 'read');
// {
//   absolutePath: '/Users/mi/project/src/index.ts',
//   relativePath: 'src/index.ts',
//   operation: 'read',
// }
```

This is a lexical path policy, not a complete Sandbox. It does not check
whether a file exists, follow or reject symbolic links, inspect permissions,
perform I/O, or ask for Approval. Future file and Shell executors must call
the policy before access and repeat filesystem-specific checks immediately
before touching the host.

The current path boundary is deliberately separate from the Tool Pipeline:

```text
Tool Pipeline
  -> Workspace Path Policy
    -> Workspace File Tools
      -> future Approval/Sandbox
```

## Session Event Store

`@weave/session` stores facts instead of repeatedly mutating a serialized
Session object. A caller submits a `NewSessionEvent`; the Store assigns the
event ID, per-Session sequence, and timestamp, then appends the event. The
first slice supports both an In-Memory Store for fast tests and a SQLite Store
for local persistence.

```text
NewSessionEvent[]
  -> SessionEventStore.append()
  -> durable SessionEvent[]
  -> projectSession()
  -> SessionProjection
```

`@weave/llm` `StreamEvent` values are temporary provider-stream transport
events. They can contain multiple text deltas for one eventual message and
must not be written directly as durable Session events. The Agent/Turn layer
will later decide which completed facts become `message.created`,
`turn.completed`, or other Session events.

The SQLite recovery path can be checked with:

```bash
pnpm --filter @weave/session test -- sqlite-store
```

The test writes events to a temporary database, closes the Store, reopens the
same file, and verifies that sequence order and payloads are still available.

## Development principle

The runtime is the source of truth. Web, CLI, SDK, and Desktop surfaces should
consume the same runtime instead of implementing separate agent loops.

## Documentation

- [Foundation architecture](docs/architecture/foundation.md): request flow,
  boundaries, examples, and interview explanation.
- [Agent HTTP/SSE learning guide](docs/learning/2026-11-15-agent-http-sse.md):
  request validation, SSE framing, cancellation, frontend consumption, and
  interview explanation.
- [Studio Agent Chat learning guide](docs/learning/2026-11-15-studio-agent-chat.md):
  browser boundaries, stream parsing, React state mapping, cancellation races,
  local composition, transient versus durable events, and interview practice.
- [ADR 0001](docs/adr/0001-foundation-vertical-slice.md): the decision and
  consequences behind the first vertical slice.
- [Foundation design](docs/superpowers/specs/2026-11-14-weave-foundation-design.md):
  detailed first-round contracts and exclusions.
- [Session Event Store design](docs/superpowers/specs/2026-11-15-session-event-store-design.md):
  durable event contracts, SQLite transactions, Projection rules, and the
  reasons behind the Session boundary.
- [Agent Loop design](docs/superpowers/specs/2026-11-15-agent-loop-design.md):
  Agent Runner API, Session recovery, transient versus durable events, and
  failure/cancellation semantics.
- [Tool Pipeline design](docs/superpowers/specs/2026-11-15-tool-pipeline-design.md):
  Tool Registry, Zod input validation, cancellation, timeout, error
  normalization, and result limits.
- [Workspace Path Policy design](docs/superpowers/specs/2026-11-15-workspace-path-policy-design.md):
  lexical path validation, Workspace root boundaries, and the separation from
  filesystem execution and Approval.
- [Workspace File Tools design](docs/superpowers/specs/2026-11-15-workspace-files-design.md):
  UTF-8 file access, realpath checks, symlink boundaries, overwrite protection,
  and stable file errors.
