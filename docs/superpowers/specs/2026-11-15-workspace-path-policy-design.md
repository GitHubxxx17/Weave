# Weave Workspace Path Policy Design

**日期：** 2026-11-15

**状态：** 已确认，进入实施

**目标阶段：** Weave Runtime 的 Workspace 安全边界

## 1. 目标

本轮为 `@weave/runtime` 增加最小的 Workspace 路径策略。它负责回答一个
问题：一个外部传入的路径，是否在 Weave 配置的 Workspace 根目录内。

完成后应满足：

1. Workspace 根目录在创建时被验证为绝对路径；
2. 工具调用传入的相对路径以 Workspace 根目录为基准解析；
3. 解析结果不能通过 `..` 逃逸到根目录之外；
4. 当前阶段拒绝绝对路径和包含空字节的路径；
5. 返回规范化的绝对路径和相对路径；
6. 使用稳定的错误类型和错误码；
7. 不读取、写入或执行任何文件系统对象；
8. 文件读写、Shell、符号链接和 Approval 在后续独立分支中接入。

本轮只建立可被后续工具复用的路径契约，不实现具体的 `read_file`、
`write_file` 或 `exec_shell` 工具。

## 2. 背景与边界

Weave 的 Tool Pipeline 是所有工具调用的统一执行入口，但 Pipeline 本身
不应该知道文件系统路径规则。文件工具需要一个独立的 Workspace 边界，
Shell 工具也需要同一边界来确定工作目录。

本轮的依赖关系保持不变：

```text
Agent Runner
  -> Tool Pipeline
    -> File/Shell Tool
      -> WorkspacePathPolicy
        -> Approval / Sandbox / Executor
```

`WorkspacePathPolicy` 只负责路径表达式和 Workspace 根目录的关系。它不
负责决定用户是否批准，不负责检查文件权限，也不负责执行系统调用。

## 3. 方案选择

### 3.1 在 Tool Pipeline 中直接判断路径

不选择。这样会把通用工具执行生命周期和文件系统安全规则耦合在一起，
网络工具、纯计算工具和文件工具也会共享不必要的路径逻辑。

### 3.2 创建独立的 Workspace 包

暂不选择。当前 Workspace 还没有独立的持久化、进程或跨运行时契约，
提前创建新包会扩大依赖图。路径策略属于 Runtime 执行边界，先放在
`@weave/runtime`，等 Workspace 需要独立被 CLI、Desktop 和 Plugin SDK
复用时再评估拆包。

### 3.3 选择：Runtime 内独立的纯路径策略模块

本轮采用：

```text
@weave/runtime
  ├── workspace-types.ts
  └── workspace-policy.ts
```

模块只依赖 Node 内置的 `node:path` 和 Zod，不新增第三方依赖。策略构造
和路径解析都可以在没有真实文件的测试环境中确定性运行。

由于 TypeScript 需要 Node 内置模块的声明文件，`@weave/runtime` 增加
`@types/node` 开发依赖。它只参与类型检查和编辑器提示，不会进入运行时
产物，也不改变部署依赖。

## 4. 公共接口

```ts
type WorkspaceOperation = 'read' | 'write' | 'execute';

interface WorkspacePolicyOptions {
  readonly root: string;
}

interface WorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly operation: WorkspaceOperation;
}

interface WorkspacePolicy {
  readonly root: string;
  resolve(inputPath: string, operation: WorkspaceOperation): WorkspacePath;
}
```

`operation` 先进入公共契约，即使本轮三种操作使用相同的根目录规则。
后续可以在不修改文件工具调用形状的情况下增加只读根目录、写入白名单
或 Shell 独立策略。

所有返回对象都会冻结，避免调用方在校验完成后修改路径元数据。

## 5. 输入与错误规则

### 5.1 Workspace 根目录

- 根目录必须是非空字符串；
- 根目录必须是绝对路径；
- 创建策略时使用 `path.resolve` 规范化；
- 本轮不要求根目录已经存在；
- 本轮不调用 `realpath`，因此不会触发文件系统 I/O。

### 5.2 输入路径

- 路径必须是非空字符串；
- 路径不能包含空字节；
- 当前阶段只接受相对路径；
- `.`、`./src/index.ts` 和包含可安全消除的 `..` 的路径可以解析；
- 解析后如果路径等于根目录，返回相对路径 `.`;
- 解析后如果路径位于根目录之外，拒绝；
- 不检查目标是否存在、是否为文件、是否为目录或是否可访问。

### 5.3 稳定错误

```ts
type WorkspacePolicyErrorCode =
  | 'workspace-invalid-input'
  | 'workspace-invalid-root'
  | 'workspace-absolute-path-not-allowed'
  | 'workspace-path-outside-root';
```

错误消息不包含完整的外部输入，避免把未经处理的路径内容直接回显到
日志或 UI。原始校验错误通过 `cause` 保留在开发调试边界。

## 6. 路径判断算法

```text
validate root
  -> path.resolve(root)
  -> validate input string
  -> reject absolute input
  -> path.resolve(root, input)
  -> path.relative(root, candidate)
  -> relative is empty or does not start with .. / ../
  -> return frozen absolute + relative path
```

不能只使用字符串前缀判断。例如 `/workspace-other` 不是
`/workspace` 的子路径。使用 `path.relative` 可以按当前平台的路径规则
判断目录关系。

本轮采用词法路径边界。符号链接可能让一个词法上位于 Workspace 内的
路径最终指向外部目标，这属于真实文件执行器的职责。后续文件工具必须
在打开文件前进行 `lstat` / `realpath` 和目标类型检查，并在写入时重新
确认目标边界，不能把本轮的词法判断当成完整 Sandbox。

## 7. 测试策略

测试放在 `packages/runtime/test/workspace-policy.test.ts`，覆盖：

- 接受绝对 Workspace 根目录；
- 拒绝相对 Workspace 根目录；
- 将普通相对路径解析到根目录下；
- 规范化 `.` 和安全的 `..`;
- 允许根目录本身；
- 拒绝 `..` 逃逸；
- 拒绝绝对输入路径；
- 拒绝空字符串和空字节；
- 拒绝未知操作；
- 返回冻结的路径对象；
- 暴露稳定错误码；
- 不访问真实文件系统。

不使用临时目录或真实文件，避免把路径策略测试误写成文件系统集成测试。

## 8. 后续接入顺序

本轮之后按以下独立主题推进：

1. `feat/workspace-files`：文件读写执行器，增加符号链接、文件类型和
   读写大小限制；
2. `feat/approval-service`：审批请求、允许/拒绝/过期状态和等待语义；
3. `feat/workspace-shell`：Shell 工作目录、命令风险级别、子进程取消；
4. `feat/agent-tool-loop`：Agent Runner 多步 Tool Call 和 Tool Message；
5. `feat/http-sse-adapter`：把 Runtime 事件适配为 HTTP/SSE；
6. `feat/studio-shell`：Studio 前端真实验收。

每项继续保持一个主题一个分支，不把 Approval 和实际工具执行混进本轮。

## 9. 面试解释

可以把这层解释为“能力执行前的边界策略”，而不是“文件工具”：

> Tool Pipeline 只负责一次工具调用的通用生命周期，Workspace Policy
> 负责把外部路径限制在当前工作区内。两者分离后，文件工具和 Shell 工具
> 可以共享同一套路径安全规则，Approval 和 Sandbox 也可以继续叠加，而
> 不需要把安全判断散落在每个工具函数里。

还需要明确：

> 词法路径检查不能解决符号链接和 TOCTOU 问题，所以它不是完整 Sandbox。
> 真正访问文件时还必须由执行器做 realpath、文件类型、权限和竞态检查。
> 这是有意保留的边界，而不是遗漏。

## 10. 实施结果

本设计已在 `feat/workspace-path-policy` 分支落地：

- 新增 `createWorkspacePolicy()`、Workspace 输入 Schema 和稳定错误类型；
- 使用 `node:path` 完成词法路径规范化和根目录边界判断；
- 增加 11 项 Workspace Policy 测试；
- `@weave/runtime` 显式加载 `@types/node`，确保 `node:path` 在严格类型检查
  下有稳定声明；
- 未引入文件系统 I/O、符号链接解析、Shell 或 Approval 行为。
