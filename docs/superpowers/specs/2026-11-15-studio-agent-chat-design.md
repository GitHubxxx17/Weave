# Weave Studio Agent Chat Design

**日期：** 2026-11-15

**状态：** 待评审

**目标阶段：** 建立第一个可以真实消费 Agent SSE 的 Studio 前端验收界面

## 1. 背景

Weave 已经具备：

```text
AgentRunner
  -> Runtime LlmClient
  -> ToolPipeline
  -> SessionEventStore
  -> AgentRuntimeEvent
  -> POST /agent/runs/stream
```

当前缺少浏览器端消费者。没有 Studio 页面，Agent HTTP/SSE 虽然可以通过
测试验证，但还不能从前端观察文本增量、工具执行状态、完成和失败。

本阶段新增 `apps/studio`，实现一个最小但完整的 Agent Chat 工作台。它的
目标是验证前后端实时链路，不提前实现完整的 Studio 产品。

## 2. 目标与非目标

### 2.1 目标

- 新增独立的 React + Vite `apps/studio` 应用；
- 提供一个可以发送用户消息的 Agent Chat 页面；
- 使用浏览器 `fetch()` 调用 `POST /agent/runs/stream`；
- 支持跨网络 chunk 边界的 SSE 解析；
- 实时渲染文本增量和 reasoning 增量；
- 显示 Tool Call、工具执行、工具结果和错误状态；
- 支持用户取消当前请求；
- 保持前端状态机只消费 Server 事件，不重写 Runtime 行为；
- 为默认 Server Mock LLM 增加确定性的本地演示脚本，使页面可以开箱验证；
- 补充前端单元测试、构建检查、架构学习文档和启动说明。

### 2.2 非目标

- 不实现用户登录、权限和多租户；
- 不实现真实 Session 列表持久化，左侧 Session 先使用本地静态数据；
- 不实现 SQLite 查询、Session 恢复或历史消息接口；
- 不实现文件树、Workspace 编辑器、插件市场和 Crew；
- 不实现独立 Run Registry、后台任务、重连或 Last-Event-ID；
- 不在前端直接调用 Tool Definition 或 Runtime 包；
- 不把前端 transient 事件直接写入 Session Event Store；
- 不引入全局状态管理库或路由库。

## 3. 方案选择

### 方案 A：新增 React + Vite Studio 应用

新增 `apps/studio`，使用 React 组件和原生 `fetch` 消费 Server SSE。

优点：

- 与产品规划中的 Studio 技术路线一致；
- 前端和 Server 通过真实 HTTP 契约连接；
- 可以独立启动、构建和部署；
- 后续可以渐进加入 Session、Workspace、Approval 和 Plugin 页面。

缺点：

- 需要新增前端依赖和构建配置；
- 第一版需要同时维护 Vite 开发代理和 Server 启动方式。

### 方案 B：在 Server 中直接返回 HTML

由 Hono 返回一个简单 HTML 页面和内联脚本。

优点是依赖少、启动简单。缺点是无法形成 Studio 的组件边界，也不符合
Weave 后续的 React 工作台方向；SSE 解析和 UI 状态会混在 Server 资源中。

### 方案 C：先只做 Storybook 或静态 Mock 页面

优点是可以先做视觉，但不能验证真实 HTTP、SSE、取消和错误语义，容易把
前端状态设计与后端契约分离。

**本阶段采用方案 A。**

## 4. 应用结构

```text
apps/studio/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── app/
│   │   ├── App.tsx
│   │   └── app.css
│   ├── features/
│   │   └── agent/
│   │       ├── agent-stream.ts
│   │       └── agent-types.ts
│   └── main.tsx
└── test/
    ├── agent-stream.test.ts
    └── App.test.tsx
```

模块职责：

- `App.tsx`：页面布局、提交/取消操作和 UI 状态组合；
- `agent-stream.ts`：HTTP 请求、增量 UTF-8 解码、SSE 分帧和事件分发；
- `agent-types.ts`：前端可消费的 Agent 事件联合类型；
- `app.css`：工作台布局和状态视觉；
- `test/App.test.tsx`：用户输入、发送和事件渲染行为；
- `test/agent-stream.test.ts`：纯 SSE parser 的边界测试。

第一版不引入 Pinia、Redux、Zustand 或 React Router。页面只有一个工作台，
组件数量和状态范围都很小，使用 React 本地状态可以更容易理解数据流。

## 5. 前端状态模型

页面状态分为请求生命周期、消息内容和工具活动三类：

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

事件处理规则：

| Runtime event | 前端动作 |
| --- | --- |
| `text-delta` | 追加到当前 assistant message |
| `reasoning-delta` | 追加到当前 reasoning 区域 |
| `tool-call` | 创建 `called` Tool Activity |
| `tool-executing` | 将工具状态改为 `executing` |
| `tool-result` | 写入结果并改为 `completed` |
| `completed` | 将 Run 状态改为 `completed` |
| `error` | 展示错误并将 Run 状态改为 `error` |

收到新的用户消息时，页面先追加 user message，再创建一个空的 assistant
message。这样文本 delta 可以直接追加，不需要从 DOM 反推状态。

## 6. SSE 消费契约

`agent-stream.ts` 提供一个面向 UI 的函数：

```ts
export interface AgentStreamHandlers {
  readonly onEvent: (event: AgentRuntimeEvent) => void;
  readonly onError?: (error: Error) => void;
}

export function streamAgentRun(
  request: AgentRunRequestInput,
  handlers: AgentStreamHandlers,
  options?: { readonly signal?: AbortSignal },
): Promise<void>;
```

实现步骤：

1. 使用 `fetch('/agent/runs/stream', { method: 'POST', body })`；
2. 非 `2xx` 响应先解析 JSON error；
3. 使用 `TextDecoder.decode(value, { stream: true })` 处理跨 chunk 的 UTF-8；
4. 将 buffer 按空行切分成 SSE frame；
5. 读取 `event:` 和一行或多行 `data:`；
6. 对 JSON data 做基础结构校验；
7. 通过 `onEvent` 按顺序交给 React 状态层；
8. 读取完成、收到 `completed` 或收到 `error` 后结束。

Server 当前每条事件只有一行 `data`，但 parser 按标准 SSE 的多行 data
规则实现，避免未来 Provider 或代理改变分块方式时前端失效。

前端不会将任意服务端 JSON 当作可信的 UI 状态。事件类型和关键字段需要
在 parser 边界检查，未知事件可以记录并忽略，格式错误则转换为可展示的
前端错误。

## 7. 取消和错误

发送请求时创建 `AbortController`，取消按钮调用：

```ts
controller.abort();
```

浏览器会终止 `fetch`，Server 的请求 signal 触发 Agent iterator 清理，
Runtime 再负责停止模型/工具并持久化 cancelled Turn/Step。前端只把
`AbortError` 解释为 `cancelled`，不显示成系统故障。

错误分为两类：

- **建立流之前**：HTTP `400` 或 `503`，解析统一 JSON error；
- **建立流之后**：SSE `error` 事件，显示 `code` 和安全的 `message`。

发送按钮在 `streaming` 时变成取消操作；请求结束、失败或取消后恢复为
发送状态，避免用户重复提交造成同一 Session 的并发交互。

## 8. Server 本地演示脚本

当前 Server 默认使用 Mock LLM，但原脚本为空，Agent 会因为缺少模型
terminal `finish` 而返回错误。为了让 Studio 第一版能够真实验收，需要
在 Server composition root 中配置固定演示脚本：

```ts
[
  { type: 'text-delta', text: '这是 Weave 的本地 Agent 演示。' },
  { type: 'text-delta', text: ' 当前消息通过 SSE 增量传输。' },
  { type: 'finish', reason: 'stop' },
]
```

这不是生产 Provider，也不是第二套 Agent Loop，只是本地启动时的确定性
`LlmClient` fixture。以后接入真实 Provider 时只替换 composition root 的
服务选择，Studio 的 HTTP/SSE 契约不变。

## 9. 开发代理和启动

Studio 使用 Vite 开发服务器，默认端口 `5173`。开发代理将 `/agent` 转发
到 `http://127.0.0.1:4317`：

```text
Browser http://127.0.0.1:5173
  -> Vite proxy /agent
  -> Server http://127.0.0.1:4317
```

本地开发步骤：

```bash
pnpm --filter @weave/server dev
pnpm --filter @weave/studio dev
```

当前 Server 尚未提供 `dev` script，实施阶段需要补充一个不会自动启动
真实 Provider 的本地启动命令，或直接复用已有 `startServer()` 入口。
两个进程分开运行，便于前端热更新和后端调试。

## 10. 测试策略

### 10.1 SSE Parser

- 一个事件跨多个 Uint8Array chunk；
- UTF-8 多字节字符跨 chunk；
- 多行 `data:` 合并；
- 事件顺序保持不变；
- 空帧和注释帧忽略；
- 非法 JSON 转换为前端错误；
- `error` 事件结束消费。

### 10.2 React UI

- 输入框可以提交一条用户消息；
- 收到 text delta 后 assistant 文本增量显示；
- Tool Activity 按 called/executing/completed 更新；
- completed 后恢复发送状态；
- error 后显示错误信息；
- 点击取消会调用 AbortController；
- streaming 状态下不会重复提交。

### 10.3 浏览器验收

- 启动 Server 和 Studio；
- 在浏览器打开 `http://127.0.0.1:5173`；
- 发送一条消息；
- 观察 assistant 文本逐步出现；
- 检查请求取消和错误状态；
- 使用桌面和窄屏宽度检查布局没有重叠或溢出。

## 11. 依赖和边界

预计新增依赖：

- `react`、`react-dom`：Studio UI；
- `vite`：开发服务器和构建；
- `@vitejs/plugin-react`：Vite 的 React/TSX 编译；
- `@types/react`、`@types/react-dom`：TypeScript 类型；
- `@testing-library/react` 或等价测试工具：组件行为测试。

新增依赖必须写入 `apps/studio/package.json`，并在实现提交中说明用途。
Studio 只能通过浏览器 HTTP 契约访问 Server，不依赖 `@weave/runtime`、
`@weave/session` 或 Node-only 模块。

## 12. 验收标准

本阶段完成的判断标准：

- `apps/studio` 可以独立执行 `dev`、`build`、`typecheck` 和 `test`；
- Server 与 Studio 可以分别启动；
- 浏览器发送消息后能看到真实 SSE 增量；
- Tool 和 error 状态可以在 UI 中观察；
- 取消请求后 Server 和 Runtime 不继续执行当前流；
- `pnpm check` 通过；
- 架构文档、学习文档和飞书总计划同步；
- 代码以独立分支提交，并通过 CI 后 squash merge。
