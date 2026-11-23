# Weave 多 Agent 第一阶段实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the adopted design within the existing authorized workflow. Steps use checkboxes and require red/green evidence plus review. Existing continuous execution and PR integration authorization remains in effect.

**Goal:** 用户能让主 Agent 并行派发默认只读或显式 workspace 的一次性子任务，在 Studio 查看真实状态/审批/结果并明确停止。

**Architecture:** 父 Session 保存任务 authority/saga facts，child origin 强制 one-shot admission。Runtime task service复用Execution Service/AgentRunner；host-only `launchBoundTask` 在acceptance/install前原子绑定父Generation lease、工具authority和pinned Workspace。Server拥有Project folder revision与组合，Studio只读HTTP/SSE。

**Tech Stack:** TypeScript ESM strict、Zod、现有SQLite/内存Session/Project stores、Hono、React、Vitest；无新依赖。

**Spec:** `docs/superpowers/specs/2026-11-23-agent-tasks-design.md`；ADR 0011 与 foundation 先于实现同步。引用核查见 `docs/learning/2026-11-23-agent-tasks-references.md`。

## Global constraints

- web内容/发行完成后，从最新origin/main创建独立`feat/agent-tasks`，不复用已合并主题分支；一主题一PR。
- native one-shot child、depth=1、默认read-only与显式workspace均交付；无messages/fork/外部后端/DAG/worktree/merge/自动父Turn通知。
- 每root最多4个preparing/live/cancelling/blocked-owned任务，全进程最多16个child（不含root executions）；每parent Turn累计accepted最多16。
- prompt 1–16,384 UTF-8 bytes；title 1–120 codepoints/480 bytes；child最多50model steps，accepted起十分钟合作式deadline，包含materialization/queue/approval。
- host Provider只继承provider/model IDs、sampling/reasoningEffort/permission，useProviderDefaults:false；client/descriptor在child run start解析，Turn内固定。plugin clients仍属父Generation；不持久credentials/client。
- origin=`agent-task-once`的Session永久拒绝ordinary launch，无论preparing/running/terminal/reload/restart；唯一host-only exact launchBoundTask可接受原execution，普通HTTP/SDK无selector。
- task retained lease/authority不进JSON；model-list、instruction工具列表、post-llmRequestHook实际request和Pipeline execute强制同一exact subset。child排除四task tools，policy只能更严。
- workspace共享Project磁盘，pinned root+monotonic folderRevision防host切换/ABA，approval后execute再次校验；无OS隔离、强杀、不冲突或hard token/cost承诺。
- status/wait确实只观察，`readOnly:true`；spawn/cancel有资源/生命周期副作用，`readOnly:false`。全部模型工具经sharedPipeline。
- wait最多4目标，timeout0–60,000默认30,000；完整serialized JSON<=24,576 bytes，详细结果每项初始<=4,096 rawUTF8，按actualJSON缩减，默认Pipeline32,000。
- append-only、单Session原子；cross-log验证由reconciler完成，不假装事务。exact replay不重复接受，restart不重放副作用。父自然结束不取消child，显式Stop cascade。
- 锁顺序`Task admission -> Project authority -> Execution/Session gate`，无inverse await；不持锁跨model/tool/approval/wait/cleanup/Generation dispose。
- 每任务先写必要行为red tests、看到失败，再实现green。测试在unit的test/，不在src旁。commit/push只沿原用户明确授权workflow，草案checkpoint不是新授权。

## Files and interfaces map

以下是拟新增文件职责。实施前用`rg --files`核对当前名称，已有模块尽量只加必要ports/guards，不塞入HTTP或整个task系统。

- Protocol：`packages/protocol/src/agent-task.ts`（closed values/tool/public schemas），`src/index.ts`；`test/agent-task.test.ts`。
- Session：`packages/session/src/agent-task-events.ts`、`agent-task-projection.ts`，`events.ts/projection.ts/index.ts`；`test/agent-task.test.ts`。
- Runtime：`agent-task-types.ts`、`agent-task-service.ts`、`agent-task-materialize.ts`、`agent-task-reconcile.ts`、`agent-task-observe.ts`、`agent-task-result.ts`、`agent-task-tools.ts`、`agent-tool-authority.ts`；修改`agent-types/runner`、`tool-types/pipeline`、`agent-execution-types/service`、`approval-types/broker`；对应test/。
- plugin-host：`src/generation-runner.ts` + `test/generation-runner.test.ts`泛型retained lease与start-fencing；继续只依赖plugin。
- Plugin/builtins：必要host seam/core tool contribution与owner校验；SDK不给taskService、runner binding、opaque lease。现有kernel引用authority不得被plugin伪造。
- workspace：`src/{types,store,memory-store,sqlite-store}.ts`增加folderRevision与atomic increment/migration；unit tests；无内部依赖。
- Server：`agent-task-composition.ts`、`agent-task-api.ts`、`agent-task-view.ts`、`project-folder-authority.ts`；必要修改runtime/agent-kernel/main/server-shutdown/session-service/workspace-api/agent-execution-api；test/。
- Studio：`features/agent-tasks/{agent-task-types.ts,agent-task-api.ts,use-agent-tasks.ts,agent-task-panel.tsx,agent-task-card.tsx}`；App/panel/approval只组合状态与导航；test/。

核心新Runtime host port（不是HTTP/PluginSDK）遵守spec第5节：

```ts
interface BoundTaskExecutionPort {
  launchBoundTask(request: BoundTaskLaunch, authority: TaskLaunchAuthority,
    lease: TaskRunnerLease): Promise<AgentExecutionSnapshot>;
  cancelBoundTask(authority: TaskLaunchAuthority): Promise<AgentExecutionSnapshot | undefined>;
  whenSettled(authority: TaskLaunchAuthority): Promise<TaskExecutionCleanup>;
}
```

`BoundTaskLaunch`含固定sessionId/requestId、预分配execution/turn/userMessage IDs、继承public input；`TaskLaunchAuthority`绑定parentaccepted+childorigin+digest+IDs+root/tool tokens；`TaskRunnerLease`仅由parent running hostcontext取得。`TaskExecutionCleanup`严格采用spec第5节定义：acceptance none要求launchClosed/pendingLaunches0/exactAcceptanceAbsent；accepted要求exactidentity/terminalSequence/executionStatus/cleanupComplete与可选resultCandidate。create/attach materializer另行drain，不能由executioncleanup冒充。TaskReason封闭union使用spec第4节映射；Task1/3实现这些既定types，后续任务不得临时换签名。

## Task 1: 固定durable facts、结果语义与跨日志reconciler

**Files:** Protocol/Session新模块与index/events/projection；Runtime新reconcile/types；tests in protocol/session/runtime。

**Produces:** `TaskSettlement`（preparation/execution union）、`TaskReason`/`resultKind`、local task projection、`reconcileAgentTask(parentPrefix,childPrefix?)`与closed reconciliation outcomes。

- [x] 将主任务采用的spec/ADR/foundation写入主题分支，记录Codex初始spawn与V2冷恢复的准确区别；仅原workflow授权后做文档checkpoint。
- [x] 写red strictschema：参数不能有root/cwd/Project/generation/token；UTF8/surrogate/control/title/prompt/target/count/wait/cursor上限；settlement discriminant禁止preparation伪childterminal、execution缺水位；封闭TaskReason/status组合拒绝任意native/provider文本，latecancel不能改child既有终态。
- [x] 写red单日志projection：legacy、重复task/origin/IDs、accept/dispatched/cancel/settled顺序、exact replay/冲突、full/incremental一致。再写跨prefixreconciler测试，证明单Sessionappend不校验另一个日志。
- [x] 写red准备失败矩阵：accepted无child、created未attach、attached未launch、明确launch拒绝、cancel-before-child、cancel-before-launch、unknownacceptance。前六项允许无execution的preparationterminal；unknown只blocked，绝不fakeTurn。
- [x] 写red结果：正常纯文本final、空文本none、step-limit executioncompleted→taskfailed+agent-step-limit、tool-callassistant不能final、failure/cancel partial、restart partial；指针必须exactTurn+terminalprefix。
- [x] 运行下面命令确认red，再实现closedfacts/localprojection与Runtimereconciler。reason映射只能封闭安全码，不带native/provider message。

```bash
pnpm exec vitest run packages/protocol/test/agent-task.test.ts packages/session/test/agent-task.test.ts packages/runtime/test/agent-task-reconcile.test.ts --maxWorkers=2
pnpm --filter @weave/protocol --filter @weave/session --filter @weave/runtime typecheck
```

- [x] 同命令green；独立review事件ownership/无跨日志事务假设。checkpoint `feat: 增加子任务持久化与结果契约`。

## Task 2: 工具authority、实际模型request与可信approval归属

**Files:** Runtime authority/types/runner/pipeline/approval + tests；Server instructions/kernel所需port；Plugin seams仅必要类型。

**Consumes:** Task1 closedvalues。**Produces:** opaque exactrun `AgentToolAuthority`；authorityfilteredmodel/instruction view；postmiddlewarevalidator；trustedexecutionapprovalmetadata。

- [x] 写red：read-only名单无edit/write/shell/tasktools；workspace是父集合减tasktools；同名新definition不能替代；model伪造未授权call在Pipeline拒绝，未触execute。
- [x] 写真实llmRequestHook red：添加run_command/agent_spawn、同名替换parameters/description、重复name都在Provider调用前失败；仅删除/保持原schema可通过。断言最终tools与instructions均在同一capturedauthority内，request可进一步收窄，不以prehook列表通过为证据。
- [x] 写toolaround red：换token/session/turn/execution/call/name/signal/permission失败；sameidentity重试可修改允许args但不扩大authority。policy ask/deny继续有效，不能allow越权。
- [x] 实现hosttoken identity checks、Runner authority view、middleware最终next的basecontinuation中每次Provider实际调用前检查、Pipelineexecution独立check；不要靠Zod接受外部object就称opaque。
- [x] approval加入可信turn/execution，只让Runner/host端赋值；Servertaskattribution从exactorigin补，plugin summary/模型字段不能授权。
- [x] 跑authority、pipeline、permission、approval、llm-middleware、plugin-owner既有suites与typecheck/lint，测试red→green；reviewhook合同和allcallpaths。checkpoint `feat: 强制子任务工具与审批authority`。

## Task 3: Retained Generation与原子launchBoundTask/one-shot admission

**Files:** plugin-host generation-runner；Runtime execution-types/service；Server runtime/coordinator/composition；相关tests。

**Consumes:** Task1 origin/IDs与Task2 authority。**Produces:** genericretainedlease、host-onlyBoundTaskExecutionPort、post-gatecleanupnotification、ordinarychildlaunchguard。

- [x] 写red泛型lifetime：runningparent retain、normalreload后原代childstart、同Session排序、retainedcreating计数、double-release、iterator.return慢期间不dispose、不裸runner绕过。
- [x] 写完整撤销表red：normalreload、nonimmediatewithdrawal、immediate/forcedreload、managedownershiploss、shutdown；已running继续/abort语义按spec，未start/再次retain永久fence；父未cleanup不能再mint。
- [x] 写原子admission red：bindingreservation/acceptanceconfirmation/install/firstnext每个barrier并发reload，始终exactparentrunner；unknownappend零liveinstall/Provider调用，commit-then-throw确认后才可install；期间cancel/revoke后确认已commit也不得迟到pump；`launch -> bind`不允许；origin/digest/IDs不符0accept；重试不换lease、IDs或input。
- [x] 写ordinarylaunch red：originSession在preparing/running/terminal、reload/restart后，HTTP/hostordinarylaunch都拒绝新acceptance；内部exactlaunchreplay允许。queue/reorder不得形成第二childrun，legacyproductionstart同guard。
- [x] 实现`launchBoundTask`：同executiongate内exactlookup→验证hostorigin/authority/lease→预留固定binding→appendaccepted/claim→确认提交→install/pump。unknown不install/pump、binding保留到exactreconcile；确定无append才释放provisional。不把bindingselector放普通launchinput。
- [x] 实现`cancelBoundTask`在同gate永久关闭authority起动权并区分无accepted/unknown/queued/active/terminal；undefined只表示exact已证实不存在。`whenSettled`按spec的none/accepted判别且无outstandinglaunch、accepted须terminaldurable+pump/iteratorcleanup；executiongate外投递immutableoutcome。普通rootlaunch路径兼容。
- [x] Providerupdate/delete/readd red：pluginclient随父代；hostclient按childstart当前配置解析/不可用，sampling继承不重applydefaults，childTurn中更新不换client；无key进入facts。
- [x] 跑generation/execution/queue/managedauthority/provider suites、boundarylint/typecheck；独立资源review。checkpoint `feat: 原子绑定子任务执行与父代lease`。

## Task 4: Project folderRevision、pinned resolver与afterapproval fencing

**Files:** workspace types/store/memory/sqlite+migration tests；Server project-folder-authority/workspace-api/composition；Runtime authoritycheckport与filemutation/afterapprovalchecks；server/runtime tests。

**Consumes:** authoritytoken/launchport。**Produces:** monotonicfolderrevision、capturedrootbinding、taskpinnedWorkspaceResolver、shortProjectgate。

- [x] 写redstoremigration：旧folderRevision0、每成功set/clear/samepath+1、rename不增、atomictransaction、safeintegeroverflow拒绝；memory/sqlite一致。
- [x] 写redpinnedresolver：rootA capture后不能resolveB；无folder不突然获Workspace；rootincarnation变化拒绝；Projectrelation改变拒绝；工具summary和execute均检查。
- [x] pendingapproval barriers red：A→B、A→B→A、同路径set，approve后零新effect；write/undo mutationqueue最终effect前再次check。已有effect旧A可能完成的限制单独记录，不假装rollback。
- [x] 实现Projectauthorityservice：锁内fence旧token+cooperativeabort，transaction更新revision，锁外排cancelintent；失败不复活旧token。所有productionfolder入口走该service，普通store不成为绕过入口。
- [x] Pipeline在policy/summary前及approval后execute前checktaskroot；pinnedresolver只返capturepolicy，built-in最终mutation内recheck。Projectgate只检查/发permit，不跨toolI/O/approval；shell/MCP/plugin外部writer限制准确。
- [x] 锁重入red：Task→Project→Execution/Session唯一顺序，executionterminalhook不得回调taskgate；rootrename/folderupdate与spawn并发无死锁。slow/reentrantStore不持锁等tool。
- [x] 运行workspace/rootchange/approval/undo/filecontextregression与typecheck，reviewABA和hostboundary。checkpoint `feat: 固定子任务目录authority并校验审批后执行`。

## Task 5: Task准入、promptreceipt与exact materialization saga

**Files:** Runtime task-service/materialize/types/reconcile；Server task-composition/session-service exactcreate；tests。

**Consumes:** settledunion、lease/atomiclaunch、Projectbinding。**Produces:** idempotentspawnreceipt、materializerfence、capacityaccounting与preparationterminal。

- [x] red准入：samecall并发只一accepted/child/provider；samekeychangedargsconflict；invalidparent/call/depth/root0effects；root4/global16/perTurn16在create前拒绝。
- [x] 实现Taskgate中strictsnapshot/exactreplay→parent/root/call校验→capacity/lease reservation→预分配所有IDs→parentaccepted。appenduncertainexactread，unknown保守blocked。accepted前signal能阻止；之后不能继承pipeline临时signal。
- [x] accepted后马上返回preparingreceipt并释放gate；hostmaterializer异步exactcreateorigin、attach、`launchBoundTask`，确认后dispatched。receipt被around丢弃/timeout/HTTPdetach不撤销，status始终可发现。
- [x] 每个effect前hostfence/deadline/root/lease检查；preparationterminal前等待所有已发出effect并exact确认noexecution。latecreateresolve/latelaunch不能在已settled后start。
- [x] redcrash/commit-then-throw：parentappend、childbatchcreate、attach、launchaccept、dispatched、parentsettled；unknownread不生成新ID/bytes、不launch第二次；collision/origin/Project不匹配failclosed。
- [x] capacity与pluginresource分离：pumpcleanup+childterminal/noaccepted可releaselease；父settleduncertain保留capacity/evidence但不无故留pluginresource；unknownchildterminal先fence/drain，不重launch。doublecleanup安全。
- [x] realSQLite+ProjectStoreintegration green，独立review孤儿发现与sideeffectreplay。checkpoint `feat: 持久接纳并materialize子会话任务`。

## Task 6: Status/wait/cancel、exact JSON预算与resultKind

**Files:** Runtime observe/result/tools/service；coretoolcontribution；runtime/protocol tests。

**Consumes:** durabletaskprojection+Brokerlive+cleanupnotifications。**Produces:**四stricttools、24,576-byteenvelopes、cursor/actionablewait与monotoniccancel。

- [x] redsemanticmetadata：status/wait readonlytrue，调用不追加领取/launch/cancelfacts；spawn/cancel readonlyfalse；child全排除tasktools。defaultstatus分页16metadata，显式最多4distinctIDs、owner全数验证。
- [x] redsubscribe-before-snapshot：已有pendingapproval首wait立即回；已resolved不伪pending；新approval/terminalrace不丢；samecursorconsumedterminal不busyloop；mixedterminal+running等待后者；allterminalconsumed回allSettled无body；cursor换targets拒绝，省after可取得未观察sibling；0/default/max/epoch/reset/abort覆盖。
- [x] 实现epoch/rootrevision、terminalRevision/pendingapprovalchangeRevision；waitcursor绑定targetSetDigest，rootSSEcursor与之区分；currentafter抑已消费body，status/fullpointer随时可读；无dequeuefact。observer/waitabort只detach，不取消任务，不持任何gate等待。
- [x] redresultJSON：四任务×4096控制字符/quotes/backslashes/CJK/emoji；actualJSON exact边界；allIDs/status/resultKind/有界结构fullpointer保留，拒绝任意URL；requiredmetadata超限固定error；默认Pipelinetruncatedfalse、较低hostcap限制如实。
- [x] 实现每fieldcap→序列化实测→轮转缩最长displaypreview→必要时title；codepointsafe，每项previewTruncated与envelopetruncated；不截指针/不删taskidentity。step-limit/partial/none按Task1固定映射。
- [x] redcancelpreparing/queued/active/terminal/unknown：intent幂等、永久fence、锁外abort、exactcancelBoundTask不借用不兼容外部queuecancel；返回cancellingreceipt，cleanup后才settle/reclaim。
- [x] green tool/pipeline/agentloop/approval regressions；独立review结果可用性和lostwake。checkpoint `feat: 提供子任务观察等待取消与完整结果`。

## Task 7: Root生命周期、恢复与可重试可靠关闭

**Files:** task-recovery/service/main/server-shutdown/session-service；tests in runtime/server。

**Consumes:** exactsaga/one-shotorigin/cleanupoutsidegate。**Produces:** prelistenrecovery、Stopcascade、lifecycleadmission与incomplete-shutdownretry。

- [x] redrecover矩阵：accepted无child/createdunattached/unlaunched（有durablecancel则preparationcancelled、否则interrupted）、queued/claimed/running、childterminal未parentsettled、unknownappend、错backlink；首个stopcause不改、晚到cancel不重写终态，零自动provider/tool重试，旧Generation不复活。
- [x] 实现从rootProjectrefsaccepted按预分配childID发现，即使attach未完成；先taskorigin/admissionindex再executionrecover；preparationterminal无fakeTurn，executionterminal可补dispatched/parentsettled。
- [x] redStop/spawnrace：同taskgate冻结exactparentTurn、snapshotchildren，锁外cancelparent+tasks；naturalcompletion不cascade、新parentTurn可spawn。childStop/stopall范围明确。
- [x] 全停测试覆盖空批次、已有单任务停止意图和 append 确认丢失。Session 校验根批次事实，Runtime 在同一 Task gate 持久化原目标列表，冷恢复重用操作 ID 和原目标。
- [x] root/childarchive-delete在taskgate检查无live/preparing/blocked-owned，然后既有Sessionidle；race无TOCTOU，409有Stop入口；terminaltombstone不抹父指针。
- [x] redclose：同步关admission/fenceleases，锁外abort/drainmaterializations→executioncleanup/durableterminal→releaseactualleases→flushparentfacts→Generationdispose→stores。terminalcallback先离childgate再排父settlement，无taskdrain等Generationdispose环。
- [x] red失败重试：uncooperativecleanup/lateeffect时shutdownincomplete不closeStore；资源已清理但appenduncertain保留stores/evidence/capacity到exactreconcile，不挂住无用pluginlease；retry不重复dispose/launch/facts。禁止Promise.race抛弃writer。
- [x] deadline包括preparation+approval；resourcecleanup期间capacity不提前返；fullshutdown/queue/managedowneddrain回归green。独立锁/lifecyclereview。checkpoint `fix: 保证子任务停止恢复与关闭一致`。

## Task 8: 薄HTTP与可信task/approval视图

**Files:** Server task-api/view/composition/appguards/main/execution-api；API/integration tests。

- [x] redlocalguards/strictquerybodycursor/Sessionvisibility/rootmembership/foreign/deleted/safeerror；originSessionordinaryPOST在各phase/restart后拒绝，onlyhostexactreplay可行。
- [x] 实现list/detail/singletreeSSE/cancelone/stopall薄调用；无HTTPspawn、无外部runner/generationselector。Approval决策保持BrokerAPI，同一approvalId只补可信attribution。
- [x] SSEallowlist/preview/approvalIds/frame64+256KiB，slowobserver断开重连；sourceepoch/rootABA/staleGET不覆盖新SSE；detach不影响execution。
- [x] realstartServer+SQLite+deterministicprovider证明origin/lease/approvalreject0write、cancelcleanup、HTTPoneshotguard、restartinterrupted和providercalls不重复。
- [x] HTTP安全projection与boundaryreview，typecheck/lint/APItests green。checkpoint `feat: 暴露子任务树观察与控制接口`。

## Task 9: Studio完整任务流与workspace模式

**Files:** Studio featuremodules、App/panel/approval、mirrortransporttypes/tests。

- [x] mirrorclosedHTTPschema与redtransporttests先行；一个root树订阅独立于activeSessionqueue，epoch/ABA/draftownershipguards。
- [x] semanticlist/tree显示title/access/status/resultKind/reason/activity/elapsed/pendingapprovalcount、打开/Stop；原生轻量线无新依赖。父timeline只tasktoolcards摘要。
- [x] childdetail复用transcript与breadcrumb、readonlyComposer说明one-shot；手工HTTPguard同时有证据。final/partial/none与step-limit提示明确，截断指向全文。
- [x] read-only默认、workspace显式选项；显示共享文件夹并发写冲突限制。hostProvider“ID/sampling继承、连接配置以childstart为准”与pluginGeneration区别在说明中准确。
- [x] 父审批聚合可信origin，同approvalId定位childcall；reject只拒工具，Stop取消task。父Stop文案“本轮及派生任务”，保留单child/stopallchildren控制。
- [x] tests涵盖现有approval、waittimeout、逐个/全停、refresh、staleGET/SSE/rootABA、parentdraft、readonly/workspace、blocked/step-limit/partial、原queue/file-context/skills/slash/undo回归。
- [x] Studiofocusedtests/build与独立UI/approvalreview green。checkpoint `feat: 在Studio管理并行子任务及审批`。

## Task 10: 真实浏览器、完整验证与一个主题PR

- [x] builtStudio+startServer+SQLite+controllableProvider：父spawn两个独立children后继续，approval在父可见，wait/timeout不cancel，单停不影响另一个，workspaceapprovalreject零实际write。
- [x] 实际临时root验证默认read-only无法Pipelinewrite，显式workspace走approval/共享mutation；folderA-B-A+pendingapprove零错误root新effect；不拿fakeUI证明OS隔离。
- [x] 原代lease在reload保留，immediate/ownershiploss阻后续start；hostProviderupdate/delete/readd按选定合同；人工childPOST始终拒绝；Stopspawnrace、refresh/restart无重复provider/tool。
- [x] 保留fixtures/providerrequests/durableprefix/JSONbyte与cleanup证据；无productiondebugendpoint。完成review九项映射和锁/shutdownfailure回归，实际证据写foundation/ADR/learning/spec状态。
- [x] 跑`pnpm check`、`pnpm marketplace:check`、`git diff --check`；最后源码变更后再跑所需全链。独立Session/Runtime/Generation与Server/Studio/approval审查，解决所有P1/P2。
- [ ] 仅沿原用户明确授权PRworkflow做中文Conventionalcommit/push，单`feat: 支持独立子会话与并行任务`PR，attach，观察exactcommitCI，全绿后squash/删远程branch。按既有授权执行此步骤。

## Review coverage and readiness

| Review项 | 对应合同与任务 |
| --- | --- |
| child ordinarylaunch绕过 | spec5；Task3+8 one-shot持久origin/Runtimeguard/HTTP+restarttests |
| 无childterminal准备失败 | spec4/5/9；Task1+5+7 preparationdiscriminant/fence/reconcile |
| 非原子binding与撤销 | spec5/6；Task3 atomiclaunch+revocationtable |
| root/approval/ABA | spec7；Task4 monotonicrevision+pinnedresolver+afterapprovalchecks |
| hostProvider非generation冻结 | spec6；Task3明确IDs/sampling继承与start时client |
| llmRequestHook扩名单 | spec6；Task2实际request+instruction+Pipeline三处一致 |
| wait已有approval/consumedterminal | spec8；Task6consistentcursor/actionabletests |
| JSONescaping预算 | spec8；Task6actualJSONbytes完整envelope |
| step-limit/partial/none | spec4；Task1+6+9exactresultKind |
| 跨日志projection/锁/关闭 | spec4/7/9；Task1+3+5+7reconciler/outsidegatecleanup/retry |

实施保持read-only默认与workspace两种模式；所有新增保证以行为测试和实际验收为依据，尚未完成项保持未勾选。

## 并行实施与接口归属

Task 1 独占 protocol/session 事件、投影、index 与 Runtime agent-task-types/reconciler/index。Task 3a 可先独立完成 plugin-host generation-runner/index/tests，采用设计第 11 节的 `run(request, scope?)` 形式；Task 4a 可先独立完成 workspace store 的 folderRevision/migration/tests。后两者仅是基础子步骤，不能标记 Task 3/4 整体完成。

合流顺序为 Task 1 → Task 2 → Task 3b（bound launch、Coordinator 旧代 authority ledger、one-shot）→ Task 4b（Project authority、pinned resolver、after-approval）→ Task 5 → Task 6 → Task 7 → Task 8/9 → Task 10。每步均保留红绿验证与独立审查，review evidence 记录在本计划的 SDD ledger。
