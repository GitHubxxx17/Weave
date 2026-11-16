# Weave Foundation Design

**日期：** 2026-11-14

**状态：** 待审阅

**目标阶段：** Weave Studio 的工程基础

## 1. 目标

本设计定义 Weave 第一轮工程化实现的范围。目标不是一次完成完整 Agent 产品，而是建立一条可以独立运行、测试和扩展的基础链路：

```text
统一协议
  -> LLM 适配层
    -> Runtime 装配层
      -> HTTP 控制入口
        -> 单元测试与契约测试
```

完成后，Weave 应该具备：

- 可复现的 TypeScript Monorepo 开发环境
- 明确的包依赖方向
- 不泄露 Provider 类型的 LLM 公共协议
- 可测试的 SSE Parser
- 可取消、可分类错误的模型流式调用接口
- 最小 Runtime 生命周期和依赖注册能力
- 能装配 Runtime 的 Hono Server
- 包级测试、契约测试、类型检查和构建命令
- 适合 AI 持续开发的目录和工程约束

本轮不实现完整 Agent Loop、Tool Pipeline、Session Event Store 或 Web UI。这些能力必须建立在本轮契约稳定之后。

## 2. 背景与约束

Weave 是 Orbit 原型之后的架构重置。Orbit 的 `RunManager` 和 `runAgent()` 可以作为经验来源，但不能作为 Weave 的 Runtime 边界。

Weave 使用以下运行时关系：

```text
Session
  -> Agent
    -> Turn
      -> Step
        -> Model Request
        -> Tool Calls
        -> Tool Results
```

第一轮只实现这条关系中最底层的基础能力：

```text
Model Contract
  -> Runtime Assembly
  -> Control Plane Entry
```

必须遵守的工程约束：

- TypeScript、ESM、strict typing
- 外部输入先经过 Zod 校验
- Provider SDK 类型不能泄露到 Runtime
- HTTP Handler 保持薄，只负责输入校验和调用 Runtime
- Runtime 不依赖 HTTP
- 不添加没有明确理由的依赖
- 代码注释只保留关键设计约束和不明显的原因
- 详细的学习内容、数据流和面试解释写入文档
- 行为变化必须有测试
- 本轮不提交或推送，等待设计确认和实现验证

## 3. 设计范围

### 3.1 本轮包含

#### 工程基础

- pnpm workspace
- Turborepo 任务编排
- TypeScript 项目引用或统一严格配置
- ESLint、Prettier、Vitest
- 根级 `check`、`test`、`build`、`format` 命令
- 包级命令和依赖边界

#### `@weave/protocol`

- 基础消息类型
- 内容片段类型
- 工具调用类型
- 工具定义类型
- LLM 请求类型
- 流式事件类型
- Token Usage 类型
- LLM 错误类型
- 对外输入的 Zod Schema
- Session 投影消息的 `occurredAt` 时间戳和可恢复的 reasoning 内容片段

#### `@weave/llm`

- `LlmClient` 公共接口
- SSE Parser
- Provider 响应解析边界
- OpenAI-compatible Provider 的最小适配器
- Mock Provider
- `AbortSignal` 取消
- 请求超时
- 稳定错误分类
- Provider Contract Test

#### `@weave/runtime`

- Runtime 配置
- 服务注册接口
- 服务获取接口
- 生命周期接口
- 最小 Runtime Context
- LLM Client 的装配入口

#### `apps/server`

- Hono 应用入口
- Runtime 装配
- `GET /health`
- 最小的 Runtime 状态检查
- HTTP 输入和错误边界示例

### 3.2 后续补充

Foundation vertical slice 已经进入 Studio 交互验证阶段。为保证会话
恢复和界面展示的一致性，当前实现补充以下跨层契约：

- Session projection 为每条消息保留创建事件的 `occurredAt`；
- Agent Runner 将 Provider 暴露的 reasoning 聚合后写入完成的 assistant
  message；
- Studio 将 reasoning、tool call、tool result 和消息时间按同一条 assistant
  message 渲染，并在刷新或切换 Session 后恢复；
- 运行中的 reasoning 仍通过 transient `AgentRuntimeEvent` 实时发送，持久化
  只在完成的 assistant message 上发生。

这组补充不改变 `protocol -> llm -> runtime -> server` 的依赖方向，只扩展
Session read model 和 Server 的消息返回结构。

### 3.3 本轮不包含

- 完整 Agent Loop
- Session 和 Turn 持久化
- SQLite Event Store
- Tool Registry
- Tool Pipeline
- Workspace 和 Sandbox
- Approval UI 或 Approval Service
- MCP
- Skills
- Plugin Manifest 和动态加载
- Crew 和 Subagent
- React 工作台
- Electron Desktop
- 生产环境部署
- 多用户认证和远程服务

这些能力不是被否定，而是按 A -> B -> C 的产品顺序后置。第一轮先证明基础契约足够稳定。

## 4. 方案对比与选择

### 方案 A：一次性创建完整包结构

一次创建所有未来包和应用，先把目录铺满。

不选择的原因：

- 空包会制造虚假的完成感
- 依赖方向未经真实调用验证
- 容易提前引入 Session、Plugin 和 Crew 的错误抽象
- AI 后续修改时会在大量低价值目录中迷失

### 方案 B：垂直切片

只创建当前确实能运行的 `protocol`、`llm`、`runtime` 和 `server`。

选择的原因：

- 每个包都有真实职责
- 可以从第一天开始做测试和构建
- 能验证 Provider、Runtime 和 Server 的边界
- 后续 Agent Loop 可以接在现有契约上
- 适合 AI 按小任务持续开发和审查

### 方案 C：单包原型

所有逻辑暂时放在一个 `src` 目录，完成后再拆分。

不选择的原因：

- Provider 类型容易泄露到 Agent
- Server、Runtime 和模型调用会耦合
- 后续拆包会产生大范围重构
- 不利于学习和面试时说明职责边界

本设计采用方案 B。

## 5. 目标目录

第一轮目标目录如下：

```text
weave/
├── apps/
│   └── server/
│       ├── src/
│       │   ├── app.ts
│       │   ├── main.ts
│       │   └── runtime.ts
│       ├── test/
│       │   └── health.test.ts
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   ├── protocol/
│   │   ├── src/
│   │   │   ├── content.ts
│   │   │   ├── errors.ts
│   │   │   ├── llm.ts
│   │   │   ├── messages.ts
│   │   │   ├── tools.ts
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   └── schemas.test.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── llm/
│   │   ├── src/
│   │   │   ├── client.ts
│   │   │   ├── errors.ts
│   │   │   ├── mock-client.ts
│   │   │   ├── openai-compatible.ts
│   │   │   ├── sse-parser.ts
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   ├── contract.test.ts
│   │   │   └── sse-parser.test.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── runtime/
│       ├── src/
│       │   ├── runtime.ts
│       │   ├── service-container.ts
│       │   ├── types.ts
│       │   └── index.ts
│       ├── test/
│       │   └── runtime.test.ts
│       ├── package.json
│       └── tsconfig.json
├── docs/
│   ├── architecture/
│   ├── adr/
│   └── superpowers/
│       └── specs/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.json
├── eslint.config.js
├── prettier.config.mjs
└── vitest.config.ts
```

文件职责必须保持单一：

- `protocol` 只定义公共数据结构和校验，不执行网络请求或文件操作
- `llm` 只负责模型调用和 Provider 差异，不创建 Session 或执行 Tool
- `runtime` 只负责服务装配和生命周期，不知道 Hono 路由
- `server` 只负责 HTTP 入口和 Runtime 装配，不实现模型循环

## 6. 依赖方向

第一轮只允许以下方向：

```text
protocol
   ↑
llm
   ↑
runtime
   ↑
server
```

具体规则：

- `@weave/protocol` 不依赖其他内部包
- `@weave/llm` 可以依赖 `@weave/protocol`
- `@weave/runtime` 可以依赖 `@weave/protocol` 和 `@weave/llm`
- `apps/server` 可以依赖 `@weave/protocol`、`@weave/llm` 和 `@weave/runtime`
- `@weave/protocol` 不能导入 `@weave/llm`
- `@weave/llm` 不能导入 `apps/server`
- `@weave/runtime` 不能导入 Hono、React 或浏览器 API
- Server 通过构造函数或装配函数向 Runtime 注入 Provider

这种方向的面试表达是：

> 底层包只提供稳定契约，上层包负责组合能力。这样替换模型 Provider 或 HTTP 框架时，不需要修改协议和 Runtime 核心。

## 7. 公共协议设计

### 7.1 内容和消息

第一轮对外只承诺文本和 reasoning 内容，但保留内容片段结构：

```ts
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }

type Message =
  | {
      role: 'system'
      content: readonly ContentPart[]
    }
  | {
      role: 'user'
      content: readonly ContentPart[]
    }
  | {
      role: 'assistant'
      content: readonly ContentPart[]
      toolCalls?: readonly ToolCall[]
    }
  | {
      role: 'tool'
      toolCallId: string
      content: readonly ContentPart[]
    }
```

第一轮不实现图片和文件内容，但不把协议设计成只能接收字符串。这样后续增加多模态内容时，不需要修改 Agent 的消息模型。

### 7.2 工具调用

模型输出的工具参数必须先保持为原始字符串：

```ts
interface ToolCall {
  id: string
  name: string
  arguments: string
}
```

本轮只定义结构，不执行工具。后续 `Tool Pipeline` 必须经过以下过程：

```text
raw arguments
  -> JSON.parse
  -> unknown
  -> tool schema validation
  -> typed arguments
  -> policy
  -> execute
```

这样可以避免把模型输出误认为可信输入。

### 7.3 LLM 请求和流式事件

`LlmRequest` 由 Weave 定义，不直接暴露 Provider SDK 类型：

```ts
interface LlmRequest {
  provider: string
  model: string
  messages: readonly Message[]
  tools?: readonly ToolDefinition[]
  temperature?: number
  maxTokens?: number
  reasoningEffort?: string
}
```

第一轮的 `StreamEvent`：

```ts
type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-start'; id: string; name: string }
  | { type: 'tool-call-delta'; id: string; argumentsDelta: string }
  | { type: 'finish'; reason: FinishReason; usage?: TokenUsage }
```

`StreamEvent` 是临时运行事实的传输协议，不等于最终持久化事件。后续
Session Event Log 需要定义自己的 durable event schema。LLM provider
错误不作为 stream event 传输；`LlmClient.stream()` 通过 reject 抛出
归一化的 `LlmError`，这样 Runtime 和调用方可以用同一条异常路径处理
取消、超时、网络和协议失败。

### 7.4 用量

用量字段保持可选，区分“服务商明确返回 0”和“服务商没有返回”：

```ts
interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
```

本轮不自行伪造计费数据。没有 Provider 返回值时保持 `undefined`，不使用 `0` 代替未知。

## 8. LLM 适配层

### 8.1 公共接口

`@weave/llm` 暴露：

```ts
interface LlmClient {
  stream(
    request: LlmRequest,
    options?: {
      signal?: AbortSignal
      timeoutMs?: number
    },
  ): AsyncIterable<StreamEvent>
}
```

上层只依赖这个接口，不知道请求是通过哪一个 SDK 或 HTTP endpoint 完成的。

### 8.2 SSE Parser

SSE Parser 是纯函数或小型状态机，输入任意大小的 UTF-8 分片，输出完整事件和剩余 buffer：

```ts
interface SseParserState {
  buffer: string
}

interface ParsedSseFrame {
  data: string
}

function pushSseChunk(
  state: SseParserState,
  chunk: string,
): {
  state: SseParserState
  frames: readonly ParsedSseFrame[]
}
```

必须处理：

- 一行被拆成多个 chunk
- 一个 chunk 包含多条事件
- JSON 被拆分
- 空行分隔事件
- `data:` 前缀
- `[DONE]`
- 最后没有额外换行的 buffer
- 非法 SSE 行

SSE 语法解析和 Provider JSON 解析分开。这样换 Provider 时无需复制底层流解析逻辑。

### 8.3 OpenAI-compatible Provider

第一轮实现一个最小的 OpenAI-compatible 适配器，支持：

- `POST` 请求
- Bearer API Key
- JSON 请求体
- SSE 文本 delta
- 基础工具调用 delta
- finish reason
- usage
- HTTP 错误分类
- AbortSignal
- timeout

Provider 只负责将外部响应转换为 Weave `StreamEvent`。它不负责重试 Agent、不保存 Session，也不决定工具审批。

### 8.4 Mock Provider

Mock Provider 必须支持确定性事件脚本，例如：

```ts
const client = createMockLlmClient([
  { type: 'text-delta', text: '分析完成' },
  { type: 'finish', reason: 'stop' },
])
```

它用于：

- 单元测试
- Runtime 装配测试
- 后续 Agent Loop 测试
- 不依赖网络的 CI
- 面试演示和本地学习

## 9. Runtime Foundation

### 9.1 责任

Runtime 第一轮只负责：

- 注册服务
- 获取服务
- 启动服务
- 关闭服务
- 保存已注册服务的类型边界
- 为 Server 提供统一装配入口

Runtime 不负责：

- 运行 Agent Loop
- 读取文件
- 执行 Shell
- 访问 HTTP
- 读写 SQLite
- 加载不受信任的插件

### 9.2 生命周期

Runtime 状态：

```text
created -> starting -> running -> stopping -> stopped
```

非法生命周期转换必须返回结构化错误，而不是静默忽略。

### 9.3 服务注册

第一轮服务注册可以采用显式 key 和工厂：

```ts
interface RuntimeService<T> {
  key: symbol
  create(context: RuntimeContext): T | Promise<T>
  dispose?(value: T): void | Promise<void>
}
```

这样可以先验证生命周期，再在 Plugin Runtime 阶段扩展为 Scope、依赖和插件贡献。

不要在第一轮引入全局单例。全局单例会让测试相互污染，也会让 CLI、Server 和未来 Crew 难以创建隔离 Runtime。

## 10. Server Control Plane

Server 只做三件事：

1. 解析和校验 HTTP 输入
2. 调用 Runtime 暴露的服务
3. 把结果转换成 HTTP 响应

第一轮只提供：

```text
GET /health
```

`/health` 返回：

```json
{
  "status": "ok",
  "runtime": "running"
}
```

Server 应该通过 `createApp(runtime)` 创建，测试可以注入 Mock Runtime，不需要启动真实网络端口。

第一轮明确不提供 `/run` 或 `/agent` 路由。没有 Agent、Session 和审批契约之前，提前暴露这些接口会固化错误 API。

## 11. 错误模型

错误需要分成稳定类别，避免上层依赖字符串：

```ts
type LlmErrorCode =
  | 'authentication'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'invalid-request'
  | 'context-overflow'
  | 'provider'
  | 'protocol'
  | 'cancelled'
```

错误对象至少包含：

```ts
interface LlmError {
  code: LlmErrorCode
  message: string
  retryable: boolean
  provider?: string
  status?: number
}
```

敏感信息约束：

- API Key 不进入错误对象
- Authorization Header 不进入日志
- 原始 Provider 响应只保留经过裁剪的诊断信息
- 错误消息不能包含完整请求头

错误处理策略：

- 网络错误、临时 5xx 和 rate limit 可以标记为可重试
- context overflow 和不支持的请求参数需要修改请求
- API Key 错误、模型不存在、用户取消和参数错误不能自动重试

## 12. 测试策略

### 12.1 Protocol

测试：

- 合法消息通过
- 非法 role 被拒绝
- 工具调用缺少 id 被拒绝
- usage 负数被拒绝
- 未知字段不会改变核心语义

### 12.2 SSE Parser

测试：

- 单 chunk 单事件
- 单 chunk 多事件
- 行被拆分
- JSON 被拆分
- 空行
- `[DONE]`
- 非法行
- 流结束时剩余 buffer

### 12.3 Provider Contract

Mock Provider 和 OpenAI-compatible Provider 使用同一组可观察行为测试：

- 文本 delta
- reasoning delta
- 工具调用开始和参数分片
- finish reason
- usage
- HTTP 错误
- AbortSignal
- timeout

OpenAI-compatible Provider 的网络请求使用注入的 `fetch`，测试不访问真实网络。

### 12.4 Runtime

测试：

- Runtime 可以创建
- 服务可以注册和获取
- 启动顺序正确
- 重复启动被拒绝或幂等行为明确
- 关闭时按逆序释放服务
- 关闭后不能获取运行中服务

### 12.5 Server

使用 Hono 的测试请求能力：

- `/health` 在 Runtime running 时返回 200
- Runtime 未运行时返回结构化错误
- Server 不需要真实端口

## 13. AI 工程化配置

第一轮工程配置必须让 AI 可以重复执行和验证，而不是只依赖人工记忆。

根级命令：

```text
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

`pnpm check` 是第一轮的定义完成标准，必须依次覆盖格式、Lint、类型检查、测试和构建。

AI 开发约束：

- 每个行为变化先添加或修改测试
- 每个包只依赖允许的内部包
- 不在 `src/` 下放测试文件
- 不使用 `any` 逃避类型检查
- 不使用 `@ts-ignore`
- 不在代码中写入真实 API Key
- 不在测试中访问真实 Provider
- 不修改与任务无关的文件
- 重要设计变化记录到 `docs/adr/`

代码注释规则：

- 只注释设计原因、边界条件和容易误改的约束
- 不为明显的变量赋值和简单流程写注释
- 不用注释代替清晰命名
- 学习性解释放在 `docs/`，不堆进生产代码

## 14. 后续扩展点

本轮完成后，下一阶段按以下顺序扩展：

1. `Tool Registry` 和工具参数校验
2. `Agent Loop` 和 Turn/Step 生命周期
3. `Session`、Event Store 和 Projection
4. Workspace、Sandbox 和 Approval
5. Server SSE 和 Web 工作台
6. Context、Token Meter 和 Compaction
7. MCP、Skills 和 Plugin Runtime
8. SDK、CLI 和 Desktop
9. Subagent 和 Crew

每个阶段都必须先更新设计和契约，再进入代码实现。

## 15. 验收标准

第一轮设计和实现最终需要满足：

- 新开发者可以通过 `pnpm install` 安装依赖
- `pnpm check` 在干净环境中通过
- `@weave/protocol` 可以独立导入和测试
- `@weave/llm` 可以用 Mock Provider 流式返回事件
- SSE Parser 能正确处理分片和结束标记
- OpenAI-compatible Provider 的网络请求可以被测试替换
- Runtime 可以启动、获取服务并关闭
- Server 可以装配 Runtime 并返回健康状态
- Server 不包含 Agent Loop
- Provider 类型没有泄露到 protocol 或 runtime
- 没有真实密钥进入源码、测试快照或事件
- 后续可以在不改 Server 路由的情况下接入 Agent

## 16. 面试表达

可以把第一轮设计概括为：

> Weave 先采用垂直切片，而不是一次铺满所有包。底层用 protocol 固化跨模块契约，LLM 包负责隔离不同模型厂商的流式协议，Runtime 负责依赖装配和生命周期，Server 只作为 Control Plane。这样可以先用 Mock Provider 做确定性测试，再逐步接入 Agent Loop、工具管线和 Session 事件溯源，避免把模型调用、HTTP 路由和业务状态耦合在一起。

当被追问为什么不直接复制 Orbit 的 `RunManager` 时：

> Orbit 的运行循环能验证功能，但核心边界围绕一次 Run。Weave 需要让 Session、Agent、Turn、Step、Tool Pipeline 和 Plugin 独立演进，因此先把跨层契约拆开，再把 Agent Loop 作为 Runtime 上层能力接入。
