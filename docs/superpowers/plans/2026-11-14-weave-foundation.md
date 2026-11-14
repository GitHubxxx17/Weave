# Weave Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Weave 第一轮可运行、可测试、可扩展的工程基础，包括 `protocol`、`llm`、`runtime` 和最小 Hono Server。

**Architecture:** 采用垂直切片，依赖方向固定为 `protocol -> llm -> runtime -> server`。`protocol` 定义跨包契约，`llm` 隔离模型服务商差异，`runtime` 负责服务注册与生命周期，Server 只负责 Control Plane 和 Runtime 装配，不实现 Agent Loop。

**Tech Stack:** TypeScript、Node.js、ESM、pnpm workspace、Turborepo、Zod、Hono、Vitest、ESLint、Prettier。

**Spec:** `docs/superpowers/specs/2026-11-14-weave-foundation-design.md`

## Global Constraints

- TypeScript、ESM、strict typing。
- 外部输入先经过 Zod 校验。
- Provider SDK 类型不能泄露到 `protocol` 或 `runtime`。
- 依赖方向只能是 `protocol -> llm -> runtime -> server`。
- HTTP Handler 保持薄，不实现 Agent Loop。
- `StreamEvent` 是临时运行协议，不等于后续 Session 的 durable event。
- 不使用 `any`，不使用 `@ts-ignore`。
- 不在测试中访问真实 Provider，不写入真实 API Key。
- 测试放在包自己的 `test/` 目录，不放在 `src/` 下。
- 代码注释只解释设计原因、边界和容易误改的约束。
- 根级 `pnpm check` 是完成标准，必须覆盖格式检查、Lint、类型检查、测试和构建。
- 不提交或推送；当前仓库规则要求只有用户明确要求时才能执行 Git commit/push。
- 所有新增依赖使用精确版本，不使用 `^` 或 `~`；添加前用 `pnpm view <package> version` 确认可用版本。

---

## 目标文件地图

### 根目录

- Create: `package.json`，根级脚本、Node/pnpm engines 和 workspace 任务入口。
- Create: `pnpm-workspace.yaml`，声明 `apps/*` 和 `packages/*`。
- Create: `pnpm-lock.yaml`，由 `pnpm install` 生成并保持提交到仓库。
- Create: `turbo.json`，定义 `format`、`lint`、`typecheck`、`test`、`build` 任务关系。
- Create: `tsconfig.json`，共享严格 TypeScript 基础配置。
- Create: `tsconfig.build.json`，根级构建引用入口。
- Create: `eslint.config.js`，TypeScript 和内部依赖边界检查。
- Create: `prettier.config.mjs`，统一格式规则。
- Create: `vitest.config.ts`，根级测试发现和覆盖率配置。
- Modify: `README.md`，补充安装、命令、目录和第一轮架构说明。
- Modify: `AGENTS.md`，补充实际脚本、目录边界和验证规则。

### `@weave/protocol`

- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/content.ts`
- Create: `packages/protocol/src/messages.ts`
- Create: `packages/protocol/src/tools.ts`
- Create: `packages/protocol/src/llm.ts`
- Create: `packages/protocol/src/errors.ts`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/schemas.test.ts`

### `@weave/llm`

- Create: `packages/llm/package.json`
- Create: `packages/llm/tsconfig.json`
- Create: `packages/llm/src/types.ts`
- Create: `packages/llm/src/errors.ts`
- Create: `packages/llm/src/client.ts`
- Create: `packages/llm/src/sse-parser.ts`
- Create: `packages/llm/src/mock-client.ts`
- Create: `packages/llm/src/openai-compatible.ts`
- Create: `packages/llm/src/index.ts`
- Create: `packages/llm/test/sse-parser.test.ts`
- Create: `packages/llm/test/contract.test.ts`
- Create: `packages/llm/test/openai-compatible.test.ts`

### `@weave/runtime`

- Create: `packages/runtime/package.json`
- Create: `packages/runtime/tsconfig.json`
- Create: `packages/runtime/src/types.ts`
- Create: `packages/runtime/src/service-container.ts`
- Create: `packages/runtime/src/runtime.ts`
- Create: `packages/runtime/src/index.ts`
- Create: `packages/runtime/test/runtime.test.ts`

### `apps/server`

- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/runtime.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/main.ts`
- Create: `apps/server/test/health.test.ts`

---

## Task 1: 建立根级 Monorepo 和 AI 工程化工具链

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `pnpm-lock.yaml`
- Create: `turbo.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `eslint.config.js`
- Create: `prettier.config.mjs`
- Create: `vitest.config.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Produces root scripts: `format`、`format:check`、`lint`、`typecheck`、`test`、`build`、`check`。
- Produces workspace package selectors such as `pnpm --filter @weave/protocol test`.
- Produces shared TypeScript settings consumed by every package and app.

- [ ] **Step 1: 确认本地工具版本和可用依赖版本**

运行：

```bash
node --version
pnpm --version
pnpm view typescript version
pnpm view turbo version
pnpm view zod version
pnpm view hono version
pnpm view vitest version
pnpm view eslint version
pnpm view prettier version
```

记录 Node 和 pnpm 的实际版本。所有新增依赖使用命令返回的明确版本，并写入 `package.json` 时不加 `^` 或 `~`。

- [ ] **Step 2: 写根级失败验证**

先创建最小根级 `package.json` 和 `pnpm-workspace.yaml`，然后运行：

```bash
pnpm install
pnpm run check
```

预期：在包尚未创建前，任务会因为缺少 workspace 包脚本或配置而失败。失败用于确认根脚本确实会执行 workspace 检查，而不是静默跳过。

- [ ] **Step 3: 创建根级配置**

`package.json` 至少包含以下脚本：

```json
{
  "name": "weave",
  "private": true,
  "type": "module",
  "scripts": {
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "build": "turbo run build",
    "check": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  }
}
```

`pnpm-workspace.yaml` 声明：

```yaml
packages:
  - apps/*
  - packages/*
```

`turbo.json` 将 `build` 配置为依赖上游包的 `build`，将 `typecheck`、`test` 和 `lint` 配置为依赖上游包的对应任务；`format` 由根级 Prettier 统一执行，不在每个包重复定义格式逻辑。

共享 `tsconfig.json` 必须启用：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noEmit": true,
    "skipLibCheck": true
  }
}
```

ESLint 必须包含 TypeScript parser、推荐规则和禁止跨层内部依赖的规则入口。即使第一版只检查 package import，也要把边界规则写成可扩展配置，并在配置中说明规则目的。

Prettier 固定 `singleQuote: true`、`semi: true`、`trailingComma: 'all'`、`printWidth: 100`。

- [ ] **Step 4: 让根脚本在空包状态下可以执行**

运行：

```bash
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

如果 workspace 尚无可运行包，根脚本应返回清晰结果，不应因为 Turbo 找不到任务而输出误导性的成功。此时允许 `typecheck`、`test` 或 `build` 显示“没有匹配任务”，但最终在 Task 2 后必须变成真实验证。

- [ ] **Step 5: 更新学习入口文档**

在 `README.md` 增加：

- Node、pnpm 安装前提
- `pnpm install`
- `pnpm check`
- 第一轮目录图
- `protocol`、`llm`、`runtime`、`server` 各自职责
- “为什么 Server 不包含 Agent Loop”的一句话解释

在 `AGENTS.md` 增加：

- 根级命令对应的验证意义
- 测试目录约定
- package 依赖方向
- 任何跨包变更先更新设计文档

- [ ] **Step 6: 验证**

运行：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

预期：根配置可被解析，格式检查通过；没有引入真实密钥或忽略锁文件。

## Task 2: 实现 `@weave/protocol` 公共契约

**Files:**

- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/content.ts`
- Create: `packages/protocol/src/messages.ts`
- Create: `packages/protocol/src/tools.ts`
- Create: `packages/protocol/src/llm.ts`
- Create: `packages/protocol/src/errors.ts`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/schemas.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: root TypeScript and Vitest configuration.
- Produces: `@weave/protocol` exports `ContentPart`, `Message`, `ToolCall`, `ToolDefinition`, `LlmRequest`, `StreamEvent`, `TokenUsage`, `LlmError`, and their Zod schemas.

- [ ] **Step 1: 写 schema 失败测试**

在 `packages/protocol/test/schemas.test.ts` 覆盖以下行为：

```ts
import { describe, expect, it } from 'vitest';
import {
  contentPartSchema,
  llmRequestSchema,
  messageSchema,
  tokenUsageSchema,
  toolCallSchema,
} from '../src/index.js';

describe('protocol schemas', () => {
  it('accepts a text user message', () => {
    expect(
      messageSchema.parse({
        role: 'user',
        content: [{ type: 'text', text: '分析项目' }],
      }),
    ).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '分析项目' }],
    });
  });

  it('rejects an unknown message role', () => {
    expect(() =>
      messageSchema.parse({
        role: 'developer',
        content: [{ type: 'text', text: 'invalid' }],
      }),
    ).toThrow();
  });

  it('keeps tool arguments as a string', () => {
    expect(
      toolCallSchema.parse({
        id: 'call-1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      }).arguments,
    ).toBe('{"path":"README.md"}');
  });

  it('rejects negative usage values', () => {
    expect(() => tokenUsageSchema.parse({ inputTokens: -1 })).toThrow();
  });

  it('requires model and messages in an LLM request', () => {
    expect(() => llmRequestSchema.parse({ provider: 'mock' })).toThrow();
  });
});
```

运行：

```bash
pnpm --filter @weave/protocol test
```

预期：FAIL，因为 schema 和导出尚不存在。

- [ ] **Step 2: 定义内容、消息和工具类型**

在 `content.ts` 定义：

```ts
export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string };
```

在 `messages.ts` 定义 `SystemMessage`、`UserMessage`、`AssistantMessage`、`ToolMessage` 和联合类型 `Message`。`AssistantMessage.toolCalls` 为可选只读数组，`ToolMessage` 必须包含 `toolCallId`。

在 `tools.ts` 定义：

```ts
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}
```

`ToolDefinition.parameters` 在第一轮代表可序列化的 JSON Schema 数据，运行时不把它当作已校验的工具参数。

- [ ] **Step 3: 定义 LLM 和错误类型**

在 `llm.ts` 定义：

```ts
export type FinishReason = 'stop' | 'tool-call' | 'length' | 'content-filter' | 'unknown';

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export interface LlmRequest {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDefinition[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly reasoningEffort?: string;
}

export type StreamEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | { readonly type: 'tool-call-start'; readonly id: string; readonly name: string }
  | { readonly type: 'tool-call-delta'; readonly id: string; readonly argumentsDelta: string }
  | { readonly type: 'finish'; readonly reason: FinishReason; readonly usage?: TokenUsage }
```

在 `errors.ts` 定义 `LlmErrorCode` 和 `LlmError`，错误码必须与设计文档一致，`retryable` 为必填布尔值。

- [ ] **Step 4: 实现 Zod schemas**

为所有跨边界输入提供 schema：

- `contentPartSchema`
- `messageSchema`
- `toolCallSchema`
- `toolDefinitionSchema`
- `llmRequestSchema`
- `tokenUsageSchema`
- `llmErrorSchema`
- `streamEventSchema`

数字 token 字段使用非负安全整数。请求中的温度和 token 上限使用非负有限数值；schema 不负责判断具体 Provider 是否支持某字段。

使用 `z.discriminatedUnion` 处理 `role` 和 `type`。对不影响核心语义的额外字段采用明确策略：协议入口使用 `z.object(...).passthrough()` 保留诊断字段，但核心代码只能读取已定义字段。

- [ ] **Step 5: 导出公共 API**

`src/index.ts` 只重新导出公共类型和 schema，不导出内部辅助函数。包的 `exports` 必须提供：

```json
{
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  }
}
```

- [ ] **Step 6: 运行测试和类型检查**

运行：

```bash
pnpm --filter @weave/protocol test
pnpm --filter @weave/protocol typecheck
pnpm --filter @weave/protocol build
```

预期：全部通过，且 `dist/index.d.ts` 不包含 Provider SDK 类型。

## Task 3: 实现可测试的 SSE Parser

**Files:**

- Create: `packages/llm/package.json`
- Create: `packages/llm/tsconfig.json`
- Create: `packages/llm/src/sse-parser.ts`
- Create: `packages/llm/test/sse-parser.test.ts`
- Create: `packages/llm/src/types.ts`
- Create: `packages/llm/src/index.ts`

**Interfaces:**

- Consumes: `@weave/protocol` 的 `StreamEvent` 相关类型。
- Produces:

```ts
export interface SseParserState {
  readonly buffer: string;
}

export interface ParsedSseFrame {
  readonly data: string;
}

export function createSseParserState(): SseParserState;

export function pushSseChunk(
  state: SseParserState,
  chunk: string,
): {
  readonly state: SseParserState;
  readonly frames: readonly ParsedSseFrame[];
};

export function flushSseParser(state: SseParserState): {
  readonly state: SseParserState;
  readonly frames: readonly ParsedSseFrame[];
};
```

- [ ] **Step 1: 写分片解析失败测试**

覆盖：

```ts
it('parses one complete data frame', () => {
  const result = pushSseChunk(
    createSseParserState(),
    'data: {"value":1}\\n\\n',
  );
  expect(result.frames).toEqual([{ data: '{"value":1}' }]);
  expect(result.state.buffer).toBe('');
});

it('keeps an incomplete frame in the buffer', () => {
  const first = pushSseChunk(createSseParserState(), 'data: {"value":');
  const second = pushSseChunk(first.state, '1}\\n\\n');
  expect(first.frames).toEqual([]);
  expect(second.frames).toEqual([{ data: '{"value":1}' }]);
});

it('parses multiple frames from one chunk', () => {
  const result = pushSseChunk(
    createSseParserState(),
    'data: first\\n\\ndata: second\\n\\n',
  );
  expect(result.frames).toEqual([{ data: 'first' }, { data: 'second' }]);
});

it('supports CRLF and ignores comment lines', () => {
  const result = pushSseChunk(
    createSseParserState(),
    ': keep-alive\\r\\ndata: value\\r\\n\\r\\n',
  );
  expect(result.frames).toEqual([{ data: 'value' }]);
});

it('flushes a final frame without a trailing blank line', () => {
  const result = flushSseParser({
    buffer: 'data: final',
  });
  expect(result.frames).toEqual([{ data: 'final' }]);
  expect(result.state.buffer).toBe('');
});
```

运行：

```bash
pnpm --filter @weave/llm test -- sse-parser
```

预期：FAIL，因为 parser 尚未实现。

- [ ] **Step 2: 实现纯函数 parser**

`pushSseChunk` 只负责 SSE framing，不解析 JSON：

1. 把 `chunk` 追加到 `state.buffer`
2. 同时识别 `\n\n` 和 `\r\n\r\n` 事件边界
3. 取出完整 frame
4. 过滤空行和以 `:` 开头的注释行
5. 合并同一 frame 中的多个 `data:` 行，用 `\n` 连接
6. 对没有 `data:` 的 frame 不产出事件
7. 保留不完整 frame 到下一次调用

不要在 parser 中调用 `JSON.parse`，也不要把 `[DONE]` 转换成 `finish`；这些属于 Provider 适配层。

- [ ] **Step 3: 实现 UTF-8 解码边界**

在 `types.ts` 或 `sse-parser.ts` 提供一个小型 `decodeSseChunks` 辅助函数时，使用 `TextDecoder.decode(chunk, { stream: true })`，不要把每个 `Uint8Array` 独立解码，避免多字节字符被 chunk 边界拆开后损坏。

如果该辅助函数不需要公开，则保持为 `llm` 包内部实现，不添加第二套公共流协议。

- [ ] **Step 4: 验证**

运行：

```bash
pnpm --filter @weave/llm test -- sse-parser
pnpm --filter @weave/llm typecheck
pnpm --filter @weave/llm build
```

预期：所有分片、CRLF、注释行和 flush 测试通过。

## Task 4: 实现 LLM 公共接口、错误分类和 Mock Provider

**Files:**

- Modify: `packages/llm/src/types.ts`
- Create: `packages/llm/src/client.ts`
- Create: `packages/llm/src/errors.ts`
- Create: `packages/llm/src/mock-client.ts`
- Modify: `packages/llm/src/index.ts`
- Create: `packages/llm/test/contract.test.ts`

**Interfaces:**

- Consumes: `LlmRequest` 和 `StreamEvent` from `@weave/protocol`。
- Produces:

```ts
export interface LlmClient {
  stream(
    request: LlmRequest,
    options?: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    },
  ): AsyncIterable<StreamEvent>;
}

export function createMockLlmClient(
  script: readonly StreamEvent[],
  options?: {
    readonly delayMs?: number;
  },
): LlmClient;

export function createLlmError(
  input: Omit<LlmError, 'retryable'> & { readonly retryable?: boolean },
): LlmError;
```

- [ ] **Step 1: 写 Mock Provider 和错误分类失败测试**

测试：

```ts
it('replays deterministic events in order', async () => {
  const client = createMockLlmClient([
    { type: 'text-delta', text: '分析' },
    { type: 'text-delta', text: '完成' },
    { type: 'finish', reason: 'stop' },
  ]);

  const events = [];
  for await (const event of client.stream({
    provider: 'mock',
    model: 'test-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: '开始' }] }],
  })) {
    events.push(event);
  }

  expect(events).toEqual([
    { type: 'text-delta', text: '分析' },
    { type: 'text-delta', text: '完成' },
    { type: 'finish', reason: 'stop' },
  ]);
});

it('stops emitting after AbortSignal is aborted', async () => {
  const controller = new AbortController();
  const client = createMockLlmClient([
    { type: 'text-delta', text: 'first' },
    { type: 'text-delta', text: 'second' },
  ]);

  const iterator = client.stream(
    {
      provider: 'mock',
      model: 'test-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: '开始' }] }],
    },
    { signal: controller.signal },
  )[Symbol.asyncIterator]();

  expect((await iterator.next()).value).toEqual({
    type: 'text-delta',
    text: 'first',
  });
  controller.abort();
  await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
});
```

同时测试 `createLlmError` 的默认 retryable 映射：

- `authentication`、`invalid-request`、`context-overflow`、`cancelled` 为 `false`
- `rate-limit`、`timeout`、`network` 为 `true`
- `provider` 和 `protocol` 必须由调用方明确传入或使用保守默认值 `false`

- [ ] **Step 2: 定义 Provider 无关的 `LlmClient`**

`client.ts` 只导出接口和与 AsyncIterable 相关的公共辅助类型，不导入 Hono、Provider SDK 或 Node 专属 API。

请求进入 `stream` 前调用 `llmRequestSchema.parse` 或在 Provider 边界执行等价校验，不能直接把未知对象交给网络层。

- [ ] **Step 3: 实现 Mock Provider**

Mock Provider 的行为：

1. 接受只读事件数组
2. 每次迭代按原顺序返回一个事件
3. 如果收到 `signal.aborted`，立即抛出 `DOMException('The operation was aborted', 'AbortError')` 或等价的 `AbortError`
4. `delayMs` 存在时使用可取消的 Promise 延迟
5. 不访问网络、不读取环境变量、不写文件

不要在 Mock Provider 中自动补 `finish` 事件；脚本是什么就返回什么，这样测试可以覆盖不完整流。

- [ ] **Step 4: 实现错误工厂**

`errors.ts` 提供：

```ts
export function createLlmError(
  input: Omit<LlmError, 'retryable'> & { readonly retryable?: boolean },
): LlmError;
```

错误消息只能包含经过清理的诊断文本，不接收 Authorization Header 或 API Key。若调用方没有提供 `retryable`，根据错误码使用固定映射。

- [ ] **Step 5: 验证**

运行：

```bash
pnpm --filter @weave/llm test -- contract
pnpm --filter @weave/llm typecheck
pnpm --filter @weave/llm build
```

预期：Mock Provider 顺序、取消和错误分类测试通过。

## Task 5: 实现 OpenAI-compatible Provider Adapter

**Files:**

- Modify: `packages/llm/package.json`
- Create: `packages/llm/src/openai-compatible.ts`
- Create: `packages/llm/test/openai-compatible.test.ts`
- Modify: `packages/llm/src/index.ts`

**Interfaces:**

- Consumes: `LlmClient`、`LlmRequest`、`StreamEvent`、`SseParserState`。
- Produces:

```ts
export interface OpenAiCompatibleClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly defaultTimeoutMs?: number;
}

export function createOpenAiCompatibleClient(
  options: OpenAiCompatibleClientOptions,
): LlmClient;
```

- [ ] **Step 1: 写注入 fetch 的失败测试**

使用假的 `fetch`，不访问真实网络。测试请求：

```ts
it('maps text streaming response into Weave events', async () => {
  const request: LlmRequest = {
    provider: 'openai-compatible',
    model: 'test-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  };
  const fetchMock = vi.fn<typeof fetch>(async () =>
    new Response(
      [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        '',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
        '',
        'data: [DONE]',
        '',
      ].join('\\n'),
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    ),
  );

  const client = createOpenAiCompatibleClient({
    baseUrl: 'https://provider.test/v1',
    apiKey: 'secret-for-test-only',
    fetch: fetchMock,
  });

  const events = [];
  for await (const event of client.stream(request)) {
    events.push(event);
  }

  expect(events).toEqual([
    { type: 'text-delta', text: 'Hello' },
    {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    },
  ]);
});
```

另外先写：

- 请求 method 必须是 `POST`
- URL 正确拼接为 `${baseUrl}/chat/completions`，避免重复 `/`
- Authorization Header 为 `Bearer <apiKey>`
- 请求体使用 Weave 消息转换结果
- 401 映射为 `authentication`
- 429 映射为 `rate-limit`
- 500 映射为可重试的 `provider`
- AbortSignal 传递到 fetch
- timeout 会触发 abort
- 响应 JSON 非法时映射为 `protocol`

运行：

```bash
pnpm --filter @weave/llm test -- openai-compatible
```

预期：FAIL，因为适配器尚未实现。

- [ ] **Step 2: 定义请求转换**

在 Provider 文件内部定义 provider 请求结构，不把它导出为 Weave 公共类型：

```ts
function toProviderRequest(request: LlmRequest): Record<string, unknown>;
```

转换规则：

- `provider` 不发送给 provider，作为 Weave 路由信息
- `model`、`messages`、`tools`、`temperature`、`max_tokens`、`reasoning_effort` 按存在性发送
- ContentPart 仅把 `text` 和 `reasoning` 转换为 provider 能接受的文本形式
- 工具定义的 `parameters` 作为 JSON Schema 透传，但不把工具参数当成已执行数据

- [ ] **Step 3: 实现 HTTP 和 timeout 边界**

实现 `stream`：

1. 校验 `LlmRequest`
2. 创建内部 `AbortController`
3. 将外部 `signal` 的 abort 转发到内部 controller
4. 创建 timeout timer
5. 调用注入的 `fetch`
6. 请求失败时读取有限长度的诊断文本，不记录 API Key
7. 非 2xx 响应转换为稳定 `LlmError`
8. 检查 `response.body` 存在
9. 用 `TextDecoder` 和 SSE Parser 逐帧处理 body
10. `data: [DONE]` 结束迭代
11. `finally` 清理 timer 和 abort listener

不要自动重试。重试属于 Agent/Runtime 策略，不属于单次 Provider 调用。

- [ ] **Step 4: 实现 Provider chunk 解析**

内部使用 Zod schema 校验每个 JSON frame，至少支持：

```text
choices[0].delta.content
choices[0].delta.reasoning_content
choices[0].delta.tool_calls[].id
choices[0].delta.tool_calls[].function.name
choices[0].delta.tool_calls[].function.arguments
choices[0].finish_reason
usage.prompt_tokens
usage.completion_tokens
usage.total_tokens
```

输出规则：

- `content` -> `text-delta`
- `reasoning_content` -> `reasoning-delta`
- 新工具调用 id/name -> `tool-call-start`
- 工具参数分片 -> `tool-call-delta`
- `finish_reason` -> `finish`
- usage 字段存在时转换为 `TokenUsage`
- provider JSON 校验失败 -> 抛出 `protocol` 错误

未知字段不改变已支持字段的解析行为。

- [ ] **Step 5: 验证**

运行：

```bash
pnpm --filter @weave/llm test -- openai-compatible
pnpm --filter @weave/llm test
pnpm --filter @weave/llm typecheck
pnpm --filter @weave/llm build
```

预期：适配器在完全离线的 fake fetch 测试中通过；测试输出不包含 API Key。

## Task 6: 实现 `@weave/runtime` 生命周期和服务容器

**Files:**

- Create: `packages/runtime/package.json`
- Create: `packages/runtime/tsconfig.json`
- Create: `packages/runtime/src/types.ts`
- Create: `packages/runtime/src/service-container.ts`
- Create: `packages/runtime/src/runtime.ts`
- Create: `packages/runtime/src/index.ts`
- Create: `packages/runtime/test/runtime.test.ts`

**Interfaces:**

- Consumes: `@weave/protocol` 和 `@weave/llm`。
- Produces:

```ts
export type RuntimeStatus = 'created' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface RuntimeContext {
  readonly signal: AbortSignal;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface RuntimeService<T> {
  readonly key: symbol;
  readonly create: (context: RuntimeContext) => T | Promise<T>;
  readonly dispose?: (value: T) => void | Promise<void>;
}

export interface Runtime {
  readonly status: RuntimeStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  get<T>(service: RuntimeService<T>): T;
}

export function createRuntime(options?: {
  readonly config?: Readonly<Record<string, unknown>>;
  readonly services?: readonly RuntimeService<unknown>[];
}): Runtime;
```

- [ ] **Step 1: 写生命周期失败测试**

测试：

```ts
it('starts services in declaration order and disposes them in reverse order', async () => {
  const calls: string[] = [];
  const first = {
    key: Symbol('first'),
    create: () => {
      calls.push('create:first');
      return 'first';
    },
    dispose: () => {
      calls.push('dispose:first');
    },
  };
  const second = {
    key: Symbol('second'),
    create: () => {
      calls.push('create:second');
      return 'second';
    },
    dispose: () => {
      calls.push('dispose:second');
    },
  };

  const runtime = createRuntime({ services: [first, second] });
  await runtime.start();
  expect(runtime.status).toBe('running');
  expect(runtime.get(first)).toBe('first');

  await runtime.stop();
  expect(runtime.status).toBe('stopped');
  expect(calls).toEqual([
    'create:first',
    'create:second',
    'dispose:second',
    'dispose:first',
  ]);
});

it('does not expose services before start or after stop', async () => {
  const service = {
    key: Symbol('service'),
    create: () => 'value',
  };
  const runtime = createRuntime({ services: [service] });

  expect(() => runtime.get(service)).toThrow();
  await runtime.start();
  expect(runtime.get(service)).toBe('value');
  await runtime.stop();
  expect(() => runtime.get(service)).toThrow();
});
```

另测：

- 重复 `start()` 的行为明确为幂等或结构化错误；本计划采用幂等
- 重复 `stop()` 为幂等
- 服务创建失败时 Runtime 不进入 `running`
- 已创建服务在启动失败时按逆序释放
- 服务 key 未注册时 `get` 抛出稳定错误

- [ ] **Step 2: 实现类型和容器**

`service-container.ts` 只管理已创建实例：

```ts
class ServiceContainer {
  set<T>(service: RuntimeService<T>, value: T): void;
  get<T>(service: RuntimeService<T>): T;
  has<T>(service: RuntimeService<T>): boolean;
  clear(): void;
}
```

不要使用全局 Map。容器属于某个 Runtime 实例，保证测试和未来多 Runtime/Crew 场景互不污染。

- [ ] **Step 3: 实现 Runtime 状态机**

`runtime.ts` 实现：

1. 初始状态 `created`
2. `start()` 将状态设为 `starting`
3. 按声明顺序创建服务
4. 全部成功后状态为 `running`
5. 任意创建失败时逆序 dispose 已成功创建的服务，状态回到 `stopped`
6. `stop()` 将状态设为 `stopping`
7. 逆序释放所有服务
8. 结束状态为 `stopped`
9. stop 后拒绝再次 start，避免复用已关闭 Runtime

每个 Runtime 创建一个 `AbortController`，stop 时 abort，使未来 Agent、LLM 和工具可以共享生命周期取消信号。

- [ ] **Step 4: 验证**

运行：

```bash
pnpm --filter @weave/runtime test
pnpm --filter @weave/runtime typecheck
pnpm --filter @weave/runtime build
```

预期：生命周期、逆序释放、失败清理和服务访问边界测试通过。

## Task 7: 装配最小 Hono Server 和 `/health`

**Files:**

- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/runtime.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/main.ts`
- Create: `apps/server/test/health.test.ts`

**Interfaces:**

- Consumes: `@weave/protocol`、`@weave/llm`、`@weave/runtime`。
- Produces:

```ts
export function createApp(runtime: Runtime): Hono;
export function createServerRuntime(): Runtime;
```

- [ ] **Step 1: 写 `/health` 失败测试**

测试不监听真实端口：

```ts
it('returns running runtime health', async () => {
  const runtime = createRuntime();
  await runtime.start();

  const response = await createApp(runtime).request('/health');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: 'ok',
    runtime: 'running',
  });

  await runtime.stop();
});

it('returns an unavailable response before runtime starts', async () => {
  const runtime = createRuntime();
  const response = await createApp(runtime).request('/health');

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    status: 'unavailable',
    runtime: 'created',
  });
});
```

运行：

```bash
pnpm --filter @weave/server test
```

预期：FAIL，因为 app 和 runtime 装配尚不存在。

- [ ] **Step 2: 实现 Server Runtime 装配**

`src/runtime.ts` 创建 Runtime 并注册一个 Mock LLM 服务，服务 key 在 server 包内定义，但服务实例由 `@weave/llm` 的 `createMockLlmClient` 提供。

不要从环境变量读取真实 API Key。第一轮 server 默认只使用 Mock Provider；真实 Provider 由后续配置层显式注入。

- [ ] **Step 3: 实现 `createApp(runtime)`**

`src/app.ts`：

1. 接收已创建的 Runtime
2. 注册 `GET /health`
3. 根据 `runtime.status` 返回 200 或 503
4. 响应只包含公开状态，不返回服务实例、配置、错误堆栈或密钥
5. 不在路由中调用模型、不执行工具、不写数据库

状态响应使用固定 schema，避免 UI 或监控依赖自由文本。

- [ ] **Step 4: 实现 Node 入口**

`src/main.ts` 使用 `@hono/node-server` 的 `serve` 启动本地 HTTP Server：

- 默认绑定 `127.0.0.1`
- 启动前创建并启动 Runtime
- 进程退出时停止 Runtime
- 端口从显式配置读取，默认使用 `4317`
- 不把 API Key 写入启动日志

只有 `main.ts` 可以调用 `serve`；测试和其他包只依赖 `createApp`。

- [ ] **Step 5: 验证**

运行：

```bash
pnpm --filter @weave/server test
pnpm --filter @weave/server typecheck
pnpm --filter @weave/server build
```

预期：`/health` 测试通过，Server 包不包含 Agent Loop 或工具执行逻辑。

## Task 8: 完成跨包边界检查、文档和全量验证

**Files:**

- Modify: `eslint.config.js`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Create: `docs/architecture/foundation.md`
- Create: `docs/adr/0001-foundation-vertical-slice.md`

**Interfaces:**

- Consumes: 完成的四个 workspace 单元。
- Produces: 可供 AI 和新开发者阅读的实际工程说明，以及根级 `pnpm check` 完整通过。

- [ ] **Step 1: 写跨包依赖失败验证**

先使用静态扫描验证当前允许关系：

```bash
rg -n "from ['\"](@weave/|apps/)" packages apps
```

预期只出现：

```text
llm -> @weave/protocol
runtime -> @weave/protocol / @weave/llm
server -> @weave/protocol / @weave/llm / @weave/runtime
```

同时确认：

```bash
rg -n "from ['\"].*(hono|react|@hono/node-server)" packages/protocol packages/llm packages/runtime
```

预期没有输出；`runtime` 不得导入 HTTP 框架。

- [ ] **Step 2: 加入 ESLint 依赖边界规则**

配置规则拒绝：

- `protocol` 导入 `llm`、`runtime`、`server`
- `llm` 导入 `apps/server`
- `runtime` 导入 Hono、React 或 Node HTTP Server
- `packages` 使用相对路径跨包访问其他包源码

允许通过 package name 导入已声明的 workspace dependency。规则失败时给出包边界和修复方向，而不是只输出无上下文的路径错误。

- [ ] **Step 3: 写架构学习文档**

`docs/architecture/foundation.md` 说明：

- 从请求到 `/health` 的完整路径
- 为什么 `protocol` 不执行行为
- 为什么 Provider 类型停留在 `llm`
- 为什么 Runtime 不依赖 HTTP
- 为什么第一轮使用 Mock Provider
- 为什么 Server 默认绑定 `127.0.0.1`
- 为什么没有在第一轮实现 `/run`
- AI 修改代码前应该检查哪些文件
- 面试中如何解释四层依赖方向

文档需要使用简洁示例和流程图，不把生产代码中的注释写成长篇教程。

- [ ] **Step 4: 写 ADR**

`docs/adr/0001-foundation-vertical-slice.md` 记录：

- 背景：Orbit 原型边界围绕 Run，Weave 需要重新拆分
- 决策：先实现 `protocol -> llm -> runtime -> server`
- 备选：完整空包结构、单包原型
- 后果：第一轮功能少，但边界和测试稳定
- 后续：Agent Loop、Session、Tool Pipeline 在此基础上扩展

- [ ] **Step 5: 执行全量验证**

按顺序运行：

```bash
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
git diff --check
git status --short --branch
```

预期：

- `pnpm check` 退出码为 0
- 所有 package tests 通过
- 所有 package build 通过
- 工作区只包含本轮文档、配置和代码变更
- 没有 API Key、`.env`、构建产物或 `node_modules` 被纳入 Git

- [ ] **Step 6: 形成实现报告**

报告必须包含：

- 实际创建的包和应用
- 每个包的公开接口
- 测试数量和命令结果
- 依赖方向验证结果
- 未实现的下一阶段能力
- 可供用户阅读的文档入口

当前仓库规则不允许自动 commit/push，因此完成报告后停在干净的工作区检查，不创建 Git 提交。

---

## 计划自检

### Spec 覆盖

- 工程基础：Task 1
- `@weave/protocol`：Task 2
- SSE Parser：Task 3
- LLM 接口、错误和 Mock Provider：Task 4
- OpenAI-compatible Provider：Task 5
- Runtime 生命周期：Task 6
- Hono Server：Task 7
- AI 工程化、依赖边界、文档和全量验证：Task 8

### 类型一致性

- Task 2 输出 `LlmRequest`、`StreamEvent`、`LlmError`，Task 4 和 Task 5 使用这些类型。
- Task 3 输出 `SseParserState`、`ParsedSseFrame`，Task 5 使用 parser 处理 Provider stream。
- Task 4 输出 `LlmClient`，Task 5 的 OpenAI-compatible Client 和 Task 7 的 Mock Provider 都实现该接口。
- Task 6 输出 `Runtime`、`RuntimeService` 和 `RuntimeStatus`，Task 7 的 app 只依赖这些公开类型。
- Task 7 输出 `createApp(runtime)`，Task 8 只做跨包验证，不改变 Server 契约。

### 占位检查

本计划没有留下未完成实现的占位步骤。所有未来能力都明确标记为后续阶段，而不是当前任务的未完成步骤。

### 风险和控制

- Provider API 差异：限制在 Task 5 的 adapter 文件和 fake fetch 测试内。
- 生命周期清理错误：Task 6 用逆序 dispose 和失败清理测试覆盖。
- 依赖循环：Task 1 固定 workspace 规则，Task 8 增加静态和 ESLint 边界检查。
- AI 误改边界：`AGENTS.md`、ADR 和 `docs/architecture/foundation.md` 同步记录原因。
- 网络不稳定：所有测试使用 Mock Provider 或 fake fetch，不依赖外部服务。
