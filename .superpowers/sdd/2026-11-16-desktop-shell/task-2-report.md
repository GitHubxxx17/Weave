# Task 2 完成报告：Studio 统一 API 基础地址

## 任务范围

本次只实现 Studio Renderer 的统一 API 基础地址适配：

- 浏览器模式继续使用相对 API 路径，由 Vite 代理转发；
- 桌面模式读取可选的 `window.weaveDesktop.serverUrl`，将 API 路径拼接为本地 Server 绝对地址；
- Workspace API、Provider API 和 Agent SSE 客户端共用同一个 URL 辅助函数；
- 保留现有请求方法、请求体、Zod 响应校验、错误码、SSE 帧解析和事件处理逻辑。

本次没有创建 Electron 文件，也没有修改 `apps/server`。已有的
`apps/server/.weave/` 未跟踪运行数据保持原样，未加入暂存区。

## 实现内容

### Runtime Bridge

新增 `apps/studio/src/features/runtime/runtime-bridge.ts`：

- `getRuntimeServerUrl(): string`
  - 浏览器环境或未注入桌面 Bridge 时返回空字符串；
  - 桌面 Bridge 存在时读取 `serverUrl`；
  - 去除 Server 地址末尾的重复斜杠。
- `runtimeApiUrl(path: string): string`
  - 规范化传入路径开头的重复斜杠；
  - Server 地址为空时返回相对路径；
  - Server 地址存在时返回绝对本地地址；
  - 保留查询字符串。

新增 `apps/studio/src/vite-env.d.ts`，声明：

```ts
window.weaveDesktop?: {
  readonly isDesktop: true;
  readonly serverUrl: string;
};
```

### API 客户端

以下客户端全部通过 `runtimeApiUrl()` 构造请求地址：

- `apps/studio/src/features/workspace/workspace-api.ts`
  - Project 请求；
  - Session 请求。
- `apps/studio/src/features/providers/provider-api.ts`
  - Provider metadata 请求。
- `apps/studio/src/features/agent/agent-stream.ts`
  - Agent POST SSE 请求。

## 测试覆盖

新增 `apps/studio/test/runtime-bridge.test.ts`，覆盖：

- 浏览器模式返回 `/projects`；
- 桌面模式返回 `http://127.0.0.1:46321/projects`；
- Server 地址和路径的重复斜杠规范化；
- 空 Server 地址仍返回合法相对路径；
- 每次测试结束清理 `window.weaveDesktop`。

更新 Workspace、Provider 和 Agent 客户端测试，覆盖：

- 浏览器模式继续请求 `/projects`、`/settings/providers` 和
  `/agent/runs/stream`；
- 桌面模式请求带 `http://127.0.0.1:<port>` 的同一路径；
- 桌面 Bridge 测试状态在测试结束后清理；
- 现有请求方法、body、Zod 校验和 SSE 行为继续保留。

测试文件放在 `apps/studio/test/`，符合仓库关于测试目录的约束。任务 brief
中列出的 `src/features/runtime/runtime-bridge.test.ts` 路径与仓库当前
“测试属于 package 或 app 的 `test/` 目录”规则冲突，因此采用可被现有
Studio 测试脚本收集的 `apps/studio/test/runtime-bridge.test.ts`。

## 验证结果

已运行：

```bash
pnpm --filter @weave/studio test
pnpm --filter @weave/studio lint
pnpm --filter @weave/studio typecheck
pnpm exec prettier --check \
  apps/studio/src/features/runtime/runtime-bridge.ts \
  apps/studio/src/vite-env.d.ts \
  apps/studio/src/features/workspace/workspace-api.ts \
  apps/studio/src/features/providers/provider-api.ts \
  apps/studio/src/features/agent/agent-stream.ts \
  apps/studio/test/runtime-bridge.test.ts \
  apps/studio/test/workspace-api.test.ts \
  apps/studio/test/provider-api.test.ts \
  apps/studio/test/agent-stream.test.ts
git diff --check
```

结果：

- Studio 测试：6 个测试文件通过，63 个测试通过；
- Studio lint：通过；
- Studio typecheck：通过；
- Prettier 检查：通过；
- Git diff 空白检查：通过。

同时按 TDD 流程先运行了新增桌面地址测试。实现前，Workspace、Provider 和
Agent 的桌面地址断言按预期失败；实现桥接和客户端改造后，完整 Studio 测试
通过。

## Git 操作

- 当前分支：`feat/desktop-shell`
- 本地提交信息：`feat: 适配桌面端本地 Server 地址`
- 只提交本任务相关的 Studio 文件和本报告；
- 未提交 `apps/server/.weave/`；
- 未推送；
- 未创建 Pull Request；
- 未调度子代理。
