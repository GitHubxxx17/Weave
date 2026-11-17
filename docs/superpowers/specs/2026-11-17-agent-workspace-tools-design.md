# 默认 Agent 接入 Workspace 文件工具与审批卡片设计

## 1. 背景

`@weave/runtime` 已经有 `read_file` / `write_file`、Workspace 路径策略和
Approval Broker，Server 也有审批 REST/SSE 接口，但三处缺口让默认 Agent 不能操作
项目文件：

1. Server 的 Tool Registry 只注册插件工具，没有注册文件工具；
2. Studio 创建项目时不提交 `folderPath`，所有项目都没有工作区目录；
3. `write_file` 需要审批，但 Studio 没有审批界面，Broker 默认不过期，写入会一直挂起。

另外，Agent Runner 目前把任何工具失败都当成整轮失败。接入真实文件后，读错路径、
用户拒绝写入都会让这一轮报错结束，模型没有机会根据错误调整。

## 2. 目标

- 会话所属项目设置了工作区目录时，Agent 可以读写其中的 UTF-8 文本文件；
- 写文件前在 Studio 中显示审批卡片，用户同意后才执行，拒绝后不产生副作用；
- 可恢复的工具失败作为工具结果交还模型，由模型继续回答；
- 桌面端用系统文件夹选择框获取项目绝对路径，浏览器模式可手动填写绝对路径。

## 3. 非目标

- 不做目录列表、搜索、Shell、Diff 和回滚；
- 不支持为已有项目补设目录（需要 Project Store 更新接口，后续单独设计）；
- 审批仍是进程内临时状态，不做持久化审计和重启恢复；
- 不做 Sandbox，文件工具已有的 TOCTOU 残余风险不变。

## 4. 契约变更

### 4.1 `@weave/runtime`：按会话解析 Workspace

`WorkspaceFileToolOptions` 增加二选一的 `resolveWorkspace`：

```ts
type WorkspaceFileToolOptions = WorkspaceFileToolLimits &
  (
    | { readonly workspace: WorkspacePolicy }
    | {
        readonly resolveWorkspace: (
          context: ToolExecutionContext,
        ) => WorkspacePolicy | undefined | Promise<WorkspacePolicy | undefined>;
      }
  );
```

- 固定 `workspace` 的旧用法不变；
- `resolveWorkspace` 在每次执行时根据 `context.sessionId` 返回该会话的策略；
- 返回 `undefined` 时抛出新错误码 `workspace-file-unavailable`；
- 对 `write_file`，解析发生在审批之后，因此未设置目录的项目仍会先弹审批。Server
  在没有目录时不改变工具列表，这是已知取舍，由工具描述提示模型先确认。

### 4.2 `@weave/runtime`：可恢复的工具失败

Tool Pipeline 抛出 `ToolExecutionError` 且错误码属于下表时，Runner 不再结束本轮：

| 可恢复 | 原因 |
| --- | --- |
| `tool-not-found`、`tool-invalid-json`、`tool-invalid-arguments` | 模型调用写错，可以重试 |
| `tool-execution-failed` | 工具自身报错，如文件不存在、超出工作区 |
| `tool-timeout`、`tool-result-serialization-failed` | 单次调用失败 |
| `tool-approval-rejected`、`tool-approval-expired` | 用户拒绝或超时，模型应告知用户 |

仍然结束本轮：`tool-cancelled`、`tool-approval-cancelled`、请求 `AbortSignal`
已中止、`tool-approval-required`（审批未配置属于装配错误）以及非 `ToolExecutionError`。

可恢复失败时 Runner：

1. 追加 `tool-result.created`（`status: 'failed'`、`errorCode`）、一条 `role: 'tool'`
   消息（内容为面向模型的错误说明）和 `step.completed(status: 'failed')`；
2. 发出 `tool-result` 事件，新增可选字段 `status: 'completed' | 'failed'` 与
   `errorCode`；
3. 继续下一次模型调用，仍受 `maxSteps` 限制。

错误说明只包含工具名、错误码和错误消息；工具自身错误（例如
`WorkspaceFileError`）取 `cause` 的错误码和消息，不包含文件内容或参数全文。

### 4.3 `@weave/server`

- `createServerAgentRunner(runtime, { resolveWorkspaceRoot })` 在插件注册之后注册
  `read_file` / `write_file`（resolver 模式）；工具名被插件占用时启动失败。
- `resolveWorkspaceRoot(sessionId)` 遍历项目及其会话关联找到所属项目，返回
  `folderPath`。本地项目数量小，不为此扩展 Project Store 接口。
- `POST /projects` 校验 `folderPath`：必须是绝对路径且是已存在的目录，否则返回
  `400 project-folder-invalid`。
- 审批等待由 Server Tool Pipeline 的 10 分钟超时约束（超时覆盖审批与执行），
  超时在审批阶段时映射为 `tool-approval-expired`；用户停止运行时审批随
  `AbortSignal` 取消。

### 4.4 `@weave/desktop`

Preload 暴露 `pickDirectory(): Promise<{ path: string; name: string } | null>`，
由 Main 进程通过 `ipcMain.handle('weave:pick-directory')` 调用
`dialog.showOpenDialog({ properties: ['openDirectory'] })`。Renderer 只拿到用户
明确选择的目录，不获得任意文件系统访问能力。

### 4.5 `@weave/studio`

- 创建项目：桌面端调用 `pickDirectory()` 取得路径和名称；浏览器模式保留原选择框，
  并增加可选的"本地绝对路径"输入框，填写后才提交 `folderPath`；
- 工具步骤支持失败状态显示；
- 订阅 `GET /approvals/stream`，在输入框上方显示待审批卡片（摘要、风险、路径、
  字节数、是否覆盖），提供"同意写入"和"拒绝"；
- Vite 开发代理增加 `/approvals`。

## 5. 安全边界

- 文件访问仍只经过 `ToolRegistry -> ToolPipeline -> Approval -> WorkspacePolicy ->
  realpath 校验`；Server 不直接调用工具的 `execute`；
- 审批卡片只显示 `write_file` 的脱敏摘要，不显示文件全文；
- `folderPath` 由 Server 校验，Renderer 提供的路径不被直接信任；
- 审批 HTTP 仍不是认证层，只监听 `127.0.0.1`。

## 6. 测试

- runtime：resolver 模式读写、未配置目录、可恢复失败继续下一步、取消仍结束本轮；
- server：文件工具注册、按会话解析目录、`folderPath` 校验；
- studio：审批卡片同意/拒绝请求、工具失败状态、浏览器模式提交路径；
- desktop：`pickDirectory` IPC。
