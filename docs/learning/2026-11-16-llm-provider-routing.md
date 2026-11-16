# Weave LLM Provider 路由：从配置到 Studio 选择

**日期：** 2026-11-16  
**对应功能分支：** `feat/llm-provider-routing`  
**学习目标：** 理解 Weave 如何在不把 API Key 暴露给浏览器的前提下，同时支持 Mock、DeepSeek 和其他 OpenAI-compatible Provider。

<callout emoji="bulb" background-color="light-blue" border-color="blue">
这一轮的核心不是“在前端再写几个模型名字”，而是把 Provider 选择变成一条完整的后端能力链：Server 读取配置，Registry 管理客户端，Runtime 按请求路由，Studio 只消费脱敏元数据。
</callout>

## 1. 先理解要解决的问题

早期 Studio 为了先跑通 Agent、SSE 和 Session，发送请求时固定使用：

```json
{
  "provider": "mock",
  "model": "weave-local-demo"
}
```

这种方式适合做最小演示，但它有三个明显限制：

1. 前端菜单里的 `DeepSeek` 或 `OpenAI` 只是文字，点击后不会改变真实调用目标。
2. Runtime 只有一个固定的 `LlmClient`，无法根据请求选择不同 Provider。
3. 如果让浏览器直接携带 API Key，密钥就会进入开发者工具、网络记录、浏览器插件或日志，边界很危险。

这次要建立的正确请求路径是：

```text
WEAVE_LLM_PROVIDERS
        |
        v
Server 配置校验
        |
        v
LlmProviderRegistry
        |
        v
AgentRunner(provider)
        |
        v
具体 LlmClient
        |
        v
Runtime 事件 -> HTTP/SSE -> Studio
```

## 2. 四个关键概念

### 2.1 Provider 是“模型服务实现”

Provider 表示一个可以提供模型能力的服务或适配器，例如：

- `mock`：本地确定性演示；
- `deepseek`：使用 DeepSeek OpenAI-compatible 接口的配置；
- `openai`：使用 OpenAI-compatible 接口的另一组配置；
- 将来的插件 Provider：通过插件注册的本地或远程模型服务。

Provider id 是系统内部稳定引用，例如 `deepseek`。label 是给人看的名称，例如 `DeepSeek`。defaultModel 是选择这个 Provider 后，Studio 默认填入的模型，例如 `deepseek-chat`。

Provider 和模型不是同一个概念。Provider 决定“请求交给哪个服务实现”，model 决定“这个服务使用哪个具体模型”。把两者分开，后续才能支持一个 Provider 暴露多个模型。

### 2.2 LlmClient 是“统一调用接口”

`@weave/llm` 对外提供 Provider 无关的 `LlmClient`：

```ts
interface LlmClient {
  stream(request: LlmRequest, options?: LlmStreamOptions): AsyncIterable<StreamEvent>;
}
```

Runtime 不需要知道 DeepSeek 返回的 JSON 字段，也不需要知道某个厂商如何编码 SSE。每个适配器负责把自己的网络响应转换成 Weave 统一的 `StreamEvent`。

这就是适配层的价值：Runtime 依赖稳定接口，Provider 差异被关在 `@weave/llm` 内部。

### 2.3 Registry 是“客户端路由表”

`LlmProviderRegistry` 保存两份信息：

```text
Provider id -> 私有 LlmClient
Provider id -> 可公开的 ProviderDescriptor
```

公开描述类似：

```ts
{
  id: 'deepseek',
  label: 'DeepSeek',
  type: 'openai-compatible',
  defaultModel: 'deepseek-chat'
}
```

私有客户端内部则捕获 API Key。`registry.list()` 只返回描述，不返回客户端和密钥。这样 Server 可以把 `list()` 的结果直接提供给 Studio，同时不需要额外维护一份容易失真的 Provider 状态。

### 2.4 Studio 只拿元数据

Studio 请求：

```text
GET /settings/providers
```

返回：

```json
{
  "providers": [
    {
      "id": "mock",
      "label": "本地演示",
      "type": "mock",
      "defaultModel": "weave-local-demo"
    },
    {
      "id": "deepseek",
      "label": "DeepSeek",
      "type": "openai-compatible",
      "defaultModel": "deepseek-chat"
    }
  ],
  "defaultProvider": "mock"
}
```

浏览器只需要知道菜单怎么显示、选择后发送什么 `provider` 和 `model`。它不需要知道 `baseUrl` 和 `apiKey`。

## 3. Server 配置是如何进入 Registry 的

Server 通过 `WEAVE_LLM_PROVIDERS` 读取一个 JSON 数组。每个外部 Provider 至少包含：

| 字段           | 作用                              |
| -------------- | --------------------------------- |
| `id`           | Agent 请求使用的稳定标识          |
| `label`        | Studio 显示名称                   |
| `type`         | 当前必须是 `openai-compatible`    |
| `baseUrl`      | Provider 的兼容 API 地址          |
| `apiKey`       | 只存在于 Server 进程              |
| `defaultModel` | Studio 选择 Provider 后的默认模型 |

本地配置示例：

```json
[
  {
    "id": "deepseek",
    "label": "DeepSeek",
    "type": "openai-compatible",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "replace-with-your-key",
    "defaultModel": "deepseek-chat"
  }
]
```

可以在启动 Server 前设置环境变量：

```bash
export WEAVE_LLM_PROVIDERS='[
  {
    "id": "deepseek",
    "label": "DeepSeek",
    "type": "openai-compatible",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "replace-with-your-key",
    "defaultModel": "deepseek-chat"
  }
]'

pnpm dev
```

实际使用时应通过本地 `.env`、Shell 环境或系统密钥管理方式注入真实密钥。不要把真实 API Key 写进 Git、README、测试 fixture、Session 事件、SSE 事件或浏览器请求。

Server 的装配顺序可以理解为：

1. 用 Zod 校验整个环境变量 JSON。
2. 先注册默认 Mock Provider，保证未配置外部服务时仍然可以启动。
3. 为每个外部配置创建 `createOpenAiCompatibleClient()`。
4. 把客户端和公开描述注册到 `LlmProviderRegistry`。
5. 把同一个 Registry 注入 Agent Runner。
6. 通过 Registry 的公开描述实现 `/settings/providers`。

这里的关键是“同一个 Registry”。如果 HTTP 路由自己维护一份 Provider 列表，Runtime 又维护另一份客户端列表，两边很容易出现菜单能选但运行时报错的情况。

## 4. Runtime 为什么按请求路由

Agent 请求已经包含：

```ts
{
  sessionId: string;
  userMessage: UserMessage;
  provider: string;
  model: string;
}
```

Runtime 在真正创建 Turn 生命周期事件之前解析 Provider：

```ts
const client = options.llmRegistry?.get(request.provider);
if (client === undefined) {
  throw new AgentRunError(
    'agent-provider-unavailable',
    `LLM provider "${request.provider}" is not configured`,
  );
}
```

这个时机很重要。假如 Provider id 写错了，系统应该在 Session 中留下“运行中”的半条 Turn。先完成请求校验和 Provider 解析，再开始持久化运行生命周期，错误语义才是干净的。

Runtime 仍然兼容旧的单客户端模式：

```ts
createAgentRunner({
  llm: client,
  sessionStore,
});
```

当 Server 使用 Registry 时，Registry 优先。这样旧测试和简单 CLI 调用不需要一次性全部迁移，同时新的 Server 具备真正的多 Provider 路由能力。

## 5. Studio 的状态变化

Studio 新增两个浏览器端模块：

- `provider-types.ts`：定义响应结构，并通过 Zod 校验 Provider 元数据；
- `provider-api.ts`：封装 `GET /settings/providers` 和稳定的 `ProviderApiError`。

App 启动时同时发起 Workspace 和 Provider 请求。Provider 请求失败时：

1. 保留已有的本地 Mock fallback；
2. 显示中文提示；
3. 不影响项目树、会话和聊天页面继续使用。

选择 Provider 时一次更新两个值：

```text
selectedProviderId = deepseek
selectedModel = deepseek-chat
```

提交消息时才把这两个值放进 Agent 请求：

```json
{
  "sessionId": "session-1",
  "userMessage": {
    "role": "user",
    "content": [{ "type": "text", "text": "介绍一下 Weave" }]
  },
  "provider": "deepseek",
  "model": "deepseek-chat"
}
```

模型菜单显示真实的 Provider 元数据。设置页显示 Provider 名称、id、类型和默认模型，并明确说明 API Key 由本地 Server 管理。

## 6. 为什么浏览器不能管理 API Key

浏览器端的 API Key 有几个天然暴露点：

- DevTools 的 Network 面板可以看到请求头；
- 浏览器扩展和注入脚本可能读取请求；
- 前端异常上报和日志可能携带请求上下文；
- 用户把页面部署到远程环境后，密钥会进入不受控的客户端；
- Session 或缓存如果误保存请求对象，密钥会被长期持久化。

Weave 当前是 local-first 应用，最合理的边界是：

```text
Browser: provider id + model
Server: provider config + API key + LlmClient
Runtime: provider-independent lifecycle
LLM adapter: vendor protocol translation
```

这也为将来的 Plugin Runtime 留出空间。插件可以在 Server 侧注册 Provider，但不能绕过 Workspace、Approval、Tool Pipeline 和安全边界。

## 7. 这轮测试验证了什么

### Registry

`@weave/llm` 覆盖注册、查找、公开描述、重复 id 和私密客户端隔离，共 5 个测试。

### Runtime

`@weave/runtime` 覆盖多 Provider 路由、未注册 Provider 和旧单客户端兼容；Runtime 与 Agent Runner 相关测试共 63 个通过。

### Server

Server 覆盖默认 Mock、JSON 配置、非法配置、重复 id、公开元数据和 Agent API 路由，共 22 个相关测试通过。

### Studio

Studio Provider API 覆盖成功响应、非 200 错误和格式错误；App 覆盖菜单展示、DeepSeek 选择、请求参数、Settings 页面和 Mock fallback。Studio 测试共 54 个通过。

这些测试使用 fake fetch、Mock LLM 和内存 Session Store，不访问真实 DeepSeek 网络，也不需要真实 API Key。

## 8. 当前边界与下一步

本轮已经完成 Provider 路由的基础纵向切片，但以下能力仍然有意保留到后续：

- Plugin Manifest、动态安装、版本兼容和插件沙箱；
- 一个 Provider 下的模型自动发现；
- 多 Provider fallback、重试、限流和负载均衡；
- Provider 健康检查和计费统计；
- 浏览器端持久化当前 Provider 选择；
- 真实工具执行、审批和多 Agent Crew 编排；
- 跨多个 Server 进程的运行租约和幂等控制。

推荐的后续顺序是：

1. 先把 Provider 选择和真实 API 调用做一次人工验收；
2. 再建立 Plugin Manifest 和受控注册接口；
3. 然后把工具、审批和 Workspace 权限纳入统一插件边界；
4. 最后再做 Crew 的多 Agent 编排。

这样可以先验证最核心的“可替换模型 + 稳定 Runtime”边界，再扩展插件自由度。
