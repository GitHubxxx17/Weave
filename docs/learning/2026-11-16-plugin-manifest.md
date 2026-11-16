# Weave Plugin Manifest：从受控注册到 GitHub 插件安装

**日期：** 2026-11-16
**对应功能分支：** `feat/plugin-manifest`
**学习目标：** 理解 Weave 为什么先实现受控的进程内插件，再扩展 GitHub 插件市场和独立进程沙箱。

<callout emoji="bulb" background-color="light-blue" border-color="blue">
这一轮插件功能解决的是“插件怎样进入 Weave 的能力体系”，不是“插件怎样从 GitHub 下载”。运行时注册和远程安装被拆成两层，后续可以独立演进。
</callout>

## 1. 这一轮解决什么问题

Weave 已经有 Tool Registry、Tool Pipeline、Approval、Workspace Policy 和
LLM Provider Registry。如果每个新功能都直接修改 Server 组合根，或者
插件直接拿到 Runtime 内部对象，系统会出现几个问题：

1. 插件可以绕过 Tool Pipeline，直接调用工具实现；
2. 插件可以绕过 Provider Registry，自行维护另一套 Provider 状态；
3. Server、CLI、Desktop 和 Crew 需要各自实现插件初始化；
4. 以后加入 GitHub 安装、MCP 或沙箱时，没有稳定的运行时边界；
5. 插件失败时可能留下已经注册一半的工具，导致进程状态不一致。

本轮建立的链路是：

```text
Plugin Manifest
  -> Plugin Context
  -> Plugin Registry
  -> Tool Registry / LlmProviderRegistry
  -> Tool Pipeline / Agent Runner
```

第一版插件由宿主代码显式创建并传入，因此属于“受信任进程内插件”。
它验证了插件契约和注册边界，但不宣称插件已经被沙箱隔离。

## 2. Plugin Manifest 是什么

`PluginManifest` 是插件对宿主的声明，主要描述身份、版本和能力：

```ts
interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly description?: string;
  readonly capabilities: readonly ('tool' | 'llm-provider')[];
}
```

字段可以这样理解：

| 字段           | 作用                                       |
| -------------- | ------------------------------------------ |
| `id`           | 机器使用的稳定标识，例如 `workspace-tools` |
| `name`         | 给用户看的名称                             |
| `version`      | 插件自身版本                               |
| `apiVersion`   | 插件依赖的 Weave Plugin API 版本           |
| `description`  | 展示和诊断信息                             |
| `capabilities` | 插件允许注册的能力类型                     |

Manifest 和 `package.json` 不是一回事。

`package.json` 解决的是 JavaScript 包如何安装、构建和解析依赖，例如：

```json
{
  "name": "@example/weave-plugin",
  "version": "1.0.0",
  "dependencies": {
    "@weave/plugin": "1.0.0"
  }
}
```

`PluginManifest` 解决的是 Weave 运行时如何理解这个扩展，例如：

```json
{
  "id": "workspace-tools",
  "name": "Workspace Tools",
  "version": "1.0.0",
  "apiVersion": "1.0.0",
  "capabilities": ["tool"]
}
```

前者是包管理问题，后者是宿主能力和兼容性问题。一个插件可以被
npm 正确安装，但仍然因为 `apiVersion` 不兼容而不能被 Weave 注册。

当前 Schema 会校验：

- id 只能使用小写字母、数字和连字符；
- 版本必须是三段数字格式；
- 能力列表至少有一项；
- 能力不能重复；
- 未知字段直接拒绝；
- API 版本结构合法，但具体兼容性由 Plugin Registry 判断。

把结构校验和兼容性检查分开有一个好处：错误可以更准确。字段写错是
`plugin-invalid-manifest`，Manifest 合法但宿主不支持它的 API 版本则是
`plugin-api-version-unsupported`。

## 3. 为什么 Plugin Context 比 Runtime 小

插件初始化时收到的是一个很窄的 Context：

```ts
interface PluginContext {
  registerTool(tool: ToolDefinition): void;
  registerProvider(provider: LlmProviderRegistration): void;
}
```

插件拿不到这些对象：

- `Runtime`；
- `ServiceContainer`；
- `SessionEventStore`；
- Workspace 根目录；
- Approval Broker 的内部状态；
- Hono App；
- Node `fs`、`child_process` 和原始网络客户端。

原因是能力注册和能力执行是两个不同问题。插件可以声明“我提供一个
工具”，但工具是否能读写文件、是否需要审批、如何处理取消，应该继续
由宿主的公共管线决定。

这种设计的面试表达是：

> Plugin Context 是最小能力接口。它只允许插件向宿主登记能力，不把宿主
> 的生命周期、持久化和安全服务暴露给插件。这样插件可以扩展系统，但
> 不能通过初始化接口绕过系统边界。

## 4. 为什么注册要先暂存再提交

插件初始化可能注册多个 Tool 和 Provider：

```ts
const plugin: WeavePlugin = {
  manifest: {
    id: 'workspace-tools',
    name: 'Workspace Tools',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['tool'],
  },
  setup(context) {
    context.registerTool(readFileTool);
    context.registerTool(writeFileTool);
  },
};
```

如果 `registerTool()` 直接修改宿主 Registry，第二个工具注册失败时，
第一个工具已经留下，插件就处于半初始化状态。

Weave 采用两阶段过程：

```text
setup()
  -> Context 暂存 Tool / Provider
  -> 检查 API、插件 ID 和名称冲突
  -> 一次性提交到宿主 Registry
  -> 记录 PluginSnapshot
```

`setup()` 失败时，暂存数据直接丢弃。Tool 名称或 Provider ID 冲突时，
也会在提交前失败。只有宿主 Registry 接收完所有注册，插件才出现在
`PluginRegistry.list()` 中。

这里的“事务”是插件注册层面的事务。当前 Tool Registry 和 Provider
Registry 没有删除 API，因此真正提交前必须完成所有已知校验。未来如果
支持热卸载，需要让宿主 Registry 记录能力所有权，再设计可逆提交。

## 5. Tool 为什么不能直接调用 execute

模型产生的 Tool Call 进入的路径必须是：

```text
Agent Runner
  -> Tool Registry
  -> Tool Pipeline
  -> JSON 解析
  -> Zod 参数校验
  -> Approval
  -> Workspace / Sandbox
  -> tool.execute()
```

Tool Pipeline 统一处理：

- 参数是否合法；
- 工具是否存在；
- 调用是否被取消；
- 是否超时；
- 是否需要人工审批；
- 返回结果是否可以序列化；
- 返回结果是否超过 UTF-8 字节限制。

如果插件直接保存并调用自己的 `execute()`，这些边界就全部失效。插件
可以实现工具逻辑，但不能决定工具绕过哪一层控制。

## 6. Provider 如何保持密钥私密

Provider 注册同样通过 Context 进入宿主：

```ts
context.registerProvider({
  id: 'deepseek',
  label: 'DeepSeek',
  type: 'openai-compatible',
  client: createOpenAiCompatibleClient({
    baseUrl: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY,
  }),
  defaultModel: 'deepseek-flash',
});
```

`LlmProviderRegistry` 保存两份信息：

```text
deepseek -> 私有 LlmClient
deepseek -> 公开 ProviderDescriptor
```

`PluginSnapshot` 只保存：

```ts
{
  id: 'provider-plugin',
  tools: [],
  providers: ['deepseek']
}
```

客户端、API Key、Base URL 和其他私有配置不会进入快照，也不会通过
`GET /settings/providers` 返回给浏览器。Runtime 根据 Agent 请求中的
Provider ID 找到私有客户端，Studio 只看到展示名称和默认模型。

## 7. GitHub 插件市场应该怎样接入

运行时 Plugin Registry 和 GitHub 安装器应该分开：

```text
Plugin Catalog
  -> Plugin Installer
  -> Installed Plugin Store
  -> Plugin Registry
  -> Runtime
```

GitHub 是获取插件代码的来源之一。安装时不能只保存仓库 URL，因为默认
分支会变化。项目应该至少锁定：

```text
repository URL
exact Commit
Monorepo package path
```

示例锁定信息：

```json
{
  "plugins": {
    "workspace-tools": {
      "source": "git",
      "repository": "https://github.com/example/weave-plugin-files",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "path": "packages/plugin",
      "version": "1.0.0"
    }
  }
}
```

建议的安装流程：

1. 从 HTTPS Catalog 读取插件条目；
2. 展示插件版本、仓库、Commit、能力和兼容版本；
3. 用户确认安装；
4. 获取精确 Commit；
5. 读取并校验 Plugin Manifest；
6. 安装依赖并构建；
7. 写入项目级锁定信息；
8. 重启或重新装配 Runtime。

Catalog 负责发现和展示，Installer 负责获取和锁定，Installed Store
负责记录安装状态，Plugin Registry 负责当前进程的能力注册。这样未来
可以增加 npm、私有仓库或 Weave 自己的市场，而不改变 Tool Pipeline。

## 8. 为什么进程内插件不等于沙箱

当前插件和 Server 在同一个 Node 进程内运行。即使 TypeScript 类型不
暴露 `fs`，插件仍然可以直接导入 Node 模块。因此当前模型是：

```text
受信任插件 + 受控注册
```

它不是：

```text
不可信插件 + 沙箱隔离
```

以后支持第三方不可信插件，需要把插件放到独立进程，通过 RPC 调用
宿主提供的权限代理，并增加资源限制、超时、进程回收、网络和文件访问
策略。Manifest 仍然可以复用，但执行 Adapter 要从
`InProcessPluginAdapter` 演进到 `ProcessPluginAdapter` 或
`SandboxPluginAdapter`。

## 9. 当前代码如何使用

当前 Server 支持显式传入受信任插件：

```ts
const server = await startServer(4317, {
  plugins: [workspaceToolsPlugin],
});
```

插件注册之后，Agent Runner 会使用同一个 Tool Registry 和 Tool Pipeline。
当前阶段不会自动读取 GitHub 地址，也不会执行任意远程代码。

常用验证命令：

```bash
pnpm --filter @weave/plugin test
pnpm --filter @weave/plugin typecheck
pnpm --filter @weave/plugin lint
pnpm check
```

## 10. 面试时如何回答

可以用下面这段话概括：

> Weave 的插件系统分成运行时注册和来源安装两层。运行时先通过
> Plugin Manifest 声明插件身份和能力，再通过受控 Plugin Context 把
> Tool 或 Provider 暂存并一次性注册到宿主 Registry。Tool 仍然经过共享
> Tool Pipeline、Approval 和 Workspace，Provider 仍然经过
> LlmProviderRegistry，API Key 不进入快照和浏览器。后续从 GitHub 安装时，
> Catalog 负责发现，Installer 负责拉取并锁定仓库、Commit 和子目录，
> Installed Store 保存状态，最后才交给 Plugin Registry。真正的不可信
> 插件需要独立进程或沙箱，不能只依赖 TypeScript 类型。
