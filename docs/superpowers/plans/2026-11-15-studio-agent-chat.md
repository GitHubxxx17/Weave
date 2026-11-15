# Studio Agent Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个 React + Vite Studio 工作台，让浏览器可以真实消费 Agent HTTP/SSE 并观察文本、reasoning、工具状态、完成、错误和取消。

**Architecture:** `apps/studio` 只依赖浏览器 HTTP 契约，不导入 Runtime、Session 或 Node 模块。`agent-stream.ts` 负责 fetch、UTF-8 增量解码和 SSE 分帧，`App.tsx` 负责把规范化事件映射到本地 React 状态；Server composition root 提供固定 Mock LLM 演示脚本，确保前端开箱可验证。

**Tech Stack:** TypeScript、React、Vite、Vitest、React Testing Library、pnpm、Turborepo。

**Spec:** `docs/superpowers/specs/2026-11-15-studio-agent-chat-design.md`

## Global Constraints

- TypeScript、ESM、strict typing。
- Studio 只能通过 `fetch('/agent/runs/stream')` 访问 Server，不导入 `@weave/runtime`、`@weave/session` 或 Node-only 模块。
- SSE parser 必须支持跨 Uint8Array chunk、跨 UTF-8 字符边界和多行 `data:`。
- 服务端 SSE 事件必须按接收顺序传递给 UI；未知事件忽略，非法结构转换为前端错误。
- `AbortError` 表示用户取消，不作为系统错误展示。
- 测试放在 `apps/studio/test/`，不放在 `src/`。
- 不引入全局状态管理、路由、登录、Run Registry、重连或持久化 Session API。
- 新增依赖必须写入 `apps/studio/package.json`，并保持锁文件同步。
- 代码注释只写必要的接口和复杂边界；学习解释写入文档。
- 提交信息使用中文 Conventional Commits。
- 每个功能使用独立分支；最终通过 CI 后 squash merge 到 `main`，保留远程功能分支。

## File Map

- Create: `apps/studio/package.json`，Studio scripts 和前端依赖。
- Create: `apps/studio/index.html`，Vite HTML 入口。
- Create: `apps/studio/vite.config.ts`，开发代理和 Vitest 配置。
- Create: `apps/studio/tsconfig.json`，Studio TypeScript 配置。
- Create: `apps/studio/src/main.tsx`，React 挂载入口。
- Create: `apps/studio/src/app/App.tsx`，工作台布局和 Agent 状态组合。
- Create: `apps/studio/src/app/app.css`，桌面/窄屏布局样式。
- Create: `apps/studio/src/features/agent/agent-types.ts`，前端 Agent 请求和事件类型。
- Create: `apps/studio/src/features/agent/agent-stream.ts`，fetch、SSE parser 和取消。
- Create: `apps/studio/test/agent-stream.test.ts`，parser 和请求层测试。
- Create: `apps/studio/test/App.test.tsx`，React 用户流程测试。
- Modify: `apps/server/src/runtime.ts`，配置固定 Mock LLM 演示脚本。
- Modify: `apps/server/package.json`，增加本地 `dev` script。
- Modify: `package.json`，必要时补充 workspace 级 Studio 操作说明。
- Modify: `README.md`，补充 Studio 启动和浏览器验收流程。
- Modify: `docs/architecture/foundation.md`，记录 Studio 到 Server 的边界。
- Create: `docs/learning/2026-11-15-studio-agent-chat.md`，解释前端 SSE 消费和状态建模。
- Modify: `docs/superpowers/plans/2026-11-15-studio-agent-chat.md`，记录执行状态。

### Task 1: Scaffold the Studio package

**Files:**
- Create: `apps/studio/package.json`
- Create: `apps/studio/index.html`
- Create: `apps/studio/vite.config.ts`
- Create: `apps/studio/tsconfig.json`
- Create: `apps/studio/src/main.tsx`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Root pnpm workspace and Vite/React toolchain.
- Produces: `@weave/studio` scripts: `dev`, `build`, `lint`, `typecheck`, `test`.

- [ ] **Step 1: Add package manifests and entry files**

Create a package with no workspace runtime dependencies:

```json
{
  "name": "@weave/studio",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "lint": "eslint src test",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests --root ../.. --config vitest.config.ts"
  }
}
```

Add React/Vite dependencies and the minimum test dependencies required by the
implemented component tests. `vite.config.ts` must proxy `/agent` to
`http://127.0.0.1:4317` and expose the existing root Vitest config through the
package test script.

- [ ] **Step 2: Install dependencies and inspect the lock diff**

Run:

```bash
pnpm install
git diff --stat pnpm-lock.yaml apps/studio/package.json
```

Expected: the lock file contains only the newly declared Studio dependencies;
no existing package dependency is removed or upgraded unexpectedly.

- [ ] **Step 3: Run the empty package checks**

Run:

```bash
pnpm --filter @weave/studio typecheck
pnpm --filter @weave/studio build
pnpm --filter @weave/studio test
```

Expected: the package compiles its entry point, Vite emits a bundle, and Vitest
exits successfully with `--passWithNoTests` without loading Server or Runtime
code.

- [ ] **Step 4: Commit**

```bash
git add apps/studio pnpm-lock.yaml
git commit -m "chore: 初始化 Studio 前端应用"
```

### Task 2: Implement and test the SSE stream client

**Files:**
- Create: `apps/studio/src/features/agent/agent-types.ts`
- Create: `apps/studio/src/features/agent/agent-stream.ts`
- Create: `apps/studio/test/agent-stream.test.ts`

**Interfaces:**
- Consumes: `POST /agent/runs/stream` HTTP contract from the Agent HTTP/SSE design.
- Produces:

```ts
export type AgentRuntimeEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly toolCall: { readonly id: string; readonly name: string; readonly arguments: string };
    }
  | {
      readonly type: 'tool-executing';
      readonly toolCall: { readonly id: string; readonly name: string; readonly arguments: string };
    }
  | {
      readonly type: 'tool-result';
      readonly result: {
        readonly toolCallId: string;
        readonly name: string;
        readonly content: string;
        readonly truncated: boolean;
      };
    }
  | { readonly type: 'completed'; readonly turnId: string };

export interface AgentRunRequestInput {
  readonly sessionId: string;
  readonly userMessage: {
    readonly role: 'user';
    readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  };
  readonly provider: string;
  readonly model: string;
}

export interface AgentStreamHandlers {
  readonly onEvent: (event: AgentRuntimeEvent) => void;
}

export function streamAgentRun(
  request: AgentRunRequestInput,
  handlers: AgentStreamHandlers,
  options?: { readonly signal?: AbortSignal },
): Promise<void>;
```

- [ ] **Step 1: Write parser and request tests first**

Cover these concrete behaviors in `apps/studio/test/agent-stream.test.ts`:

```ts
it('reassembles an event split across Uint8Array chunks', async () => {
  // Mock fetch returns two chunks for one complete text-delta frame.
  // Assert onEvent receives exactly { type: 'text-delta', text: '你好' }.
});

it('supports a UTF-8 character split between chunks', async () => {
  // Split encoded bytes in the middle of a Chinese character.
  // Assert decoded event text is not corrupted.
});

it('joins multiple data lines into one JSON payload', async () => {
  // Feed data: {"type":"text-
  // and data: delta","text":"ok"}.
  // Assert parser joins with newline according to SSE rules before JSON parse.
});

it('maps a non-2xx JSON response to a safe Error', async () => {
  // Mock 400 response with { error: { code, message } }.
  // Assert promise rejects with the server message and code included.
});

it('passes an AbortSignal to fetch', async () => {
  // Call streamAgentRun with a controller.signal and assert fetch init.signal.
});

it('ignores unknown events and stops after an error event', async () => {
  // Feed unknown, error, and later text frames.
  // Assert only the error is surfaced as a thrown AgentStreamError and later
  // event is not delivered.
});
```

- [ ] **Step 2: Run focused tests and verify the expected failure**

Run:

```bash
pnpm --filter @weave/studio test -- agent-stream
```

Expected: the test file cannot import `agent-stream.ts` because the production
parser has not been implemented yet.

- [ ] **Step 3: Implement the minimal typed SSE client**

Implement:

```ts
export class AgentStreamError extends Error {
  readonly code: string;
}

export function parseSseFrame(frame: string): { readonly event: string; readonly data: string } | null;
export function parseAgentEvent(eventName: string, dataText: string): AgentRuntimeEvent | null;
```

Use `TextDecoder` with `{ stream: true }`, retain incomplete text in a buffer,
split on `\n\n`, support `\r\n`, ignore empty/comment lines, and join multiple
`data:` lines with `\n`. Validate each known event's required fields before
calling `onEvent`. Unknown event names return `null`. An SSE `error` payload
throws `AgentStreamError` with the safe server code/message. Do not include raw
response bodies or stack traces in user-facing errors.

- [ ] **Step 4: Run focused tests and refactor only after green**

Run:

```bash
pnpm --filter @weave/studio test -- agent-stream
pnpm --filter @weave/studio typecheck
pnpm --filter @weave/studio lint
```

Expected: all parser/request tests pass with no lint or TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add apps/studio/src/features/agent apps/studio/test/agent-stream.test.ts
git commit -m "feat: 增加 Studio Agent SSE 客户端"
```

### Task 3: Build the Studio Agent Chat UI

**Files:**
- Create: `apps/studio/src/app/App.tsx`
- Create: `apps/studio/src/app/app.css`
- Modify: `apps/studio/src/main.tsx`
- Create: `apps/studio/test/App.test.tsx`

**Interfaces:**
- Consumes: `streamAgentRun()` and `AgentRuntimeEvent`.
- Produces: a page with Session rail, message timeline, reasoning/tool activity
  panel, composer, send/cancel controls, and explicit run status.

- [ ] **Step 1: Write UI behavior tests first**

Cover these user-visible behaviors:

```tsx
it('submits a message and renders streamed assistant text', async () => {
  // Mock streamAgentRun invokes onEvent twice with text-delta and once with
  // completed. Fill the composer, click Send, assert both messages and final
  // assistant text are visible.
});

it('renders tool lifecycle state in order', async () => {
  // Deliver tool-call, tool-executing, and tool-result events.
  // Assert the activity shows the tool name and Completed state.
});

it('shows an error without leaking implementation details', async () => {
  // Reject with AgentStreamError('agent-step-limit', 'Agent run failed').
  // Assert safe text is visible and cause/path text is absent.
});

it('cancels an active stream and returns to idle controls', async () => {
  // Start a stream that waits for AbortSignal, click Cancel, assert abort was
  // observed and Send becomes available again.
});
```

- [ ] **Step 2: Run UI tests and verify the expected failure**

Run:

```bash
pnpm --filter @weave/studio test -- App
```

Expected: the App import or component module is missing.

- [ ] **Step 3: Implement the UI state machine**

Keep state local to `App`:

```ts
type RunStatus = 'idle' | 'streaming' | 'completed' | 'error' | 'cancelled';

type ChatMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
};

type ToolActivity = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: string;
  readonly status: 'called' | 'executing' | 'completed' | 'failed';
  readonly result?: string;
};
```

On submit, append user + empty assistant messages, create an AbortController,
and call `streamAgentRun`. Apply each event with functional React state updates.
On `text-delta`, append to the latest assistant message; on tool events, update
the matching activity by `toolCallId`; on `completed`, set status completed. On
AbortError, set cancelled without showing an error; on other errors, show the
safe message and set error. Disable duplicate submit while streaming.

Use semantic HTML and accessible labels. The first viewport should be the
working chat surface, not a marketing hero. Use lucide icons only if an icon
dependency is already present; otherwise use text labels for the clear Send and
Cancel commands.

- [ ] **Step 4: Add responsive styling and run focused tests**

Implement a restrained operational workspace layout:

- desktop: fixed 240px session rail, flexible conversation column, 300px activity rail;
- narrow screens: collapse activity rail below conversation and keep composer visible;
- use stable button/input dimensions;
- keep cards limited to individual messages and tool activities;
- avoid gradients, decorative blobs, oversized hero text, and nested cards;
- ensure long tool arguments/results wrap without horizontal overflow.

Run:

```bash
pnpm --filter @weave/studio test -- App
pnpm --filter @weave/studio typecheck
pnpm --filter @weave/studio build
```

- [ ] **Step 5: Commit**

```bash
git add apps/studio/src/app apps/studio/src/main.tsx apps/studio/test/App.test.tsx
git commit -m "feat: 增加 Studio Agent Chat 工作台"
```

### Task 4: Make the local Server demo deterministic

**Files:**
- Modify: `apps/server/src/runtime.ts`
- Modify: `apps/server/package.json`
- Modify: `apps/server/test/health.test.ts`
- Modify: `apps/server/test/agent-api.test.ts`

**Interfaces:**
- Consumes: existing `createMockLlmClient()` and `createServerAgentRunner()`.
- Produces: a local Server process whose default Agent endpoint emits a valid
  deterministic completed response.

- [ ] **Step 1: Add a failing integration test**

Add a test using `createServerRuntime()` and `createServerAgentRunner()` that
calls the App with the real default Runner and asserts the response includes:

```text
event: text-delta
data: {"type":"text-delta","text":"这是 Weave 的本地 Agent 演示。"}

event: completed
data: {"type":"completed","turnId":"turn-1"}
```

The test should read the complete response body and assert it ends with a
`completed` event rather than an `error` event.

- [ ] **Step 2: Run the integration test and verify it fails**

Run:

```bash
pnpm exec vitest run apps/server/test/agent-api.test.ts --config vitest.config.ts
```

Expected: the default empty Mock LLM script produces an Agent protocol error
instead of `completed`.

- [ ] **Step 3: Configure the fixed Mock LLM script**

Use a constant script in `apps/server/src/runtime.ts`:

```ts
const localDemoScript: readonly StreamEvent[] = [
  { type: 'text-delta', text: '这是 Weave 的本地 Agent 演示。' },
  { type: 'text-delta', text: ' 当前消息通过 SSE 增量传输。' },
  { type: 'finish', reason: 'stop' },
];
```

Keep the composition-root choice explicit. Do not modify Agent Runner logic or
create a Server-specific Agent state machine.

- [ ] **Step 4: Add the Server dev script and verify**

Add:

```json
{
  "scripts": {
    "dev": "node --experimental-strip-types src/main.ts"
  }
}
```

Node `24.4.0` is already the repository minimum and supports the development
entrypoint's type erasure. Do not add a runtime transpiler dependency only for
this local script.
Run:

```bash
pnpm --filter @weave/server test
pnpm --filter @weave/server typecheck
pnpm --filter @weave/server build
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/runtime.ts apps/server/package.json apps/server/test
git commit -m "feat: 增加 Studio 本地 Agent 演示脚本"
```

### Task 5: Synchronize docs and perform browser verification

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/foundation.md`
- Create: `docs/learning/2026-11-15-studio-agent-chat.md`
- Modify: `docs/superpowers/plans/2026-11-15-studio-agent-chat.md`

**Interfaces:**
- Consumes: implemented Studio app, Agent HTTP/SSE contract, and local demo
  startup commands.
- Produces: understandable repository learning docs and a completed
  implementation record.

- [ ] **Step 1: Write the learning document**

Explain:

- why Studio does not import Runtime;
- why `fetch` + ReadableStream is used instead of EventSource;
- how UTF-8 chunk boundaries and SSE frame boundaries differ;
- how transient event state maps to React state;
- why AbortController is part of the cross-layer cancellation chain;
- how to explain the architecture in an interview.

- [ ] **Step 2: Update README and architecture**

Document:

- `apps/studio` layout;
- `pnpm --filter @weave/server dev`;
- `pnpm --filter @weave/studio dev`;
- the Vite `/agent` proxy;
- the browser acceptance flow;
- current non-goals around persistence and reconnection.

- [ ] **Step 3: Run browser verification**

Run the Server and Studio dev servers:

```bash
pnpm --filter @weave/server dev
pnpm --filter @weave/studio dev -- --host 127.0.0.1
```

Use a browser automation tool to verify `http://127.0.0.1:5173`:

- the first viewport contains the working Studio surface;
- submitting a message shows user and assistant content;
- assistant text arrives through SSE;
- status changes to completed;
- narrow viewport does not produce horizontal overflow.

- [ ] **Step 4: Run the complete verification**

```bash
pnpm check
git diff --check
git status --short --branch
```

Expected: all workspace checks pass, including Studio lint/typecheck/test/build.

- [ ] **Step 5: Commit docs and plan record**

```bash
git add README.md docs/architecture/foundation.md \
  docs/learning/2026-11-15-studio-agent-chat.md \
  docs/superpowers/plans/2026-11-15-studio-agent-chat.md
git commit -m "docs: 补充 Studio Agent Chat 学习说明"
```

### Task 6: Publish Feishu learning material and open the PR

**Files:**
- Modify: `docs/superpowers/plans/2026-11-15-studio-agent-chat.md`

- [ ] **Step 1: Publish the Feishu learning document**

Read `/Users/mi/.codex/skills/feishu/reference/extended-markdown.md`, inspect
folder `IaaUfCD1klneledtbUycz7bLndh`, confirm the next document number, create
the next `Weave Studio Agent Chat` learning document in that folder, and fetch
it back to verify the outline.

- [ ] **Step 2: Append progress to the Feishu total plan**

Append the Studio milestone, frontend verification scope, repository commands,
and next step to `Weave 全项目计划与前端验收路线`; fetch the outline again.

- [ ] **Step 3: Run the final verification and mark the plan**

Mark implementation and documentation steps complete. Leave the PR step
unchecked until GitHub reports the PR merged.

- [ ] **Step 4: Push and create the PR**

```bash
git push -u origin HEAD:refs/heads/feat/studio-agent-chat
gh pr create \
  --repo GitHubxxx17/Weave \
  --base main \
  --head feat/studio-agent-chat \
  --title "feat: 增加 Studio Agent Chat 工作台" \
  --body "## 变更内容
- 新增 React + Vite Studio Agent Chat
- 接入 Agent HTTP/SSE
- 支持文本、reasoning、工具状态、错误和取消
- 增加本地 Mock Agent 演示和学习文档

## 验证
- pnpm check
- 浏览器验收 http://127.0.0.1:5173

## 合并方式
请使用 squash merge 合入 main，保留远程功能分支。"
gh pr merge <PR_NUMBER> --repo GitHubxxx17/Weave --auto --squash
```
