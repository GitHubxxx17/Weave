# Weave Workspace Files Design

**日期：** 2026-11-15

**状态：** 已确认，进入实施

**目标阶段：** Weave Runtime 的受保护文件工具

## 1. 目标

本轮在 `WorkspacePolicy` 之上增加最小的文本文件读取和写入工具。工具必须
作为标准 `ToolDefinition` 接入共享 Tool Pipeline，不能让调用方直接绕过
Pipeline 执行 Node 文件 API。

完成后应满足：

1. 提供 `read_file` 和 `write_file` 两个 Runtime 工具定义；
2. 输入先经过 Zod 校验；
3. 路径先经过 `WorkspacePolicy` 的词法边界判断；
4. 真实访问前检查 Workspace 根目录和目标的 `realpath`；
5. 拒绝符号链接解析后位于 Workspace 外的目标；
6. 拒绝目录作为文本文件读取或写入；
7. 读取和写入都支持 UTF-8 字节限制；
8. 写入默认拒绝覆盖已有文件，显式 `overwrite: true` 才允许覆盖；
9. 把 Node 文件系统错误归一化为稳定的 Workspace File 错误码；
10. 使用 Tool Pipeline 提供的 `AbortSignal`；
11. 不自动创建父目录，不实现 Approval、Shell 或 Diff。

## 2. 数据流和边界

```text
Tool Call
  -> Tool Pipeline
    -> Workspace File Tool
      -> WorkspacePolicy.resolve()
      -> realpath / lstat / stat
      -> fs.readFile / fs.writeFile
      -> Tool Result
```

Tool Pipeline 负责通用的参数解析、工具查找、超时、取消、结果序列化和结果
大小限制。Workspace File Tool 负责文件系统特有的路径、类型、大小和错误
规则。它不直接写 Session Event Store，也不实现用户 Approval。

WorkspacePolicy 是词法边界；文件工具在访问前再次解析真实路径。这样可以
拒绝常见的符号链接越界：

```text
/workspace/project/link -> /private
/workspace/project/link/secret.txt
```

真实目标不在 Workspace 内时，工具必须拒绝。

本轮仍不能宣称解决所有 TOCTOU 风险。文件系统执行器后续还可以增加更严格
的目录句柄、平台特定的 `open` 标志和 Sandbox。当前实现至少不直接沿着未经
检查的外部路径读写。

## 3. 公共 API

```ts
interface WorkspaceFileToolOptions {
  readonly workspace: WorkspacePolicy;
  readonly maxReadBytes?: number;
  readonly maxWriteBytes?: number;
}

interface WorkspaceFileTools {
  readonly readFile: ToolDefinition<ReadFileInput, string>;
  readonly writeFile: ToolDefinition<WriteFileInput, WriteFileResult>;
}
```

输入：

```ts
interface ReadFileInput {
  readonly path: string;
  readonly maxBytes?: number;
}

interface WriteFileInput {
  readonly path: string;
  readonly content: string;
  readonly overwrite?: boolean;
  readonly maxBytes?: number;
}
```

`maxBytes` 是调用级限制；没有传入时使用工具创建时的默认限制。返回结果
由 Tool Pipeline 序列化，`read_file` 返回 UTF-8 文本，`write_file` 返回：

```ts
interface WriteFileResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly overwritten: boolean;
}
```

路径字段返回 Workspace 相对路径，不把宿主机绝对路径暴露给模型或 UI。

## 4. 路径和符号链接规则

### 4.1 读取

1. 使用 `WorkspacePolicy.resolve(path, 'read')`；
2. 对 Workspace 根目录执行 `realpath`；
3. 对候选目标执行 `realpath`；
4. 用 `path.relative(realRoot, realTarget)` 检查真实目标是否在根目录内；
5. 对真实目标执行 `lstat` / `stat`；
6. 目录拒绝，普通文件读取；
7. 读取前检查文件字节大小；
8. 使用 UTF-8 和 Pipeline 信号读取。

目标不存在时不调用 `realpath` 会得到稳定的 not-found 错误。读取不自动创建
文件或目录。

### 4.2 写入

1. 使用 `WorkspacePolicy.resolve(path, 'write')`；
2. 检查内容 UTF-8 字节数；
3. 对 Workspace 根目录执行 `realpath`；
4. 如果目标存在，解析目标真实路径并确认仍在根目录内；
5. 如果目标是目录，拒绝；
6. 如果目标已存在且 `overwrite` 为 `false`，拒绝；
7. 如果目标不存在，解析父目录真实路径并确认仍在根目录内；
8. 将写入目标绑定到已解析的真实父目录，避免直接沿用未检查的符号链接父路径；
9. 使用 `flag: 'wx'` 防止默认模式下的覆盖竞态，覆盖模式使用 `flag: 'w'`；
10. 使用 UTF-8 和 Pipeline 信号写入。

父目录不存在时返回 not-found，不自动创建目录。写入目标路径的最后一段
允许是新文件名，但中间目录必须已经存在。

## 5. 错误分类

```ts
type WorkspaceFileErrorCode =
  | 'workspace-file-invalid-input'
  | 'workspace-file-not-found'
  | 'workspace-file-outside-root'
  | 'workspace-file-symlink-outside-root'
  | 'workspace-file-is-directory'
  | 'workspace-file-already-exists'
  | 'workspace-file-too-large'
  | 'workspace-file-permission-denied'
  | 'workspace-file-cancelled'
  | 'workspace-file-read-failed'
  | 'workspace-file-write-failed';
```

路径策略错误会被转换为 Workspace File 错误，避免文件工具把 Runtime 内部
策略细节直接暴露给上层。Node 原始错误通过 `cause` 保留。

## 6. 不实现的内容

本轮不实现：

- Approval 请求、等待和拒绝；
- Shell 和子进程；
- Diff；
- 自动创建目录；
- 文件监听；
- 二进制文件读取；
- 多步 Agent Tool Call；
- Session Tool Event；
- HTTP / SSE；
- 前端界面。

文件工具可以在下一阶段被 Approval 包装，但不能因为当前没有 Approval 就
把写入权限扩展到 Workspace 之外。

## 7. 测试策略

使用每个测试独立的临时目录，测试真实文件系统行为：

- 读取 UTF-8 文件；
- 写入新文件；
- 默认拒绝覆盖；
- 显式覆盖已有文件；
- 读取目录和写入目录被拒绝；
- 目标不存在；
- 父目录不存在；
- `..` 越界和绝对路径；
- 符号链接指向 Workspace 外部；
- 符号链接指向 Workspace 内部；
- 读取和写入字节限制；
- 无效输入不会触碰文件系统；
- 通过 Tool Pipeline 注册和执行；
- Tool Pipeline 的超时/取消可以传到文件工具。

测试只断言稳定错误码和业务结果，不依赖宿主机绝对临时目录名称。

## 8. 面试解释

可以这样解释文件工具和 Workspace Policy 的分工：

> WorkspacePolicy 负责词法路径边界，文件工具负责真实文件系统边界。
> 文件工具不会直接信任字符串路径，而是再次 realpath 并检查符号链接和
> 文件类型。Tool Pipeline 负责统一执行生命周期，避免每个入口重复实现
> 参数校验、超时、取消和结果限制。

关于覆盖保护：

> 写入默认使用 `wx`，先从产品语义上禁止意外覆盖，再用文件系统的独占
> 创建标志减少检查和写入之间的竞态。只有调用方明确传入 `overwrite: true`
> 才进入覆盖模式。

## 9. 实施记录

本阶段已实现：

- `@weave/runtime` 导出 `read_file` 和 `write_file` 工具工厂；
- 通过 `ToolRegistry` 注册并由 `ToolPipeline` 执行；
- UTF-8 读写、调用级和工厂级字节限制；
- 默认禁止覆盖，显式 `overwrite: true` 才允许覆盖；
- 真实 Workspace 根目录、目标和父目录检查；
- 外部符号链接拒绝、目录拒绝和稳定错误码；
- 预取消请求和文件 API 取消信号传递；
- 真实临时目录文件系统测试。

实现验证记录：

- 聚焦测试：15 个测试通过；
- `@weave/runtime` lint：通过；
- `@weave/runtime` typecheck：通过。

尚未实现的边界仍与本设计一致：Approval、Shell、Diff、Session Tool
Event、HTTP/SSE、Studio UI，以及更强的操作系统级 Sandbox。
