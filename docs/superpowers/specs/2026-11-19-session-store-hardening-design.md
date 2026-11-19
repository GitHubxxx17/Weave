# Session 存储健壮性设计（SQLite PRAGMA、增量投影、迁移框架）

## 1. 背景

`@weave/session` 的持久化目前有三处健壮性缺口，长期运行或多会话并发时会暴露：

- **E4 并发**：`createSqliteSessionEventStore` 开库后只 `CREATE TABLE IF NOT EXISTS`，
  没有设置任何 PRAGMA。默认 `journal_mode` 是 `delete`、`busy_timeout` 是 0，所以
  一个连接写入时另一个连接读/写会立刻拿到 `SQLITE_BUSY` 而不是短暂等待。
  `AgentRunner` 内部虽然对同一会话做了串行队列，但不同 `AgentRunner` 实例或不同进程
  之间没有协调（见 `foundation.md`），多会话并发写同一个库文件时就会撞上这个问题。
- **E3 投影成本**：`projectSession(events)` 每次都对**全量事件**做一遍
  `sessionEventSchema.parse`（Zod 判别联合解析）再重放。`session-service.ts` 的
  `get`、`rename`、`archive`、`restore`、`delete`、`assertRunnable` 每次调用都读全量并重投影；
  `listProjectSessions` 更是对项目下**每个会话**都读全量并重投影。会话越长、数量越多，
  列表和详情越慢，而最贵的一步是对历史事件的重复 Zod 解析。
- **W1 迁移**：建表用 `CREATE TABLE IF NOT EXISTS`，没有 schema 版本概念。将来改表结构
  时，无法区分"新库"与"旧库"，也无法阻止用新代码打开一个结构更旧、或被更新版本写过的库。

## 2. 范围与边界

- 只改 `packages/session/*`（源码 + 该包 `test/`）。**不碰任何其它包**，与并行进行的
  `feat/studio-control-surface`、`feat/panel-multi-tab` 没有文件重叠。
- 对外契约只做**向后兼容的新增**：新增一个可选构造项、一个错误码、一组投影缓存导出。
  `projectSession` 的签名与行为保持不变（内部重构成"可增量折叠"的核心）。
- **非目标**：把投影缓存接进 `session-service.ts`（跨到 `apps/server`，属别的边界，单独一步）；
  跨进程写协调（CAS / lease，属未来的会话并发切片）；真正的多线程并发压测。

## 3. E4 ｜ SQLite PRAGMA

开库后、建表（迁移）前，在连接上依次设置：

| PRAGMA | 值 | 原因 |
|-|-|-|
| `busy_timeout` | 可配，默认 `5000`（毫秒） | 写冲突时等待而非立即 `SQLITE_BUSY` |
| `journal_mode` | `WAL` | 允许读与写并发；WAL 是**库文件级持久设置** |
| `foreign_keys` | `ON` | 当前表无外键，仍显式开启以统一行为、为后续表结构预留 |

- `busy_timeout` 与 `foreign_keys` 是**每连接**设置，必须在每次开库时设置。
- `journal_mode = WAL` 不能在事务中切换，所以三条 PRAGMA 都在迁移事务**之前**执行。
- 构造项新增 `busyTimeoutMs?: number`（`sqliteSessionEventStoreOptionsSchema` 同步加
  `z.number().int().positive().optional()`）。缺省 5000。

WAL 会产生 `<db>-wal` / `<db>-shm` 边车文件；测试清理时一并删除。

## 4. W1 ｜ 迁移框架（`PRAGMA user_version`）

- 用 SQLite 内置的 `PRAGMA user_version`（整数，存于库文件头）记录 schema 版本。
- `migrations` 是一个有序数组，`migrations[0]` 把 v0 升到 v1，内容即当前建表语句；
  `SCHEMA_VERSION = migrations.length`（当前为 1）。
- 开库流程：读 `user_version = current`：
  - `current > SCHEMA_VERSION` → 抛新错误码 `session-store-migration`（库被更新版本写过，拒绝打开，
    避免新代码按旧结构误读/误写）。
  - `current === SCHEMA_VERSION` → 无需迁移。
  - `current < SCHEMA_VERSION` → 在一个 `BEGIN IMMEDIATE` 事务里依次执行
    `migrations[current..SCHEMA_VERSION-1]`，再 `PRAGMA user_version = SCHEMA_VERSION`，然后 COMMIT；
    任一步失败则 ROLLBACK 并抛出（迁移要么整体成功要么整体回滚）。
- **向后兼容**：现有库由旧代码创建，表已存在但 `user_version` 为 0。迁移 `migrations[0]`
  用 `CREATE TABLE IF NOT EXISTS` 是幂等的，对已有库只把版本号抬到 1，数据不动。
- 构造函数捕获错误时保留 `SessionStoreError`（迁移错误码不被重新包装成 `session-store-io`）。
- 读查询不需要新增索引：`WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC`
  已由主键 `(session_id, sequence)` 完全覆盖。

## 5. E3 ｜ 增量投影缓存

### 5.1 投影核心重构（行为不变）

把 `projection.ts` 的"全量重放"拆成可复用的核心：

- `ProjectionState`：原来 `projectSession` 的局部可变状态（title/archivedAt/deletedAt/
  messages/messageIds/turns/turnById/activeTurnId/lastSequence）集中成一个可变结构。
- `applyEvent(state, rawEvent)`：对单个事件做 `sessionEventSchema.parse` + 全部校验与状态推进；
  校验逻辑与原实现**逐条等价**（首个事件必须是 `session.created` 且 `sequence === 1`；
  后续事件校验 `sessionId` 一致、`sequence === lastSequence + 1`；`session.created` 只能在首位；
  删除后不再接受事件；等等），错误码与错误信息文本保持不变。
- `snapshot(state)`：产出与现在 `projectSession` 返回值结构完全一致的不可变投影。
- `projectSession(events)` = 建状态 → 空数组抛原有 `requires a session.created event` →
  逐条 `applyEvent` → `snapshot`。现有 34 个单测是等价性的护栏。

因为 Store 是**只追加**的（历史事件永不回改、sequence 由 Store 分配且连续），
"按 `afterSequence` 读新事件、折叠到保留状态"永远正确——这正是增量投影成立的前提。

### 5.2 缓存 API

```ts
export interface SessionProjectionCache {
  /** 投影一个会话；无任何事件（会话不存在）时返回 undefined。读模型损坏时抛 SessionProjectionError。 */
  project(sessionId: string): Promise<SessionProjection | undefined>;
  /** 丢弃某会话的缓存状态（如删除后释放内存）。 */
  invalidate(sessionId: string): void;
  /** 清空全部缓存状态。 */
  clear(): void;
}

export interface SessionProjectionCacheOptions {
  /** 最多保留多少个会话的投影状态，按最近使用淘汰；默认 128。 */
  readonly maxEntries?: number;
}

export function createSessionProjectionCache(
  store: SessionEventStore,
  options?: SessionProjectionCacheOptions,
): SessionProjectionCache;
```

### 5.3 行为

- 每次 `project(sessionId)`：读 `store.read(sessionId, { afterSequence: 上次 lastSequence })`，
  只拿**新事件**折叠到保留的可变状态；首次调用 `afterSequence` 为 0，读全量。
  所以**历史事件只解析一次**，这是相对 `projectSession` 的提速点。
- 读到的新事件为空时，返回上次构建好的不可变快照（不重复建快照）；有新事件时才重建快照并缓存。
- 首次读到 0 个事件（会话无任何事件）→ 返回 `undefined`（供调用方区分"不存在"）。
- 折叠过程中任一事件校验失败 → **丢弃该会话缓存条目**并抛 `SessionProjectionError`；
  下次调用重新从 0 读取，确定性地抛出同一个错误（不会留下半折叠的脏状态）。
- `maxEntries` 用 Map 插入序做最近使用淘汰，防止长运行进程缓存无界增长。
- 始终从 Store 读增量，所以同一 Store 上的新 `append` 下次 `project` 必然可见，无需手动失效；
  `invalidate` 只用于释放内存。

### 5.4 与消费方的关系

本 PR 只在 `@weave/session` 内提供缓存并用单测证明其"只读增量、结果与 `projectSession` 等价"。
把它接进 `session-service.ts`（`readProjection` 用缓存、`delete` 后 `invalidate`）是一处约 5 行、
跨到 `apps/server` 的改动，留作单独一步，以免越过本道的文件边界、与并行分支抢文件。

## 6. 契约变更清单

- `store.ts`：`SessionStoreErrorCode` 增加 `'session-store-migration'`。
- `sqlite-store.ts`：`SqliteSessionEventStoreOptions` 增加 `busyTimeoutMs?: number`；
  schema 同步；开库改为"设 PRAGMA → 迁移"。
- `projection.ts`：内部重构出 `ProjectionState` / `applyEvent` / `snapshot`，`projectSession` 行为不变。
- 新增 `projection-cache.ts`：`createSessionProjectionCache` 及其类型。
- `index.ts`：导出缓存工厂与类型。

## 7. 测试

- **E4**：第二个连接读同一 WAL 库 `PRAGMA journal_mode` 为 `wal`；两个 Store 实例交错
  append/read 到同一文件都成功、都能读到对方已提交事件（WAL 读写并发 + 实际不再 BUSY）；
  传入自定义 `busyTimeoutMs` 能正常开库工作。
- **W1**：新库 `user_version` 变为 1；预置 `user_version = 999` 的库被拒绝（`session-store-migration`）；
  预置"有表、有数据、`user_version = 0`"的旧库能平滑打开、数据可读、版本抬到 1。
- **E3**：缓存结果与 `projectSession` 逐字段相等；第二次 `project` 只按 `afterSequence` 读增量
  （用记录调用参数的包装 Store 断言）；无事件会话返回 `undefined`；损坏读模型抛错并丢弃条目；
  `maxEntries` 淘汰最久未用条目。

## 8. 验收

并发 append 不再 `SQLITE_BUSY`（WAL + busy_timeout）；投影在大会话下避免重复解析历史事件而更快；
迁移框架就位且旧库平滑升级；`pnpm check` 全绿。
