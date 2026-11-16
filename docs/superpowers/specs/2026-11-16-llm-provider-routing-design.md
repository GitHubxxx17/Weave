# Weave LLM Provider 路由设计

**日期：** 2026-11-16
**状态：** 已批准，待实施

## 1. 背景

Weave 当前已经具备 `LlmClient`、Mock Provider 和
OpenAI-compatible Provider 适配器。`AgentRunRequest` 也包含
`provider` 和 `model` 字段，但 Server 组合根仍然只注入一个固定的
Mock LLM，Studio 的模型菜单只是本地界面状态。

这使得当前 Studio 可以验证 Agent Loop、SSE 和 Session 持久化，却不能
真正选择并调用 DeepSeek 或其他 OpenAI-compatible 服务。下一步需要补齐
Provider 的注册、配置、路由和 Studio 展示，同时保持 Runtime 不依赖
具体厂商实现。

## 2. 目标

本轮完成一个可测试的 Provider 路由纵向切片：

1. `@weave/llm` 提供进程内 Provider Registry；
2. Runtime 根据 Agent 请求中的 `provider` 选择对应的 `LlmClient`；
3. Server 从 `WEAVE_LLM_PROVIDERS` 环境变量读取本地 Provider 配置；
4. Server 公开不包含密钥的 Provider 元数据；
5. Studio 启动时读取可用 Provider，并让模型菜单使用真实配置；
6. 默认继续提供确定性的 Mock Provider，未配置外部服务时仍可运行；
7. DeepSeek 可以通过 OpenAI-compatible 配置接入，不需要修改 Runtime；
8. 补充测试、架构文档和学习文档。

## 3. 非目标

本轮不实现：

- 浏览器端保存或提交 API Key；
- 登录、账号系统、远程密钥管理或加密密钥库；
- Plugin Manifest、动态插件安装和第三方插件沙箱；
- Provider 自动发现、模型列表探测和计费统计；
- 多 Provider fallback、重试策略和负载均衡；
- Crew 多 Agent 编排；
- 改变 Session Event Store、Tool Pipeline 或 Agent Loop 的生命周期语义。

API Key 只在 Server 进程配置中出现。浏览器只接收 Provider 的公开
`id`、展示名称、类型和默认模型。

## 4. 方案比较

### 方案 A：Server 只读取一组固定环境变量

例如只支持 `WEAVE_LLM_BASE_URL`、`WEAVE_LLM_API_KEY` 和
`WEAVE_LLM_MODEL`。

优点是实现最简单。缺点是只能同时配置一个外部 Provider，Studio 的
模型选择无法表达 DeepSeek、OpenAI 和其他兼容服务并存的情况，也不利于
后续插件贡献 Provider。

### 方案 B：本地 Provider Registry，推荐

`@weave/llm` 管理稳定的 Provider id 和 `LlmClient`，Server 负责把经过
Zod 校验的环境配置转换为 Registry。配置使用 JSON 数组，因此可以同时
注册多个 OpenAI-compatible Provider。Runtime 只通过 Registry 查找客户端，
不会知道 `deepseek` 或 `openai` 的具体实现。

这是本轮采用的方案。它保留当前的 Provider Adapter 边界，同时为后续
Plugin Runtime 提供一个明确的注册点。

### 方案 C：现在直接把 Provider 做成 Plugin

把每个 Provider 都放进动态插件包，由插件负责配置、加载和生命周期。

这个方向与 Weave 的长期目标一致，但会同时引入插件清单、加载失败隔离、
权限边界和版本兼容问题。当前 Agent 还没有真实 Provider 路由，直接做
完整插件系统会让这条纵向切片过大，因此推迟到 Provider Registry 稳定后。

## 5. 架构

```text
WEAVE_LLM_PROVIDERS
        |
        v
Server Provider Config
        |
        v
LlmProviderRegistry
   |              |
 mock client   OpenAI-compatible client
        |
        v
AgentRunner(provider)
        |
        v
AgentRuntimeEvent -> HTTP/SSE -> Studio
```

### 5.1 `@weave/llm` Registry

新增 `LlmProviderRegistry`：

```ts
export interface LlmProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly type: 'mock' | 'openai-compatible';
  readonly defaultModel?: string;
}

export interface LlmProviderRegistry {
  register(provider: LlmProviderRegistration): void;
  get(providerId: string): LlmClient | undefined;
  list(): readonly LlmProviderDescriptor[];
}
```

Registry 保存客户端和公开描述的对应关系。`apiKey` 等私密字段只存在
客户端闭包中，`list()` 不返回任何秘密配置。

### 5.2 Runtime 路由

`AgentRunnerOptions` 支持一个 Provider Registry。为了保持已有 CLI、
测试和调用方兼容，原来的单一 `llm` 选项继续可用：

- 只配置 `llm` 时，Runner 使用旧的单客户端模式；
- 配置 `llmRegistry` 时，Runner 必须按请求的 `provider` 查找；
- Registry 中没有请求的 Provider 时，抛出稳定的
  `agent-provider-unavailable`；
- Server 使用 Registry 模式，避免错误地把任意 provider 字符串都路由到
  Mock Client。

### 5.3 Server 配置

Server 读取环境变量 `WEAVE_LLM_PROVIDERS`。它是一个 JSON 数组：

```json
[
  {
    "id": "deepseek",
    "label": "DeepSeek",
    "type": "openai-compatible",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "server-only-key",
    "defaultModel": "deepseek-chat"
  }
]
```

配置数组为空或未设置时，Server 仍注册：

```text
mock / 本地演示 / mock
```

每个外部 Provider 都通过现有 `createOpenAiCompatibleClient()` 创建。
配置解析失败会阻止 Server 启动，并返回脱敏的配置错误；错误消息不能
包含 API Key。

### 5.4 Provider 元数据 API

新增：

```text
GET /settings/providers
```

响应只包含：

```json
{
  "providers": [
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

该接口只读，不支持浏览器提交 API Key。Server 通过 Registry 生成响应，
从源头避免 HTTP 层重新维护一份 Provider 状态。

### 5.5 Studio

Studio 启动时并行加载项目树和 Provider 元数据。加载结果只保存公开的
Provider 信息：

- 没有配置外部 Provider 时默认选择 `mock`；
- 配置 DeepSeek 后，模型菜单显示 `DeepSeek` 和默认模型；
- 切换 Provider 时使用该 Provider 的默认模型；
- Provider 请求失败时显示中文错误提示，并保留当前会话；
- 设置页展示已配置 Provider、类型和默认模型，不显示 API Key。

当前 Studio 的模型菜单仍然位于 Composer 内部，不新增全局状态管理。
Provider 状态通过一个独立的浏览器 API 模块读取，便于后续拆出设置页。

## 6. 错误与安全

- 环境变量 JSON 无法解析：Server 启动失败，错误分类为配置错误；
- Provider 配置字段不完整：Server 启动失败，错误分类为配置错误；
- Agent 请求使用未注册 Provider：Runtime 返回
  `agent-provider-unavailable`，HTTP SSE 发送稳定 `error` 事件；
- 外部 Provider 的 HTTP、认证、限流和协议错误继续由现有
  OpenAI-compatible Adapter 归一化；
- API Key 不写入 Session、SSE 事件、Provider 元数据响应、日志或错误
  消息；
- `WEAVE_LLM_PROVIDERS` 配置中只允许 `type: "openai-compatible"`；
- Provider id、label、base URL 和默认模型在进入 Registry 前使用 Zod
  校验。

## 7. 测试策略

### `@weave/llm`

- Registry 可以注册、查找并列出公开描述；
- 重复 Provider id 被拒绝；
- `list()` 不暴露注册配置中的 API Key；
- 未注册 Provider 返回 `undefined`。

### `@weave/runtime`

- Registry 模式按请求 provider 调用正确的 LLM；
- 未注册 Provider 返回 `agent-provider-unavailable`；
- 旧的单一 `llm` 模式保持现有行为。

### Server

- 默认只返回 Mock Provider；
- 有效 JSON 配置会注册多个外部 Provider；
- 无效 JSON、重复 id 和非法 URL 在启动配置阶段被拒绝；
- `/settings/providers` 不返回 API Key；
- Agent API 使用 Registry 路由。

### Studio

- Provider API 正确解析响应和错误；
- 启动时读取 Provider；
- 模型菜单展示真实 Provider；
- 切换 Provider 后提交请求使用对应的 provider 和 defaultModel；
- 未配置外部 Provider 时仍然使用 Mock 演示。

完整验证仍然使用根级 `pnpm check`。

## 8. 文档同步

实现完成后同步：

- `docs/architecture/foundation.md`：补充 Provider Registry 和配置请求路径；
- `README.md`：增加 DeepSeek/OpenAI-compatible 本地配置示例；
- `docs/learning/2026-11-16-llm-provider-routing.md`：解释 Registry、
  Server 密钥边界、Runtime 路由和前端元数据；
- 本设计和实施计划：记录真实实现、测试数量和当前边界。
