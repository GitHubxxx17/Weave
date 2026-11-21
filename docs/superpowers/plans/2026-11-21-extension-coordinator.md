# Stage 5.1a Extension Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Server 的完整扩展 Generation 组装与发布归属统一到一个协调器，同时保留已交付的本地 ESM 插件行为，为 MCP 来源提供接入点。

**Architecture:** 从 plugin-host 提取无 controller 的本地 ESM source；独立 PluginHost 保留兼容门面，Server 改由唯一协调器消费 source。控制器及 ServerHost 增加同步 commit、异步 retirement 的明确边界；所有来源共享一个管理队列与 admission latch。

**Tech Stack:** TypeScript strict ESM、现有 Zod 4.6.7、Vitest；Node >=24.4.0；无新增依赖。

**Spec:** [Stage 5 stdio 设计](../specs/2026-11-21-mcp-stdio-design.md)，特别是 §7、§8、§10。

## Global Constraints

- 用户于 2026-11-21 确认推荐设计；本计划仅实施 5.1a，不启动任何 MCP 服务。
- 新功能分支从合并设计后的最新 origin/main 创建，单独 PR，CI 后 squash merge。
- plugin-host 内部仍只依赖 plugin；Server 为唯一组合根；Studio HTTP-only。
- 保留公开 createPluginHost、Server 本地插件管理接口和稳定 Runner 的语义。
- 保留 ESM 精确摘要、导入前复验、setup 超时、有界排除重试和一次释放。
- durable append 返回后同步 fold + block，再进入下一次 await；append 失败不阻断或取消。
- unchanged refresh/recheck 不增加 source revision；拒绝已观察日志的回退或前缀改写。
- publication 不得含未授权成员；同步 commit 失败不能误提交 membership 或清除 latch。
- 关闭入口同步拒绝操作并取消候选、当前和退役回合；持久库最后关闭。
- 测试在各包 test/；新行为先写能区分错误实现的测试并观察失败；完成整仓 pnpm check。
- 参考 Codex、Kiro、DeepSeek Harness 的优点，核实来源并记录取舍，遵守 Weave 的 Session/Agent/Tool Pipeline/Plugin 边界。

## Task 1: 明确同步 Generation commit

**Files:**

- Modify: `packages/plugin-host/src/generation-runner.ts`
- Modify: `apps/server/src/server-host.ts`, `apps/server/src/runtime.ts`
- Test: `packages/plugin-host/test/generation-runner.test.ts`
- Test: `apps/server/test/server-host.test.ts`（没有该文件时新增针对 ServerHost 的测试）

**Interfaces:**

```ts
interface GenerationCommit {
  readonly retirement: Promise<void>;
}
// GenerationController，ServerHost 使用 ServerGeneration 特化：
commit(next: RunnerGeneration<R, E, T>, options?: { immediate?: boolean }): GenerationCommit;
```

原有 replace/publish 保留 Promise API，由同步 commit 后等待 retirement 实现。
commit 完成全部同步验证后切换 current，验证失败同步 throw；不提前创建资源所有权。

- [ ] 新增测试：无效 ID、disposed 和 Provider 冲突同步抛错且 current 未变；有效 commit
      返回前 current 已变，旧代 disposer 被 gate 阻塞时 retirement 仍 pending。

```ts
expect(() => controller.commit(invalidGeneration)).toThrow();
expect(controller.current()).toBe(previous);
const committed = controller.commit(next);
expect(controller.current()).toBe(next);
let retired = false;
void committed.retirement.then(() => {
  retired = true;
});
await Promise.resolve();
expect(retired).toBe(false);
releasePreviousDisposal();
await committed.retirement;
expect(retired).toBe(true);
```

- [ ] 运行目标测试并确认新测试因缺失 commit 失败；实现最小契约后再次运行。
- [ ] 验证旧 replace/publish 的取消、会话顺序、Provider 冲突和关闭测试保持通过。
- [ ] 独立审查同步临界段与所有权移交；记录测试和改动，不由子代理提交或切换分支。

## Task 2: 提取 LocalPluginSource，保留独立 PluginHost

**Files:**

- Create: `packages/plugin-host/src/local-source-types.ts`, `packages/plugin-host/src/local-plugin-source.ts`
- Modify: `packages/plugin-host/src/host.ts`, `host-reload.ts`, `host-state.ts`, `host-types.ts`, `index.ts`
- Test: `packages/plugin-host/test/local-plugin-source.test.ts`
- Reuse: `test/support/host-fixtures.ts`、既有 host-trust / host-reload / host-shutdown 测试。

**Interfaces:**

新 controller 命名为 `LocalPluginSourceController`，避免与 loader 已导出的数据别名
`LocalPluginSource` 冲突；后者保持兼容。source API 由以下职责组成：

```ts
interface LocalSourceStamp {
  readonly revision: number;
  readonly trustSequence: number;
}
// Snapshot 包含冻结的 discovery、ResolvedLocalPlugin[]、信任记录及 stamp。
// prepare 的实例含 identity、KernelPlugin、normalize(error)、幂等 dispose。
interface LocalPluginSourceController {
  snapshot(): LocalPluginSourceSnapshot;
  refresh(): Promise<LocalPluginSourceSnapshot>;
  mutate(command: LocalPluginSourceMutation): Promise<LocalPluginSourceSnapshot>;
  prepare(
    stamp: LocalSourceStamp,
    options: {
      readonly signal: AbortSignal;
      readonly excluded: ReadonlySet<string>;
    },
  ): Promise<PreparedLocalPlugins>;
  recheck(prepared: PreparedLocalPlugins, signal: AbortSignal): Promise<LocalSourceRecheck>;
  close(): Promise<void>;
}
```

在 local-source-types.ts 定义全部类型后交给 Task 3；source 不保存 active/current、
generation controller 或 acceptingRuns。创建选项提供同步 onAuthorityChange 回调，
内含 snapshot/reason/affectedIds/immediate。source 的行政操作由上层统一串行化。
未知 ID 的外部管理错误在门面保持兼容；撤销已经撤销但仍在旧代的插件可幂等执行。

- [ ] 先测试 source 不触发装配、refresh 不 import；未授权 prepare 不执行工厂；
      已授权 prepare 分配新实例且 close 不销毁已移交 Generation 的实例。
- [ ] 测试相同 refresh 不增 revision；摘要变化增 revision；日志回退/前缀改写拒绝。
- [ ] 用 deferred append 验证 observer 看到已 fold 的状态，且在后续 discovery await
      前同步调用；append 失败无通知；外部撤销即使后续发现失败也先通知宿主。
- [ ] 测试 prepare 后文件变化使 recheck 失效；取消后分配晚到的资源仍释放一次。
- [ ] 运行新测试观察缺失行为的失败，实施 source，再迁移独立 host 的内部使用。
- [ ] 运行所有 plugin-host 测试，保留原有目录竞态、setup deadline、可归因重试及
      慢 retirement 状态投影；不通过弱化旧断言掩盖语义变化。
- [ ] 审查资源所有权及源/门面之间无重复行政状态机。

## Task 3: Server 唯一协调器与来源适配

**Files:**

- Create: `apps/server/src/extension-types.ts`, `extension-coordinator.ts`, `local-extension-source.ts`
- Modify: `apps/server/src/local-plugin-host.ts`, `main.ts`
- Test: `apps/server/test/extension-coordinator.test.ts`
- Reuse: `apps/server/test/local-plugin-integration.test.ts`、实际 ServerRuntime/内核及临时目录。

**Interfaces:**

extension-types.ts 定义 Server 私有 source port，不将其升级为 plugin-host 通用协议平台。
每个 source 提供 snapshot/refresh/prepare/recheck；prepared items 带 sourceId、pluginId、
identity、KernelPlugin 和幂等 disposer。来源 authority 变更通过同步 observer 递增
desiredRevision，阻断不再授权的 current 成员，必要时取消所有旧代回合。
统一协调器提供 local PluginHost 兼容 facade、统一 reload、runner、generationSnapshot
和 dispose；后续 MCP source 消费同一内部接口。

- [ ] 用两个真实贡献插件的可控假 source 写测试：慢 source A 重建时排入 source B
      的变更，最终 current 同时保留两者最新状态，旧回合保持原代。
- [ ] 验证 revoke durable append 成功后装配失败，新回合被阻断；随后另一个来源的
      reload 不复活被撤销成员；旧候选/无效 stamp 不能解封。

```ts
await coordinator.mutate('mcp-fixture', revokeFixture);
await expect(nextTurn()).rejects.toThrow();
allowAssembly();
await coordinator.reload();
expect(currentPluginIds()).not.toContain('mcp-fixture');
expect(await nextTurn()).toEqual(expectedHealthyOutput);
```

- [ ] 覆盖单来源失败健康来源继续；不可归因装配错误保留旧指针；排除集合严格扩大，
      每轮全新实例；候选清理和已发布实例清理均幂等。
- [ ] 覆盖同步 commit throw 不改变 projection；慢 retirement 时 projection 立即
      对齐 current；关闭中不允许旧 commit/清理完成回调解除新阻断。
- [ ] 实施同一队列的完整候选 assembly，并在无 await 临界段检查 revision/stamp /
      enabled/trust/closed 后调用 Task 1 的 commit；随后同步提交 membership/latch。
- [ ] createServerLocalPluginHost 变为协调器兼容入口；Server 不再创建独立
      createPluginHost。既有配置工厂按代新建，保留 memoized disposal 及基线 ID 检查。
- [ ] 目标测试与既有 local-plugin-integration 全通过后独立审查。

## Task 4: 启动和 HTTP Generation 投影

**Files:**

- Modify: `apps/server/src/main.ts`, `plugin-api.ts`, `plugin-management-types.ts`, `plugin-catalog.ts`
- Test: `apps/server/test/plugin-api.test.ts`、`local-plugin-integration.test.ts`、现有启动测试。
- Modify: `docs/architecture/foundation.md` 和 Stage 5 spec 的实施记录。

**Interfaces:**

`GET /plugins` 新增兼容字段 `generation: { id, acceptingRuns, blocked? }`。
真实 startServer 即使 `pluginsDirectory: false` 也提供该字段；纯路由依赖注入可保留
可选 generationSnapshot 回调以兼容无真实 Runtime 的调用方。不泄露 controller/resources。

- [ ] 测试关闭本地 ESM 时，真实 Server 仍投影当前代；manager 启用时顶层 generation
      与 local.generation 一致，慢 retirement/blocked/关闭场景不读出假 acceptingRuns。
- [ ] 启动只创建一个 coordinator，停止时先同步取消/阻断、再 drain 所有代、最后
      关闭信任库；失败启动和重复 stop 仍满足一次释放。
- [ ] 保留旧 `/plugins` 写接口、安全守卫和 Studio 消费兼容性；本项不增加 MCP UI。
- [ ] 运行 `pnpm check` 并保存日志，独立整分支审查并修复可复现问题。
- [ ] 仅提交当前任务文件，创建独立 PR，CI 通过后按用户已确认的顺序推进。

## 交付证据

进度、红绿测试、接口裁定和审查记录保存在本计划专属的 ignored SDD ledger。
完成时报告实际检查、测试数量、PR 和合并状态；不以 API 预留能力声称已交付 MCP。
