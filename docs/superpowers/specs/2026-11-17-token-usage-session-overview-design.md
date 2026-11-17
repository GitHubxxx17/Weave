# Token 用量统计、回复元信息与会话概览面板设计

## 1. 背景

右侧"会话状态"面板只显示会话 ID、当前一轮的工具次数和思考过程；思考过程已在每条
回复中展示，工具次数刷新或切换会话后清零。Token 用量完全不可见：

- OpenAI 兼容适配器流式请求没有 `stream_options.include_usage`，很多服务不返回用量；
- 只解析了 `prompt_tokens` / `completion_tokens` / `total_tokens`，DeepSeek 的
  `prompt_cache_hit_tokens`、OpenAI 的 `prompt_tokens_details.cached_tokens`、
  `completion_tokens_details.reasoning_tokens` 被丢弃；
- 用量没有写入 Session 事件，刷新后丢失。

后续要做 token 优化，需要先能看到每轮的输入、输出、思考 token 和缓存命中率。

## 2. 参考

| 来源 | 借鉴 |
| --- | --- |
| Kiro | 每条回复底部：模型 · 用量 · 耗时；时间与操作按钮（最后一轮重试，其余引用，复制） |
| DeepSeek Harness | 运行中展示 token 速度、缓存命中率、轮次和运行时长 |
| Codex | 右侧面板放会话相关产物（这里是文件和工具时间线） |

## 3. 契约变更

### 3.1 `@weave/llm`

- 请求体增加 `stream_options: { include_usage: true }`；
- `cacheReadTokens` 取 `prompt_cache_hit_tokens`，缺失时取
  `prompt_tokens_details.cached_tokens`；`reasoningTokens` 取
  `completion_tokens_details.reasoning_tokens`；
- 允许 `usage: null` 的中间块。未报告的字段保持缺失，不当作 0。

### 3.2 `@weave/session`

- `step.started` 增加可选 `provider`、`model`；
- `step.completed` 增加可选 `usage`（与协议 `TokenUsage` 相同字段，未知字段丢弃）；
- 投影：`SessionTurn` 增加 `startedAt` / `completedAt`；`SessionStep` 增加
  `startedAt` / `completedAt` / `provider` / `model` / `usage`；`SessionMessage` 增加
  `turnId`（消息创建时正在运行的 Turn，发起 Turn 的用户消息没有）；
- 新增 `sumTokenUsage()`：逐字段相加，只有被报告过的字段才出现在结果里。

旧事件没有这些字段，投影照常工作，界面显示"模型未返回用量"。

### 3.3 `@weave/runtime`

- 模型 `step.started` 写入请求的 `provider` / `model`；
- 模型流 `finish.usage` 写入该步的 `step.completed`；
- 新增临时事件 `{ type: 'usage', usage, provider, model }`，每次模型调用结束发出一次，
  不单独持久化。

### 3.4 `@weave/server`

`GET /sessions/:id` 增加 `turns`：

```ts
{
  turnId, status, startedAt, completedAt?, provider?, model?,
  usage?,                 // 本轮所有模型步骤的合计
  modelSteps: [{ startedAt, completedAt?, usage? }],
  toolCalls, failedToolCalls,
}
```

消息增加 `turnId`。

### 3.5 `@weave/studio`

- **回复底部**：每轮最后一条助手消息下显示"模型 · 输入（命中率）· 输出 · 思考 · 耗时"，
  悬停显示每次模型调用的明细；第二行为时间和按钮。最后一轮显示"重试"，更早的轮次显示
  "引用"（把回复以 Markdown 引用插入输入框），都有"复制"。
- **重试**：用最后一条用户消息新开一轮，原来那轮保留在历史中（事件只追加）。
- **右侧"会话概览"**：项目文件夹（可设置）、模型、运行状态与已运行时长、输出速度、
  轮次 / 工具 / 失败次数；Token 合计（输入、命中缓存、输出、思考）与命中率条、
  每轮用量（点击跳到对应回复）；本会话读写过的文件及状态；整个会话的工具时间线。
- 删除右侧"思考过程"区块；审批卡片仍在输入框上方。
- 运行中先用临时 Turn（`live-<消息 id>`）累计 `usage` 事件，`completed` 时换成真实
  Turn id；失败或取消时标记对应状态。

## 4. 不做

- 上下文窗口占用比例（需要每个模型的上下文长度配置）；
- 按单价估算费用（需要价格配置）；
- token 优化本身（之后先调研主流做法再设计）。

## 5. 测试

- llm：DeepSeek 缓存与思考字段、OpenAI `cached_tokens` 回退、`usage: null`；
- session：投影的时间、归属、用量，`sumTokenUsage` 不补 0；
- runtime：每个模型步骤持久化用量并发出 `usage` 事件，工具步骤没有用量；
- server：会话详情的 `turns` 汇总与消息 `turnId`；
- studio：统计工具函数；回复底部用量、概览命中率、每轮列表、重试新开一轮、
  旧回复显示引用并写入输入框。
