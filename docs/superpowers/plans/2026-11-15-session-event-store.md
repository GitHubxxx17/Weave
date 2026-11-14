# Session Event Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Weave 增加一个可测试、可持久化、可恢复的 `@weave/session` Event Store 和 Session Projection。

**Architecture:** `@weave/session` 依赖 `@weave/protocol`，通过 `SessionEventStore` 接口隔离 In-Memory 和 SQLite 实现。Store 只负责 append-only 事件的校验、序列号、事务和读取；Projection 通过纯函数从事件日志恢复 Session 状态，不依赖 Runtime、HTTP 或数据库。

**Tech Stack:** TypeScript、ESM、Node.js 24.4 `node:sqlite`、Zod、Vitest、pnpm workspace、Turborepo。

**Spec:** `docs/superpowers/specs/2026-11-15-session-event-store-design.md`

## Global Constraints

- TypeScript、ESM、strict typing。
- 外部输入先经过 Zod。
- durable Session Event 只允许 append，不提供 update/delete。
- `StreamEvent` 是临时 LLM 传输事件，不作为 Session durable event。
- `@weave/session` 只能依赖 `@weave/protocol`、Zod、Node 类型声明和 Node 内置模块。
- Runtime、Hono、React、Provider SDK 不得进入 `@weave/session`。
- 测试放在 `packages/session/test/`，不放在 `src/`。
- 不使用 `any` 或 `@ts-ignore`。
- 不增加数据库依赖，使用 Node.js 24.4 的 `node:sqlite`。
- 每个行为先写失败测试，再实现最小代码。
- 不提交或推送，除非用户明确要求或当前任务流程明确要求。

## 目标文件地图

### Package Boundary

- Modify: `eslint.config.js`
  - 增加 `@weave/session` workspace package；
  - 允许 `@weave/session -> @weave/protocol`；
  - 允许未来 `@weave/runtime -> @weave/session`。
- Modify: `pnpm-lock.yaml`
  - 由 workspace package 变化自动更新，不添加外部数据库依赖。

### `@weave/session`

- Create: `packages/session/package.json`
- Create: `packages/session/tsconfig.json`
- Create: `packages/session/src/events.ts`
- Create: `packages/session/src/store.ts`
- Create: `packages/session/src/memory-store.ts`
- Create: `packages/session/src/sqlite-store.ts`
- Create: `packages/session/src/projection.ts`
- Create: `packages/session/src/index.ts`
- Create: `packages/session/test/schemas.test.ts`
- Create: `packages/session/test/memory-store.test.ts`
- Create: `packages/session/test/sqlite-store.test.ts`
- Create: `packages/session/test/projection.test.ts`

### Documentation

- Create: `docs/superpowers/specs/2026-11-15-session-event-store-design.md`
- Create: `docs/superpowers/plans/2026-11-15-session-event-store.md`
- Modify: `README.md`
  - 增加 `@weave/session` 职责、事件溯源和 Session Store 测试命令。
- Modify: `docs/architecture/foundation.md`
  - 增加 Session 包位于基础层和 Runtime 之下的边界说明；
  - 明确 `StreamEvent` 与 durable Session Event 不同。

## Task 1: 建立 Package Boundary 和 Session 包骨架

**Files:**

- Modify: `eslint.config.js`
- Create: `packages/session/package.json`
- Create: `packages/session/tsconfig.json`
- Create: `packages/session/src/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces package name `@weave/session`；
- Produces package scripts `build`、`lint`、`test`、`typecheck`；
- Produces an empty public entry point that can be imported after later exports are added。

- [ ] **Step 1: 写包边界失败验证**

在 `packages/session/package.json` 和 `eslint.config.js` 尚不存在 Session 配置时，
先创建最小测试入口，然后运行：

```bash
pnpm --filter @weave/session typecheck
```

预期：FAIL，因为 workspace package 尚未注册。

- [ ] **Step 2: 创建最小 package manifest**

`packages/session/package.json` 使用：

```json
{
  "name": "@weave/session",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src test",
    "test": "vitest run --root ../.. --config vitest.config.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@weave/protocol": "workspace:*"
  }
}
```

`tsconfig.json` 继承根配置，打开声明输出，`rootDir` 为 `src`，只包含 `src/**/*.ts`。

- [ ] **Step 3: 扩展 ESLint 层级**

在 `workspacePackageNames` 中增加 `@weave/session`，并增加：

```js
[
  '@weave/session',
  {
    allowedDependencies: ['@weave/protocol'],
    layer: 'session',
  },
]
```

同时把 `@weave/session` 加入 `@weave/runtime` 的允许依赖列表。不要把
`@weave/session` 加入 `@weave/protocol`、`@weave/llm` 或 Server 的反向依赖列表。

- [ ] **Step 4: 安装 workspace 链接并验证骨架**

运行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @weave/session typecheck
pnpm --filter @weave/session lint
```

预期：package 可以被 workspace 发现，Session 没有跨层 import。

- [ ] **Step 5: 运行边界验证**

运行：

```bash
pnpm lint
pnpm typecheck
```

预期：现有 Foundation 包和空 Session 包都通过。

## Task 2: 定义 Event Schema 和公共类型

**Files:**

- Create: `packages/session/src/events.ts`
- Create: `packages/session/test/schemas.test.ts`
- Modify: `packages/session/src/index.ts`

**Interfaces:**

- Produces `SessionEventType`、`NewSessionEvent`、`SessionEvent`；
- Produces `newSessionEventSchema`、`sessionEventSchema`；
- Produces `sessionEventPayloadSchema`；
- Produces `SessionStoreErrorCode` and `SessionStoreError` types for later Store code。

- [ ] **Step 1: 写 Schema 失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  newSessionEventSchema,
  sessionEventSchema,
} from '../src/index.js';

describe('session event schemas', () => {
  it('accepts a message.created event with a protocol message', () => {
    expect(
      newSessionEventSchema.parse({
        type: 'message.created',
        payload: {
          messageId: 'message-1',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '开始分析' }],
          },
        },
      }),
    ).toEqual({
      type: 'message.created',
      payload: {
        messageId: 'message-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '开始分析' }],
        },
      },
    });
  });

  it('rejects an unknown event type', () => {
    expect(() =>
      newSessionEventSchema.parse({
        type: 'session.deleted',
        payload: {},
      }),
    ).toThrow();
  });

  it('requires store-generated fields on a persisted event', () => {
    expect(() =>
      sessionEventSchema.parse({
        sessionId: 'session-1',
        type: 'session.created',
        payload: { title: 'Demo' },
      }),
    ).toThrow();
  });

  it('rejects a non-positive sequence', () => {
    expect(() =>
      sessionEventSchema.parse({
        eventId: 'event-1',
        sessionId: 'session-1',
        sequence: 0,
        type: 'session.created',
        occurredAt: '2026-11-15T00:00:00.000Z',
        payload: { title: 'Demo' },
      }),
    ).toThrow();
  });
});
```

运行：

```bash
pnpm --filter @weave/session test -- schemas
```

预期：FAIL，因为事件类型和 schema 尚不存在。

- [ ] **Step 2: 定义 payload schemas**

在 `events.ts` 中从 `@weave/protocol` 导入 `messageSchema` 和 `Message`，
使用 `z.discriminatedUnion('type', ...)` 定义六类 New Event payload。

对 payload 的字符串 ID 使用非空字符串；对可选标题和原因使用可选字符串；
对 `message.created.message` 复用 `messageSchema`，不要复制 Message 结构。

- [ ] **Step 3: 定义 persisted event schema**

Persisted event schema 必须包含：

```text
eventId: non-empty string
sessionId: non-empty string
sequence: positive safe integer
type: known event type
occurredAt: valid ISO timestamp
payload: matching payload schema
```

Schema 需要保证 Envelope 的 `type` 和 `payload` 一一对应，不能只校验
`payload: unknown`。

- [ ] **Step 4: 导出公共类型和 schema**

在 `src/index.ts` 只导出后续消费者需要的公共类型和 schema，不导出 Zod
内部辅助 schema。为公共导出添加必要 TSDoc，说明 New Event 不包含 Store
生成字段。

- [ ] **Step 5: 运行测试和构建**

```bash
pnpm --filter @weave/session test -- schemas
pnpm --filter @weave/session typecheck
pnpm --filter @weave/session build
```

预期：Schema 测试通过，生成的声明文件不暴露 Provider 或 SQLite 内部类型。

## Task 3: 定义 Store 接口和错误边界

**Files:**

- Create: `packages/session/src/store.ts`
- Modify: `packages/session/src/index.ts`
- Modify: `packages/session/test/schemas.test.ts`

**Interfaces:**

```ts
export interface SessionEventStore {
  append(
    sessionId: string,
    events: readonly NewSessionEvent[],
  ): Promise<readonly SessionEvent[]>;

  read(
    sessionId: string,
    options?: { readonly afterSequence?: number },
  ): Promise<readonly SessionEvent[]>;

  close(): Promise<void>;
}

export class SessionStoreError extends Error {
  readonly code: SessionStoreErrorCode;
}
```

- [ ] **Step 1: 写输入边界失败测试**

测试以下行为：

```ts
it('rejects an empty session id before a store implementation runs', () => {
  expect(() => sessionIdSchema.parse('')).toThrow();
});

it('rejects a negative afterSequence value', () => {
  expect(() => readSessionEventsOptionsSchema.parse({ afterSequence: -1 })).toThrow();
});
```

- [ ] **Step 2: 定义 Store schemas**

定义 `sessionIdSchema` 和 `readSessionEventsOptionsSchema`。Store 实现必须在
访问 Map 或 SQLite 之前 parse 输入。

- [ ] **Step 3: 定义稳定错误**

实现 `SessionStoreError` 和错误码：

```ts
export type SessionStoreErrorCode =
  | 'session-store-closed'
  | 'session-store-invalid-input'
  | 'session-store-io'
  | 'session-store-protocol';
```

错误 message 不拼接完整 payload、API Key 或未裁剪的数据库响应；SQLite 原始
异常通过 `cause` 保留给开发调试。

- [ ] **Step 4: 验证**

```bash
pnpm --filter @weave/session test -- schemas
pnpm --filter @weave/session typecheck
```

预期：输入 schema 和错误类型通过，尚未有具体 Store 实现。

## Task 4: 实现 In-Memory Store

**Files:**

- Create: `packages/session/src/memory-store.ts`
- Create: `packages/session/test/memory-store.test.ts`
- Modify: `packages/session/src/index.ts`

**Interfaces:**

```ts
export function createInMemorySessionEventStore(): SessionEventStore;
```

- [ ] **Step 1: 写连续序号失败测试**

```ts
it('appends events with continuous per-session sequences', async () => {
  const store = createInMemorySessionEventStore();

  const written = await store.append('session-1', [
    { type: 'session.created', payload: { title: 'Demo' } },
    { type: 'turn.started', payload: { turnId: 'turn-1' } },
  ]);

  expect(written.map((event) => event.sequence)).toEqual([1, 2]);
  expect((await store.read('session-1')).map((event) => event.type)).toEqual([
    'session.created',
    'turn.started',
  ]);

  await store.close();
});
```

运行：

```bash
pnpm --filter @weave/session test -- memory-store
```

预期：FAIL，因为 In-Memory Store 尚未实现。

- [ ] **Step 2: 写隔离、增量和关闭测试**

补充以下独立测试：

- 不同 Session 的 sequence 都从 `1` 开始；
- `afterSequence: 1` 只返回第二个事件；
- 空数组追加返回空数组且不增加 sequence；
- 关闭后再次 close 不报错；
- 关闭后 append/read 拒绝；
- 非法批量输入不会留下部分事件。

- [ ] **Step 3: 实现最小 Map Store**

实现：

1. 校验 `sessionId`、`events` 和 `afterSequence`；
2. 深度校验每个 `NewSessionEvent`；
3. 在临时数组中生成完整事件；
4. 全部通过校验后一次性写入 Map；
5. 根据当前数组长度分配 sequence；
6. 使用 `crypto.randomUUID()` 和 `new Date().toISOString()` 生成 Store 字段；
7. 关闭后统一抛出 `session-store-closed`。

不要在 Store 中实现 Projection 或业务顺序检查。

- [ ] **Step 4: 验证**

```bash
pnpm --filter @weave/session test -- memory-store
pnpm --filter @weave/session typecheck
```

预期：In-Memory Store 的接口和错误行为全部通过。

## Task 5: 实现 SQLite Store 和恢复测试

**Files:**

- Create: `packages/session/src/sqlite-store.ts`
- Create: `packages/session/test/sqlite-store.test.ts`
- Modify: `packages/session/src/index.ts`

**Interfaces:**

```ts
export interface SqliteSessionEventStoreOptions {
  readonly filename: string;
}

export function createSqliteSessionEventStore(
  options: SqliteSessionEventStoreOptions,
): SessionEventStore;
```

- [ ] **Step 1: 写关闭重开失败测试**

```ts
it('restores events after closing and reopening the database', async () => {
  const filename = join(tmpdir(), `weave-session-${randomUUID()}.sqlite`);
  const first = createSqliteSessionEventStore({ filename });

  await first.append('session-1', [
    { type: 'session.created', payload: { title: 'Persisted' } },
    { type: 'turn.started', payload: { turnId: 'turn-1' } },
  ]);
  await first.close();

  const reopened = createSqliteSessionEventStore({ filename });
  const events = await reopened.read('session-1');

  expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  expect(events[0]?.payload).toEqual({ title: 'Persisted' });

  await reopened.close();
  await rm(filename, { force: true });
});
```

运行：

```bash
pnpm --filter @weave/session test -- sqlite-store
```

预期：FAIL，因为 SQLite Store 尚未实现。

- [ ] **Step 2: 写事务失败测试**

覆盖：

- 首次打开自动建表；
- 多 Session 隔离；
- `afterSequence` 增量读取；
- 非法事件不写入；
- 每批事件 sequence 连续；
- 写入失败后不会留下部分批次；
- 关闭后读写拒绝。

- [ ] **Step 3: 实现 SQLite 初始化**

使用 Node 内置 `DatabaseSync`：

```ts
import { DatabaseSync } from 'node:sqlite';
```

初始化时执行固定的 `CREATE TABLE IF NOT EXISTS`。数据库连接只存在于
`sqlite-store.ts`，不从公共 `index.ts` 导出。

- [ ] **Step 4: 实现事务追加**

追加流程必须是：

```text
validate input
  -> BEGIN IMMEDIATE
  -> SELECT MAX(sequence)
  -> INSERT each event
  -> COMMIT
```

任何异常都执行 `ROLLBACK`，并把异常转换成 `SessionStoreError`。返回值使用
内存中已经生成并经过 schema 校验的完整事件，不重新拼接未经校验的数据库值。

- [ ] **Step 5: 实现参数化读取**

使用预编译参数，不拼接 `sessionId` 和 sequence。读取每一行后：

1. `JSON.parse(payload_json)`；
2. 构造 `SessionEvent`；
3. 使用 `sessionEventSchema.parse`；
4. 任意一行失败就抛出 `session-store-protocol`。

- [ ] **Step 6: 验证 SQLite**

```bash
pnpm --filter @weave/session test -- sqlite-store
pnpm --filter @weave/session typecheck
pnpm --filter @weave/session build
```

预期：SQLite 事件可以关闭后重新读取，测试只使用临时文件，不访问网络。

## Task 6: 实现 Session Projection

**Files:**

- Create: `packages/session/src/projection.ts`
- Create: `packages/session/test/projection.test.ts`
- Modify: `packages/session/src/index.ts`

**Interfaces:**

```ts
export interface SessionMessage {
  readonly messageId: string;
  readonly message: Message;
  readonly sequence: number;
}

export interface SessionStep {
  readonly stepId: string;
  readonly kind: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface SessionTurn {
  readonly turnId: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly steps: readonly SessionStep[];
}

export interface SessionProjection {
  readonly sessionId: string;
  readonly title: string | undefined;
  readonly messages: readonly SessionMessage[];
  readonly turns: readonly SessionTurn[];
  readonly lastSequence: number;
}

export function projectSession(
  events: readonly SessionEvent[],
): SessionProjection;
```

- [ ] **Step 1: 写完整恢复失败测试**

```ts
it('projects a session with messages, turns, and steps', () => {
  const state = projectSession([
    event(1, 'session.created', { title: 'Demo' }),
    event(2, 'message.created', {
      messageId: 'message-1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '开始' }],
      },
    }),
    event(3, 'turn.started', { turnId: 'turn-1' }),
    event(4, 'step.started', { turnId: 'turn-1', stepId: 'step-1', kind: 'model' }),
    event(5, 'step.completed', {
      turnId: 'turn-1',
      stepId: 'step-1',
      status: 'completed',
    }),
    event(6, 'turn.completed', { turnId: 'turn-1', status: 'completed' }),
  ]);

  expect(state.title).toBe('Demo');
  expect(state.messages).toHaveLength(1);
  expect(state.turns[0]).toMatchObject({
    turnId: 'turn-1',
    status: 'completed',
  });
  expect(state.turns[0]?.steps[0]).toMatchObject({
    stepId: 'step-1',
    status: 'completed',
  });
});
```

- [ ] **Step 2: 写非法顺序测试**

补充：

- 没有 `session.created`；
- 第一条事件不是 sequence `1`；
- 重复 `session.created`；
- 重复 Turn/Step ID；
- `turn.completed` 引用不存在的 Turn；
- `step.started` 引用不存在的 Turn；
- `step.completed` 引用不存在的 Step；
- 输入事件数组在 Projection 后保持不变。

- [ ] **Step 3: 实现纯函数 reducer**

实现 `projectSession` 时：

1. 先对每个事件执行 `sessionEventSchema.parse`；
2. 检查 sessionId 一致；
3. 检查 sequence 严格递增；
4. 按事件类型创建新的状态对象；
5. 不修改传入数组或其中的事件对象；
6. 发现非法业务顺序时抛出带稳定 code 的 Projection 错误。

不要在 Projection 中访问 Store、读取文件或调用 Runtime。

- [ ] **Step 4: 验证 Projection**

```bash
pnpm --filter @weave/session test -- projection
pnpm --filter @weave/session typecheck
```

预期：完整状态恢复和非法顺序测试通过。

## Task 7: 更新架构学习文档并运行完整验证

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture/foundation.md`
- Modify: `packages/session/src/index.ts`

- [ ] **Step 1: 补充 README 学习入口**

增加：

- `@weave/session` 的职责；
- `StreamEvent` 与 Session Event 的区别；
- In-Memory 与 SQLite 的使用场景；
- 关闭后重新打开恢复事件的验证命令。

- [ ] **Step 2: 补充 Foundation 架构文档**

增加依赖图：

```text
protocol -> { llm, session } -> runtime -> server
```

说明 Session Store 不直接进入 Runtime 业务逻辑，Runtime 只在后续装配阶段
通过接口使用它。

- [ ] **Step 3: 检查公共导出和注释**

确认 `@weave/session` 的公共类、接口、类型、Schema 和函数都有必要的
TSDoc，内部辅助函数不添加逐行注释。确认导出的声明文件没有 `DatabaseSync`
或 SQLite 表结构泄露到公共接口。

- [ ] **Step 4: 运行包级验证**

```bash
pnpm --filter @weave/session test
pnpm --filter @weave/session lint
pnpm --filter @weave/session typecheck
pnpm --filter @weave/session build
```

- [ ] **Step 5: 运行根级完整验证**

```bash
pnpm check
git diff --check
```

预期：格式、Lint、类型检查、全部测试和构建均通过。Session 分支不提交或
推送，除非用户随后明确要求进入 PR 流程。

## Self-Review Checklist

- [ ] 设计文档中的六类事件都在 Schema、In-Memory、SQLite 和 Projection 计划中覆盖。
- [ ] Store 只负责持久化，Projection 只负责解释事件，没有跨职责调用。
- [ ] SQLite 使用事务追加，读取使用参数化 SQL。
- [ ] 所有公共接口签名在任务之间保持一致。
- [ ] `StreamEvent` 没有被当作 durable Session Event。
- [ ] `@weave/session` 没有反向依赖 Runtime、Server 或 LLM。
- [ ] 没有使用 TBD、TODO 或“后续补充”作为实现步骤。
