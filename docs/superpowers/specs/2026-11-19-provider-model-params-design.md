# 每 Provider 模型参数设计（采样参数 + 上下文窗口默认值）

## 1. 背景

道1（#44）只做了模型强度（reasoningEffort）。设置页还缺：采样参数 `temperature`/`maxTokens`、
每 Provider 上下文窗口 `contextWindowTokens`。`contextWindowTokens` 仅在 env 配置 schema 里有，
动态 Provider 管理流程（store/manager/registry/公开描述符/Studio 表单）都没带；`temperature`/
`maxTokens` 是 `AgentRunRequest` 的 per-run 字段，但 Studio 从不发送、也没 UI。

## 2. 方案（已与用户确认 · 方案 A）

三者都做成**每 Provider 默认值**：在 Provider 表单里填 → 持久化进 Provider 记录 → 由
**Agent Runner 在请求未显式指定时服务端兜底应用**。UI 只落在设置页/Provider 表单，不碰
composer，也不改 App.tsx 的运行发送逻辑。

- `contextWindowTokens`：已被 runner 用于上下文预算（`resolveContextWindowTokens` 读描述符）。
- `temperature`/`maxTokens`：runner 在 `request.xxx ?? descriptor.xxx` 处兜底；`maxTokens`
  同时影响预算的 `reserveOutputTokens`。
- 三者都是可选；留空即不设，runner 回退到内置默认（窗口 128k、maxTokens 由 provider 决定）。

## 3. 契约变更（全部向后兼容新增）

**@weave/llm `provider-registry.ts`**
- `LlmProviderRegistration` 与 `LlmProviderDescriptor` 各加可选 `temperature`、`maxTokens`
  （`contextWindowTokens` 已有）。`providerRegistrationSchema` + `toDescriptor` 同步。
  校验：`temperature` `z.number().min(0).max(2)`；`maxTokens` 正整数。

**@weave/runtime `agent-runner.ts`**
- 新增 `resolveProviderSamplingDefaults(options, provider)` 读描述符的 temperature/maxTokens。
- 每步计算 `effectiveTemperature = request.temperature ?? 默认`、`effectiveMaxTokens =
  request.maxTokens ?? 默认`，用于 `buildModelContext` 预算与 `LlmRequest`。行为：��求显式值优先，
  否则用 Provider 默认，否则回退内置。

**apps/server**
- `provider-settings-types.ts`：`providerSettingsRecordSchema`、`createProviderSettingsInputSchema`
  加三字段可选；`updateProviderSettingsInputSchema` 三字段 `number | null`（null=清除、省略=保持）；
  `providerSettingsDescriptorSchema` 加三字段可选。
- `provider-settings-store.ts`：provider_settings 表加列 `temperature REAL`、`max_tokens INTEGER`、
  `context_window_tokens INTEGER`。无迁移框架，按 #43 方式用 `PRAGMA user_version`：建表后若
  `user_version < 1` 执行 `ALTER TABLE ADD COLUMN`×3 并置 1（新库旧库最终都 12 列，幂等）。
  INSERT/UPDATE/SELECT/parseRecord 同步。
- `provider-settings-manager.ts`：`getDescriptor` 带出三字段；`registerRecord` 注册时透传；
  `create`/`update` 处理三字段（update 的 null=清除、省略=保持）。
- `llm-providers.ts`：env `externalProviderSchema` + `ServerLlmProviderConfig` 加 `temperature`/
  `maxTokens`；env 路径注册时透传。
- `provider-api.ts`：路由复用上述 schema，天然放行；公开描述符经 `providerSettingsDescriptorSchema`
  带出三字段。

**apps/studio**
- `provider-types.ts`：`providerDescriptorSchema`、`ProviderSettingsInput`、`ProviderSettingsPatch`
  加三字段（patch 用 `number | null`）。
- Provider 表单（App.tsx 设置区）：加三个数值输入（温度 0–2 步进 0.1、最大输出 token、上下文窗口
  token），创建/编辑时读当前值、提交时带上（空=清除/不设）。表单校验范围。**不碰 composer。**

## 4. 测试

- llm：注册与描述符带出 temperature/maxTokens。
- runtime：请求省略时用 Provider 默认兜底；请求显式值覆盖默认；maxTokens 影响预算。
- server：store 迁移后读写三字段、旧库（无列）打开后可用；manager create/update/list 带出；
  env 配置带出。
- studio：provider 表单渲染/提交三字段（若有表单测试则补）。

## 5. 验收

Provider 表单可设温度/最大输出/上下文窗口；不设时行为不变；设了之后对应 Provider 的运行据此
兜底；`pnpm check` 全绿；不触碰 composer，与并行 L6 UI 在 App.tsx 的改动区域错开。
