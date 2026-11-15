# Weave Tool Pipeline 设计

## 1. 背景

当前 `@weave/runtime` 已经具备一个最小的无工具 Agent Runner。模型产生
`tool-call-start` 或 `finish.reason = "tool-call"` 时，Runner 会明确失败，
因为 Weave 还没有一个可以被 HTTP、CLI、Desktop、Studio 和未来 Plugin
共同使用的工具执行边界。

本轮实现 Tool Registry 和 Tool Pipeline，但不把文件系统、Shell、Approval
或 HTTP 逻辑提前塞进 Runtime。目标是先固定“工具如何定义、如何查找、如何
校验输入、如何被取消、如何限制输出以及如何报告错误”的基础契约。

## 2. 目标与非目标

### 2.1 目标

- 提供可注册、可查找、可列出的 Tool Registry；
- 为每个工具保存模型可见的名称、描述和参数 Schema；
- 使用 Zod 校验模型传入的 JSON 参数；
- 通过一个统一的 Tool Pipeline 执行所有工具；
- 支持调用级取消和超时；
- 将工具结果序列化为稳定的文本内容，并限制最大字节数；
- 对未知工具、非法 JSON、参数不合法、取消、超时和执行失败提供稳定错误分类；
- 保留工具实现抛出的原始错误作为 `cause`；
- 让未来 Agent Runner 可以在不依赖具体工具实现的情况下接入 Pipeline；
- 为上述行为提供确定性单元测试和学习文档。

### 2.2 非目标

本轮不实现：

- 文件读写、目录遍历或 Shell 执行；
- Workspace、Sandbox、路径边界和权限策略；
- Approval、人工确认和拒绝流程；
- Tool Call 的 Session durable event；
- Agent Runner 的多步工具循环；
- HTTP `/run`、SSE Adapter 和 Studio 前端；
- MCP、Skills、Plugin Manifest 或 Crew。

这些能力需要分别建立安全边界和对外协议，不能因为已有 Pipeline 就默认获得
执行权限。

## 3. 设计原则

### 3.1 Registry 与 Pipeline 分离

Registry 只回答“工具是否存在、工具定义是什么”。Pipeline 才负责一次
调用的输入校验、生命周期控制、执行和结果处理。这样 Registry 可以被模型
请求构造和插件加载复用，而 Pipeline 的安全策略可以独立测试。

### 3.2 Runtime 才是执行边界

调用方只能提交一个 provider-neutral 的 Tool Call 给 Pipeline，不能直接
调用注册工具的 `execute`。HTTP Handler、前端和未来插件都不能绕过 Pipeline。

### 3.3 工具参数与模型 Schema 分开

模型需要名称、描述和 JSON Schema-like 的参数描述；Runtime 需要一个真正
可执行的 Zod Schema。两者语义相关但用途不同，因此注册定义同时保存：

```ts
interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  parameters: unknown;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput> | TOutput;
}
```

本轮不引入 JSON Schema 转换依赖。`parameters` 是模型协议需要的 provider-
neutral 数据，`inputSchema` 是本地执行前的可信校验器。后续若引入 Schema
生成器，应在单独的依赖决策中评估。

### 3.4 取消是合作式的

Pipeline 会把组合后的 `AbortSignal` 传给工具实现。取消或超时只能保证：

- Pipeline 不再等待并接受已经失效的结果；
- 工具可以观察 signal 并主动停止；
- 调用方收到稳定的取消或超时错误。

JavaScript 无法强制终止已经运行的普通 Promise，因此 Pipeline 不声称可以
回收所有底层资源。Workspace 和 Shell 的强制终止策略属于后续执行器设计。

## 4. 公共契约

### 4.1 工具定义

建议在 `@weave/runtime` 中增加：

```ts
export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly sessionId?: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly inputSchema: z.ZodType<TInput>;
  readonly execute: (
    input: TInput,
    context: ToolExecutionContext,
  ) => Promise<TOutput> | TOutput;
}
```

约束：

- `name` 必须是非空字符串；
- 同一个 Registry 不允许重复名称；
- `description` 和 `parameters` 原样供模型请求适配器读取；
- `execute` 只能通过 Pipeline 调用；
- 工具实现必须自行响应 `context.signal`，不能假设 Pipeline 可以强杀任务。

### 4.2 Registry

```ts
export interface ToolRegistry {
  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void;
  get(name: string): ToolDefinition | undefined;
  list(): readonly ToolDefinition[];
}
```

`register()` 在以下情况失败：

- 名称为空；
- 名称已经存在；
- 定义缺少可执行函数或参数校验器。

Registry 返回的列表按注册顺序稳定排列，便于模型请求、测试和 UI 展示。

### 4.3 调用请求

Pipeline 接收已经由模型协议归一化的 Tool Call：

```ts
export interface ToolExecutionRequest {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: string;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
```

`arguments` 保持字符串，因为模型可能分片传输 JSON。Pipeline 在完整调用
组装后才执行 `JSON.parse()` 和 Zod 校验。

### 4.4 调用结果

```ts
export interface ToolExecutionResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly truncated: boolean;
}
```

`content` 是后续构造 `tool` message 的稳定文本边界。对象、数组、数字和
布尔值使用 JSON 文本；字符串保留原文本；无法序列化的结果进入稳定错误
分类。结果限制按 UTF-8 字节计算，截断后 `truncated` 为 `true`。

### 4.5 错误

增加 `ToolExecutionError`，至少包含以下 code：

```ts
type ToolExecutionErrorCode =
  | 'tool-invalid-input'
  | 'tool-not-found'
  | 'tool-invalid-json'
  | 'tool-invalid-arguments'
  | 'tool-cancelled'
  | 'tool-timeout'
  | 'tool-execution-failed'
  | 'tool-result-serialization-failed';
```

错误必须满足：

- `name` 为 `ToolExecutionError`；
- `code` 可被调用方稳定判断；
- 工具实现抛出的错误保留在 `cause`；
- 取消优先于普通执行错误；
- 超时优先归类为 `tool-timeout`，即使底层随后因 signal 抛出
  `AbortError`；
- 输入错误发生在工具执行前，不调用 `execute`。

## 5. 执行流程

```text
ToolExecutionRequest
  -> 输入契约校验
  -> Registry 查找
  -> JSON.parse(arguments)
  -> inputSchema.parse(input)
  -> 创建组合 AbortSignal
  -> 调用 tool.execute(input, context)
  -> 序列化结果
  -> 按 UTF-8 字节限制结果
  -> ToolExecutionResult
```

任何失败都不会进入下一个步骤，也不会调用工具实现。

### 5.1 超时

有效超时来自请求级 `timeoutMs`，没有请求级配置时使用 Pipeline 默认值。
`undefined` 表示不设置超时；`0` 不是“立即超时”的特殊值，而是一个合法的
零毫秒预算，应该在开始执行前触发超时。

Pipeline 必须清理计时器和 AbortSignal 监听器，避免每次调用留下资源。

### 5.2 结果限制

结果限制只作用于返回给模型和调用方的 `content`，不修改工具内部返回值。
截断发生在 UTF-8 字节边界上，不能产生半个多字节字符。截断后的内容需要
保持可读，并通过 `truncated` 标记让上层决定是否记录警告或继续处理。

### 5.3 结果序列化

- `string`：直接作为 content；
- 其他 JSON 值：使用 `JSON.stringify`；
- `undefined`：使用空字符串；
- 循环引用或其他无法序列化值：抛出 `tool-result-serialization-failed`。

## 6. 与 Agent Loop 的接入边界

本轮不修改 `createAgentRunner()` 的工具拒绝语义。完成后，Agent Loop 的
下一条分支可以依赖：

```text
tool-call-start + tool-call-delta
  -> assemble ToolCall
  -> ToolPipeline.execute(request)
  -> ToolExecutionResult
  -> tool message / next model step
```

Agent Runner 仍然负责 Turn、Step 和 Session 事件；Pipeline 不直接写
SessionEventStore，也不生成 Session durable events。这样可以避免 Runtime
层把工具执行和事件持久化耦合在一起。

## 7. 文件边界

预计修改：

- `packages/runtime/package.json`：声明直接使用的 `zod` 依赖；
- `packages/runtime/src/index.ts`：导出 Tool Pipeline 公共契约。

预计新增：

- `packages/runtime/src/tool-types.ts`：类型、Schema、错误；
- `packages/runtime/src/tool-registry.ts`：Registry 实现；
- `packages/runtime/src/tool-pipeline.ts`：执行、取消、超时和结果处理；
- `packages/runtime/test/tool-registry.test.ts`：Registry 行为；
- `packages/runtime/test/tool-pipeline.test.ts`：Pipeline 行为；
- `docs/superpowers/plans/2026-11-15-tool-pipeline.md`：实施计划。

不修改：

- `packages/protocol` 的既有 Tool Call 和 Tool Definition 协议；
- `packages/session` 的事件模型；
- `packages/runtime/src/agent-runner.ts` 的工具拒绝路径；
- `apps/server` 和前端。

## 8. 验收标准

- 工具可以注册、查找和稳定列出；
- 重复名称在注册阶段失败；
- 未知工具不会执行任何 handler；
- 非法 JSON 和非法参数在执行前失败；
- 正常执行可以得到稳定 `ToolExecutionResult`；
- 外部取消得到 `tool-cancelled`；
- 请求或默认超时得到 `tool-timeout`；
- 工具原始错误保留为 `cause`；
- 超大结果按 UTF-8 字节限制并设置 `truncated`；
- 循环引用结果得到 `tool-result-serialization-failed`；
- `pnpm check` 通过；
- 完成后新增飞书学习文档并更新总计划。

## 9. 后续扩展

Tool Pipeline 完成后，下一步应单独实现 Workspace、Sandbox 和 Approval。
只有这些边界稳定后，Agent Runner 才适合把工具调用接入多步循环，再之后
实现 HTTP/SSE 和 Studio 前端。
