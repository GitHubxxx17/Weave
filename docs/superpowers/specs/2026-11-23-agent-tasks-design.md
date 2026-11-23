# Weave 多 Agent 第一阶段设计

日期：2026-11-23。状态：沿既有连续实施授权采用，实施中。

本设计在联网插件内容与固定版本市场发行合并后，从最新 `origin/main` 的独立 `feat/agent-tasks` 分支实施。先记录跨包合同，再修改实现。已核对当前 Execution、Generation、Session、Provider、Workspace、Approval 与关闭代码；以下新增 API 是本主题的实施合同，未完成的行为不能作为现有保证。

一手参考及版本见 [引用核查](../../learning/2026-11-23-agent-tasks-references.md)。原研究审查发现已纳入正文，本主题继续保留完整 one-shot、retained Generation、权限收窄、目录版本、跨日志恢复和可靠关闭范围。

## 1. 要交付的有用能力

主 Agent 可以将独立任务交给最多四个后台子 Agent，继续自己的工作，通过 `agent_status` 或有界 `agent_wait` 收集结果，并明确 `agent_cancel`。每个被派发的任务拥有独立 Session、最多一个 durable execution 和一轮 Agent Turn；准备阶段失败可以没有 execution。Studio 在父会话显示任务树、状态、待处理审批、部分输出与结果入口。子会话可以打开查看，首版 Composer 只读；真正的一次性约束由 durable origin 和执行准入强制执行。

保留默认 `read-only` 与显式 `workspace` 两种 access。前者用于调查、独立审查和资料读取；后者允许主 Agent 将实现工作派发给子任务，但只能使用父本轮 authority 的子集，正常经过既有审批与 Workspace 规则。二者都共享同一 Project 文件夹，没有自动 worktree、磁盘或 OS 隔离；并发写入可能冲突，产品必须显示这一事实。

首版工具为 `agent_spawn`、`agent_status`、`agent_wait`、`agent_cancel`。不做消息/steer、驻留角色、自动上下文 fork/模型总结、定时 Crew、外部后端、任务 DAG、自动 Git 合并或自动父 Turn 通知。深度固定为 1，child 不获得任何 task tool。`update_plan` 仍是单 Turn 计划，任务树只显示真实被接受的工作。

采用原生 child Session，复用 AgentRunner、Execution Service、shared Tool Pipeline 与 Generation 生命周期。Runtime 的 task service 管准入、saga 和观察，不新增 Orbit 风格的 RunManager 或 Crew 执行器；未来 Crew 消费相同稳定合同。

## 2. 已核对的一手参考与选择

检查日期为 2026-11-23。固定源码引用采用仓库已记录的版本；另发现的最新提交不作为此草案的行为依据。

| 官方来源 | 本次实际读取的内容 | 采用原则与 Weave 取舍 |
| --- | --- | --- |
| Codex `a0995c2b2b68248960c69cb812b5f4898dac7e4c`：[spawn handler](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs)、[wait handler](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/core/src/tools/handlers/multi_agents/wait.rs)、[close handler](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/core/src/tools/handlers/multi_agents/close_agent.rs)、[control/spawn](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/core/src/agent/control/spawn.rs)、[shared budget controller](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/core/src/agent/control/budget.rs) | spawn 在创建前检查深度，通过 Agent control 创建有 parent/root Turn 信息的线程；wait 订阅状态、终态可立即返回、到期只报告 timed_out；close 与 wait 分开；control 在初始 spawn 前预留容量；V2 冷恢复校验父拥有关系、保留环境绑定，并在权限变动时取交集；budget 明确由共享控制器记账。 | 独立子会话、先准入后返回、有界等待、取消与观察分离、受共享容量治理。Weave 不复制其线程存储、sandbox 或 rollout 预算；首版不提供 full-history fork，也不宣称 token 费用硬上限。 |
| Harness `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`：[subagent README](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/subagent/subagent/README.zh.md)、[manager](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/subagent/subagent/src/manager.ts)、[child policy/composition](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/subagent/subagent/src/child-agent.ts)、[control validation](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/subagent/subagent/src/control.ts) | parent-owned catalog 与 child descriptor 分工；同树 ownership；深度与 activation 容量独立；容量先预留，清理后归还，满额拒绝而非等待；已发布 activation 生命周期与创建调用 signal 分离；shutdown drain 待创建和已运行子级。 | 采用父拥有关系、确切身份、有限控制面、保守恢复与清理所有权。Weave 首版只支持本机 one-shot 子会话，不引入其 backend/preset/continuation 体系，不借用其进程或 sandbox 保证。 |
| Kiro [custom-agent subagents](https://kiro.dev/docs/custom-agents/subagents/)（页面更新 2026-11-13） | CLI V3/IDE 对子工具使用 parent 与 child 两个政策的更严格结果；工具可见性与起动审批不同；独立 context。 | 采用权限只能收窄、起动不等于批准子工具。Weave 沿用 ask/trust/yolo 的现有定义，并不复制 Kiro permissions.yaml。 |
| Kiro [Crew subagents](https://kiro.dev/docs/crew/features/subagents/)（页面更新 2026-09-30） | 独立 session、Activity 状态/Stop、owner-scoped 控制、主会话继续工作；明确容量/超时/工具次数与 durable queue 的产品语义。 | 采用可见任务、显式停止和共享资源上限。Weave 首版不做自动重启排程、不承诺其 memory injection、3 小时/1000 tool calls 或自动注入结果。 |
| Kiro [experimental delegate](https://kiro.dev/docs/cli/experimental/delegate/)（页面更新 2026-08-04） | 明确弃用方向、异步任务和有限持久性。 | 仅作为历史产品边界，不能混称当前 subagents/Crew 行为；不采用任务可绕过配置而 trust-all 的路径。 |

可选方案比较：把 child 放入父 Session 会破坏当前单 Session 排序；外部进程后端能复用外部 Agent，但增加凭据、权限、协议和清理面；原生独立 child Session 是现有架构下最小、可验证的垂直切片。

## 3. 当前事实与新增边界

- Execution Service 已有 accepted/claimed/finished、每 Session 单 active、10/100 waiting、exact requestId replay、uncertain append reconciliation、detached SSE 与 restart interruption；`launch()` 返回前已经 install 并安排 pump。不能外部先 launch 再补 runner binding。
- Generation Runner 在 Session 队首选择当前代，active pin 延续至 iterator cleanup；没有父代 retained lease。新增 API 必须留在 plugin-host 泛型生命周期层，不导入 Runtime/HTTP。
- Tool Pipeline 是执行入口；临时调用 signal 在调用结束会 abort，不能成为 child 的 lifetime signal。permissionMode 是审批模式，不是工具 allowlist。LLM middleware 当前可改工具 schema，新增 authority 必须校验最后实际发给 Provider 的请求。
- Session append 只对单 Session 原子；Project/Session 无联合事务或全局 Session list。SessionService 当前随机 create/attach/补偿不适于 task exact replay。单日志 projection 不能替代跨 Session reconciliation。
- Provider view 的 plugin clients 属于 Generation，host clients 来自 live registry。Project folder 更新当前没有单独 monotonic revision，工具会动态 resolve Workspace；两者不能靠 generation number 假装冻结。
- Approval 是 Runtime transient Broker 状态；展示 task attribution 由 Server 从可信 origin/execution 补出。Studio 不能只靠 active Session 审批列表覆盖子任务。

本设计、ADR 0011 与 foundation 受影响合同先于实现落入主题分支。依赖方向保持 `protocol -> {llm,session} -> runtime -> plugin -> {plugin-builtins,plugin-host} -> server -> desktop`，workspace 仅被 Server 消费，Studio 只消费 HTTP/SSE。

## 4. 身份、durable facts、结果与跨日志校验

Runtime 预分配 `taskId/childSessionId/childExecutionId/childTurnId/childUserMessageId`（UUID），冻结在父 accepted 中，整个 saga 不重新生成。root/parent Session、parent execution/Turn/toolCall 取可信调用上下文；模型不能指定这些字段、Project、cwd、generation 或 token。depth=1，parentSessionId=rootSessionId，child 归父唯一 Project。

core facts 均 version:1，plugin writer 无权追加：

- 父 `agent.task.accepted`：lineage、上述预分配 IDs、固定 requestId=`agent-task:<taskId>`、canonical logical request digest、title/prompt/access、继承的 providerId/model/temperature/maxTokens/reasoningEffort/permissionMode（`useProviderDefaults:false`）、exact tool identity descriptor、Project/root provenance。只持久化公开配置与摘要，不写 client/credential/token。Store `occurredAt` 开始十分钟 deadline；deadline 包括 materialization、排队、模型和审批。
- child 的第一个原子 batch 为 `session.created + agent.task.origin`。origin 含 task/root/parent、parent accepted sequence/digest、预分配 execution IDs 和 `admissionClass:'agent-task-once'`。不是普通可续聊 Session。
- 父 `agent.task.dispatched`：child execution.accepted 的确切 sequence/digest；只在重读确认后追加。child 可先于 dispatched 结束，reconciler 仍按 accepted IDs 校验。
- 父 `agent.task.cancel-requested`：host operationId、目标 task 与安全 reason。是 durable intent，资源是否清理单独表示。
- 父 `agent.task.settled` 使用下列判别 union。每个 task 最多一个 terminal，重复 exact bytes 可重放；冲突不覆盖。

```ts
type TaskStopReason =
  | 'task-cancelled' | 'parent-stop' | 'task-deadline' | 'workspace-changed'
  | 'generation-revoked' | 'ownership-lost' | 'shutdown';
type TaskPreparationReason =
  | 'preparation-failed' | 'preparation-interrupted' | 'generation-unavailable'
  | TaskStopReason;
type TaskExecutionReason =
  | 'agent-step-limit' | 'child-failed' | 'child-interrupted'
  | 'generation-unavailable' | TaskStopReason;
type TaskReason = TaskPreparationReason | TaskExecutionReason;

type TaskSettlement =
  | { phase: 'preparation'; status: 'failed' | 'cancelled' | 'interrupted';
      reason: TaskPreparationReason;
      evidence: { stage: 'accepted' | 'child-created' | 'project-attached';
        parentAcceptedSequence: number; childOriginSequence?: number };
      resultKind: 'none' }
  | { phase: 'execution'; status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
      reason?: TaskExecutionReason;
      executionStatus: 'completed' | 'failed' | 'cancelled' | 'interrupted';
      childExecutionId: string; childTerminalSequence: number;
      resultKind: 'final-answer' | 'partial' | 'none'; messageId?: string;
      preview: string; previewTruncated: boolean };
```

上述 reason 是本期封闭词汇，schema 同时校验 status/reason 的合法组合：preparation-failed/generation-unavailable/child-failed/agent-step-limit 对应 failed；preparation-interrupted/child-interrupted 对应 interrupted；TaskStopReason 对应 cancelled；completed 无 reason。普通 child cancelled 无额外已知 cause 时映射 task-cancelled。host stop cause 只在 preparation fence 或 execution gate 确认选中了取消结果时使用；若 child 已 durable completed/failed/interrupted，晚到 cancel 不改写既有终态。重启无已知 host cause 时为 interrupted。未知 provider/native failure 或 interruption 分别映射 child-failed/child-interrupted；原始文本只留 child 日志，不能成为公开 task reason。preparation terminal 只在 materializer 已被永久 fencing、所有已发出 create/attach/launch Promise 已 settlement、exact read 确认 execution.accepted 不存在时追加；没有 child 时无 child 水位。未知 acceptance 是 blocked，不编造 Turn/terminal。execution terminal 需要 exact child finished durable 可读且 pump/iterator/tool cleanup 已结束；Generation disposal 不属于 task cleanup 前提。

Session 层只验证纯 JSON shape、本日志身份唯一性/状态顺序/terminal discriminant；Runtime `reconcileAgentTask(parentPrefix, childPrefix?)` 负责跨日志 exact origin/backlink/digest/Project relation/dispatched/terminal 水位。Server 注入 Project 校验 port。reconciler 不能从一个日志假设另一个 append 已原子提交。增量 projection 只缓存 bounded summary/指针，不复制 transcript；full/incremental 相同。旧无 task facts 日志行为不变，accepted prompt 不自动进入父模型历史。

结果只能来自 child Turn 对应 durable assistant message。`final-answer` 要求该消息处于确切 child Turn 区间、无 toolCalls、先于 terminal 水位，且 execution completed 无 `agent-step-limit`；纯 reasoning/空文本为 `none`。失败/取消/恢复保留的纯文本为 `partial`，绝不拿 tool-call assistant message 当答复。step limit 保留 `executionStatus:'completed'`，task 映射 `status:'failed',reason:'agent-step-limit'`，有合法部分纯文本则 partial，否则 none。成功但空文本为 completed + none，并明确“没有最终正文”。部分输出可查看，不伪称成功交付。

## 5. Spawn、one-shot admission 与跨 Session saga

模型参数 strict `{title,prompt,access?:'read-only'|'workspace'}`；title 1–120 codepoints/480 UTF-8 bytes，prompt 1–16,384 UTF-8 bytes，拒绝 unpaired surrogate 与不支持的 controls。access 默认 read-only。四个 tool 的语义 metadata：status/wait `readOnly:true`，只观察/临时订阅，不落领取事实、不起停 child；spawn/cancel `readOnly:false`（或省略 false）。spawn 不新增普通确认弹窗，既有 policy 仍可 ask/deny；其许可不批准 child 的写入/shell/network。

idempotency key 为 parent Session/Turn/toolCall 三元组；digest 是 canonical 参数。先做 exact replay，再 runnable/capacity；同 key 改参数 conflict。host 检查确切 running parent execution/Turn 和名为 `agent_spawn` 的 `tool-call.created`。调用上下文使用 opaque host token，不接受普通 JSON 的 parent IDs。若未来 SDK 发起任务，只能通过另一个 typed host-authority port，首版不公开给用户插件。

one-shot admission 强制约束：含 `agent.task.origin` 的 Session 在 preparing/running/terminal/归档/重启后均拒绝 ordinary `launch`、HTTP POST execution 与生产 legacy/direct start；拒绝发生在 acceptance 前。唯一许可是下面 host port 的原 bytes exact launch/replay，不提供子 Session 的第二次执行、queue、权限升级或当前代 fallback。GET/detail/观察可用；cancel 控制 exact task execution。HTTP 也返回稳定 `execution-task-session-read-only`，但 Runtime port 是真正 enforcement；不能仅禁用 Composer。

新增 host-only port，和外部 `AgentExecutionService.launch` 分离、不加入 SDK：

```ts
interface BoundTaskLaunch {
  readonly sessionId: string;
  readonly requestId: string; // agent-task:<taskId>
  readonly identity: { readonly executionId: string; readonly turnId: string;
    readonly userMessageId: string };
  readonly input: AgentExecutionInput; // inherited public snapshot, explicit new prompt
}
interface BoundTaskExecutionPort {
  launchBoundTask(request: BoundTaskLaunch, authority: TaskLaunchAuthority,
    lease: TaskRunnerLease): Promise<AgentExecutionSnapshot>;
  cancelBoundTask(authority: TaskLaunchAuthority): Promise<AgentExecutionSnapshot | undefined>;
  whenSettled(authority: TaskLaunchAuthority): Promise<TaskExecutionCleanup>;
}
interface BoundTaskIdentity {
  readonly sessionId: string;
  readonly requestId: string;
  readonly executionId: string;
  readonly turnId: string;
  readonly userMessageId: string;
}
type TaskExecutionCleanup =
  | { readonly acceptance: 'none'; readonly identity: BoundTaskIdentity;
      readonly launchClosed: true; readonly pendingLaunches: 0;
      readonly exactAcceptanceAbsent: true; readonly cleanupComplete: true }
  | { readonly acceptance: 'accepted'; readonly identity: BoundTaskIdentity;
      readonly launchClosed: true; readonly pendingLaunches: 0;
      readonly executionStatus: 'completed' | 'failed' | 'cancelled' | 'interrupted';
      readonly terminalSequence: number; readonly reason?: TaskExecutionReason;
      readonly cleanupComplete: true;
      readonly resultCandidate?: { readonly messageId: string;
        readonly messageSequence: number } };
```

`TaskLaunchAuthority/TaskRunnerLease` 是非 JSON opaque host objects，身份存 WeakMap/内部 sealed map，不靠可伪造的 numeric ID。authority 精确绑定 accepted/origin/预分配 IDs/request digest/工具/root binding。`launchBoundTask` 在与普通 launch 相同的 execution Session gate 内，先 exact replay/reconcile，再校验 origin/authority/lease、分配的 IDs 与输入原 bytes；在 append 前预留唯一 runner binding，**只有 acceptance/claim append 已确认提交后** 才 install live execution 并安排 pump。unknown append 不 install、不 pump，binding reservation 保留并只由同 authority reconcile；不能用另一个 lease 覆盖。若确定无 append，释放 provisional binding；确定已 acceptance 复用原 binding。重启不恢复内存 lease，只 recover interruption。该原子 port 从未返回一个可被 current runner 抢跑的未绑定 acceptance，禁止 `launch -> bind`。

`cancelBoundTask` 同一 gate 内永久关闭该 authority 的起动权，覆盖尚未 launch、unknown append、queued/active 与 terminal；返回 undefined 只表示 exact 确认无 acceptance，unknown 必须保留 pending/明确 retryable 诊断，不以未查到冒充不存在。`whenSettled` 只产生上述两种可信 cleanup outcome；无 acceptance 变体要求起动已关闭、已发出 launch 已结束并 exact 确认未接受，accepted 变体要求 child terminal durable 与真实 pump/iterator/tool cleanup 完成。resultCandidate 仅是待核对指针，Runtime reconciler 重读 exact child prefix 后决定 resultKind。task service 还须单独 drain create/attach 等 materializer effects，不能仅凭 execution port 的 cleanup 就宣称整个 saga 无 late effect。重启从 durable prefixes 重建 settlement evidence，不反序列化旧 token/cleanup object。

append uncertainty 被确认已提交后，reconcile 在安排任何 first next 前重新检查永久 fence/lease start permission；若已取消或撤销，只将原 exact execution 收敛为取消/中断，不允许迟到 pump。exact replay 本身可在终态或已失去起动权后返回原记录，但不会重新取得起动权。终态 child 的 cancel 返回原状态，不追加互相冲突的 terminal。

task admission 顺序：

1. strict snapshot、exact replay → task admission gate 重查。
2. 校验 parent/root/call/depth/Project folder authority/Generation，预留容量与 retained lease，预分配全部 IDs。
3. append 父 accepted；uncertain 用 exact reconciliation，unknown 保守 reservation。durable accepted 是 ownership commit point。
4. 释放 admission gate，立即返回 `{taskId,childSessionId,status:'preparing',cursor}` receipt；由 host materializer 继续 exact-create/attach/launchBoundTask。任务不以 receipt 是否到模型为生存条件。
5. materializer 每次 effect 前检查 host fence/cancel/deadline/Generation/root binding，用已保存 IDs exact-create child+origin、幂等 attach 同 Project，在 host admission scopes 内 launchBoundTask。确认 child acceptance 后写 dispatched，再异步观察 cleanup/settlement。

父 accepted 前调用 signal 可阻止创建；之后独立 controller 接管，不继承 pipeline 临时 signal。HTTP/观察断开、工具 timeout、around 丢弃 receipt 都不撤销 accepted task；status/Studio 从 durable 索引发现它。原 tool call retry 返回同 task，不等 materialization，不重新执行。materialization failure 由 task 状态报告，而非丢失的 spawn 响应。只有确定无 execution acceptance 且无 late materializer 的任务可 preparation-settle；不确定保持 blocked。Exact create child collision/origin/Project 不匹配 fail closed，不覆盖日志。

## 6. 父 Generation、Provider 与工具/审批 authority

child 使用父实际运行 Generation 的 retained lease，registry/hooks/plugin clients/插件 prompt sections 属于该代。plugin-host 增泛型 retained lease，从真实 running host context 获取；不能按 HTTP/model generationId 查找。lease 的 child run 仍进入同一个 GenerationController Session 排序，active/retained 计数直到实际 iterator cleanup；不裸调用 generation.runner。Server 将泛型 lease 适配 Runtime port，Runtime 不依赖 plugin-host。

lease 状态至少 `open -> start-closed -> aborted/released`，start-closed 不再恢复。同步 retain/start 检查 controller 关闭、generation authority 状态和 managed ownership guard；创建中 lease 也占 retirement pin。语义表：

| 事件 | 已 running child | 已 accepted 未 start child | 父再次 retain/start |
| --- | --- | --- | --- |
| 普通 reload（无 authority withdrawal） | 原代继续 | 原 lease 可在原代 start | 仍 running 的父可取原代 lease；不落新代 |
| 非 immediate disable/revoke/authority withdrawal | 现有 run 沿现有非 immediate 语义完成 | 受影响旧代 lease 永久 start-closed，任务安全取消/失败 | 拒绝；重新启用须新代新任务 |
| immediate disable/revoke/forced reload | 合作式 abort，清理后释放 | 永久 fencing + abort，不再 start | 拒绝，即使父尚未 cleanup |
| managed ownership loss / host admission failure | child abort、禁止新工具准入 | fencing + abort | 拒绝，不能 lease 绕过 guard |
| shutdown/dispose | abort 并等待实际 cleanup | fencing + abort | 同步拒绝 |

不能把 ordinary parent abort 自动当作子 lifetime signal：父自然结束/失败 children 继续；显式 Stop cascade 走第 8 节。retained lease 不使撤销重新获得执行权。若 old generation 的 authority 是否受影响无法确认，start fail closed，不按名称选新代。

Provider 明确选择：继承父本轮解析后的 **provider ID、model ID、sampling、reasoningEffort 和 permissionMode**，并设置 useProviderDefaults:false；不继承 host client/endpoint/key 的快照。host Provider client/descriptor 在 child 实际 run start 从 live host registry 解析，再由 Runner 在 child Turn 内固定。起动前更新 host endpoint/key 会影响 child，删除导致安全 unavailable，删除重建按当前配置解析；UI/说明不得称“沿用父凭据/连接”。plugin Provider client 仍由父 Generation 固定。任何 credentials/client handle 均不持久化。context descriptor 在 child start 解析，不能冒称与父完全同 context budget。

工具 authority 捕获父本轮允许的 exact owner/name/definition identity。read-only 仅允许 `readOnly===true`，workspace 允许父本轮集合，二者均排除四个 task tools。opaque authority 绑定 execution/run/token 并在 tool around 的 next invariants 中强制相同；同名新定义不可替代。Pipeline lookup/execution 独立拒绝越权，policy 只能更严。

模型名单、base instruction 工具说明使用同一 authority view。**每次实际 Provider request 在 middleware 最终 next 委派的 base continuation 中、真正调用 Provider 之前** 验证工具集合：middleware 可删除条目；不可新增 name、重复 name、替换同名 description/parameters 或越过 definition identity 的原始 public schema snapshot。不能等 Provider 返回后才检查。instructions 与最终 request 均受同一 captured authority 约束，request 允许进一步收窄。该校验和原 provider/model/signal/context-budget 校验都保留。middleware 合成的未授权 tool call 仍由 Pipeline 拒绝。可信进程内插件可执行任意本机代码的既有信任事实不变，这不是 OS sandbox。

child 工具写 child Turn facts、经过父代 shared pipeline、skills audit/hooks 与 pinned Workspace resolver。Approval 增可信 turnId/executionId；Server 从 exact origin/execution 补 task/root/title，不信 plugin summary 或模型字段。parent/child 显示相同 approvalId，Broker 独占决定；reject 只拒绝工具，Stop 才取消 task；审批等待计入 deadline。重启不复活旧审批。

## 7. Workspace folder revision、pinned resolver 与锁顺序

ProjectStore 新增 durable safe-integer `folderRevision`：旧数据迁移为 0；每次成功 `updateProjectFolder`（即使同路径重设）在同一 Store transaction 原子 +1，rename 不增加。不能用 updatedAt 代替；A -> B -> A 有两个新 revision，溢出 fail closed。workspace 单元仍无内部依赖。Server 的 Project-folder authority service 是生产修改入口，任何 HTTP/host folder mutation 都经过它；不用普通 ProjectStore 调用绕开 task fencing。

task capture `ProjectId + folderRevision + folderPath? + real canonical root/incarnation digest?`，无 folder 时绑定“无 Workspace”。materialization/start/每工具准入验证同 Project relation 与此 binding；任务不能转移 Project。task 专用 Workspace resolver 永远返回 capture 的 policy/root，绝不动态切换到新 folder。它在 summary 与 execute-after-approval 两次检查 revision、task signal/fence 与真实 root 身份；built-in 写/undo 的 mutation queue 内最终 effect 前再检查。Pipeline 对所有 task tool calls 在 policy/summary 前和 approval 后、execute 前检查 root/task authority；task-scoped resolver 也检查，不能只依赖一次外层校验。

folder change 在 Project gate 内先永久 fence 旧 revision 的 task tokens、发出 cooperative abort，再原子保存新 revision；失败也不复活旧 token（可用新任务），锁释放后排 durable cancel intent/settlement。对 pending approval 的 change -> approve 测试必须零新文件操作。已经进入实际 effect 的旧 root A 操作可能完成，无法回滚；它仍不能改到 B。shell/MCP/可信 plugin/外部进程不是该 file mutation queue 管理的写者，abort 是合作式，不能声称强杀或全磁盘隔离。外部文件系统替换仍有现有 residual TOCTOU；root incarnation 检查提高一致性而非 OS 保证。

锁顺序固定：`Task admission gate (可选) -> Project folder-authority gate -> Execution/Session admission gate`。同层多 Session 按 ID 排序；优先分成无嵌套短操作。gate 只含查验/reservation/有界 durable store 操作；不包模型、tool.execute、approval、wait、runner cleanup 或 Generation dispose。最终 effect permit 校验可以短暂取 Project gate，但不在锁内执行工具 I/O。atomic launchBoundTask 由上述 host scopes 调用，不从 execution gate 回调 task admission。

Execution pump 在其 gate **释放后** 通知不可变 cleanup outcome；terminal listener 入 task settlement queue，再写父日志，不在 child gate 内 await parent task gate。Project mutation 同步 fence 后也在锁外排取消。shutdown 在锁外 await materializer/pump，禁止 task drain 等 Generation dispose、同时 dispose 又等 task lease 的环。确定的 serialization/fence 保证仅针对本进程合作入口。

## 8. 容量、观察、取消与父生命周期

固定：每 root 最多 4 个 preparing/live/cancelling/blocked-owned task，全进程最多 16 child（不含普通 root executions）；每 parent Turn 累计 accepted 最多 16，depth=1；每 child 最多 50 model steps，accepted 起十分钟 wall deadline；wait 最多4目标，timeout 0–60,000ms 默认30,000；status 默认分页最多16条，显式 status/wait/cancel 最多4目标，IDs 去重、全数 owner 校验后才变更。容量满立即拒绝，不等槽；取消中仍占容量。没有 hard token/cost guarantee。

资源与 bookkeeping 分开：Generation lease 在 materializer 不可能 late-start、execution pump/iterator/tool cleanup 结束且 child finished 已 durable（或已确认无 execution acceptance）后释放，不等待 parent settled append 或整个 Generation dispose。task capacity 直到 parent settled durable 才归还；parent append uncertain 保守 blocked/保留容量，但不无限保留已无执行的 plugin 资源。child terminal persistence uncertain 时先 fence/drain live资源，再保留 evidence/reservation 到 reconcile，不用旧 lease 重新 launch。所有 release 幂等。

status/wait 不改变事实或领取结果。tree observer 有 transient process `epoch` 与 root `revision`（safe integer）；每任务记录 terminalRevision 和当前 pendingApprovalIds/changeRevision。root SSE cursor 是 strict `{epoch,rootSessionId,revision}` 的 opaque 编码，与 durable sequence 分开、不可跨 root。wait cursor 另外绑定去重排序后目标 ID 集合的 `targetSetDigest`，不能用于不同集合；变更 targets 要省略 after 或获得新 snapshot，避免未观察的 sibling terminal 被一个全 root revision 隐藏。spawn receipt 的观察 cursor 仅覆盖该新 task。subscribe-before-snapshot 取一致 view：

- 无 after 或旧 epoch：返回当前已 terminal/已有 pending approval 的 actionable snapshot（reason 为 terminal/approval）；若均无则等待。epoch reset 不 suppress body。
- 同 epoch：只在目标有 revision > after 的 terminal 或当前 pending approval 时立即返回；已消耗 terminal 不反复唤醒，也不重复大正文。一个 consumed terminal + 一个 running 可以等待后者。只消费观察窗口，不是 dequeue；status/full pointer 随时可读。
- pending approval 在 subscribe 前创建也能从 snapshot 唤醒；已解决且当前无 pending 不伪造待批，若无 terminal 则继续等；新 pending/terminal race 不丢。所有目标均 terminal 且已消费时立即返回 `allSettled:true,changed:false` 无正文，模型说明不得再等待此组。
- timeout 返回当前 snapshot、cursor、`timedOut:true`，0 是 snapshot；wait abort 只撤订阅，不 cancel task。不持任何 admission/root/Session mutex。observer 数量/frame/byte 有界，慢 consumer 断开重连。

所有四个工具输出完整 JSON <=24,576 UTF-8 bytes（默认 Pipeline 32,000 下有效），最多4个 detailed task results，每个初始纯文本 preview <=4,096 UTF-8 bytes、title<=480 bytes、固定 IDs<=240 ASCII chars、安全 reason<=80 ASCII chars。status 列表最多16条只含<=256-byte preview；page cursor<=600 ASCII chars，approvalId最多4条/task，更多用 count + child link。full-result pointer 是有界 sessionId/executionId/turnId/messageId 与 safe-integer watermark 的结构，不由模型提供任意 URL；UI 根据这些 ID 构造入口。

先生成全部 required metadata，再对 text/preview codepoint-safe 限长；每次以 `Buffer.byteLength(JSON.stringify(envelope),'utf8')` 实测。若超限，按返回顺序轮转缩减最长 display preview，保留每个 taskId/status/resultKind/full pointer；耗尽 preview 后可缩 title，不删任务身份，不截 URL/指针。每条 `previewTruncated` 和 envelope `truncated` 明确；metadata 自身超限抛固定 `agent-task-result-too-large`。quotes/backslashes/controls 都计 escaping；不能只加4×4KiB。若 host 自配 Pipeline cap 更小，仍可能由 Pipeline 截断，文档明确默认 cap 保证，不提高全局限制。

cancel 在 task gate 内追加幂等 intent并永久 fence（无论 preparing/accepted/running）；首个已接受的 host stop cause 固定，重复/后续 stop 不改写原因。然后锁外 abort materializer/task controller。preparing 等 outstanding effects settle/read 后走 preparation terminal；已 execution accepted 使用 `cancelBoundTask` 在 execution gate 内区分 queued/claimed/running，queued 原子 finished-cancelled，active abort，terminal exact replay，不借用普通 cancelQueued 的外部 revision 请求。ambiguous acceptance 只 reconcile，不盲目重发 launch。terminal task 返回原状态，不删除 Session。cancel API 返回 cancelling receipt，不持调用直到不合作工具完成。

父自然完成/失败，children 可继续；不自动建父 Turn。根 Studio Stop 明确为“停止本轮及其派生子任务”：在 task gate 永久冻结 exact parent Turn 的 spawn，快照已 accepted/preparing 子任务，再锁外取消 exact parent execution/children；新父 Turn 可正常开始。还有“停止全部子任务”只影响该 root 当前 live tasks，显式批量 operation 最多4条。子页 Stop 只停该 task。archive/delete root/child 在 task gate 检查 no live/preparing/blocked-owned task，再用既有 withSessionIdle，避免 TOCTOU；否则409。终态 child 可归档/tombstone，父历史指针仍存在；rename不变。

## 9. 恢复与关闭

listen 前从 Project refs 的 root Sessions 扫父 accepted，按预分配 child ID 读取（即使 attach 未完成），建立 task authority/admission index，再执行 task-aware execution recover。origin class 永久生效；普通 child POST在重启后仍拒绝。cross-log reconciler 验证所有双向 IDs/digests/watermarks，未知/冲突 blocked，不覆盖。

- 已 child finished durable：验证 terminal + resultKind/指针，补缺 dispatched/父 execution settlement，不调用模型。
- accepted 后 child缺失/未 execution accepted：永久 fence materialization、确认无 acceptance；已有 durable host stop intent 时写 preparation cancelled 并保留首个 reason，否则 preparation interrupted（没有伪 Turn）。attach未完成可保留审计但不再发起工作。
- execution accepted/claimed/queued/running 无终态：既有 recover 记 interrupted；保留 partial text，补父 execution settlement。旧 Generation/token/client/审批不恢复。
- append或read uncertain：保守 blocked，不归还不明容量、不重新 launch；retry recovery只读/补确定事实，不执行模型工具。

新“重试”必须新 toolCall/task/child Session，使用用户明确重新发起的 prompt与当时设置；不 resume 原有副作用。浏览器重连只观察。十分钟 deadline 不跨重启重新计时以恢复执行。

关闭协议：同步关 task admission/fence所有未 start leases；close execution admission；锁外 abort materializers与child controllers。drain已发出 saga effects到不可能 late launch，再 drain execution pumps/iterator/tool cleanup；写可确认 child terminal并按上节释放实际 lease。execution cleanup callback锁外进入 settlement queue，flush dispatched/cancel/parent settled。此后才 Generation dispose/插件准备资源、Runtime/Session/Project stores关闭。

失败分类：未结束的工具/iterator/materializer表示资源仍可能写 Store，shutdown保持可重试 incomplete，不关闭其 stores、不用Promise.race抛弃工作。资源已清理但 durable append失败时 fence所有task/不释放其capacity，返回明确诊断；同一shutdown attempt保留stores执行exact reconciliation/重试，未确认前不报告成功或关闭stores。已确认无latewriter的Generation可以先完成dispose，与durable retry解耦；task settlement不得等待dispose。disposal失败按既有aggregate诊断，不伪称成功；禁止互相await同一gate或强行关闭仍有writer的Store。

## 10. HTTP、Studio 与验收

薄路由：GET `/sessions/:rootId/agent-tasks` 分页 summary、`.../events` 单树bounded SSE、`.../:taskId` metadata/child/result pointers，POST `.../:taskId/cancel`、`.../cancel` stop-all。spawn首版只有模型 shared Pipeline，无HTTPspawn；所有现有 execution launch入口额外强制one-shot origin。沿用loopback Host/Origin/Sec-Fetch/JSON guards，Session可见性、exact Project/root membership、strict ID/query/cursor/body。Approval仍走原Broker API，无task approve新权限。

SSE只发allowlist metadata、有限preview/pending IDs，不传播prompt/authority descriptor或全部child tokens；最多64帧/256KiB订阅队列与snapshot cap，满则关闭观察并重连。epoch/cursor防stale GET覆盖新SSE及root切换ABA；断连不拥有执行。

Studio用语义列表/轻量SVG线展示四个子节点，无依赖。显示title/access/status/resultKind/reason/activity/elapsed/approvalCount、打开/停止、parent breadcrumb与只读子Composer。父审批聚合可信后代的同一个approvalId；打开child定位call。终态显示final/partial/none，截断有全文入口，step-limit明确“未完成答复”。workspace显示共享文件夹/并发写冲突说明；Provider说明继承IDs/sampling，host连接配置以child start为准。父草稿不因进入child丢失；parent toolbar完成/失败/审批badge更新但不自动发消息。

实现验收覆盖九项review逐项回归、legacy日志、full/incremental、所有saga crash/commit-then-throw、one-shot HTTP/restart、capacity/latecleanup、retained lease撤销矩阵、post-LLM-middleware名单、Provider update/delete/readd、folderRevision A-B-A和approval后检查、wait已有approval/consumed terminal、exact JSON escaping、step-limit/partial、锁重入/shutdown retry。真实startServer+SQLite+builtStudio+可控慢Provider完成父spawn2children继续工作、workspace审批拒绝零write、逐个/全树Stop、refresh/reload/restart无重复副作用；临时目录做实际文件验证，确定性fixture不证明OS隔离。

最终`pnpm check`、`pnpm marketplace:check`、`git diff --check`。独立Session/Runtime/Generation与Server/Studio/approval审查，P1/P2解决。一个主题一个PR，CI通过后按已有授权workflow处理。本设计沿原用户授权实施；每个主题独立 PR，通过 CI 和审查后 squash 合并。复核重点是atomic host port、one-shot persistence、root revision/后approval fencing和shutdown失败路径，不能用省掉这些边界换取workspace功能。

## 11. 实施接口与分工补充

先并行完成 protocol/session/纯 reconciler、plugin-host 泛型 retained 生命周期，以及 workspace store 的 folderRevision；这些仍在同一多 Agent 主题分支集成。Execution、Runner、Pipeline 和 Server 组合按计划顺序衔接，避免并行修改同一核心文件。

GenerationRunner 采用兼容的 `run(request, scope?)` 第二参数形式：仅在实际 Session 队首、guard 成功且 running pin 已建立后，由 controller mint 私有 running scope。scope 的 retain 产生一次 child run 的 lease；lease 的 run 仍经过原 Session queue。retain 立即持准备 pin，release 幂等且不等待 Generation dispose，真实 iterator cleanup 前不释放 pin。scope 在父完成后不能再次 retain；已接纳的 lease 独立存活。controller 用原 Generation 对象身份关闭后续 retained starts，禁止模型数字 ID 选择。普通 reload 不关闭原代 start；受影响的 authority withdrawal 单调关闭旧代，重新 publish 不重开旧 lease。

Server 根据已有 activeByGeneration 的确切来源与完整成员身份，对所有未清理 Generation 维护永久 start fence，不能只检查 current。真实 running scope 适配为 Runtime 私有 WeakMap 识别的非 JSON run token，贯穿 instructions、最终模型请求与 Tool Pipeline；外部 executionIdentity 结构值不赋予 authority。around 委派保持相同 token 引用。工具允许集同时捕获 owner、exact definition 引用与独立深度 public schema snapshot，防止同名替换及嵌套 schema 变更。

Project folder fence 在唯一 Server 修改入口内、写事务前同步生效；最终文件 mutation queue 内采用同步 fence/permit 检查，避免持 root mutation queue 后反向等待 Project gate。folderRevision 与 pinned real root 的检查仍覆盖 summary、审批后 execute 和最终写入准入。

Bound launch 与 unresolved acceptance 的 replay 分支共用原 execution gate，并在 install/first next 前重核原 authority 的永久 fence；没有 acceptance 后外部再绑定 runner 的窗口。cleanup 通知在 gate 外发布，不等待父日志或 Generation dispose。Server shutdown 遇到未结束 writer/materializer 或不确定 durable append 时返回可重试 incomplete，停止关闭相关 Store；不能以 record-and-continue 抛弃仍可能写入的资源。
