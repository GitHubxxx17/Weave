# Weave Runtime Session Store 装配设计

**日期：** 2026-11-15

**状态：** 已确认，进入实施

**目标阶段：** Weave Studio 的 Runtime 服务装配

## 1. 目标

本轮把已经完成的 `@weave/session` Event Store 接入 `@weave/runtime` 的服务
生命周期，同时让本地 Server 默认装配一个 In-Memory Store。

完成后应满足：

1. Runtime 可以注册并获取 `SessionEventStore`；
2. Runtime 启动时创建 Store，停止时调用 Store 的 `close()`；
3. Store 创建失败时遵循现有 Runtime 的清理和重试语义；
4. Runtime 不知道 SQLite、文件路径或 Server 框架；
5. Server 可以自行选择 In-Memory 或 SQLite 实现；
6. 通过测试证明 Session Store 不会绕过 Runtime 生命周期。

本轮不实现 Agent Loop、Session HTTP API、Workspace、Approval 或前端。

## 2. 方案

在 `@weave/runtime` 增加一个小型适配器：

```ts
createSessionEventStoreService({
  create: (context) => createInMemorySessionEventStore(),
});
```

这个适配器返回普通的 `RuntimeService<SessionEventStore>`。它只负责：

- 为 Store 分配 Runtime 内部服务标识；
- 调用调用方提供的工厂创建 Store；
- 在 Runtime 停止或启动失败清理时调用 `store.close()`。

Runtime 不直接导出 SQLite 配置，也不把 `SessionEventStore` 的具体实现写死在
生命周期核心中。这样 CLI、Server、桌面端和测试都可以用不同的 Store 实现，
但共享相同的启动和关闭语义。

## 3. 数据流与生命周期

```text
Server/CLI 选择 Store 实现
  -> createSessionEventStoreService(factory)
  -> createRuntime({ services: [...] })
  -> runtime.start()
  -> factory(RuntimeContext)
  -> Runtime.get(sessionStoreService)
  -> runtime.stop()
  -> store.close()
```

启动失败时仍然遵循 Runtime 的已有规则：

1. 先 abort 当前启动尝试的 `AbortSignal`；
2. 按创建顺序的逆序释放已经成功创建的服务；
3. 保留启动错误和清理错误；
4. Runtime 进入 `stopped`，不能再次启动。

Session Store 工厂接收 `RuntimeContext`，因此未来可以读取经过 Runtime 装配的
只读配置或观察生命周期信号，但本轮不把未知配置直接转换为 SQLite 参数。

## 4. 边界

### `@weave/session`

只提供 `SessionEventStore` 接口和 In-Memory、SQLite 实现，不依赖 Runtime。

### `@weave/runtime`

只依赖 `SessionEventStore` 接口和 Runtime 自身的生命周期类型。它不导入
Hono、React、Node HTTP 模块或 SQLite 具体 API。

### `apps/server`

负责选择本地 Server 的默认实现。本轮选择 In-Memory Store，避免 Server 测试
依赖临时数据库文件；SQLite 仍可通过同一个 Runtime Service 适配器注入。

## 5. 测试策略

- Runtime 包测试服务工厂收到 `RuntimeContext`，Store 被 `get()` 返回，停止时
  `close()` 被调用；
- Runtime 包测试 Store 创建失败时会执行已创建服务的逆序清理；
- Server 包测试默认 Server Runtime 确实装配 Session Store；
- 完整 `pnpm check` 继续验证包依赖边界、类型、测试和构建。

## 6. 面试解释

这里使用的是“适配器 + 依赖注入”，而不是让 Runtime 自己 `new SQLite`。Runtime
只关心服务生命周期，具体实现由组合根决定。这样做有两个直接收益：

1. 测试可以注入 In-Memory Store，速度快且确定；
2. 生产环境可以注入 SQLite 或未来的远程 Store，而不修改 Runtime 核心。

这也保持了 Weave 的依赖方向：底层 Session 定义能力，上层 Runtime 负责组合，
更上层 Server 决定运行场景。
