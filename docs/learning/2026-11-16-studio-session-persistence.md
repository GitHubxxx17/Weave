# Weave Studio 项目与会话持久化学习说明

这次改造解决了一个具体问题：Studio 之前可以在浏览器里创建项目、会话和
消息，但刷新页面后这些内容会消失。现在 Studio 只负责展示和交互，
Project、Session 标题、生命周期状态和完整消息由 Server 通过 SQLite 保存。

这篇文档按照一次请求的实际路径解释实现，帮助你从前端视角理解 Agent 产品
为什么需要多个存储边界，以及这些边界在面试中应该怎样说明。

## 1. 先区分 Project 和 Session

Weave 的产品模型是：

```text
Project（项目）
  ├── Session（会话）
  ├── Session（会话）
  └── Session（会话）
```

Project 表示一个本地代码工作区。它保存项目名称、文件夹名称和可选的文件夹
路径。Session 表示一次可以持续进行的 Agent 对话，它保存标题、用户消息、
Agent 消息以及归档和删除状态。

两者拆开有三个原因：

1. 一个项目可以包含多个会话。用户可以把“架构讨论”“修复登录问题”和
   “准备面试”放在同一个代码项目下。
2. 项目的生命周期和会话的生命周期不同。当前版本可以归档会话，但没有实现
   删除项目；如果把它们放在同一个对象中，状态会很快混在一起。
3. Project Store 需要快速列出项目树，Session Event Store 需要保留完整事件。
   两种数据的查询方式和一致性要求不同，应该由不同的边界负责。

前端的 `StudioProject` 是渲染模型，不是数据库模型。它把 API 返回的 Project
和 Session 摘要转换成适合树状界面的结构：

```ts
function toStudioProject(project: ProjectWithSessions): StudioProject {
  return {
    id: project.id,
    name: project.name,
    folderName: project.folderName,
    sessions: project.sessions.map(toStudioSession),
  };
}
```

## 2. 两个 Store 分别保存什么

`@weave/workspace` 的 `ProjectStore` 保存项目元数据和 Project/Session 关系：

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

它知道某个 Session 属于哪个 Project，但不保存 Session 标题和消息。这样
Workspace 包不需要依赖 Runtime，也不会把 Agent 事件模型复制一份。

`@weave/session` 的 `SessionEventStore` 保存 Session 的事件事实，例如：

```text
session.created
turn.started
message.created
tool-call.created
tool-result.created
session.renamed
session.archived
session.restored
session.deleted
```

事件存储的接口只关心追加、读取和关闭。调用方不提交 `eventId`、`sequence`
和 `occurredAt`，这些字段由 Store 生成，避免浏览器或上层服务伪造事件顺序。

可以把两个 Store 记成一句话：

```text
ProjectStore：这个会话属于哪个项目？
SessionEventStore：这个会话发生过什么？
```

## 3. Projection 是怎样恢复当前状态的

事件日志适合追加和审计，但界面需要的是“当前标题是什么”“是否已归档”、
“有哪些消息”。Projection 就是把事件序列折叠成当前状态的过程：

```text
event 1 -> session.created
event 2 -> message.created
event 3 -> session.renamed
event 4 -> session.archived
                    │
                    ▼
          SessionProjection（当前状态）
```

`projectSession()` 按 sequence 顺序读取事件，并维护标题、消息、归档时间和
删除时间。它不修改输入事件，也不写数据库，因此可以在内存中重复执行：

```ts
const projection = projectSession(events);

console.log(projection.title);
console.log(projection.messages);
console.log(projection.archivedAt);
```

这带来一个重要性质：数据库保存的是事实，当前状态是可重建的。如果将来发现
Projection 规则有 bug，可以在不改变历史事件的情况下修复投影逻辑并重新计算。

Projection 还承担顺序校验。例如：

- 没有 `session.created` 就出现消息；
- 已归档 Session 又创建新的 Agent Turn；
- 已删除 Session 后继续追加事件；
- 未归档时重复归档；
- 未归档时尝试恢复。

这些情况会得到稳定的 `session-projection-invalid-order` 错误，而不是让
Studio 得到一个自相矛盾的状态。

## 4. 为什么“永久删除”使用 tombstone

Studio 的“永久删除”当前不会执行 SQL `DELETE`。Server 会追加
`session.deleted` 事件。

这条事件叫 tombstone，表示“这个 Session 曾经存在，但现在已经被删除”。
它仍然是 append-only 事实，因此可以保留：

- 事件序列连续性；
- 审计和故障诊断信息；
- 未来迁移或数据清理所需要的依据；
- 对重复删除、误恢复等请求的明确判断。

删除后，Projection 返回 `deletedAt`，Server 在普通项目列表中隐藏它。Studio
看到的结果像是会话消失了，但底层并没有丢掉历史事件。

需要区分两个概念：

```text
产品层永久删除：追加 deleted tombstone，并从正常列表隐藏
磁盘层物理清理：真正删除事件和数据库记录，需要另一个清理设计
```

后者涉及备份、恢复、用户确认和隐私策略，不应该被当前的按钮名称偷偷实现。

## 5. SessionService 为什么存在

Event Store 保持通用，只负责 Schema 校验、序号生成、事务和持久化。它不应该
猜测“归档后能不能恢复”或“删除后能不能重命名”。这些是业务状态机规则，
由 Server 的 `SessionService` 集中处理：

```text
HTTP Handler
  -> SessionService
      -> 读取 SessionEventStore
      -> projectSession()
      -> 校验当前状态
      -> 追加生命周期事件
      -> 返回新的 Projection
```

实际代码还会处理 Session 不存在、已归档、投影损坏以及跨 Store 补偿。
这样做的好处是 HTTP、CLI 和未来桌面端都可以复用同一套领域规则。

## 6. Server 怎样把两个 Store 组合起来

Server 是组合根。它决定使用 SQLite 还是内存实现，并把依赖注入到 Runtime、
SessionService 和 HTTP 路由：

```text
apps/server/main.ts
  ├── SQLite ProjectStore
  ├── SQLite SessionEventStore factory
  ├── SessionService
  ├── AgentRunner
  └── Hono routes
```

依赖注入的含义是：业务代码依赖接口，启动代码决定具体实现。测试时可以注入
In-Memory Store，不需要创建真实数据库；本地启动时使用
`.weave/weave.sqlite`，Server 重启后重新打开同一个文件。

HTTP Handler 保持薄，只做四件事：

1. 读取请求；
2. 用 Zod 校验外部输入；
3. 调用 Service；
4. 把领域错误映射成稳定 HTTP 状态码和错误码。

例如 `PATCH /sessions/:sessionId` 只负责把请求转给
`sessionService.rename()`，不会在 Handler 中直接拼接 Session 事件。

## 7. Studio 刷新时如何恢复项目树和消息

Studio 不直接导入 `@weave/session`、`@weave/runtime` 或 Node 模块。它只依赖
Server 提供的 JSON 和 SSE 契约。

首次加载流程是：

```text
Studio mount
  -> GET /projects?includeArchived=true
  -> 得到 Project + SessionSummary 树
  -> 选择第一个未归档 Session
  -> GET /sessions/:sessionId
  -> 将 Message[] 转成 ChatMessage[]
  -> 渲染界面
```

项目树只拿 Session 摘要，避免第一次加载就把所有历史消息传到浏览器。用户
切换会话时，再按需调用详情接口。

浏览器端也有一层 Zod Schema：

```ts
const parsed = sessionDetailSchema.safeParse(payload);
if (!parsed.success) {
  throw new WorkspaceApiError(
    'workspace-api-protocol',
    '本地服务返回的数据格式无效',
    response.status,
  );
}
```

Server 的 Zod 校验保护服务端边界，Studio 的 Zod 校验保护浏览器边界。两端
之间传输的是不可信数据，即使 Server 是本地服务，也可能因为版本不一致、
代理错误或数据库损坏返回不符合预期的内容。

创建、重命名、归档、恢复和删除都遵循同一个 UI 规则：

```text
调用 API
  -> API 成功
  -> 用响应更新本地树
API 失败
  -> 不提前改变界面
  -> 显示中文错误
```

## 8. Durable State 和 Transient State

下面这些是 durable state，必须由 Server 和 Store 负责：

- Project 名称和文件夹信息；
- Project 与 Session 的关系；
- Session 标题；
- Session 归档、恢复和删除状态；
- 完整的用户消息和 Agent 消息。

下面这些是 transient state，可以留在 Studio 内存中：

- 输入框当前文字；
- 右侧活动面板是否展开；
- 当前模型菜单是否打开；
- SSE 正在到达的 text delta；
- 当前运行的 AbortController；
- 工具调用过程中的 loading 状态。

流式响应期间，Studio 可以先显示用户消息和 Agent 占位消息，但这些只是实时
反馈。真正能在刷新后恢复的内容，必须由 Agent Runner 追加 durable Session
事件。这样就不会把“页面当前显示过”误当成“系统已经保存”。

## 9. 为什么测试要同时使用内存和 SQLite

两种实现解决不同问题：

```text
In-Memory Store
  -> 快速验证领域行为和 API 逻辑

SQLite Store
  -> 验证真实表结构、事务、重启恢复和文件生命周期
```

Store contract tests 让两种实现遵循同一组行为契约。Server 的持久化测试会
使用临时 SQLite 文件，启动 Server、创建项目和会话、停止 Server，再用同一
文件启动一次，确认标题、归档状态和消息仍然存在。

Studio 测试则 mock `fetch`，重点验证浏览器 API 适配层和界面交互，不需要在
每个 React 测试中启动真实 TCP Server。分层测试可以让失败位置更明确：

- Projection 测试失败：领域状态机有问题；
- Server API 测试失败：HTTP 组合或错误映射有问题；
- Workspace API 测试失败：浏览器契约有问题；
- App 测试失败：界面状态转换有问题。

## 10. 面试时可以怎样解释

可以用下面这段话概括本次设计：

> Weave 把项目元数据和会话事件拆成两个 Store。Project Store 负责项目以及
> Project/Session 关系，Session Event Store 以 append-only 方式保存会话事实。
> Server 通过 SessionService 对 Session 事件做状态机校验，再把领域能力暴露为
> HTTP API。Studio 只消费 API 和 SSE，不直接访问 SQLite 或 Runtime。页面刷新
> 时，Studio 先加载项目和会话摘要，再按需加载 Session Projection 的完整消息。
> 归档和删除都是事件，删除使用 tombstone，因此保留了审计和恢复所需的事实。
> 测试通过依赖注入分别使用内存和 SQLite 实现，既保证测试速度，也验证真实的
> 重启恢复行为。

后续扩展应保持同样的边界：

1. 增加消息增量同步或版本号，减少大 Session 的重复加载；
2. 为运行中的 Agent 增加 Run Registry 和可恢复的后台任务；
3. 为 Workspace 文件访问增加权限、Sandbox 和审批链路；
4. 在 Studio API 客户端中加入取消请求、重试和离线提示；
5. 再把 Crew 多 Agent 编排放到 Runtime 之上，而不是让 Studio 直接编排工具。
