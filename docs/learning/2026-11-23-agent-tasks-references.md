# Weave 多 Agent 草案第 2 节一手参考核查

核查日期：2026-11-23。对象：`/tmp/weave-multi-agent-design.md` 第 2 节。只读源码/文档事实核查；未改仓库，未执行 Git mutation。

结论：第 2 节的 12 个链接均成功读取（HTTP 200）；Codex 与 Harness 的文件均存在于文中固定 commit，Kiro 三页的更新日期与草案一致。采用原则均可从已引内容找到支持。未发现失效引用或需要阻止设计评审的来源错误。有一处建议收窄措辞，避免混淆 Codex V1 spawn 与 V2 cold resume。

## 建议精确化的一处措辞

草案 Codex 行把“control 在准备子线程时预留资源、保留父绑定及权限交集”合在一起。`control/spawn.rs` 的初始 `spawn_agent_internal` 确实先预留容量（L665–724），但“保留父环境绑定”“权限取交集”的直接证据位于同文件 V2 冷恢复路径：L443 的注释保留 child retained binding，L508 的 `intersect_effective_permission_profiles` 处理权限变更。建议改为：

> control 在初始 spawn 前预留容量；V2 冷恢复校验父拥有关系、保留环境绑定，并在权限变动时取交集。

这属于适用路径说明，非架构建议。现表格把 V1 handler 与共用 control 文件合并引用，容易让读者把 V2 恢复保证读成 V1 初次 spawn 的全部实现。

证据：[初始 spawn 容量预留](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/core/src/agent/control/spawn.rs#L665)、[V2 恢复绑定](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/core/src/agent/control/spawn.rs#L443)、[V2 恢复权限交集](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/core/src/agent/control/spawn.rs#L508)。

## 核实证据

| 来源                                       | 核实结果                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex `multi_agents/spawn.rs`（200）       | L76–84 在调用创建前验证 next depth；L125–145 通过 `agent_control.spawn(SpawnRequest)` 创建，带 parent thread、parent turn、root turn 以及 inherited environments/plugin choices。草案准确。                                                                                                    |
| Codex `multi_agents/wait.rs`（200）        | L127 起订阅状态，L172 已有终态立即返回；L183 以固定 deadline 等待；L206 返回 `timed_out = statuses.is_empty()`；超时没有 close/cancel 路径。返回实际是 `{status:{}, timed_out:true}`，草案“只报告 timed_out”可理解为不取消任务，未构成误述。                                                   |
| Codex `multi_agents/close_agent.rs`（200） | 独立 handler，L69–70 读取状态后调用 `close_agent`，与 wait 分离。额外注意 L73 注释明确 legacy close 可以针对 unrelated loaded threads；草案没有借用其 ownership 保证，因而无误。                                                                                                               |
| Codex `agent/control/spawn.rs`（200）      | L699–724 资源预留；L443/L508 retained binding/permission intersection 位于 V2 冷恢复路径，见上方措辞建议。                                                                                                                                                                                     |
| Codex `agent/control/budget.rs`（200）     | L11–17 的共享 controller 方法调用 `self.runtime.rollout_budget.record_usage(usage, hook_units)`；L20 起 reminder 状态同样经 controller 访问。仅据该文件不应声称 provider 成本硬限制，而草案已明确不作此承诺。                                                                                  |
| Harness `README.zh.md`（200）              | L51–59 明确 activation 容量与 depth 独立、创建/冷恢复前预留、清理后归还、满额拒绝不排队；L84 明确创建 signal 仅取消未发布工作、发布后由精确 activation dispose 管理，并要求 root teardown 前 drain descendants；L114/135 描述 parent-owned catalog，L113/142 描述 child descriptor。草案准确。 |
| Harness `manager.ts`（200）                | L239–243 drain 先关闭准入、abort materializations、等待已准入创建、再 dispose residents；L587 起验证创建目录与 ancestry；L719 预留池；L823–834 临时 signal 转发在启动后解除；L1094–1120 dispose 后归还容量。支持草案。                                                                         |
| Harness `child-agent.ts`（200）            | L49 起 depth 通过持久 parent floor 推导；child 继承 model/maxTokens 与 delegated policy/composition 由专用 helper 处理。支持草案所称 child policy/composition 边界。                                                                                                                           |
| Harness `control.ts`（200）                | 外部 control 字段通过 Zod 校验；拒绝码仅暴露封闭的 admission vocabulary，`UNAUTHORIZED` 映射为无法验证 active tree membership。草案把它称作 control validation 准确；真正 ownership 校验在 manager。                                                                                           |
| Kiro custom-agent subagents（200）         | live page 的“Sub-agent permissions”明确 CLI V3/IDE 检查 parent policy 与 child permissions，“The stricter result wins”；拒绝优先、任一 ask 需审批；工具可见性来自 child config；升级 trustedAgents 规则只跳过启动审批，不批准子工具。页面写明 `Page updated: November 13, 2026`。              |
| Kiro Crew subagents（200）                 | live page 明确独立 session、Activity task/elapsed/status/Stop、owner-scoped agent controls、父工作继续、auto-sized cap、3h/1000 tool calls、accepted 前 durable queue 与保守重启 reconciliation。页面写明 `Page updated: September 30, 2026`。草案明确不采用其自动注入/排程行为，未混淆。      |
| Kiro experimental delegate（200）          | live page 有明确 Deprecation notice，称未来由官方 subagents 替代；异步独立 chat，session-scoped，may not survive restarts；无 agent 的 task 有 trust-all elevated permissions 警告。页面写明 `Page updated: August 4, 2026`。草案准确区分历史行为。                                            |

补充核对：为直接验证满额拒绝逻辑，另读取同 pinned Harness 的 `src/activation.ts`（HTTP 200），L28–37 的 `ActivationPool.reserve()` 在已满时同步抛 `ACTIVATION_LIMIT_REACHED`，不维护等待队列，release 为幂等 Set.delete。

## 获取与版本说明

初次批量抓取 GitHub raw 部分文件发生网络超时，经重试最终全部成功。没有将超时当作 404 或缺失引用。下载原文在 `/tmp/weave-ref-audit/`，Kiro HTML 旁另有去标签 `.txt`。Codex/Harness URL 保留固定 commit；Kiro 是随时间变化的 live docs，此核查仅证明 2026-11-23 实际读取内容及页内更新日期。
