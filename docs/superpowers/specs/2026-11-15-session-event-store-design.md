# Weave Session Event Store 设计

**日期：** 2026-11-15

**状态：** 已确认，进入实施

**目标阶段：** Weave Studio 的本地 Session 持久化基础

## 1. 目标

本设计为 Weave 增加第一条 Session 持久化垂直切片。它只解决以下问题：

1. 用稳定的 durable event schema 表达 Session 内发生过的事实；
2. 以 append-only 方式追加和读取 Session 事件；
3. 用 In-Memory Store 支持快速、确定性的单元测试；
4. 用 SQLite Store 验证本地持久化和关闭后恢复；
5. 用纯函数 Projection 从事件日志重建 Session 状态。

本轮不实现 Agent Loop、Tool Pipeline、Workspace、Approval、SSE API 或前端界面。它们后续都应该消费本轮稳定的事件和 Projection 契约，而不是把数据库细节带入各自的边界。

## 2. 背景与约束

Weave 是 Orbit 原型之后的架构重置。Orbit 的 `RunManager` 和
`runAgent()` 不能成为新的 Runtime 边界。Session 是持久化事实的聚合边界，
而 Turn、Step、Message 是 Session 内的业务事实。

当前 Foundation 依赖方向为：

```text
@weave/protocol -> @weave/llm -> @weave/runtime -> @weave/server
```

本轮增加 `@weave/session` 后，允许的方向为：

```text
@weave/protocol
  ├── @weave/llm
  └── @weave/session
        └── @weave/runtime
              └── @weave/server
```

具体约束：

- `@weave/session` 可以依赖 `@weave/protocol`、Zod 和 Node 类型声明；
- `@weave/session` 不依赖 `@weave/runtime`、Hono、React 或 Provider SDK；
- `@weave/runtime` 未来可以装配 `@weave/session`，但本轮不把 Session Store 强行注入 Runtime；
- 外部进入 Store 的事件必须先经过 Zod；
- durable Session Event 与 LLM `StreamEvent` 必须分离；
- transient live-control state 不写入 durable event；
- 不新增数据库依赖，使用 Node.js 24.4 提供的 `node:sqlite`；
- 行为变化必须有包级测试；
- 代码注释只解释边界、不变量和不明显的设计原因，学习内容写入 `docs/`。

## 3. 核心概念

### 3.1 Durable Event

Durable Event 是已经发生、需要在进程退出后保留的事实，例如“某条消息创建了”
或“某个 Step 完成了”。事件一旦追加成功，就不能更新或删除。

### 3.2 Transient Live-Control State

Live-Control State 是当前进程运行时状态，例如 `AbortSignal`、正在执行的
Promise、HTTP 连接、当前订阅者和内存中的取消标记。这些状态不能序列化为
Session Event，因为它们不是业务事实，也不能在进程重启后直接恢复。

### 3.3 StreamEvent 与 SessionEvent

`@weave/llm` 的 `StreamEvent` 是 Provider 流式响应的临时传输协议。它描述
模型正在输出的 delta，不代表最终业务事实。

例如：

```text
StreamEvent: text-delta("你好")
StreamEvent: text-delta("，世界")
       ↓ Agent/Turn 层聚合
SessionEvent: message.created
```

LLM 错误仍然通过 `LlmClient.stream()` 的 reject 路径传播，不把错误强行转换
成 `StreamEvent`。Session 后续可以定义 `turn.failed` 等 durable event，但那
属于 Agent/Turn 业务边界，不属于 Provider 流协议。

## 4. 方案选择

### 4.1 只实现 SQLite

优点是实现路径短，可以直接验证本地文件持久化。

缺点是所有测试都需要数据库，事件 Store 的接口设计会被 SQLite API 牵着走，
后续 Agent Loop 测试也会变慢。

### 4.2 只实现 In-Memory Store

优点是测试简单、速度快。

缺点是无法验证真正的本地持久化、事务和重新打开后的恢复，后续接 SQLite
时可能重新设计公共接口。

### 4.3 选择：统一接口、两个实现、纯函数 Projection

本轮采用：

```text
SessionEventStore
  ├── InMemorySessionEventStore
  └── SqliteSessionEventStore

SessionEvent[]
  -> projectSession()
  -> SessionProjection
```

Store 只负责追加和读取，不负责解释事件；Projection 只负责把事件解释成
可供上层读取的状态，不负责数据库操作。这样可以分别测试持久化和状态转换，
也为后续 snapshot、增量投影和事件版本迁移留下边界。

## 5. 事件模型

### 5.1 事件 Envelope

所有已持久化事件共享以下 Envelope：

```ts
interface SessionEvent {
  readonly eventId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly type: SessionEventType;
  readonly occurredAt: string;
  readonly payload: SessionEventPayload;
}
```

字段语义：

- `eventId`：Store 生成的全局事件标识，使用 UUID；
- `sessionId`：事件所属 Session，不能为空；
- `sequence`：Session 内从 `1` 开始递增的序号；
- `type`：稳定的事件类型标识；
- `occurredAt`：Store 追加事件时生成的 ISO 时间；
- `payload`：经过对应事件 Schema 校验的事件数据。

调用方只能提交 `NewSessionEvent`，不能提交 `eventId`、`sequence` 或
`occurredAt`。这三个字段必须由 Store 生成，避免外部伪造顺序和持久化身份。

### 5.2 第一批事件

```ts
type SessionEventType =
  | 'session.created'
  | 'message.created'
  | 'turn.started'
  | 'turn.completed'
  | 'step.started'
  | 'step.completed';
```

事件 payload：

```ts
type NewSessionEvent =
  | {
      readonly type: 'session.created';
      readonly payload: {
        readonly title?: string;
      };
    }
  | {
      readonly type: 'message.created';
      readonly payload: {
        readonly messageId: string;
        readonly message: Message;
      };
    }
  | {
      readonly type: 'turn.started';
      readonly payload: {
        readonly turnId: string;
      };
    }
  | {
      readonly type: 'turn.completed';
      readonly payload: {
        readonly turnId: string;
        readonly status: 'completed' | 'failed' | 'cancelled';
        readonly reason?: string;
      };
    }
  | {
      readonly type: 'step.started';
      readonly payload: {
        readonly turnId: string;
        readonly stepId: string;
        readonly kind: string;
      };
    }
  | {
      readonly type: 'step.completed';
      readonly payload: {
        readonly turnId: string;
        readonly stepId: string;
        readonly status: 'completed' | 'failed' | 'cancelled';
      };
    };
```

本轮不增加 `session.deleted`、`session.renamed`、`turn.failed` 或
`step.failed`。失败和取消先作为完成事件的 `status` 表达，等 Agent Loop
稳定后再根据实际查询需求拆分事件类型。

### 5.3 事件顺序

Store 只保证每个 Session 的序列号严格递增，不负责判断业务顺序。例如 Store
可以暂时接受一个没有 `session.created` 的事件，Projection 在恢复时负责报告
不合法的业务事件顺序。

这样拆分的原因是：

- Store 的职责是可靠保存事实；
- Projection 的职责是解释事实；
- 未来导入旧事件或进行事件迁移时，不需要把业务规则硬编码到数据库写入层。

## 6. Store 接口

公共接口定义为：

```ts
interface SessionEventStore {
  append(
    sessionId: string,
    events: readonly NewSessionEvent[],
  ): Promise<readonly SessionEvent[]>;

  read(
    sessionId: string,
    options?: {
      readonly afterSequence?: number;
    },
  ): Promise<readonly SessionEvent[]>;

  close(): Promise<void>;
}
```

行为约束：

- `append(sessionId, [])` 返回空数组，不创建任何事件；
- 一次 `append` 中的事件按传入顺序分配连续序号；
- 批量追加要么全部成功，要么全部失败；
- `read` 始终按 `sequence ASC` 返回；
- `afterSequence` 只返回严格大于该序号的事件；
- 不存在的 Session 返回空数组；
- `close` 可重复调用；
- 关闭后调用 `append` 或 `read` 必须拒绝，并返回稳定的 Store closed 错误；
- Store 不提供 update 和 delete API。

Store 不负责自动补 `session.created`，也不自动补 `turn.completed`。事件脚本是什么，
就保存什么，业务层负责决定什么时候生成事实。

## 7. In-Memory 实现

In-Memory Store 使用：

```text
Map<sessionId, SessionEvent[]>
```

它必须完整遵守公共接口的序列号、关闭状态和批量追加语义，不能因为只是测试
实现就省略约束。它主要用于：

- Schema 和 Store 契约测试；
- Projection 测试；
- 后续 Agent Loop 测试；
- 不依赖文件系统的快速 CI。

事件 ID 和时间由 Store 内部生成。测试不依赖具体 UUID 或当前时间，而是断言
结构、顺序和 payload。

## 8. SQLite 实现

### 8.1 数据表

第一版使用单表：

```sql
CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence)
);
```

不提前创建 Session、Turn、Step 多张表，因为这些都是事件 Projection 的结果；
如果现在同时维护多张派生表，就会出现事件表和派生表双写不一致的问题。

### 8.2 追加事务

SQLite Store 使用 `BEGIN IMMEDIATE`、多次 `INSERT` 和 `COMMIT` 完成一次批量
追加。失败时执行 `ROLLBACK`。

追加流程：

```text
校验 sessionId 和 NewSessionEvent[]
  -> 开始写事务
  -> 查询当前 session 的 MAX(sequence)
  -> 为本批事件分配连续序号
  -> 插入所有事件
  -> 提交事务
  -> 返回写入后的完整事件
```

SQLite 在当前单进程 local-first 场景下负责串行化写入。未来如果 Weave 支持
多进程写入，需要单独设计锁、进程协调和迁移策略，不在本轮隐式解决。

### 8.3 读取和恢复

读取使用参数化 SQL：

```sql
SELECT
  event_id,
  session_id,
  sequence,
  type,
  occurred_at,
  payload_json
FROM session_events
WHERE session_id = ? AND sequence > ?
ORDER BY sequence ASC;
```

读取数据库中的 `payload_json` 后仍然必须经过 Session Event Schema 校验，不能
因为数据来自本地文件就跳过验证。损坏数据需要转换为稳定的 Store protocol
错误，不能把原始 JSON 直接泄露给上层。

## 9. Projection

Projection 是纯 TypeScript 逻辑，不导入 SQLite 和 Runtime：

```ts
interface SessionProjection {
  readonly sessionId: string;
  readonly title: string | undefined;
  readonly messages: readonly SessionMessage[];
  readonly turns: readonly SessionTurn[];
  readonly lastSequence: number;
}

function projectSession(
  events: readonly SessionEvent[],
): SessionProjection;
```

Projection 规则：

- 第一条事件必须是 `session.created`；
- `session.created` 只能出现一次；
- `message.created` 追加消息；
- `turn.started` 创建 running Turn；
- `turn.completed` 更新对应 Turn 状态；
- `step.started` 追加到对应 Turn；
- `step.completed` 更新对应 Step 状态；
- 引用不存在的 Turn、Step 或重复 ID 时抛出稳定的 Projection 错误；
- 事件序号必须严格递增；
- 输入事件数组不会被修改。

Projection 不保存 AbortSignal、Promise、连接或正在执行的函数。恢复出来的
状态只描述持久化事实，不能假装恢复出一个仍在运行的 Agent。

## 10. 错误模型

本轮错误不复用 `LlmError`，因为 Session Store 与 Provider 错误的重试语义不同。

至少区分：

```text
session-store-closed
session-store-invalid-input
session-store-io
session-store-protocol
session-projection-invalid-order
session-projection-missing-reference
```

错误对象需要包含稳定 `code` 和面向开发者的 message。错误信息不能包含 API Key
或完整的数据库路径之外的敏感凭据。底层 SQLite 错误可以作为 `cause` 保留，
但公共 message 不直接拼接完整 SQL 或数据库内容。

## 11. 测试策略

### 11.1 Schema

- 合法的六类事件可以解析；
- 未知事件类型被拒绝；
- `message.created` 中的 Message 使用 `@weave/protocol` Schema；
- 事件 envelope 的 sequence 必须是正整数；
- Store 生成的字段缺失时，持久化事件 Schema 拒绝；
- 非法 payload 被拒绝。

### 11.2 In-Memory Store

- 空 Store 读取返回空数组；
- 批量追加生成连续 sequence；
- 不同 Session 互相隔离；
- `afterSequence` 只返回增量事件；
- 空批量追加不改变 sequence；
- append 后返回的事件包含 Store 生成的 eventId 和 occurredAt；
- 关闭后重复 close 幂等；
- 关闭后读写都拒绝；
- 批量输入非法时不写入部分事件。

### 11.3 SQLite Store

- 首次打开自动创建表；
- 写入后按 sequence 读取；
- 批量追加在同一 Session 内连续编号；
- 读写不同 Session 不串数据；
- 关闭并重新打开后仍能读取原事件；
- 非法 payload 不进入数据库；
- 事务中途失败不会留下部分批次；
- 关闭后读写拒绝。

### 11.4 Projection

- 完整事件序列能恢复 Session、消息、Turn 和 Step；
- 缺少 `session.created` 被拒绝；
- 重复 Session、Turn、Step ID 被拒绝；
- 引用不存在的 Turn 或 Step 被拒绝；
- 事件序号不连续或倒退被拒绝；
- Projection 不修改输入事件数组。

## 12. 明确排除

本轮不实现：

- Runtime 中的 Session Service 装配；
- Agent Loop；
- Tool Call 和 Tool Result durable event；
- Approval、Workspace、Sandbox；
- HTTP Session API；
- SSE 广播；
- SQLite snapshot；
- 数据库迁移框架；
- 多进程并发写入；
- 远程数据库；
- 用户认证和多租户。

这些能力应该在本轮契约通过完整检查后，作为独立分支继续实现。

## 13. 验收标准

完成本轮后必须满足：

- `@weave/session` 可以独立构建和测试；
- `@weave/session` 只依赖 `@weave/protocol`、Zod 和 Node 内置模块；
- In-Memory 与 SQLite 遵守同一 Store 接口；
- SQLite 关闭并重新打开后能够恢复同一批事件；
- Projection 可以从事件恢复可验证的 Session 状态；
- durable event 与 `StreamEvent` 没有混用；
- 根级 `pnpm check` 通过；
- 架构文档、实现契约和测试行为一致。

## 14. 学习与面试表达

可以这样解释这个设计：

> Session Event Store 不直接保存一个不断被修改的 Session 对象，而是只追加已经发生的事实。Session 当前状态是事件的 Projection，因此状态可以在进程重启后重建，也可以在未来增加快照或新的读取模型。In-Memory Store 用于快速测试，SQLite Store 用于证明 local-first 持久化，两者通过同一个接口隔离上层。

当被问为什么不让 Runtime 直接操作 SQLite 时：

> Runtime 负责服务生命周期和依赖装配，不应该知道事件表结构。Session 包只暴露 Store 和 Projection 契约，SQLite 是它的内部实现。这样 Runtime、Agent Loop 和未来的 Desktop/CLI 都可以使用同一套 Session 能力，而不依赖数据库细节。
