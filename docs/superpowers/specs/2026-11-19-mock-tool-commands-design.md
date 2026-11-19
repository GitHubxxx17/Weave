# 本地演示模型支持 `/tool` 指令

## 1. 背景

测试审批卡片、工具步骤这类界面时，现在只能用真实模型：内置的 `mock` Provider（本地演示）
只回放两句固定的话，从不调用工具；真实模型要花 token，而且不一定按需要发起某个调用。

本设计让本地演示模型按用户消息里的 `/tool` 指令发起任意工具调用，不需要真实模型就能在
Studio 里触发审批、失败、多个调用等场景。工具照常经过 Tool Pipeline 真实执行。

## 2. 行为

`@weave/llm` 新增 `createToolCommandMockLlmClient({ fallback, delayMs })`，按请求的最后一条
消息决定输出：

| 最后一条消息 | 输出 |
|-|-|
| user 消息，含以 `/tool` 开头的行 | 每行一个工具调用：`tool-call-start`，再接一个 `tool-call-delta`（参数原文），最后 `finish(tool-call)` |
| user 消息，有 `/tool` 行缺少合法工具名 | 一段用法说明，`finish(stop)`，不调用任何工具 |
| user 消息含 `/tool` 行，但请求不带 `tools` | 一段"本轮没有可用的工具"的说明，`finish(stop)` |
| 末尾是一组 tool 结果 | 一段文字，逐个列出工具名和结果的第一行（最多 160 字符），`finish(stop)` |
| 其他 | 回放 `fallback` 脚本，与 `createMockLlmClient` 相同 |

规则：

- 行格式为 `/tool <工具名> [JSON 参数]`，前后空白忽略；工具名匹配 `[A-Za-z0-9_.-]+`。
  参数必须写在同一行，换行写成 `\n`；省略参数时为 `{}`。
- 参数不解析，原样交给 Tool Pipeline。JSON 写错、工具不存在、只读模式拦截都按正常路径
  返回 `tool-invalid-json`、`tool-not-found`、`tool-not-permitted`，便于测试失败的显示。
- 调用 id 为 `mock-call-<uuid>`，满足投影"同一 Turn 内 id 唯一"的约束。
- 只看最后一条消息：工具结果回来后输出摘要并结束，`/tool` 不会在同一轮里重复触发。
- 不返回 usage；请求照旧用 `llmRequestSchema` 校验，取消照旧生效。

## 3. 接入

`apps/server/src/llm-providers.ts` 的默认 `mock` Provider 改用该客户端，`fallback` 为原来的
固定脚本。`createServerLlmProviders({ mockScript })` 的 `mockScript` 仍然只替换 `fallback`。
普通消息的输出不变。

## 4. 影响的契约

- llm：新增导出 `createToolCommandMockLlmClient` 与 `ToolCommandMockOptions`；
  `createMockLlmClient` 不变。
- server：默认 mock 的行为扩展，普通消息不变。
- protocol、session、runtime、workspace、plugin、studio、desktop：不变。层次依赖不变。

## 5. 测试

- llm：回放 fallback；单行与多行调用；参数省略与原样透传；缺少工具名时的用法说明；请求不带
  `tools` 时的说明；工具结果摘要（含失败结果）；请求校验；取消。
- server：默认 mock 经 `/agent/runs/stream` 发起 `read_file` 与 `write_file`，审批通过后写入
  文件并返回摘要。

## 6. 注意

工具是真实执行的：在界面上同意审批，就会真的运行命令、写入文件。只想看界面时可以拒绝审批，
或者给项目设置一个临时文件夹。
