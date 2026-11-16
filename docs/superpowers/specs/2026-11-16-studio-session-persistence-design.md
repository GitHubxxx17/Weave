# Weave Studio 会话持久化设计

**日期：** 2026-11-16

**状态：** 待评审

**目标阶段：** Weave Studio 的 Project/Session 本地持久化基础

## 1. 背景

当前 Studio 已经具备项目树、会话管理、Agent SSE 流式交互和归档区等
前端交互，但项目与会话数据仍保存在 `apps/studio/src/app/App.tsx` 的
React 内存状态中。浏览器刷新或 Server 重启后，项目、会话标题、归档状态和
消息都会丢失。

当前 Server 默认使用 `@weave/session` 的 In-Memory Store，也没有 Project
或 Session 管理 API。下一步需要把 Studio 从“本地演示状态”升级为“通过
Server 访问本地持久化数据”的工作台。

这一步是架构型功能，必须保持 Weave 已确认的边界：

```text
Studio
  -> HTTP Project/Session API
    -> Server 组合根
      -> Workspace Project Store
      -> Session Event Store
      -> Runtime Agent Runner
```

Studio 不直接导入 `@weave/session`、`@weave/runtime` 或 Node.js 模块。
Server 负责 HTTP 输入校验和 Store 组合，Runtime 仍然负责 Agent 行为，
Session Event Store 仍然只负责 durable events。

## 2. 目标与非目标

### 2.1 目标

本轮完成以下能力：

1. 新增 `@weave/workspace`，持久化项目元数据和项目到 Session 的关系；
2. 为 Session 增加标题修改、归档、恢复和逻辑删除事件；
3. 让 Session Projection 可以重建标题、归档时间和删除时间；
4. 为 Server 增加 Project/Session 管理 API；
5. 让 Studio 首次加载时从 API 恢复项目树、会话列表和会话消息；
6. 让 Agent 运行产生的 durable events 继续由 Runtime 写入 Session Store；
7. 使用 SQLite 作为本地 Server 的默认持久化实现；
8. 保留 In-Memory 实现，继续支持快速、确定性的测试；
9. 对数据库损坏、输入错误、关联不存在和 Store 关闭等情况返回稳定错误；
10. 用包级单元测试、Server API 测试和 Studio 适配层测试覆盖行为变化。

### 2.2 非目标

本轮不实现以下内容：

- Workspace 文件读写、目录扫描、Git 状态读取或 Sandbox；
- 多用户、登录、远程同步和云端数据库；
- 多进程写入协调、分布式锁和跨设备同步；
- Run Registry、后台 Agent、断线重连或 `Last-Event-ID`；
- Plugin Manifest、插件安装和 Crew 多 Agent 编排；
- Session 快照、事件压缩和历史事件迁移；
- 物理删除 SQLite 事件；
- 把浏览器 `FileSystemHandle` 序列化到 Server。

本轮的“项目等于文件夹”表示项目持久化一个稳定的本地文件夹身份。真正的
文件读写边界仍由后续 Workspace/Sandbox 功能负责。

## 3. 方案选择

### 3.1 方案 A：把 Project 和 Session 全部放入 `@weave/session`

这种方式实现路径最短，但会让 Session Event Store 同时负责项目名称、
文件夹身份和 Session 归属。后续加入 Workspace、Plugin 和 Sandbox 时，
Session 包会变成所有上层能力的耦合点，边界需要再次拆分。

### 3.2 方案 B：新增 `@weave/workspace`，由 Server 组合两个 Store

本设计采用此方案。

`@weave/session` 只解释 Session 内的 durable facts；`@weave/workspace`
只负责 Project 元数据和 Project/Session 关系索引；Server 在 HTTP 层组合
两者。这样每个 Store 都有清晰的事实来源：

```text
Project name/folder/membership -> Workspace Store
Session title/messages/turns/status -> Session Event Store
```

这个方案多一个包和一次 Server 组合，但能把当前持久化需求和未来的文件系统、
权限、插件边界分开，适合 Weave 的长期方向。

### 3.3 方案 C：把所有持久化逻辑直接写在 Server

这种方式初期代码更少，但 Server 会同时承担数据库表结构、Project 规则、
Session Projection 和 HTTP 适配，测试与复用都会变困难。它不符合“HTTP
Handler 保持薄、领域能力位于独立包”的现有架构约束，因此不采用。

## 4. 包边界与依赖方向

本轮依赖方向调整为：

```text
@weave/protocol
  ├── @weave/llm
  └── @weave/session

@weave/session
  └── @weave/runtime

@weave/workspace
  └── @weave/server
```

更准确地说，`@weave/server` 同时依赖 `@weave/session`、`@weave/workspace`
和 `@weave/runtime`。`@weave/workspace` 只依赖 Zod 和 Node 类型声明，不依赖
`@weave/protocol`、Runtime、Hono、React 或 Node HTTP Server。

### 4.1 `@weave/session`

负责：

- `SessionEvent` 和 `NewSessionEvent` Schema；
- In-Memory 和 SQLite Event Store；
- Session Projection；
- Session 生命周期事件；
- Session Store 的错误类型和读取契约。

不负责：

- Project 元数据；
- 文件系统访问；
- HTTP；
- 当前运行中的 Promise、AbortSignal 或 SSE 连接。

### 4.2 `@weave/workspace`

负责：

- Project 元数据；
- Project 的本地文件夹身份；
- Project 与 Session 的关系索引；
- Project Store 的 In-Memory 和 SQLite 实现；
- Project Store 的输入校验和错误类型。

它只保存 Session ID，不解释 Session 事件，也不复制 Session 标题、消息和
Agent 运行状态。读取完整 Session 摘要时，由 Server 先读取关系索引，再通过
Session Event Store 投影出摘要。

### 4.3 `apps/server`

负责：

- 选择 SQLite 或 In-Memory 实现；
- 创建默认数据库目录和数据库文件；
- 组合 Project Store、Session Event Store 和 Agent Runner；
- 校验 HTTP 请求和响应；
- 将领域错误映射为稳定的 HTTP 错误码；
- 在跨 Store 操作失败时执行补偿或返回明确失败。

Handler 不直接执行 Agent Loop，也不直接调用 Tool Definition。

### 4.4 `apps/studio`

负责：

- 通过 HTTP API 加载项目树；
- 通过 HTTP API 创建项目、创建会话和修改会话状态；
- 通过现有 SSE API 发送 Agent Turn；
- 在请求失败时显示可理解的中文错误；
- 将短暂的输入框、面板展开状态和流式增量保留在内存中。

Studio 可以暂时保留这些 transient UI state，但不能把项目、会话标题、
归档状态和 durable messages 作为唯一数据源。

## 5. Workspace 数据模型

### 5.1 Project

```ts
interface Project {
  readonly id: string;
  readonly name: string;
  readonly folderName: string;
  readonly folderPath: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

字段语义：

- `id`：Store 生成的 UUID；
- `name`：Studio 中显示的项目名称；
- `folderName`：稳定的文件夹显示名称；
- `folderPath`：可选的本地绝对路径。浏览器目录选择器无法可靠暴露真实
  路径时允许为空，不能伪造一个可执行路径；
- `createdAt`、`updatedAt`：Store 生成的 ISO 时间。

当前版本不允许物理删除 Project。项目删除会影响 Session 关系、文件夹绑定
和恢复策略，属于后续独立功能。

### 5.2 Session Membership

```ts
interface ProjectSessionRef {
  readonly projectId: string;
  readonly sessionId: string;
  readonly createdAt: string;
}
```

Project Store 只保存关系，不保存 Session 标题和消息。一个 Session 在本轮
只能归属于一个 Project；同一个 Project 不能重复关联同一个 Session。

如果未来需要跨项目会话或移动会话，应新增明确的关系事件或迁移 API，而不是
直接修改 `project_sessions` 表中的行。

### 5.3 Store 接口

`@weave/workspace` 提供以下领域接口：

```ts
interface ProjectStore {
  createProject(input: CreateProjectInput): Promise<Project>;
  listProjects(): Promise<readonly Project[]>;
  getProject(projectId: string): Promise<Project | undefined>;
  attachSession(projectId: string, sessionId: string): Promise<ProjectSessionRef>;
  listSessionRefs(projectId: string): Promise<readonly ProjectSessionRef[]>;
  close(): Promise<void>;
}
```

`CreateProjectInput` 只包含调用方可控字段：

```ts
interface CreateProjectInput {
  readonly name: string;
  readonly folderName: string;
  readonly folderPath?: string;
}
```

Store 不接受 `id`、时间字段或重复关系，避免外部伪造持久化身份。

Store 行为约束：

- 空名称、空文件夹名称和非法路径输入返回
  `workspace-store-invalid-input`；
- 不存在的 Project 返回 `workspace-project-not-found`；
- 重复关系返回 `workspace-session-already-attached`；
- 关闭后所有读写操作返回 `workspace-store-closed`；
- `listProjects()` 和 `listSessionRefs()` 始终按创建时间升序返回；
- `close()` 可重复调用；
- Store 不提供更新和删除 Project 的方法。

## 6. SQLite Schema

本轮默认使用一个 SQLite 文件：

```text
.weave/weave.sqlite
```

`.weave` 目录由 Server 启动时创建。数据库路径可通过环境变量或 Server
组合配置覆盖，但必须经过 Zod 校验，并且不能在 Runtime 内部解析。

### 6.1 Session Events

保留现有表：

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

Event Store 仍然使用 `BEGIN IMMEDIATE`、批量 INSERT、COMMIT/ROLLBACK。

### 6.2 Workspace Tables

```sql
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  folder_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_sessions (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE INDEX IF NOT EXISTS project_sessions_by_project
  ON project_sessions(project_id, created_at);
```

`project_sessions` 不设置指向 `session_events` 的外键，因为 SQLite 的事件
表没有单独的 Session 行，Session 是否真实存在必须由 Event Store 和
Projection 判断。

Project Store 的写事务只覆盖自己的表。跨 Store 的一致性由 Server 的
应用服务流程保证，见第 9 节。

## 7. Session Durable Events 与 Projection

### 7.1 新增事件

在现有事件类型基础上增加：

```ts
type SessionEventType =
  | 'session.created'
  | 'session.renamed'
  | 'session.archived'
  | 'session.restored'
  | 'session.deleted'
  | 'message.created'
  | 'turn.started'
  | 'turn.completed'
  | 'step.started'
  | 'step.completed'
  | 'tool-call.created'
  | 'tool-result.created';
```

新增 payload：

```ts
type SessionLifecycleEvent =
  | {
      readonly type: 'session.renamed';
      readonly payload: { readonly title: string };
    }
  | {
      readonly type: 'session.archived';
      readonly payload: { readonly reason?: string };
    }
  | {
      readonly type: 'session.restored';
      readonly payload: { readonly reason?: string };
    }
  | {
      readonly type: 'session.deleted';
      readonly payload: { readonly reason?: string };
    };
```

事件的 Store-owned 字段仍然是 `eventId`、`sequence` 和 `occurredAt`。生命周期
状态以事件发生时间为准，调用方不能提交归档时间或删除时间。

### 7.2 Projection 字段

`SessionProjection` 增加：

```ts
interface SessionProjection {
  readonly sessionId: string;
  readonly title: string | undefined;
  readonly archivedAt: string | undefined;
  readonly deletedAt: string | undefined;
  readonly messages: readonly SessionMessage[];
  readonly turns: readonly SessionTurn[];
  readonly lastSequence: number;
}
```

Projection 规则：

- `session.created` 必须是第一条事件，且只能出现一次；
- `session.renamed` 修改当前标题；
- `session.archived` 设置 `archivedAt`；
- `session.restored` 清除 `archivedAt`；
- `session.deleted` 设置 `deletedAt`，并视为终态；
- 已删除 Session 后面不能追加任何事件；
- 已删除 Session 不能恢复；
- 已归档 Session 不能继续创建 Agent Turn；
- 没有 `session.created` 的事件序列仍然是 Projection 错误；
- 不同 Session ID、重复生命周期转换和缺失引用仍然返回稳定的 Projection
  错误码。

`session.deleted` 是 append-only tombstone，不是数据库删除。这样可以保留
“曾经存在过的事实”，避免物理删除破坏审计、恢复诊断和未来事件迁移。
“永久删除”在 Studio 中的含义是从正常列表隐藏，并追加删除 tombstone；
如果未来需要真正清理磁盘，必须另立数据清理设计和用户确认流程。

通用 `SessionEventStore.append()` 只负责 Schema、序号和事务，不负责猜测
生命周期顺序。标题、归档、恢复和删除都通过 Server 内部的
`SessionService` 执行：Service 先读取并投影当前 Session，验证状态转换后
再追加事件。这样 Event Store 保持通用，业务状态机集中在一个可测试的领域
服务中。

### 7.3 Session 摘要

Server 不把完整事件日志直接返回 Studio，而是返回摘要：

```ts
interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly archivedAt: string | undefined;
  readonly deletedAt: string | undefined;
  readonly lastSequence: number;
  readonly lastMessage: Message | undefined;
}

interface SessionDetail extends SessionSummary {
  readonly messages: readonly Message[];
}

interface ProjectWithSessions extends Project {
  readonly sessions: readonly SessionSummary[];
}
```

如果 `SessionProjection.title` 为空，Server 在摘要和详情响应中统一返回
`未命名会话`，避免让每个前端调用方重复实现默认标题。

默认列表过滤 `deletedAt !== undefined` 的 Session。归档区可以显示
`archivedAt !== undefined` 且未删除的 Session。打开一个 Session 时再读取
完整的投影消息，避免项目树首次加载携带全部历史内容。

## 8. HTTP API

所有请求和响应都使用 Zod Schema 校验。错误统一返回：

```json
{
  "error": {
    "code": "workspace-project-not-found",
    "message": "Project does not exist"
  }
}
```

错误消息可以面向日志使用英文稳定文本，但 Studio 负责将已知错误码显示为
中文，不把 Server 内部异常堆栈发送到浏览器。

### 8.1 Project API

```text
GET  /projects
POST /projects
GET  /projects/:projectId/sessions
POST /projects/:projectId/sessions
```

`GET /projects` 返回 Project 基本信息和未删除 Session 的摘要，不返回完整
消息。它支持 `includeArchived=true|false`，默认只返回未归档、未删除的
Session。`POST /projects` 创建 Project 并返回完整 Project。

`GET /projects/:projectId/sessions` 支持：

```text
?includeArchived=true|false
```

默认只返回未归档、未删除 Session；归档区显式传
`includeArchived=true`。两个列表接口使用同一过滤语义。

`POST /projects/:projectId/sessions` 请求：

```json
{
  "title": "新的会话"
}
```

Server 生成 Session ID，追加 `session.created`，再创建 Project/Session
关系，返回 Session 摘要和空消息列表。

### 8.2 Session API

```text
GET   /sessions/:sessionId
PATCH /sessions/:sessionId
POST  /sessions/:sessionId/archive
POST  /sessions/:sessionId/restore
DELETE /sessions/:sessionId
```

`GET` 返回 Session Projection 和消息列表。`PATCH` 当前只允许修改标题：

```json
{
  "title": "新的会话标题"
}
```

`DELETE` 不执行 SQL DELETE，而是追加 `session.deleted`。如果 Session 已被
删除，接口保持幂等并返回当前删除状态；如果 Session 已归档，则仍然可以
追加 tombstone。

`POST /archive` 和 `POST /restore` 也应保持幂等：

- 已归档再次归档不重复追加事件；
- 未归档恢复返回当前状态，不追加无意义事件；
- 已删除 Session 返回 `session-already-deleted`；
- 归档、恢复和删除由 Server 调用 Session Service，而不是由 HTTP Handler
  直接拼接事件。

Session Service 至少提供以下内部操作：

```ts
interface SessionService {
  create(projectId: string, title?: string): Promise<SessionDetail>;
  get(sessionId: string): Promise<SessionDetail>;
  rename(sessionId: string, title: string): Promise<SessionDetail>;
  archive(sessionId: string): Promise<SessionDetail>;
  restore(sessionId: string): Promise<SessionDetail>;
  delete(sessionId: string): Promise<SessionDetail>;
  assertRunnable(sessionId: string): Promise<void>;
}
```

HTTP 状态码保持简单且稳定：

- `200`：查询和幂等状态操作成功；
- `201`：创建 Project 或 Session 成功；
- `400`：请求体、查询参数或路径参数无效；
- `404`：Project 或 Session 不存在；
- `409`：Session 状态不允许当前操作，或关系重复；
- `422`：事件序列或持久化数据无法投影；
- `500`：未分类的 Server 错误；
- `503`：Runtime 或 Store 尚未可用。

### 8.3 Agent API 的变化

现有：

```text
POST /agent/runs/stream
```

继续保留。它的 `sessionId` 必须先通过 Session Service 验证：

- Session 不存在：返回 `session-not-found`；
- Session 已删除：返回 `session-deleted`；
- Session 已归档：返回 `session-archived`；
- Session 正常：交给 Runtime Agent Runner。

Agent Runner 继续负责追加用户消息、Turn、Step、Assistant Message 和工具
事件。Server 不复制这些写入逻辑。

## 9. 跨 Store 一致性

Project Store 和 Session Event Store 是两个独立接口，不能假设它们之间存在
一个自动的跨 Store 数据库事务。因此 Server 使用明确的应用服务顺序和补偿：

### 9.1 创建 Session

```text
校验 projectId
  -> 追加 session.created
  -> attachSession(projectId, sessionId)
  -> 返回 Session
```

如果 `attachSession` 失败，Server 尝试追加 `session.deleted` tombstone，
并返回原始关系错误。这样不会留下一个可以被 Agent API 继续使用的孤立
Session。若补偿也失败，记录组合错误并在后续列表中隐藏无法关联的 Session。

### 9.2 读取列表

```text
读取 Project
  -> 读取 ProjectSessionRef
  -> 逐个读取 Session events
  -> projectSession()
  -> 过滤 deletedAt
  -> 生成 SessionSummary
```

关系索引是查询入口，Session Event Store 是 Session 状态的权威来源。关系
指向不存在或损坏事件的 Session 不会让整个项目列表崩溃；Server 跳过该
Session，继续返回其他有效 Session，并在响应的 `warnings` 中返回可诊断的
`session-projection-invalid` 条目：

```ts
interface ProjectListWarning {
  readonly code: 'session-projection-invalid';
  readonly sessionId: string;
}

interface ProjectListResponse {
  readonly projects: readonly ProjectWithSessions[];
  readonly warnings: readonly ProjectListWarning[];
}
```

### 9.3 未来的原子性升级

本轮不引入跨 Store 事务协调器。因为默认实现使用同一个 SQLite 文件，
未来可以在不改变 HTTP 契约的前提下增加 Server 级事务协调，或将 Project
和 Session Store 改造成共享连接的适配器。这个升级必须单独记录 ADR，
不能把两个 Store 的内部数据库句柄暴露给 Runtime 或 Studio。

## 10. Server 启动与配置

默认 Server 启动流程改为：

```text
读取并校验 WEAVE_DATA_DIR / WEAVE_DATABASE_FILE
  -> mkdir 数据目录
  -> createSqliteWorkspaceStore()
  -> createSqliteSessionEventStore()
  -> createRuntime({ services })
  -> createServerAgentRunner()
  -> createApp()
```

推荐配置：

```text
WEAVE_DATA_DIR=.weave
WEAVE_DATABASE_FILE=
```

如果 `WEAVE_DATABASE_FILE` 有值，直接使用它；否则将
`WEAVE_DATA_DIR`（默认 `.weave`）与 `weave.sqlite` 拼接为数据库路径。
目录和文件名都必须经过 Zod 校验。Server 测试继续注入临时 SQLite 文件或
In-Memory Store，不依赖用户机器上的真实项目目录。

Runtime 仍然只接收抽象的 `SessionEventStore`，不读取路径、不导入 SQLite。
Workspace Store 也由 Server 组合根创建。

## 11. Studio 加载与交互流程

### 11.1 首次加载

```text
Studio mount
  -> GET /projects
  -> 得到项目树和 SessionSummary
  -> 选中第一个可用 Project/Session
  -> GET /sessions/:sessionId
  -> 渲染消息
```

加载期间显示中文 Loading 状态。请求失败时保留空工作台和重试入口，不使用
隐藏的内存初始数据覆盖真实错误。

### 11.2 创建项目

```text
打开项目创建弹窗
  -> 选择文件夹并填写项目名称
  -> POST /projects
  -> 将返回项目插入树
  -> 进入该项目的空状态
```

浏览器只能把可用的文件夹显示名称和可选路径信息交给 Server。当前阶段不
把 File System Access API 的句柄当成 durable state。

### 11.3 创建和切换会话

创建会话时调用 `POST /projects/:projectId/sessions`，切换会话时调用
`GET /sessions/:sessionId`。会话列表中的标题、归档状态和消息以服务器返回
值为准，切换前的本地流式增量必须在运行结束或取消后由服务端事件恢复。

### 11.4 标题、归档和删除

- 编辑标题：`PATCH /sessions/:sessionId`；
- 归档：`POST /sessions/:sessionId/archive`；
- 恢复：`POST /sessions/:sessionId/restore`；
- 永久删除：`DELETE /sessions/:sessionId`。

操作成功后更新本地树；操作失败时不提前修改 UI，显示中文错误并保留原状态。
运行期间继续禁用项目、会话和会话管理操作，避免把一个正在写入的 Session
切换到另一个生命周期状态。

### 11.5 Agent 消息恢复

发送消息时仍使用 `/agent/runs/stream`。浏览器只把当前用户消息和流式
assistant 占位符作为 transient UI，运行成功后重新请求当前 Session 或使用
返回的 `lastSequence` 增量恢复。刷新页面时，所有完整消息都来自
`GET /sessions/:sessionId` 的 Projection。

## 12. 错误与恢复策略

### 12.1 Store 错误

`@weave/session` 保留现有错误码，并增加一致的 Workspace 错误码：

```text
session-store-closed
session-store-invalid-input
session-store-io
session-store-protocol

workspace-store-closed
workspace-store-invalid-input
workspace-store-io
workspace-project-not-found
workspace-session-already-attached

session-not-found
session-archived
session-deleted
session-already-deleted
session-projection-invalid
server-internal-error
```

Server 只向客户端暴露稳定错误码，不暴露 SQLite 原始错误信息。未知错误
统一映射为 `server-internal-error`，详细原因只写本地日志。

### 12.2 数据损坏

如果 SQLite 中的事件 JSON、事件序号或 Project 行不能通过 Schema：

- 对单个 Session 的读取返回 `session-projection-invalid`；
- 不允许 Agent 继续写入该 Session；
- 项目列表仍可返回其他可用 Project/Session；
- Server 日志记录 Session ID、sequence 和错误类别，不记录用户消息正文。

### 12.3 Server 重启

Server 启动后重新打开两个 SQLite Store，Studio 再次调用 `GET /projects`。
正在运行的 Agent 不会伪装成可恢复的 live state；如果重启前只写入了
`turn.started` 或 `step.started`，后续的恢复/失败收尾由未来的后台 Run
能力负责。本轮只保证已经持久化的 durable events 不丢失。

## 13. 测试策略

### 13.1 `@weave/session`

新增或修改测试：

- 生命周期事件 Schema；
- rename、archive、restore、delete 的 Projection；
- 删除后的事件被拒绝；
- 删除后的 Projection 包含 `deletedAt`；
- 归档 Session 的状态恢复；
- SQLite 关闭后重开仍能恢复事件；
- tombstone 不会物理删除已有事件。

### 13.2 `@weave/workspace`

测试：

- Project 创建、查询和排序；
- `folderPath` 可选与输入校验；
- Project/Session 关系创建和重复关系拒绝；
- SQLite 关闭后重开能恢复 Project 和关系；
- Store 关闭、损坏数据和不存在 Project 的错误；
- In-Memory 与 SQLite 遵循同一接口契约。

### 13.3 `apps/server`

测试：

- `GET /projects` 返回 Project 和 Session 摘要；
- 创建 Project 和 Session；
- 标题修改、归档、恢复和 tombstone 删除；
- 已删除或已归档 Session 无法启动 Agent；
- 跨 Store 失败时执行删除 tombstone 补偿；
- HTTP 输入、错误码和状态码；
- 默认组合根使用可注入的 Store。

### 13.4 `apps/studio`

测试：

- 首次加载通过 API 构建项目树；
- 失败状态显示重试入口；
- 标题、归档、恢复和删除调用正确的 API；
- 切换会话加载对应消息；
- Agent 流式状态仍然正常；
- 运行期间管理按钮保持禁用。

测试放在各自的 `test/` 目录，不在 `src/` 中放测试文件。

## 14. 实施顺序

为了保持每个提交和 PR 仍然可审查，实施拆成以下阶段：

1. 扩展 `@weave/session` 生命周期事件和 Projection；
2. 新增 `@weave/workspace` 包及 In-Memory/SQLite Project Store；
3. 增加 Server 的 Project/Session Service 和 HTTP API；
4. 将 Server 默认装配切换到 `.weave/weave.sqlite`；
5. 将 Studio 的项目树和会话详情改为 API 数据源；
6. 接入加载、错误、恢复和 Agent 状态回填；
7. 运行完整检查并补充学习文档。

每个阶段都应先更新测试，再写最小实现；跨包契约变化先更新本设计或新增
ADR。实现计划会在本设计通过评审后单独编写。

## 15. 设计取舍与学习要点

### 15.1 为什么要拆 Project Store 和 Session Event Store？

Project 是工作区组织信息，Session 是 Agent 运行事实。项目名称可以修改，
文件夹身份可以被工作台展示，而消息、Turn、Tool Call 是需要按顺序保留的
事件。把它们放在同一个表或同一个领域对象中，会让“修改项目名称”和
“追加 Agent 事实”共享错误的并发与删除语义。

拆开以后：

- Project Store 适合普通 CRUD 查询；
- Session Store 适合 append-only 和 Projection；
- Runtime 只依赖 Session 抽象；
- Workspace/Sandbox 未来可以独立演进。

### 15.2 为什么删除不用 SQL DELETE？

Session 是 Agent 的历史事实。物理删除会让“这个 Session 是否曾经运行过”
无法回答，也会破坏事件序号、诊断和未来迁移。`session.deleted` 是一个
tombstone：它保留删除事实，让正常查询隐藏对象，同时保持 Event Store 的
append-only 不变量。

### 15.3 为什么 Studio 不直接读数据库？

前端直接读数据库会把 SQLite schema、Node API 和安全边界带入浏览器，
以后无法替换为桌面壳、CLI 或远程 Server。HTTP API 让 Studio 只依赖稳定
的请求/响应契约，Server 负责校验和组合，Runtime 负责 Agent 行为。

### 15.4 为什么不把 transient state 也持久化？

AbortSignal、SSE 连接、当前 Promise 和面板展开状态不是业务事实。它们在
进程退出后没有可重建语义，写入 Session Event 只会制造假的“可恢复”状态。
本轮只持久化已经发生的消息和生命周期事实。
