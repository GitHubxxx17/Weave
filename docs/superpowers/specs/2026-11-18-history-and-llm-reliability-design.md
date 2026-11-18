# 会话历史展示与模型可靠性修复设计

## 1. 背景

真实 DeepSeek 对话与刷新验收暴露了一批前后端问题，本次在一个分支内修复。

## 2. 修复项

### 2.1 会话存储字段权威性（session）

`append` 过去用 `{ eventId, sessionId, sequence, occurredAt, ...event }` 组装事件，
调用方对象展开在最后，可以覆盖 Store 分配的 `sequence` / `eventId` / `occurredAt`，
导致会话永久无法投影。改为只取调用方的 `type` 和 `payload`，Store 字段放在后面。
内存版与 SQLite 版都已修正，并加回归测试。

### 2.2 历史不回传思考内容（llm）

`contentToText` 过去拼接全部内容块。思考块会被当成正文发回模型：浪费输入 token，
且模型会模仿这种格式。改为只拼接 `text` 块，丢弃 `reasoning`。DeepSeek 等思考模型
本就要求请求里不带 `reasoning_content`，与此一致。

### 2.3 流中途错误帧（llm）

部分厂商返回 HTTP 200，却在流里发 `data: {"error":{...}}`。过去这帧没有 `choices`，
被 Zod 判为 `protocol` 错误，真实原因丢失。改为在校验 `choices` 前先识别 `error` 字段，
按 type / code 归类为 `rate-limit` / `authentication` / `context-overflow` / `provider`，
并保留脱敏后的厂商消息。

### 2.4 空闲超时（llm + server）

适配器原来只有总时长 `timeoutMs`，Server 和 Runner 都没传，实际没有任何超时。新增
`idleTimeoutMs`：每收到一个数据块就重置，覆盖首字等待与流中途停顿，不会切断正常的
长回答。Server 侧 `createServerLlmProviders` 与 `ProviderSettingsManager` 默认传入
`defaultProviderIdleTimeoutMs = 120000`（两分钟）。

### 2.5 模型步骤自动重试（runtime）

Runner 对**尚未向消费方发出任何 delta** 的模型步骤，遇到 `retryable` 的 `LlmError`
时指数退避重试（最多 2 次，250ms→500ms，受取消信号打断）。一旦发出过 delta 或已被
取消就不再重试，避免重复输出。

### 2.6 刷新后按轮次合并消息（studio）

一轮可能有多次模型调用，每次存成一条助手消息。刷新后 `toChatMessages` 按 `turnId`
把同一轮的助手消息合并成一张卡片：reasoning、工具调用来自各步，正文取各步拼接（与
运行时实时累计一致）。"没有正文"的提示只在整轮确实无正文时显示。

### 2.7 工具步骤折叠（studio）

新增 `ToolStep` 组件：默认折叠，标题显示工具名、目标路径与状态；展开后参数和结果放在
限高可滚动框内，长文件不再撑开对话。消息卡片内与右侧时间线共用该组件。

### 2.8 usage 事件白名单（studio）

`parseAgentEvent` 的已知事件名集合漏了 `usage`，运行中用量事件被丢弃，导致底部与右侧
都显示"—"。补进白名单并加单测。

### 2.9 每轮底部操作（studio）

合并后每一轮都有唯一卡片，底部统一显示时间、复制，最后一轮显示重试、其余显示引用。
刷新后同样生效（之前只有运行中的最后一轮有）。

### 2.10 desktop:dev 构建依赖（工程）

`desktop:dev` 过去只构建 desktop 自身，server / runtime 用旧 `dist`，拉新代码后出现
新旧混用。改为 `pnpm --filter @weave/desktop... build`，连同依赖一起构建。

## 3. 不在本次范围

- 上下文长度控制（L5）：与 token 优化一起，先调研主流方案；
- 每轮工具状态在刷新后的精确回显（服务端 `turns` 目前只返回计数，不含单次工具状态）；
- 列目录 / 搜索等新文件工具。

## 4. 测试

- session：调用方字段不能覆盖 Store 分配值；
- llm：历史丢弃 reasoning、流中途错误归类、空闲超时中止；
- runtime：失败重试后成功、发出 delta 后不重试、超过上限放弃；
- studio：usage 事件解析、多步合并成一张卡、工具步骤默认折叠、每轮底部操作。
