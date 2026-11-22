# Weave Skills: complete vertical slice design

Final review compatibility rulings: explicit `turn.started.userMessageId` owns
the user association and may replace only the legacy active-turn inference,
never a previous explicit binding. This permits new turns after a process crash
without rewriting or silently completing orphaned durable turns.

Request snapshots use optional `useProviderDefaults` across Runtime and HTTP.
Omission retains existing default resolution. Every newly admitted Turn saves
`request.useProviderDefaults:false` and its effective temperature/maxTokens;
an omitted number with that flag means it was actually absent. Exact retry
keeps that flag so later provider default changes cannot change sampling.
Legacy history without a complete snapshot marker cannot promise exact retry.
Middleware next requests must be detached and validated before identity checks,
then the same frozen normalized values go to execution; accessor values are not
compared on a plugin object and reread later.

Cancellation ordering: consumer return synchronously aborts the real run signal,
then waits for admitted execution and persistence to settle before any fallback
terminal append. Required host audit rechecks the signal after its asynchronous
log read and immediately before append. Already accepted append work settles
before the turn terminal fact, preventing late Skill facts after cancellation.

Date: 2026-11-22. Status: accepted implementation contract under the user-authorized plugin completion sequence.

This independent topic follows merged GitHub acquisition (#91) and marketplace (#92). It includes the Skills vertical slice; developer distribution and custom panel SDK follow as separate topics. The existing isolated workspace is on `feat/skills-vertical-slice`, created from `origin/main` at `0dafa38d6d3610418db7acd67d7e8154b25ef07e`.

## 1. Outcome and scope

Users can select builtin, enabled-plugin, current-project and user Skills in Studio
and send exact structured references with a message. The Agent sees only a bounded
metadata catalog by default and can progressively load a Skill and its resources
using the shared Tool Pipeline. Explicit selections apply full instructions only
to the admitted turn. Every source is attributed, reads are bound to exact content,
and preparation is durably audited before the next model request.

A Skill is an instruction bundle. It cannot grant permissions, define executable
hooks, bypass tool policy or spawn processes. Scripts/resources remain inert text;
existing `run_command` retains ordinary workspace/approval/cancellation behavior.
No remote Skill installer, filesystem watchers, special script runner, binary
renderer, implicit third-party home scan or external publishing is added.

Pure Skill distribution must not require a fake ESM entry. This slice supports
builtin/project/user disk text and inline declarations of already-enabled ESM
plugins. The following developer-distribution topic adds an explicit declarative
skill-only installable type to descriptor/artifact/authority/marketplace contracts,
then official and curated third-party distribution. Do not enlarge this topic's
installer or use placeholder ESM modules to imitate that future type.

Existing slash commands stay prompt templates. AGENTS.md stays standing project
instructions. Plugin prompt sections stay generation-wide contributions. Skills
are a separate, per-turn instruction source with progressive disclosure.

## 2. References and Weave choices

Already verified evidence from the read-only audit and official source update:

- Current Codex `cf3ff1530d821ec2d26452da4971d8e3e7d18d25`:
  [catalog guidance](https://github.com/openai/codex/blob/cf3ff1530d821ec2d26452da4971d8e3e7d18d25/codex-rs/ext/skills/src/catalog_prompt.rs).
- Current `openai/plugins` `981b02c0c44058b595f3b4180002c3ae3c806d40`:
  [curated examples](https://github.com/openai/plugins/blob/981b02c0c44058b595f3b4180002c3ae3c806d40/README.md)
  and [marketplace](https://github.com/openai/plugins/blob/981b02c0c44058b595f3b4180002c3ae3c806d40/.agents/plugins/marketplace.json).
  The old openai/skills repository is deprecated; being in a curated directory
  does not mean authored by OpenAI/Weave or preinstalled. Superpowers remains
  Jesse Vincent's work; no third-party authored Skill is relabeled as Weave-owned.
- Current official audit: `docs/learning/2026-11-22-official-plugin-references.md`; official
  developer site403 is not treated as read evidence. Older parser/resource source
  below remains the exact version actually inspected, not claimed current.

- Codex `bfe3c825702e9235a631a1db58f291bed7a44cfe`: [metadata parser](https://github.com/openai/codex/blob/bfe3c825702e9235a631a1db58f291bed7a44cfe/codex-rs/skills/src/parser.rs), [catalog guidance](https://github.com/openai/codex/blob/bfe3c825702e9235a631a1db58f291bed7a44cfe/codex-rs/ext/skills/src/catalog_prompt.rs), [resource reader](https://github.com/openai/codex/blob/bfe3c825702e9235a631a1db58f291bed7a44cfe/codex-rs/ext/skills/src/tools/read.rs).
- [Kiro Skills](https://kiro.dev/docs/skills/) (official page verified 2026-11-22;
  page dated 2026-11-18): metadata discovery, explicit/automatic invocation,
  workspace/user roots, progressive instructions/resources.
- Harness `2e39e70496aa02986ca6a820c5d497e816b69d7e`: [Skills subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/docs/subsystems/skills.md), [skill tool](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/skill/tool-skill/src/index.ts).

Adopt metadata/body/resource separation, qualified source ownership, invocation
policy and incomplete-catalog semantics. Weave chooses exact structured refs,
existing Session audit, pinned Generation and shared Pipeline. Do not copy Cordis
world state/watchers, lenient YAML repair or other hosts' sandbox guarantees.
Root can supplement fresh source verification; no behavior below relies on an
unverified new external feature.

## 3. Dependency ownership

| Layer | Responsibility | New public names |
|---|---|---|
| protocol | Pure Skill wire schemas/types | `skillRefSchema`, `skillRefsSchema`, `skillSummarySchema`, `skillCatalogSchema`, `skillPageSchema`, corresponding types |
| session | Core Skill facts and existing turn/history projection | `SessionTurn.skills` and related readonly types |
| runtime | Run refs/context, actual turn identity, generic read-tool adapters | `AgentInstructionsContext`, `createSkillTools`, `readSkillInputSchema`, `readSkillResourceInputSchema`, `defaultToolResultMaxBytes`, `defaultAgentMaxToolResultTokens`, `estimateTokens` |
| plugin | Governed declarative inline contributions | `skillContributionSchema`, `SkillContribution`, `AttributedSkillContribution`, `skillsExtensionPoint`, `SkillsExtensionApi` |
| plugin-host | Inert disk parsing/discovery/snapshot reads | `parseSkillDocument`, `discoverSkillBundles`, `pinSkillBundle`, `readPinnedSkillResource`, domain types below |
| server | Session roots, per-generation/per-turn composition, hashing, audit, thin HTTP | `createSkillCatalogService`, `createTurnSkillController`, `withSkillAuditPipeline`, `registerSkillRoutes` |
| studio | Independent HTTP Zod mirror, picker/chips/preview/history | `fetchSessionSkills`, `previewSessionSkill`, `SkillPicker` |

Internal boundaries remain protocol -> {llm,session} -> runtime -> plugin ->
{plugin-builtins,plugin-host} -> server -> desktop; Studio has no @weave/Node import.
Plugin accesses pure Skill types via Runtime **type-only reexports**; do not add a
new plugin->protocol internal dependency. Plugin-host depends internally only on
plugin, which reexports the Skill data types type-only. Runtime generic tool
factory avoids a new plugin-builtins integration surface.

## 4. Wire records, hashes and limits

`packages/protocol/src/skills.ts` exports these strict Zod schemas and inferred
readonly types. Zod parsing creates detached copies; freeze them at owner boundary.

```ts
interface SkillRef {
  readonly id: string; // <=240, qualified below
  readonly instructionSha256: string; // lowercase 64hex
  readonly bundleSha256: string;      // lowercase 64hex
}
interface SkillSource {
  readonly kind: 'builtin' | 'plugin' | 'project' | 'user';
  readonly label: string; // <=300, safe text
  readonly pluginId?: string; // only real plugin owner
}
interface SkillSummary extends SkillRef {
  readonly name: string; // kebab-case <=64
  readonly description: string; // nonblank normalized <=1024
  readonly source: SkillSource;
  readonly invocation: { readonly user: boolean; readonly model: boolean };
}
interface SkillCatalog {
  readonly schemaVersion: 1;
  readonly generation: number; // positive safe integer
  readonly fingerprint: string; // sha256 of canonical wire summaries + flags
  readonly entries: readonly SkillSummary[];
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly issues: readonly SkillIssue[];
}
interface SkillIssue {
  readonly source: string; // path-free root label
  readonly code: 'unreadable'|'invalid-document'|'unsafe-entry'|'source-changed'|'limit-exceeded';
  readonly skillId?: string;
}
interface SkillPage {
  readonly skill: SkillRef;
  readonly kind: 'instructions' | 'resource';
  readonly path?: string; // resource-relative only
  readonly contentSha256: string;
  readonly text: string;
  readonly offset: number; // Unicode codepoint offset
  readonly eof: boolean;
  readonly nextCursor?: string;
}
```

Additional exports: `skillSourceSchema`, `skillIssueSchema`, and types
`SkillSource`, `SkillIssue`, `SkillRef`, `SkillSummary`, `SkillCatalog`, `SkillPage`.
`skillRefsSchema` accepts <=32 unique IDs. Duplicate refs fail input validation.

IDs: `builtin:<name>`, `plugin:<pluginId>/<name>`,
`project:<rootHash32>/<native|agents>/<name>`, `user:<rootHash32>/<name>`.
`rootHash32` is the first 32 SHA-256 hex chars of canonical Server-owned root path;
never accept a root path in request. Changing project root changes identity.

Hashes:

1. `instructionSha256`: UTF-8 SHA-256 of instruction body after BOM removal,
   CRLF->LF normalization and removal of frontmatter, **without trim**. Blank
   body is invalid; preserved whitespace is part of instruction identity.
2. `contentSha256` resource: SHA-256 of exact resource bytes. UTF-8 text is decoded
   strictly and not normalized; pages concatenate to exact decoded text.
3. `bundleSha256`: SHA-256 UTF-8 of canonical JSON
   `[name,description,invocation.user,invocation.model,instructionSha256,
   resourcesSortedByPath.map(r=>[r.path,r.sha256,r.bytes])]`.
   Metadata not used by runtime can be omitted from hash only when parser explicitly
   classifies it inert; name/description/policy/resource identity always participate.
4. Catalog fingerprint hashes emitted qualified summaries in deterministic order,
   plus complete/truncated flags. Never hash absolute paths into public JSON.

Concrete bounds:

- SKILL.md <=64KiB; YAML frontmatter <=8KiB; name64, description1024.
- <=128 candidate directories per root; project-native, project-agents and one
  configured user root only. Max384 disk entries plus <=128 builtin/plugin entries.
- <=1000 regular files/20MiB resource bytes per disk bundle, <=8 resource nesting
  levels. Reject symlinks/special files; resource hash scan shares a64MiB total
  per catalog operation; exhaustion reports incomplete/limit-exceeded.
- Inline contribution <=64 resources, <=256KiB each, <=2MiB total; body<=64KiB.
- <=32 explicit selections and <=1MiB total explicit instruction bytes per turn.
- Model catalog serialized UTF-8 <=32KiB; HTTP metadata catalog <=512 entries,
  issues<=64. No silent loss: clipped catalog sets truncated and incomplete.
- Tool page serialized JSON <=4096 bytes and <=actual Pipeline byte cap and
  <=actual Agent maxToolResultTokens. Cursor max256 chars, <=256 retained cursor
  snapshots per turn, <=32 activated bundles per turn.
- Discovery/preview/read operations carry AbortSignal; bounded filesystem work
  is sequential or concurrency<=4. Missing root = complete empty; denied/invalid
  root = incomplete. No infinite directory walking.

## 5. Disk Skill document and resource contract

Project roots are `<project>/.weave/skills` and `<project>/.agents/skills`.
User root is `<dataDirectory>/skills`, configurable by explicit
`StartServerOptions.skillsDirectory?: string | false` and `WEAVE_SKILLS_DIR`;
`false` disables user disk discovery, not builtin/plugin/project Skills.
Only direct `<root>/<name>/SKILL.md` candidates are discovered. No ancestor scan,
implicit ~/.codex or ~/.kiro imports, flat markdown shorthand or recursive globs.

Require YAML frontmatter delimiters, optional UTF-8 BOM, name matching directory,
nonblank description; positive normalized invocation defaults user/model true.
Standard fields: name, description, license, compatibility, metadata,
`disable-model-invocation` and `user-invocable`. Unknown fields are inert and
bounded; reject YAML duplicate keys, custom tags, anchors/aliases and nested
structures beyond the supported metadata string map. Strings including block
and quoted scalars are supported via `yaml` dependency in plugin-host, pinned
exactly during implementation after registry verification; document its need
(strict YAML, no evaluation) before installing. Do not handwrite a partial parser.

Private plugin-host API (export exact names/types from its index):

```ts
interface SkillScanBudget { remainingBytes:number }
createSkillScanBudget(totalBytes?:number):SkillScanBudget; // defaults to 64MiB
interface SkillRootInput { readonly id: string; readonly directory: string; readonly label: string }
interface DiskSkillHandle { readonly rootId: string; readonly name: string; readonly instructionSha256: string; readonly bundleSha256: string }
interface DiscoveredSkillBundle { readonly handle: DiskSkillHandle; readonly name: string; readonly description: string; readonly invocation: {readonly user:boolean;readonly model:boolean}; readonly resources: readonly SkillResourceIdentity[] }
interface SkillResourceIdentity { readonly path:string; readonly sha256:string; readonly bytes:number }
interface SkillDiscoveryResult { readonly bundles:readonly DiscoveredSkillBundle[]; readonly complete:boolean; readonly truncated:boolean; readonly issues:readonly {code:string;name?:string}[] }
interface PinnedSkillBundle { readonly handle:DiskSkillHandle; readonly instructions:string; readonly resources:readonly SkillResourceIdentity[] }
parseSkillDocument(text: string, expectedName: string): ParsedSkillDocument;
discoverSkillBundles(input: {root:SkillRootInput;signal?:AbortSignal;budget?:SkillScanBudget}): Promise<SkillDiscoveryResult>;
pinSkillBundle(input: {root:SkillRootInput;handle:DiskSkillHandle;signal?:AbortSignal;budget?:SkillScanBudget}): Promise<PinnedSkillBundle>;
readPinnedSkillResource(input: {root:SkillRootInput;bundle:PinnedSkillBundle;path:string;signal?:AbortSignal;budget?:SkillScanBudget}): Promise<{readonly text:string;readonly sha256:string}>;
```

Plugin-host exports `SkillHostError` with stable codes `skill-invalid-document`, `skill-unreadable`, `skill-unsafe-entry`, `skill-source-changed`, `skill-limit-exceeded`, `skill-unsupported-text`. Server maps these to safe wire issues. All filesystem observations in one catalog share the same scan budget object; no operation can replenish it implicitly.

Root and handles are Server-private values, never raw HTTP/model inputs. Handle
must resolve in the exact supplied root/name and revalidate complete hashes before
pinning. Resource read is confined to pinned inventory and verified hash; editing
resources after catalog or pin yields skill-source-changed. No read fallback.

Validate every path component, reject absolute/drive/UNC/backslash/dot segments,
NUL and URL-shaped input; open regular files without symlink following, verify
fstat and bounded growth reads, await close, check cancellation before publication.
Hashing metadata/body/resources is inert discovery, not model instruction loading.
Binary resource returns a clear unsupported-text error; it is never rendered,
fetched or executed. These are application checks, not an OS sandbox promise.

## 6. Plugin contribution and API1.0 compatibility

Keep `pluginApiVersion = '1.0.0'`. Add optional recognized `'skill'` capability and
`contributes.skills` governed name list. Existing1.0 plugin methods/semantics are
unchanged. New Skill plugins fail old host strict manifest validation before import;
forward compatibility with unknown optional vocabulary is not promised. Do not
bump global constant while exact equality remains, and do not loosen arbitrary
major-version matching. ADR documents additive optional capability semantics.

`packages/plugin/src/skills.ts`:

```ts
interface SkillContribution {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly invocation?: {readonly user:boolean;readonly model:boolean};
  readonly resources?: Readonly<Record<string,string>>;
}
interface AttributedSkillContribution extends SkillContribution { readonly pluginId:string }
interface SkillsExtensionApi { addSkill(skill: SkillContribution): void }
```

Public SDK author passes a SkillContribution to `skillsExtensionPoint` governed
facade; its guard validates, assigns actual pluginId, deep-copies and freezes all
resources. The structural owner API accepts SkillContribution and narrows the
guarded value using `attributedSkillContributionSchema` before collecting it as
AttributedSkillContribution. The contribution schema rejects a supplied pluginId;
the guard adds the actual owner after parsing. Never trust plugin-supplied pluginId.

Add SDK.skillsExtensionPoint, manifest required capability mapping, ContributedNameKey,
PluginContributed.skills snapshot and extension collected bookkeeping. Same owner
same-name duplicate fails assembly. Different owners remain qualified, visible.
Host derives bundle hashes itself with shared recipe. No path callback, executable
loader function or descriptor resource path supplied by a plugin becomes host
filesystem authority. Plugin developer can embed SKILL.md/body/resources into
inline declarations at build time. CLI automation belongs to later tooling topic.

## 7. Runtime preparation, tool scope and budgets

Add `AgentRunRequest.skills?: readonly SkillRef[]`. Parse/copy refs when request
is accepted so caller mutation while queued cannot alter selection. HTTP schema
strictly validates the same structure; only real user request can select refs.

Export `AgentInstructionsContext` and use in AgentRunnerOptions.instructions:
`{sessionId,turnId,permissionMode,skills:readonly SkillRef[],signal,maxToolResultTokens}`.
Instructions run once after actual queued admission and durable turn start.
`signal` is the actual combined Runner signal; Runner aborts it in finally on
success/failure/cancel. Extend ToolExecutionContext with optional turnId/toolCallId;
request with optional turnId. AgentRunner passes actual generated turnId; Pipeline
passes all IDs to summaries and execute.

`ToolAround.next` cannot replace original sessionId/turnId/toolCallId/name or
external signal. Reject identity substitution with tool-invalid-input; arguments,
permissionMode and timeout adjustment continue through existing policy/approval.
This closes cross-turn lookup through around request rewriting.

Runtime exports `createSkillTools(options: SkillToolPorts): SkillTools`,
`readSkillInputSchema`, `readSkillResourceInputSchema`, `ReadSkillInput`,
`ReadSkillResourceInput`, `SkillToolPorts`, `SkillTools`, `readSkillToolName`
('read_skill'), `readSkillResourceToolName` ('read_skill_resource').

```ts
interface ReadSkillInput {readonly skill:SkillRef;readonly cursor?:string}
interface ReadSkillResourceInput extends ReadSkillInput {readonly path:string}
interface SkillToolPorts {
  read(input:ReadSkillInput, context:ToolExecutionContext):Promise<SkillPage>;
  readResource(input:ReadSkillResourceInput, context:ToolExecutionContext):Promise<SkillPage>;
}
interface SkillTools {readonly readSkill:ToolDefinition<ReadSkillInput,SkillPage>;readonly readSkillResource:ToolDefinition<ReadSkillResourceInput,SkillPage>}
```

Tools are readOnly, with JSON-schema parameters and Zod runtime inputs. Runtime
factory is structural and imports only protocol data; no plugin/fs dependency.
Export actual default caps and estimateTokens so Server budgets the serialized
page rather than copying magic numbers. Small custom budgets reduce pages;
if framing cannot fit, return a clear scope/read-unavailable failure. Never claim
EOF or activation after hidden Pipeline/context truncation. Explicit full bodies
are system instructions and existing context overflow is preserved, not sliced.

## 8. Server generation and turn state

`assembleAgentKernel` adds host loader ToolDefinitions to existing server-tool-host,
collects immutable attributed Skill definitions after seal, and returns `skills`.
Inactive/untrusted plugin discovery never imports ESM for Skill metadata. Existing
trust + loading controls remain the only activation path.

`ServerGenerationResources` owns a `TurnSkillController` and immutable definitions.
Construct controller with initialized-once plugin definition holder before tool
assembly; initialize it after collection before publishing runner. No global
latest-generation state. Generation dispose awaits controller drain and kernel
cleanup; existing Generation pins retain old turn resources.

```ts
interface SkillCatalogService {
  catalog(sessionId:string,signal?:AbortSignal):Promise<SkillCatalog>;
  preview(sessionId:string,ref:SkillRef,signal?:AbortSignal):Promise<{skill:SkillSummary;instructions:string}>;
}
interface TurnSkillController extends SkillToolPorts {
  prepare(ctx:AgentInstructionsContext):Promise<{readonly text:string}>;
  pendingReceipt(scope:{sessionId:string;turnId:string;toolCallId:string}):SkillReadReceipt|undefined;
  commitReceipt(receipt:SkillReadReceipt,result:ToolExecutionResult):Promise<void>;
  closeSync():void;
  drain():Promise<void>;
}
```

Key turn state by controller+sessionId+turnId. At prepare resolve current Session
Project root once, compose native/agents/user disk observations + immutable builtin
and active plugin definitions, check refs exactly and user policy, pin selected
bodies/resources, check abort, record audit before returning framed catalog and
explicit instructions. Model catalog appears only for exact registered host loader
objects, not a third-party same-name tool. Tool name collision fails assembly.
Order hints project-native, project-agents, user, plugin, builtin; all entries
stay source-qualified, no implicit short-name fallback.

For GET catalog use current generation captured once; after async disk discovery,
verify generation still current or return skill-catalog-stale409. Bound retained
cache to16 session-root observations; incomplete observations are retried, not
cached as complete empty. Turn admission always refreshes disk content identities.
Selected old refs after generation/root/file changes fail stale before model.

Abort invalidates turn state synchronously; wait for actual reads/close to settle
in drain. No cursor/resource lookup after completion/cancellation. Concurrent
Sessions with same Skill name keep independent pins; queued turn resolves the
Generation selected at queue head. Disable/revoke follows existing next-turn or
immediate cancellation semantics.

## 9. Model lazy activation, cursors and required audit

Require real sessionId/turnId/toolCallId for loader access; no-context direct call
fails with recoverable scope-unavailable error. `read_skill` checks model-invocable
policy both summary and pinned definition. Explicit user-only Skills can be read
as resources after user activation but cannot be newly auto-activated by model.

Page cursor is opaque random state bound to turn/ref/content/path/next offset;
replay is deterministic and cannot select arbitrary offsets. Instruction EOF only
activates after final result passed host audit wrapper. Resources require an
activated exact bundle. Invalid/stale cursor or content returns stable safe
failure; scripts never run. At most32 activations and256 cursors per turn.

Required audit is outside isolated plugin observers and Pipeline execute catch:

1. Host read prepares exact serialized SkillPage and pending receipt keyed actual
   turn/toolCallId. It does not activate bundle yet.
2. `withSkillAuditPipeline(base,controller)` wraps the assembled Pipeline outside
   plugin around/result middleware.
3. For successful host loader calls compare final result name/id/content to the
   receipt and require `truncated:false`. Success without receipt (fabrication or
   bypass) or changed text fails closed. Policy rejection still uses ordinary
   denied flow, without applied audit.
4. Commit receipt via core SessionStore; EOF prepares content+application facts
   and activates only after append success. Intermediate pages use optional
   deduplicated read receipt or rely on durable tool result; do not claim full
   application before EOF.
5. Audit failure throws host SkillAuditError outside base Pipeline so Runner treats
   it as nonrecoverable and makes no next model call. Ordinary file/stale/missing
   resource failures remain recoverable tool errors.

Plugin around retries can replace the pending receipt only with a later exact
host execution for the same identity; final result must match last receipt. No
failed/abandoned attempt records activation. Same-tool-call receipt commits once.

`skill.applied` means content prepared and durably audited, not proof a model has
consumed it. Model application is displayed as delivered only with a matching
successful durable tool-result event. If Runner's later tool-result append fails,
the Session has preparation evidence but no successful-delivery badge. This keeps
receipt wrapper minimal without a generic post-tool Runtime audit API.

## 10. Session facts and history

Add strict core events to input + recorded union:

```ts
skill.content: {sha256:string,text:string};
skill.catalog-applied: {turnId:string,generation:number,catalog:SkillCatalog};
skill.requested: {turnId:string,userMessageId:string,skills:readonly SkillRef[]};
skill.failed: {turnId:string,skill:SkillRef,stage:'selection'|'load'|'resource',code:'skill-not-found'|'skill-source-changed'|'skill-not-invocable'|'skill-unavailable',toolCallId?:string};
skill.applied: {turnId:string,skill:SkillSummary,invocation:'user'|'model',placement:number,toolCallId?:string};
```

Append content once per Session/hash from actual log; Runtime appends requested
in the initial user-message/turn-start/step-start batch only when
`request.skills !== undefined`; Studio always sends an array, including empty
refs. Existing Runtime callers that omit skills retain their event count;
Server appends failed facts for validated requested refs rejected during selection
or model loading when persistence remains healthy; audit storage failure terminates
without pretending a failure fact could necessarily be saved. Requested does not
mean applied. Preserve requested/applied/failed independently so stale failures
remain visible after restart. The initial batch's turn.started payload adds
`userMessageId` to associate the already-written user message with that exact turn;
projector validates reference and assigns SessionMessage.turnId. Old logs without explicit userMessageId retain their previous projection; do not guess a historical user-to-turn association.
For all new turns, turn.started also records bounded optional `request` metadata
`{provider,model,temperature?,maxTokens?,reasoningEffort?,permissionMode}` (without
Signal or duplicated image bytes) so retry after restart retains original run
settings. Request Skills are in skill.requested, full images/text remain in linked
message.created. Export `TurnRequestMetadata` and `turnRequestMetadataSchema` from
`packages/protocol/src/turn-request.ts` as pure shared wire types; no Runtime
import into Session. Runtime creates metadata from the selected run request.

Record the bounded catalog actually rendered before first model;
user applied in selection order. Model applied only EOF receipt. Real pluginId
only in plugin source. Never reuse prompt.section events with fake plugin IDs.
Audit failure before model is fatal. Store text exactly hashed; schema/ref checks
reject malformed facts. Resource text already exists in durable tool result and
does not require duplicating huge body as skill.content.

Projection core advances lastSequence for Skill events without inventing messages.
Extend existing SessionTurn projection with optional `skills` shaped as
`{requested:SkillRef[],applications:[{skill:SkillSummary,invocation,placement,toolCallId?,delivery:prepared|delivered}],failures:[{skill:SkillRef,stage,code,toolCallId?}]}`.
Requested/application/failure facts remain separate. `skill.requested` also links
the exact userMessageId and fills that user message turnId. Correlate model
application delivery only with successful same-turn durable tool results; explicit
user instruction preparation remains prepared and makes no model-consumption claim.
Do not add a parallel history projector or route. Session skeleton or current-turn
detection must not see a fake user catalog message.

## 11. HTTP, Studio and product flow

Routes use existing SessionService existence/archive/delete lifecycle checks:

- GET `/sessions/:id/skills`: SkillCatalog, path-free, no plugin loading/activation.
- POST `/sessions/:id/skills/preview`: `{skill:SkillRef}` ->
  `{schemaVersion:1,skill:SkillSummary,instructions:string}`; bounded JSON,
  same JSON/loopback Host/Origin/Sec-Fetch guard (read preview uses POST to avoid
  oversized query identity and is still inert). No audit/application side effect.
- Existing agent POST adds optional `skills:SkillRef[]`, validates and forwards
  only; no host discovery behavior in handler.

Stable public Skill errors: skill-not-found404, skill-catalog-stale409,
skill-source-changed409, skill-not-invocable400, skill-invalid-input400,
skill-unavailable503, skill-audit-failed (SSE Agent failure, safe message).
Never expose local absolute paths/raw filesystem errors. Preview never grants trust.

Studio maintains per-session selected refs with App-owned draft lifetime. Add a
labeled Skills button/picker and removable chips, search with source badges,
preview instructions and incomplete/changed diagnostics. Keep commands in existing
slash picker with distinct labeling; do not overload bare slash dispatch this
slice. Send refs as structured request fields, snapshot them with that send and
clear only sent chips after accepted send; queued messages retain own refs.
Switching project/root clears incompatible picks only; switching main pages does
not lose draft. Late catalog/preview responses cannot replace current session.

Session detail adds `userMessageId`, optional bounded `request` metadata and
`skills:{requested,applications,failures}` to existing turn summaries; no dedicated
history route is required. Applications preserve `placement`, optional `toolCallId`
and `delivery:'prepared'|'delivered'`. Message DTO retains real `turnId` for user
as well as assistant.
`toChatMessages` maps that turnId onto user cards. Skill history joins by turnId,
never by visible text or latest user message. User cards show requested first,
then applied/failed after durable reconciliation; preparation is not called applied.

Refactor `submitMessage(retryText?:string)` into immutable `AgentSubmissionSnapshot`
`{sessionId,userMessage,provider,model,temperature?,maxTokens?,reasoningEffort?,permissionMode,skills}`.
New sends capture all image parts and exact refs; retries submit that full snapshot
as a new turn. After restart reconstruct it from turn.request, linked full user
message and skill.requested. Retry does not use current picker/provider/model,
does not re-expand slash templates, does not drop images, and never remaps stale
Skill refs. If historical request metadata is unavailable, disable exact retry
with a clear explanation or explicitly present editable retry settings; do not
silently fabricate original settings. New data must support exact retry.

After reload history reconstructs per-turn chips from Session facts; live chips
can use current sent snapshot until reconciliation. Model read pages use ordinary
existing tool timeline. Render text as inert text/Markdown with current sanitizer;
no Skill-provided HTML/actions/code executes in Studio.

Plugin details/market review include contributes.skills and capability labels.
Disk text Skills are not presented as installed trusted code plugins. A builtin
`weave-planning` Skill with one reference demonstrates all APIs; no claims that
third-party Skills or arbitrary scripts are fully compatible.

## 12. Verification and delivery gates

Each behavior change has package/app tests. Must cover real queued admission
Generation, mutable request snapshot, simultaneous Sessions, exact refs including
resource-only edits, all invocation policies, disabled/untrusted exclusions,
no-context reads, EOF/cursor replay, low byte+token budgets, plugin hook fabrication,
audit append failure no further model request, fs cancellation/close/symlink/growth,
all four sources, malformed YAML, incomplete roots, Session restart and history,
full-image/Skill/settings retry and exact user-message-to-turn provenance.

Keep old1.0 plugin load and prompt/command tests green. Root pnpm check plus
real loopback SSE scripted provider and Studio desktop/mobile flow. No network or
real LLM required for acceptance. New branch from latest origin/main, one Skills
PR; preserve separately integrated acquisition/marketplace topics. No commit/push
unless root's authorized workflow explicitly performs it.

## 13. Implementation rulings

`SessionTurn.skills` uses `{requested,applications,failures}` exactly. Each application carries `{skill:SkillSummary,invocation,placement,toolCallId?,delivery:'prepared'|'delivered'}`; a model application is delivered only when the same Turn has a successful, untruncated `read_skill` tool result carrying exact matching refs and EOF. User selection is labeled prepared/applied-to-instructions without claiming model consumption. UI must keep that wording distinction.

Catalog JSON is the `SkillCatalog` record directly; requests and async ownership bind the Session id at the transport/store boundary. No new turn-started SSE is necessary: durable refresh on completion/error obtains the explicit userMessageId/turnId association. Before that, optimistic user chips say selected/requested only. No message queue/insert UI is introduced.

`ToolAround.next` retains original name, sessionId, turnId, toolCallId, signal and permissionMode; arguments/timeout adjustments still pass the inner validation/policy/approval. Holding permissionMode prevents untrusted request rewriting from upgrading ask to yolo.

The initial bundled example is `weave-planning`, authored for Weave with a relative reference. A fuller official suite follows the distribution/tooling topic after these APIs are verified.

Filesystem compatibility: only exact macOS OS-owned aliases `/var`, `/tmp`, `/etc` resolving to corresponding `/private` directories are accepted before checking application path components. Arbitrary project/data ancestors and all candidate/resource symlinks remain rejected. Unknown frontmatter extensions accept only bounded strings; rich extension objects require explicit adaptation to Weave's parser subset.
