# Studio Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Weave Studio 通过 Server 访问本地 SQLite 持久化的 Project、Session、消息和生命周期状态，刷新或重启后仍能恢复工作台。

**Architecture:** 新增 `@weave/workspace` 保存 Project 元数据和
Project/Session 关系；`@weave/session` 继续以 append-only 事件保存 Session
事实，并扩展标题、归档、恢复和删除 tombstone；`apps/server` 组合两个 Store
并提供薄 HTTP API，`apps/studio` 只消费 API 和 SSE，不直接访问 Node 或
Session 包。

**Tech Stack:** TypeScript、ESM、strict typing、Zod、Node.js 24.4
`node:sqlite`、Hono、React 19、Vite、Vitest、Turborepo、pnpm。

**Spec:** `docs/superpowers/specs/2026-11-16-studio-session-persistence-design.md`

## Global Constraints

- 使用 TypeScript、ESM 和 strict typing。
- 外部输入必须先通过 Zod 校验。
- Durable facts 必须 append-only；Session 的“永久删除”使用 `session.deleted` tombstone。
- Durable Session events 与 transient live-control state 必须分离。
- HTTP handlers 保持薄；Session 状态机和 Agent 行为放在 Server Service/Runtime。
- Agent 工具仍然必须通过共享 Tool Pipeline 执行。
- `@weave/runtime` 不依赖 Hono、React、Node HTTP 或 `@weave/workspace`。
- Workspace 文件读写、Git 状态、Sandbox、Plugin、Crew 和 Run Registry 不在本轮实现。
- 测试放在对应 package 或 app 的 `test/` 目录。
- 不新增数据库依赖，SQLite 使用 Node.js 24.4 的 `node:sqlite`。
- 每个任务完成独立测试后提交；提交信息使用中文 Conventional Commits。
- 远程分支保留；最终 PR 使用 Squash Auto-Merge 合入 `main`。

## 文件地图

本计划会新增或修改以下文件。实现过程中如果发现需要额外文件，必须先把
文件职责补进当前任务，再开始编辑，避免在多个包之间产生隐式耦合。

### Session 包

- Modify: `packages/session/src/events.ts`
  - 增加四类 Session 生命周期事件和 Zod Schema。
- Modify: `packages/session/src/projection.ts`
  - 投影 `archivedAt`、`deletedAt`，校验生命周期状态转换。
- Modify: `packages/session/test/schemas.test.ts`
  - 覆盖新增事件的输入和持久化 Schema。
- Modify: `packages/session/test/projection.test.ts`
  - 覆盖 rename、archive、restore、delete 和非法顺序。
- Modify: `packages/session/test/memory-store.test.ts`
  - 覆盖事件仍然可读、Store 不执行物理删除。
- Modify: `packages/session/test/sqlite-store.test.ts`
  - 覆盖关闭后重开仍能读到 tombstone。

### Workspace 包

- Create: `packages/workspace/package.json`
  - 声明 `@weave/workspace`、构建、lint、typecheck 和 test 脚本。
- Create: `packages/workspace/tsconfig.json`
  - 沿用根 strict 配置，输出 `dist` 声明文件。
- Create: `packages/workspace/src/types.ts`
  - 定义 Project、Session 关系、Store 错误和 Zod Schema。
- Create: `packages/workspace/src/store.ts`
  - 定义 `ProjectStore` 接口和错误类型。
- Create: `packages/workspace/src/memory-store.ts`
  - 实现 In-Memory Project Store。
- Create: `packages/workspace/src/sqlite-store.ts`
  - 实现 SQLite Project Store 和表初始化。
- Create: `packages/workspace/src/index.ts`
  - 导出公共接口和两个 Store 工厂。
- Create: `packages/workspace/test/store-contract.test.ts`
  - 通过同一组测试验证 In-Memory 和 SQLite 的行为契约。

### Server

- Modify: `apps/server/package.json`
  - 增加 `@weave/workspace` workspace dependency。
- Modify: `apps/server/src/runtime.ts`
  - 允许组合根注入 Session Store 工厂，默认测试运行时继续使用内存 Store。
- Create: `apps/server/src/session-service.ts`
  - 实现 Session 生命周期、Project/Session 关系和摘要转换。
- Create: `apps/server/src/workspace-api.ts`
  - 注册 Project 与 Project Session HTTP 路由。
- Create: `apps/server/src/session-api.ts`
  - 注册 Session 详情、标题、归档、恢复、删除路由。
- Modify: `apps/server/src/app.ts`
  - 将 Workspace Store 和 Session Service 注入 HTTP 应用。
- Modify: `apps/server/src/agent-api.ts`
  - Agent 流开始前调用 `assertRunnable()`。
- Modify: `apps/server/src/main.ts`
  - 默认创建 `.weave/weave.sqlite`，协调 Workspace Store 关闭。
- Create: `apps/server/test/session-service.test.ts`
  - 测试领域服务状态转换和跨 Store 补偿。
- Create: `apps/server/test/workspace-api.test.ts`
  - 测试 Project 和 Project Session API。
- Create: `apps/server/test/session-api.test.ts`
  - 测试 Session 生命周期 API。
- Modify: `apps/server/test/agent-api.test.ts`
  - 给 Agent API 测试注入 Session Service，并覆盖已归档/已删除拒绝。
- Modify: `apps/server/test/health.test.ts`
  - 验证默认启动可以装配可关闭的持久化依赖。

### Studio

- Modify: `apps/studio/vite.config.ts`
  - 为 `/projects` 和 `/sessions` 增加本地 Server proxy。
- Create: `apps/studio/src/features/workspace/workspace-types.ts`
  - 定义浏览器端 Project、Session Summary、Session Detail 和 API error Schema。
- Create: `apps/studio/src/features/workspace/workspace-api.ts`
  - 封装加载、创建、修改、归档、恢复和删除请求。
- Modify: `apps/studio/src/app/App.tsx`
  - 移除持久化数据的唯一内存初始值，接入 API 加载和保存。
- Modify: `apps/studio/test/App.test.tsx`
  - 为 API 请求建立可复用的 fetch mock，覆盖加载和管理操作。
- Create: `apps/studio/test/workspace-api.test.ts`
  - 测试浏览器端 API Schema、状态码和错误映射。

### 学习文档

- Create: `docs/learning/2026-11-16-studio-session-persistence.md`
  - 用中文解释 Project Store、Session Event Store、Projection、tombstone、
    HTTP Service 和 Studio 恢复流程。

---

### Task 1: 扩展 Session 生命周期事件与 Projection

**Files:**

- Modify: `packages/session/src/events.ts`
- Modify: `packages/session/src/projection.ts`
- Modify: `packages/session/test/schemas.test.ts`
- Modify: `packages/session/test/projection.test.ts`
- Modify: `packages/session/test/memory-store.test.ts`
- Modify: `packages/session/test/sqlite-store.test.ts`

**Interfaces:**

- Consumes: 现有 `SessionEventStore`、`SessionEvent`、`projectSession()`。
- Produces: `session.renamed`、`session.archived`、`session.restored`、
  `session.deleted` 四种 `NewSessionEvent`，以及带
  `archivedAt: string | undefined` 和 `deletedAt: string | undefined` 的
  `SessionProjection`。

- [ ] **Step 1: 为生命周期 Schema 写失败测试**

在 `packages/session/test/schemas.test.ts` 增加四组合法事件，并增加以下非法
输入断言：

```ts
expect(() =>
  newSessionEventSchema.parse({
    type: 'session.renamed',
    payload: { title: '' },
  }),
).toThrow();

expect(() =>
  newSessionEventSchema.parse({
    type: 'session.archived',
    payload: { reason: 1 },
  }),
).toThrow();
```

在 `packages/session/test/projection.test.ts` 增加一个完整生命周期：

```ts
const state = projectSession([
  event(1, 'session.created', { title: '初始标题' }),
  event(2, 'session.renamed', { title: '新标题' }),
  event(3, 'session.archived', {}),
  event(4, 'session.restored', {}),
  event(5, 'session.archived', {}),
  event(6, 'session.deleted', {}),
]);

expect(state).toMatchObject({
  title: '新标题',
  archivedAt: expect.any(String),
  deletedAt: expect.any(String),
  lastSequence: 6,
});
```

再增加删除后追加事件、删除后恢复、归档后创建 Turn 和重复归档/恢复的失败
用例。每个用例都断言 `SessionProjectionError.code` 为稳定的
`session-projection-invalid-order`。

- [ ] **Step 2: 运行 Session 测试确认失败**

Run:

```bash
pnpm --filter @weave/session test
```

Expected: 新增 Schema 测试因未知事件类型或 Projection 缺少字段而失败，现有
测试应继续通过。

- [ ] **Step 3: 实现新增事件 Schema**

在 `packages/session/src/events.ts` 增加：

```ts
const sessionRenamePayloadSchema = z.object({
  title: nonEmptyStringSchema,
}).passthrough();

const sessionLifecyclePayloadSchema = z.object({
  reason: z.string().optional(),
}).passthrough();
```

把四个事件加入 `sessionEventPayloadSchema` 和
`persistedEventSchemas`。保持事件 Envelope 的 `eventId`、`sequence`、
`occurredAt` 仍由 Store 生成，调用方不能提交这些字段。

- [ ] **Step 4: 实现 Projection 生命周期状态机**

在 `packages/session/src/projection.ts` 中新增局部变量：

```ts
let archivedAt: string | undefined;
let deletedAt: string | undefined;
```

按事件顺序处理：

- `session.renamed`：只允许在未删除时修改 `title`；
- `session.archived`：只允许在未删除且当前未归档时设置
  `archivedAt = event.occurredAt`；
- `session.restored`：只允许在未删除且当前已归档时清除 `archivedAt`；
- `session.deleted`：只允许在未删除时设置 `deletedAt`，并视为终态；
- 任意后续事件先检查 `deletedAt !== undefined`，然后抛出
  `session-projection-invalid-order`。

对 `turn.started`、`message.created`、`tool-call.created` 和其他现有事件
增加“Session 已归档时拒绝”的状态检查。返回值中增加两个只读字段，不修改
输入事件。

- [ ] **Step 5: 运行测试并补充 Store 恢复断言**

Run:

```bash
pnpm --filter @weave/session test
pnpm --filter @weave/session typecheck
pnpm --filter @weave/session lint
```

Expected: Session 包全部通过；SQLite 关闭后重新打开可以读到
`session.deleted`，并且事件序号保持连续。删除后的事件序列由
`projectSession()` 拒绝，Event Store 本身仍只负责保存事实，不实现业务状态机。

- [ ] **Step 6: 提交**

```bash
git add packages/session
git commit -m "feat: 增加会话生命周期事件"
```

### Task 2: 新增 `@weave/workspace` Project Store

**Files:**

- Create: `packages/workspace/package.json`
- Create: `packages/workspace/tsconfig.json`
- Create: `packages/workspace/src/types.ts`
- Create: `packages/workspace/src/store.ts`
- Create: `packages/workspace/src/memory-store.ts`
- Create: `packages/workspace/src/sqlite-store.ts`
- Create: `packages/workspace/src/index.ts`
- Create: `packages/workspace/test/store-contract.test.ts`
- Modify: `eslint.config.js`

**Interfaces:**

- Consumes: Zod、Node `crypto`、Node `path`、Node `sqlite`。
- Produces:

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

- [ ] **Step 1: 创建包骨架和失败契约测试**

在 `packages/workspace/package.json` 中使用与 `@weave/session` 相同的
`build`、`lint`、`test` 和 `typecheck` 脚本。dependencies 只增加 `zod`，
devDependencies 增加 `@types/node`。`packages/workspace/tsconfig.json` 继承
根配置，`rootDir` 为 `src`，`outDir` 为 `dist`。

在 `packages/workspace/test/store-contract.test.ts` 先定义一个工厂参数化测试：

```ts
type StoreFactory = () => Promise<{
  store: ProjectStore;
  cleanup: () => Promise<void>;
}>;

function describeProjectStore(name: string, createStore: StoreFactory): void {
  describe(name, () => {
    it('creates and lists projects in creation order', async () => {
      // 断言 Project ID、时间字段由 Store 生成。
    });

    it('attaches a session once and rejects duplicate relations', async () => {
      // 断言重复关系返回 workspace-session-already-attached。
    });

    it('restores projects and relations after SQLite reopen', async () => {
      // In-Memory 工厂在这里跳过；SQLite 工厂关闭后重开。
    });

    it('rejects invalid input and operations after close', async () => {
      // 断言 Zod 输入错误和 workspace-store-closed。
    });
  });
}
```

测试文件必须同时调用 In-Memory 和 SQLite 工厂，不能只测试一个实现。

- [ ] **Step 2: 运行 Workspace 测试确认包尚未实现**

Run:

```bash
pnpm --filter @weave/workspace test
```

Expected: 因包文件和工厂未定义而失败；失败只应来自新包，不修改其他包。

- [ ] **Step 3: 定义 Project、关系和错误 Schema**

在 `packages/workspace/src/types.ts` 中定义：

```ts
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly folderName: string;
  readonly folderPath: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectSessionRef {
  readonly projectId: string;
  readonly sessionId: string;
  readonly createdAt: string;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly folderName: string;
  readonly folderPath?: string;
}
```

`folderPath` 为空或绝对路径才合法；名称使用非空字符串；Project ID 和
Session ID 使用非空字符串。Store 错误码固定为：

```ts
type WorkspaceStoreErrorCode =
  | 'workspace-store-closed'
  | 'workspace-store-invalid-input'
  | 'workspace-store-io'
  | 'workspace-store-protocol'
  | 'workspace-project-not-found'
  | 'workspace-session-already-attached';
```

- [ ] **Step 4: 实现 In-Memory Store**

使用：

```ts
Map<string, Project>
Map<string, ProjectSessionRef[]>
```

每次返回前用 `structuredClone()` 复制 Project 和关系，防止测试或上层修改
Store 内部状态。`attachSession()` 必须先校验 Project 存在，再检查同一
Project 下是否已经有相同 Session ID。列表按 `createdAt` 升序返回，`close()`
清空 Map，关闭后所有操作都抛出 `workspace-store-closed`。

- [ ] **Step 5: 实现 SQLite Store**

在 `packages/workspace/src/sqlite-store.ts` 初始化：

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

`createSqliteWorkspaceStore({ filename })` 的构造参数先通过 Zod 校验。
`createProject()` 使用 `randomUUID()` 和同一个 ISO 时间值写入创建/更新时间。
`attachSession()` 使用事务插入关系，把 SQLite 主键冲突转换为
`workspace-session-already-attached`。读出的每一行都先转换为 `unknown`，
再通过 Project/关系 Schema 校验，失败时返回 `workspace-store-protocol`。

- [ ] **Step 6: 更新边界规则并运行 Workspace 全部检查**

在 `eslint.config.js`：

- 把 `@weave/workspace` 加入 `workspacePackageNames`；
- 增加 package layer，允许依赖为空；
- 让 `@weave/server` 的 allowed dependencies 增加 `@weave/workspace`。

Run:

```bash
pnpm exec prettier --check packages/workspace
pnpm --filter @weave/workspace lint
pnpm --filter @weave/workspace typecheck
pnpm --filter @weave/workspace test
```

如果 Workspace 包没有单独的 `format:check` 脚本，改为：

```bash
pnpm exec prettier --check packages/workspace
```

- [ ] **Step 7: 提交**

```bash
git add packages/workspace eslint.config.js
git commit -m "feat: 增加工作区项目存储"
```

### Task 3: 实现 Server Session Service 与 Project/Session API

**Files:**

- Modify: `apps/server/package.json`
- Modify: `apps/server/src/runtime.ts`
- Create: `apps/server/src/session-service.ts`
- Create: `apps/server/src/workspace-api.ts`
- Create: `apps/server/src/session-api.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/agent-api.ts`
- Create: `apps/server/test/session-service.test.ts`
- Create: `apps/server/test/workspace-api.test.ts`
- Create: `apps/server/test/session-api.test.ts`
- Modify: `apps/server/test/agent-api.test.ts`
- Modify: `apps/server/test/health.test.ts`

**Interfaces:**

- Consumes: `ProjectStore`、`SessionEventStore`、`projectSession()`、
  `@hono` 和 Zod。
- Produces:

```ts
export interface SessionService {
  create(projectId: string, title?: string): Promise<SessionDetail>;
  get(sessionId: string): Promise<SessionDetail>;
  listProjectSessions(
    projectId: string,
    options?: { readonly includeArchived?: boolean },
  ): Promise<SessionListResult>;
  rename(sessionId: string, title: string): Promise<SessionDetail>;
  archive(sessionId: string): Promise<SessionDetail>;
  restore(sessionId: string): Promise<SessionDetail>;
  delete(sessionId: string): Promise<SessionDetail>;
  assertRunnable(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface SessionListResult {
  readonly sessions: readonly SessionSummary[];
  readonly warnings: readonly ProjectListWarning[];
}

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly archivedAt: string | undefined;
  readonly deletedAt: string | undefined;
  readonly lastSequence: number;
  readonly lastMessage: Message | undefined;
}

export interface SessionDetail extends SessionSummary {
  readonly messages: readonly Message[];
}

export interface ProjectListWarning {
  readonly code: 'session-projection-invalid';
  readonly sessionId: string;
}
```

- [x] **Step 1: 定义服务错误和 API 测试辅助工厂**

在 `apps/server/src/session-service.ts` 定义稳定的 Service 错误码：

```ts
type SessionServiceErrorCode =
  | 'session-not-found'
  | 'session-archived'
  | 'session-deleted'
  | 'session-projection-invalid';
```

服务错误需要保留 `code`、`message` 和可选 `cause`。在测试中增加
`createInMemorySessionTestContext()`，创建 In-Memory Project Store、
In-Memory Session Store 和 Service，并在每个用例后关闭两个 Store。

- [x] **Step 2: 写 Session Service 的失败测试**

在 `apps/server/test/session-service.test.ts` 覆盖：

```ts
it('creates a session and attaches it to a project', async () => {
  const result = await service.create(project.id, '测试会话');
  expect(result.title).toBe('测试会话');
  expect(await projectStore.listSessionRefs(project.id)).toHaveLength(1);
});

it('compensates with a delete tombstone when attachment fails', async () => {
  // 使用一个会对 attachSession 抛错的 ProjectStore stub。
  // 断言 Session Event Store 最后一条事件为 session.deleted。
});

it('rejects agent runs for archived and deleted sessions', async () => {
  await service.archive(session.id);
  await expect(service.assertRunnable(session.id)).rejects.toMatchObject({
    code: 'session-archived',
  });
  await service.delete(session.id);
  await expect(service.assertRunnable(session.id)).rejects.toMatchObject({
    code: 'session-deleted',
  });
});
```

在 `workspace-api.test.ts` 和 `session-api.test.ts` 先写 HTTP 级失败测试：
创建、查询、重命名、归档、恢复、删除和无效输入分别断言状态码与
`{ error: { code, message } }` 结构。

- [x] **Step 3: 运行 Server 测试确认失败**

Run:

```bash
pnpm --filter @weave/server test
```

Expected: 新增测试因 Service、路由和 `AppOptions` 尚未存在而失败；已有健康
检查和 Approval 测试的失败只能来自接口注入变化，不允许删除原有行为断言。

- [x] **Step 4: 实现 Session Service**

`create()` 按下面顺序执行：

```text
getProject(projectId)
  -> 生成 sessionId
  -> append(session.created)
  -> attachSession(projectId, sessionId)
  -> get(sessionId)
```

`attachSession()` 失败时追加：

```ts
await sessionStore.append(sessionId, [
  { type: 'session.deleted', payload: { reason: 'project-session-attach-failed' } },
]);
```

然后重新抛出原始 Workspace 错误；补偿失败时抛出带 `cause` 的组合错误。

`get()` 读取完整事件并调用 `projectSession()`。标题为空时返回
`未命名会话`；最后一条 `message.created` 转换为 `lastMessage`。`listProjectSessions()`
只读取关系指向的 Session，跳过已删除或损坏 Projection，并返回
`{ sessions, warnings }`；API 层把这个结构直接放进项目列表响应。

`rename()`、`archive()`、`restore()`、`delete()` 都先投影当前状态，再按设计
文档里的状态转换规则追加一个事件。重复归档和重复删除保持幂等；已删除
Session 的恢复返回 `session-deleted` 和 HTTP 状态码 `410`。`assertRunnable()` 只允许
未归档、未删除的 Session。删除接口对重复删除返回当前详情，不重复追加
tombstone。

- [x] **Step 5: 实现 Project 和 Session 路由**

在 `workspace-api.ts` 注册：

```text
GET  /projects
POST /projects
GET  /projects/:projectId/sessions
POST /projects/:projectId/sessions
```

在 `session-api.ts` 注册：

```text
GET   /sessions/:sessionId
PATCH /sessions/:sessionId
POST  /sessions/:sessionId/archive
POST  /sessions/:sessionId/restore
DELETE /sessions/:sessionId
```

请求体使用 `.strict()` Schema。路径参数和 `includeArchived` 查询参数也先
通过 Zod 校验。Handler 只负责解析输入、调用 Service、映射错误和返回 JSON，
不在路由中拼装 Session events。

统一错误映射：

```text
400 -> workspace-store-invalid-input / invalid-request
404 -> workspace-project-not-found / session-not-found
409 -> workspace-session-already-attached / session-archived
410 -> session-deleted
422 -> session-projection-invalid
500 -> server-internal-error
503 -> session-service-unavailable
```

`DELETE /sessions/:sessionId` 对已经追加 tombstone 的 Session 返回 `200` 和
当前 SessionDetail，保证重复点击删除不会把前端带入错误状态；`restore` 对
已删除 Session 返回 `410 session-deleted`。

- [x] **Step 6: 把 Service 接入 App 和 Agent API**

扩展 `AppOptions`：

```ts
export interface AppOptions {
  readonly agentRunner?: AgentRunner;
  readonly projectStore?: ProjectStore;
  readonly sessionService?: SessionService;
}
```

`createApp()` 注册两个新路由。`agent-api.ts` 在获取 Agent Runner 前先检查
`sessionService`；生产组合必须注入它，测试里使用共享的 In-Memory Service。
对于未注入 Service 的调用返回 `503 session-service-unavailable`，保留已有
“没有 Agent Runner 返回 503”的行为。

修改 Server 测试中所有依赖 Runner 的 App 构造，使用测试上下文创建一个
已存在的 `session-http-1`，避免 Agent 请求因为 Session 不存在而提前失败。

- [x] **Step 7: 运行 Server 测试与类型检查**

Run:

```bash
pnpm --filter @weave/server lint
pnpm --filter @weave/server typecheck
pnpm --filter @weave/server test
```

Expected: 新增 API、Service、Agent 状态校验和原有 Approval/Health/SSE 行为
全部通过。

- [x] **Step 8: 提交**

```bash
git add apps/server packages/workspace/package.json
git commit -m "feat: 增加项目与会话管理接口"
```

### Task 4: 切换 Server 到本地 SQLite 持久化

**Files:**

- Modify: `apps/server/src/runtime.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/test/health.test.ts`
- Modify: `apps/server/test/session-api.test.ts`
- Create: `apps/server/test/persistence-fixture.ts`

**Interfaces:**

- Consumes: `createSqliteSessionEventStore()`、`createSqliteWorkspaceStore()`、
  `createSessionEventStoreService()`。
- Produces: `startServer(port, options?)` 在未传入测试 Store 时使用
  `.weave/weave.sqlite`，并在停止时关闭 Workspace Store 和 Runtime Store。

- [x] **Step 1: 写默认持久化的重启测试**

在 `apps/server/test/health.test.ts` 增加临时数据库目录测试：

```ts
const first = await startServer(temporaryPort, {
  databaseFile: filename,
});
const project = await postProject(first.port, {
  name: 'Weave',
  folderName: 'weave',
});
await first.stop();

const second = await startServer(nextPort, { databaseFile: filename });
expect(await getProjects(second.port)).toContainEqual(
  expect.objectContaining({ name: 'Weave' }),
);
await second.stop();
```

测试必须使用 `tmpdir()` 生成唯一文件，结束时 `rm(..., { force: true })`。

- [x] **Step 2: 运行测试确认默认持久化尚未接入**

Run:

```bash
pnpm --filter @weave/server test -- health.test.ts
```

Expected: 新增重启测试失败，因为 `startServer()` 还没有数据库配置参数和
Workspace Store 生命周期。

- [x] **Step 3: 实现数据库配置 Schema**

在 `apps/server/src/main.ts` 定义：

```ts
const persistenceOptionsSchema = z.object({
  dataDirectory: z.string().min(1).default('.weave'),
  databaseFile: z.string().min(1).optional(),
});
```

解析规则：

- 调用方传入 `databaseFile` 时直接使用；
- 未传入时使用 `path.join(dataDirectory, 'weave.sqlite')`；
- 启动前 `mkdir(dataDirectory, { recursive: true })`；
- 文件路径和目录路径在进入 Store 工厂前完成校验。

为了让测试可以注入内存 Store，`startServer()` 的 options 同时支持：

```ts
interface StartServerOptions {
  readonly databaseFile?: string;
  readonly dataDirectory?: string;
  readonly projectStore?: ProjectStore;
  readonly sessionStoreFactory?: () => SessionEventStore | Promise<SessionEventStore>;
}
```

当传入 `projectStore` 时直接使用它；当传入 `sessionStoreFactory` 时通过
Runtime Service 使用它；两个依赖都传入时不创建默认 SQLite 文件。未传入时，
Server 根据解析后的 `databaseFile` 分别创建 SQLite Project Store 和
SQLite Session Event Store。

- [x] **Step 4: 实现启动、失败清理和停止清理**

启动顺序：

```text
解析配置
  -> 创建 Workspace Store
  -> 创建 Runtime 和 Session Store Service
  -> runtime.start()
  -> 从 Runtime 获取 Session Store
  -> 创建 Session Service
  -> createApp()
  -> bind HTTP server
```

任何后续步骤失败，都按逆序关闭已创建的 Store 和 HTTP Server，并保留原始
错误。`stop()` 先关闭 HTTP Server，再停止 Runtime，最后关闭 Workspace
Store。Runtime 仍负责关闭 Session Store。

- [x] **Step 5: 运行 Server 持久化测试**

Run:

```bash
pnpm --filter @weave/server lint
pnpm --filter @weave/server typecheck
pnpm --filter @weave/server test
```

Expected: 同一个 SQLite 文件关闭并重启 Server 后，Project、Session 标题、
归档状态和消息都可以读取；停止重复调用不会抛错。

- [x] **Step 6: 提交**

```bash
git add apps/server
git commit -m "feat: 接入本地 SQLite 持久化"
```

### Task 5: 将 Studio 项目树和会话详情改为 API 数据源

**Files:**

- Modify: `apps/studio/vite.config.ts`
- Create: `apps/studio/src/features/workspace/workspace-types.ts`
- Create: `apps/studio/src/features/workspace/workspace-api.ts`
- Modify: `apps/studio/src/app/App.tsx`
- Modify: `apps/studio/test/App.test.tsx`
- Create: `apps/studio/test/workspace-api.test.ts`

**Interfaces:**

- Consumes: Project/Session HTTP API 和现有 `/agent/runs/stream` SSE。
- Produces:

```ts
export interface WorkspaceApi {
  listProjects(options?: { readonly includeArchived?: boolean }): Promise<ProjectListResponse>;
  getSession(sessionId: string): Promise<SessionDetail>;
  createProject(input: CreateProjectInput): Promise<Project>;
  createSession(projectId: string, title?: string): Promise<SessionDetail>;
  renameSession(sessionId: string, title: string): Promise<SessionDetail>;
  archiveSession(sessionId: string): Promise<SessionDetail>;
  restoreSession(sessionId: string): Promise<SessionDetail>;
  deleteSession(sessionId: string): Promise<SessionDetail>;
}
```

- [ ] **Step 1: 建立浏览器 API Schema 和失败测试**

在 `workspace-types.ts` 中定义与 Server 响应一一对应的 Zod Schema。浏览器
只接受：

```ts
type ProjectListResponse = {
  readonly projects: readonly ProjectWithSessions[];
  readonly warnings: readonly ProjectListWarning[];
};
```

在 `workspace-api.test.ts` 覆盖：

- `GET /projects` 成功响应；
- 非 JSON 响应转换为 `workspace-api-protocol`；
- `404`、`409` 和 `500` 转换为保留 `code` 的 `WorkspaceApiError`；
- 请求体只包含 API 允许的字段。

- [ ] **Step 2: 运行 Studio 测试确认 API Client 尚未实现**

Run:

```bash
pnpm --filter @weave/studio test -- workspace-api.test.ts
```

Expected: 因 API Client 和类型文件不存在而失败。

- [ ] **Step 3: 实现 Workspace API Client**

在 `workspace-api.ts` 中实现一个 `requestJson()`：

```ts
async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T>
```

流程：

1. 调用 `fetch`；
2. 非 2xx 时解析 `{ error: { code, message } }`；
3. JSON 解析失败抛出 `workspace-api-protocol`；
4. 成功响应通过传入 Schema；
5. 不把原始响应堆栈或 HTML 返回给用户。

路径必须使用 `encodeURIComponent(sessionId/projectId)`，避免 ID 中的特殊
字符破坏路由。

- [ ] **Step 4: 增加 Vite proxy**

在 `apps/studio/vite.config.ts` 增加：

```ts
proxy: {
  '/agent': { target: 'http://127.0.0.1:4317' },
  '/projects': { target: 'http://127.0.0.1:4317' },
  '/sessions': { target: 'http://127.0.0.1:4317' },
},
```

保持现有 `/agent` 行为不变，Studio 开发服务器请求三个前缀都转发到
`http://127.0.0.1:4317`。

- [ ] **Step 5: 将 App 初始加载改成 API 加载**

在 `App.tsx`：

- 删除 `initialProjects` 作为唯一数据源；
- 增加 `isLoadingWorkspace`、`workspaceError` 和 `workspaceApi`；
- `useEffect` 首次调用 `listProjects()`；
- 成功后设置项目树，选择第一个项目的第一个未归档 Session；
- 再调用 `getSession()` 填充完整消息；
- 失败时展示中文错误和“重试加载”按钮；
- 加载状态不启动 Agent、不显示假项目；
- 保留菜单、面板、输入框、运行状态等 transient state。

将 `StudioSession.messages` 与 API 返回的 `Message[]` 做一个单独转换函数，
不要在 JSX 中直接混合 Protocol message 和展示文本。

- [ ] **Step 6: 将创建、编辑、归档、恢复和删除接入 API**

替换这些当前纯内存函数：

```text
createProject()
createSession()
saveSessionTitle()
archiveSession()
restoreSession()
permanentlyDeleteSession()
```

每个函数遵循：

```text
校验当前 UI 状态
  -> 调用 WorkspaceApi
  -> 成功后使用响应更新本地树
  -> 失败时保持原状态并显示中文 notice
```

删除操作仍然先在归档区二次确认，但调用 `DELETE /sessions/:sessionId`；
成功后从正常树和归档区移除。运行状态为 `streaming` 时继续禁用所有会话
管理操作。

- [ ] **Step 7: 为 Studio 测试增加 fetch mock 并验证行为**

在 `App.test.tsx` 建立可读的响应工厂：

```ts
function mockJsonResponse<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
```

每个测试在 `beforeEach` 设置默认 Project/Session 响应，在 `afterEach` 恢复
`globalThis.fetch`。保留现有中文界面、项目树、会话按钮和 SSE 测试，并把
管理操作断言改为“请求成功后 UI 更新”。

- [ ] **Step 8: 运行 Studio 检查**

Run:

```bash
pnpm --filter @weave/studio lint
pnpm --filter @weave/studio typecheck
pnpm --filter @weave/studio test
```

Expected: 刷新式重新挂载可以从 mock API 恢复消息；所有按钮仍然保持原有
交互，API 失败不会静默修改界面。

- [ ] **Step 9: 提交**

```bash
git add apps/studio
git commit -m "feat: 接入 Studio 项目会话持久化"
```

### Task 6: 补充学习文档并完成全量验证

**Files:**

- Create: `docs/learning/2026-11-16-studio-session-persistence.md`
- Modify: `docs/architecture/foundation.md`
- Modify: `docs/superpowers/specs/2026-11-16-studio-session-persistence-design.md`
  only if implementation decisions require a documented correction.

**Interfaces:**

- Consumes: 已实现的 Session、Workspace、Server 和 Studio 代码。
- Produces: 面向学习和面试解释的中文文档，以及可审查的完整验证结果。

- [ ] **Step 1: 写学习文档**

文档按以下顺序解释：

1. 为什么 Project 与 Session 需要拆开；
2. `SessionEventStore` 和 `ProjectStore` 分别保存什么；
3. Projection 如何从事件重建当前状态；
4. 为什么删除是 tombstone；
5. `SessionService` 如何保证状态转换；
6. Server 如何把两个 Store 组合成 HTTP API；
7. Studio 刷新时如何恢复项目树和消息；
8. In-Memory 与 SQLite 在测试中的分工；
9. 面试时如何解释依赖注入、append-only 和 transient state。

每个概念都配一个来自代码的短 TypeScript 示例，避免只写抽象名词。

- [ ] **Step 2: 更新 Foundation 架构说明**

在 `docs/architecture/foundation.md` 增加 Project/Session 持久化路径：

```text
Studio
  -> Project/Session HTTP API
  -> Server SessionService
  -> Workspace ProjectStore + SessionEventStore
  -> Runtime AgentRunner
```

明确说明 Studio 不直接导入 `@weave/session`、`@weave/runtime` 或 Node 模块，
并保留现有 Agent SSE、Runtime 和 Tool Pipeline 的边界说明。

- [ ] **Step 3: 运行完整验证**

Run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
git status --short --branch
```

Expected:

- Prettier、ESLint、TypeScript、Vitest 和 Turborepo build 全部退出码为 `0`；
- 所有测试通过；
- `git diff --check` 没有空白错误；
- 工作区只保留当前功能分支的已提交内容。

- [ ] **Step 4: 提交文档和验证相关修改**

```bash
git add docs/learning/2026-11-16-studio-session-persistence.md docs/architecture/foundation.md
git commit -m "docs: 补充 Studio 会话持久化学习文档"
```

- [ ] **Step 5: 推送、创建 PR 并开启自动合并**

先确认分支、远程和工作区：

```bash
git branch --show-current
git remote -v
git status --short --branch
```

推送当前功能分支：

```bash
git push -u origin HEAD:refs/heads/feat/studio-session-persistence
```

创建一个 PR，标题使用：

```text
feat: 增加 Studio 项目与会话持久化
```

PR 描述只说明问题、架构、行为变化和验证命令，不附加飞书学习文档内容。
确认 CI 通过后开启 Squash Auto-Merge：

```bash
gh pr merge <PR_NUMBER> --auto --squash --repo GitHubxxx17/Weave
```

按用户要求保留远程功能分支；不执行删除远程分支操作。

## Self-Review Checklist

- [ ] 每条设计目标都对应了一个 Task 和至少一个测试层。
- [ ] Session 生命周期事件先于 Workspace、Server 和 Studio 使用。
- [ ] Workspace 不依赖 Runtime、Hono、React 或 Node HTTP。
- [ ] Runtime 仍只接收抽象 `SessionEventStore`，不读取数据库路径。
- [ ] HTTP Handler 不直接拼接 durable events。
- [ ] Studio 不直接访问 SQLite、Node 模块或 Session 包。
- [ ] 删除只追加 tombstone，没有 SQL DELETE。
- [ ] Project 列表遇到损坏 Session 时可以返回有效数据和 warnings。
- [ ] 测试全部位于各包和应用的 `test/` 目录。
- [ ] 所有类型名、接口和步骤都已在本计划或引用的设计文档中定义。
- [ ] 每个 Task 都包含失败测试、最小实现、验证命令和中文提交信息。
