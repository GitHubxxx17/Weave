# 插件贡献与服务调用方归属

本次修复是自定义面板的前置条件，契约见
[ADR 0009](../adr/0009-plugin-consumer-ownership.md) 和
[设计](../superpowers/specs/2026-11-22-plugin-owner-boundary-design.md)。

Kernel 在 setup 前解析、复制并深冻结 manifest。插件后续修改原始对象不会改变
身份、服务权限或 Generation 的插件列表。Studio 的命令和贡献目录仅展示 owner
实际接受的项目；捕获重复注册异常不再产生一条成功贡献。

## 宿主装配迁移

宿主向 builtin 提供真实 Store 和同一 Generation 的事件注册表：

```ts
hostServicesPlugin({ approvalBroker, sessionStore, pluginEvents });
```

提供 Store 却没有 `pluginEvents` 会立即失败。宿主直接解析服务仍取得真实实例；
插件通过 `env.use(sessionStoreRef)` 或服务 factory 的 deps 解析，都会取得绑定
调用插件身份的 writer。factory 的依赖使用该 factory 提供者的身份。

宿主自己调用 helper 时，必须传入 owner：

```ts
createPluginSessionStore(sessionStore, pluginEvents, 'quality-report');
```

一个批次在运行任何事件 Schema 前先检查全部事件类型。它只能写自身已注册的
`<pluginId>/<name>`；跨 owner、核心事件、未注册事件或 Schema 错误使整批零写入。
读取保留共享 Session 历史语义，插件的 `close()` 不关闭宿主 Store。插件停用或
移除也不删除历史。既有事件没有补写 producer、artifact 或 Generation 证明。

`pluginEventsRef` 现在提供 `PluginEventReader`。`get/list` 仅返回冻结的
`{ type, hasProjection }` 元数据，不能取得 Schema 或 projection 函数；reader
保留 `parse/project`，没有 `define`。完整 Registry 由宿主持有。

## 自定义扩展点迁移

治理 guard 使用同步接受接口：

```ts
guard: (api, check) => ({
  addItem(item) {
    return check(item.name, () => api.addItem(item));
  },
});
```

owner 同步返回 `undefined` 才记录成功，返回 `false` 表示跳过。异常、Promise
或其它返回值都不记录成功。数组 collector 要用 block，避免返回 `push()` 的数字：

```ts
addItem: (item) => {
  items.push(item);
};
```

旧 `check(name)` 仍验证声明，但不记录成功贡献。contributor 与 owner 接受回调
都必须同步结束。guarded API 在 contributor 返回或抛错后关闭，保留引用也不能
继续调用；意外 Promise 的拒绝会被观察，宿主不会等待无限期 Promise。已经发生的
owner 副作用无法由内核自动回滚，候选 Generation 的回收仍由宿主负责。

## 验证范围

新增 Server 回归覆盖捕获重复命令后实际归属，以及直接和 factory deps 两条
跨 owner 写入路径。真实 loopback HTTP 验收创建本地插件、人工信任、Session，
经 Agent 和共享 Tool Pipeline 写 report，再检查越权拒绝、停用和 SQLite 重启
后的历史保留。对应测试是 `apps/server/test/plugin-owner-boundary.test.ts` 和
`apps/server/test/plugin-owner-http.test.ts`。

这里约束标准 SDK 的逻辑归属。受信任的 Node 插件仍在宿主进程中执行，不能把
服务视图解释为操作系统隔离或完整的恶意代码沙箱。
