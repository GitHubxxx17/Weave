# Studio 大规模渲染 Implementation Plan（只读研究稿）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以真实对照实现5,000条Agent会话的动态消息窗口、流式更新隔离，以及50,000文件的固定行窗口，完整保留执行/审批/来源/输入归属语义。

**Architecture:** Studio browser-only投影和按session订阅的immutable store，逐event有序归约、每frame发布；headless virtualizer只控制挂载与测量，执行状态仍由现有HTTP/SSE与durable history确认。消息与文件树分两个独立分支/PR，benchmark使用现有隔离生产构建fixture。

**Tech Stack:** TypeScript strict/ESM、React19.3.1、现有Zod/Vitest/Testing Library/Vite/Playwright CLI。推荐新增exact版本 `@tanstack/react-virtual`，只有正式设计批准和依赖理由入文档后安装；研究时registry候选3.14.28/MIT，实施时复核。

**Spec:** `/tmp/weave-rendering-design-final.md`。root审阅后正式文件建议名为 `docs/superpowers/specs/2026-11-23-studio-rendering-design.md`（实际顺序启动若跨日则统一更新日期）；此稿不属于当前web/release实现。

## Global Constraints

- 当前任务仅写/tmp，执行本计划发生在用户路线的多Agent/记忆/检索之后；从最新origin/main创建新独立分支。绝不在web/release分支实施。
- Studio不import任何 `@weave/*`、Node或Electron模块；不修改Runtime、Session事实、协议、服务端分页或模型上下文。
- 外部HTTP/SSE输入继续Zod验证。渲染丢帧可以合并显示，事件不能丢失、乱序、跨execution或覆盖已确认terminal history。
- exact draft owner/epoch、请求捕获、文件附件、plugin insertion、producer detach/cancel区别、watermark、精确重试、审批与文件撤销请求身份必须保留。
- 不静默截断正文、工具结果或引用。全文查找/复制与辅助技术退路在虚拟化PR内交付。
- 所有测试位于apps/*/test；source性能仪器不获得执行权。普通pnpm check只跑确定性测试，不跑机器相关计时门槛。
- 保留旧100/1000/5000消息、markdown/tools、100×20ms stream、production/fresh browser/no-store/1440×1000。旧数据不能用来计算尚未运行的新结果。
- 不自动全局安装工具/下载浏览器、不读取真实项目/用户数据库、不调用provider；无提交/推送除非root执行已授权工作流。

---

## PR 1：长会话与工具流渲染

### Task 1: 固定新基线、设计与可比较测量契约

**Files:**

- Modify at sequential start: `docs/architecture/foundation.md`，正式rendering spec和plan，`docs/learning/2026-11-23-studio-performance-baseline.md`只补充新报告链接，不覆盖历史观察。
- Modify: `apps/server/test/performance/scenario.mjs`, `fixture.mjs`, `browser-probe.mjs`, `run.mjs`。
- Modify/Test: `apps/server/test/studio-performance-fixture.test.ts`。
- Create results after running: `docs/learning/2026-11-23-studio-rendering-results.md` 与其raw artifacts；若实际执行跨日，root统一更新文件名日期。

**Interfaces:**

- 保留 `createScenario(count,variant)` 与 `startPerformanceFixture({count,variant,...})` 现有调用，新增可选 `streamVariant:'text'|'tools'`，旧默认text不变。
- report `schemaVersion:2`；sample保留coldReadyMs/warmSwitchMs/inputFillToPaintMs/frameGapsMs/longTasks，新增logicalMessageCount、mountedMessageCount（合并后的conversation rows，排除额外tool records）、rawHistoryRecordCount、historyBytes、fixtureHash、executionApiMode、readinessMode。
- probe selector契约：timeline根 `data-session-id/data-logical-count/data-range-start/data-range-end`；row `data-message-id/data-message-index`。这些是诊断属性，非新的HTTP服务。

- [ ] 在最新main检查App/执行/文件接口是否已因先行功能改变，按符号重定位本计划源点；记录真实commit、dirty与harness hash。先运行旧小场景确认环境。
- [ ] 冻结第一份production当前基线：`pnpm studio:benchmark --counts=100,1000,5000 --variants=markdown,tools --repeats=3 --output=dist/performance/rendering-before.json`。失败保留原始失败与原因，不抄旧数值。
- [ ] 为fixture新增tool stream先写红测试：完整序列含tool-call/executing/result、reasoning/text，接受/观察通过真实execution service；新增 producer 必须追加对应 durable tool/step/result 事实，并替换 fixture 当前0/0/[]的 Turn tool summary，最终Session投影及终态reload的工具身份/结果/状态/顺序一致。保留旧100文本的精确期望。
- [ ] probe新增可同时读取full DOM或logical selector的readiness；优化前后都执行首/中/尾sentinel跳转，记录最终全文。full-dom路径保留旧count断言。虚拟路径不得以mounted count证明逻辑count。
- [ ] runner新增明确 `--stream-variants=text,tools`（默认text，max2），固定可选fixtures，Zod约束repeat1..5；加入schema测试和未知路由404测试，输出运行环境、schema、fixture hash。
- [ ] 运行 `pnpm exec vitest run apps/server/test/studio-performance-fixture.test.ts` 与小production场景；校对新版harness在尚未优化App时没有改变旧fixture内容/stream顺序。后续所有消融用这个版本。
- [ ] root审阅并按已授权工作流建立第一个可复现实验checkpoint。benchmark原始JSON不能有手填结果或真实秘密。

### Task 2: 线性历史投影与稳定行组件

**Files:**

- Create: `apps/studio/src/features/conversation/conversation-model.ts`, `conversation-row.tsx`, `conversation-types.ts`。
- Modify: `apps/studio/src/app/App.tsx`，保留原产品状态但调用抽出组件；`conversation/tool-step.tsx`。
- Create/Test: `apps/studio/test/conversation-model.test.ts`, `conversation-row.test.tsx`。
- Retain/re-run: `App.test.tsx`, `markdown-message.test.tsx`, `turn-stats.test.ts`, `file-context-flow.test.tsx`, `turn-file-review.test.tsx`。

**Interfaces:**

```ts
interface ConversationSnapshot {
  readonly sessionId: string;
  readonly revision: number;
  readonly rowIds: readonly string[];
  readonly rowsById: ReadonlyMap<string, ConversationRow>;
  readonly turnById: ReadonlyMap<string, TurnSummary>;
  readonly toolOwnerByKey: ReadonlyMap<string, string>;
  readonly durableOwnerByKey: ReadonlyMap<string, string>;
  readonly retryByTurn: ReadonlyMap<string, CapturedSubmission>;
  readonly latestAssistantId: string | null;
  readonly liveOverlays: ReadonlyMap<string, LiveConversationOverlay>;
  readonly durableSequence: number;
}
// Types above are Studio-local and reuse browser-facing Workspace/Agent types.
function projectConversation(detail: SessionDetail, previous?: ConversationSnapshot): ConversationSnapshot;
function getConversationRow(snapshot:ConversationSnapshot, id:string):ConversationRow | undefined;
function getConversationTurn(snapshot:ConversationSnapshot, id:string):TurnSummary | undefined;
type ConversationAction =
  | { readonly type:'quote'; readonly sessionId:string; readonly rowId:string }
  | { readonly type:'retry'; readonly sessionId:string; readonly turnId:string }
  | { readonly type:'inspect-tool'; readonly target:ToolIdentity };
interface ToolIdentity {
  readonly sessionId:string; readonly turnId:string; readonly toolCallId:string;
}
interface LiveConversationOverlay {
  readonly owner:LiveOwner;
  readonly rowsById:ReadonlyMap<string,ConversationRow>;
  readonly turnById:ReadonlyMap<string,TurnSummary>;
}
```

`ConversationRow`是当前ChatMessage的提取（含fileAttachments、originalUserMessage、images、submission、turnId，字段不丢）；`CapturedSubmission`提取现有AgentSubmissionSnapshot。getter先按 exact Turn 查询相应小 liveOverlays，再查稳定history索引；tool key使用session/Turn/call的canonical tuple，durable alias使用session/Turn/message。`onAction(action)`保持稳定，在拥有者中读取最新状态。

- [ ] 写红测试：user/assistant多step合并、不同turn与不同Session复用相同toolCallId但具有不同结果/状态、failed/rejected结果、legacy无ID、附件/来源、usage与retry全部保持；包含交错工具result先后和无result。直接比对原有功能fixture输出。
- [ ] 实现message/tool/turn索引单次构建；删除每tool `messages.find`、每row `messages.some`、每footer的全量submission查找。测试未改行引用保持stable，changed行才替换；索引key用完整身份。
- [ ] 提取memo行，业务action按ID回调；行只收到自身row/turn/primitive状态，禁止传每render新建完整Maps或闭包作为稳定props。
- [ ] 工具summary解析按arguments memo；process/tool body仅open时创建。红测试：closed工具无参数/result节点，打开后全文精确；关闭重开还原open IDs；审批检查的打开动作仍能显式focus参数；pending目标不会因尚未mount被清除。
- [ ] 保留MarkdownMessage的URL/HTML/image安全测试；不加innerHTML或新parser。运行Studio相关测试、typecheck、lint。
- [ ] 用Task1相同harness采checkpoint `rendering-indexed.json`。只报告实际数据，区分投影成本和DOM总量尚未下降。

### Task 3: 按session订阅与有序流frame发布

**Files:**

- Create: `conversation/conversation-store.ts`, `use-conversation.ts`, `conversation-pane.tsx`, `agent/live-turn-projector.ts`。
- Modify: `App.tsx` 的renderExecution/executionHandlers/reconcile/legacy处理、`agent/agent-execution-view.ts`可复用pure projector；不要改变HTTP观察client的验证/接受语义。
- Create/Test: `apps/studio/test/conversation-store.test.ts`, `live-turn-projector.test.ts`, `conversation-isolation.test.tsx`。
- Re-run: `agent-execution-view.test.ts`, `agent-execution-client.test.ts`, `App.test.tsx`, `composer-draft.test.tsx`, `file-context-flow.test.tsx`, `plugin-panel-lifecycle.test.tsx`。

**Interfaces:**

```ts
interface LiveOwner {
  readonly sessionId:string; readonly executionId:string; readonly turnId:string;
  readonly userMessageId:string; readonly runId:string; readonly epoch:number;
}
interface ConversationStore {
  getSnapshot(sessionId:string):ConversationSnapshot;
  subscribeSession(sessionId:string, listener:()=>void):()=>void;
  hydrate(detail:SessionDetail):boolean; // reject rollback below durableSequence
  replaceLive(owner:LiveOwner, snapshot:AgentExecutionSnapshot):void;
  appendLive(owner:LiveOwner, event:AgentRuntimeEvent):void;
  flush(owner:LiveOwner):void;
  settle(owner:LiveOwner, detail:SessionDetail):boolean; // exact terminal watermark confirmation only
  removeSession(sessionId:string):void;
  dispose():void;
}
```

store测试可注入 `scheduleFrame(callback):number` / `cancelFrame(id):void`，production使用requestAnimationFrame；不得注入到model/tool输入。empty snapshot缓存；getSnapshot无变化时Object.is相同。

- [ ] 写红测试：一次frame前100个event全部有序归约且最多安排一个frame，flush得到完整字串/工具状态；1000非相邻delta+tools的增量结果与权威executionTurnView一致。
- [ ] 覆盖reconnect snapshot替换、同session新execution/ABA、cancel后迟到frame、previous terminal read pending while next execution active、newer settled before older read、terminal durable replacement、dispose后callback、后台hidden再visible、schedule取消和listener清理。
- [ ] 实现内存accumulator和frame发布；event立即归约，React snapshot只在flush改变；只替换对应 execution 的小 liveOverlay，保留其它尚未 durable 确认的 overlays；history Maps与rowIds保持稳定，不逐token复制5,000项索引。terminal/error路径取消pending frame并flush，再遵守原watermark reconciliation。不要把DOM detach变成Runtime cancel。
- [ ] ConversationPane使用useSyncExternalStore订阅active session，App draft更新不重做历史索引或创建row JSX；context/overview按轻量selector消费变化。保留useComposerDraft原owner实例。
- [ ] 行隔离行为测试：普通输入时稳定历史组件不commit；stream只变live row/当前统计；切换到另一session不会读取/发布旧内容。用受控计数器或独立Profiler测试，不把测试观察器打进普通产品包。
- [ ] 运行上述回归；同harness采 `rendering-isolated.json`。若streamCPU仍大，先采Chrome trace/profiling定位，不抢做worker或Markdown增量parser。

### Task 4: 动态高度消息窗口、锚点与交互兼容

**Files:**

- After approved dependency decision: `apps/studio/package.json`, `pnpm-lock.yaml`，正式spec依赖理由。
- Create: `conversation/conversation-timeline.tsx`, `use-conversation-viewport.ts`, `conversation-ui-state.ts`, `conversation-search.tsx`, `conversation-transcript.tsx`。
- Modify: `conversation-pane.tsx`, `use-auto-scroll.ts`, `tool-step.tsx`, `file-undo/turn-file-review.tsx`, `App.tsx` jump/inspect接线，`app.css`。
- Create/Test: `conversation-timeline.test.tsx`, `conversation-viewport.test.tsx`, `conversation-search.test.tsx`；扩展 `use-auto-scroll.test.tsx`, approvals/file-review tests；browser probe功能用例位于 `apps/server/test/performance/` 或独立acceptance脚本。

**Interfaces:**

```ts
type ConversationTarget =
  | { readonly kind:'row'; readonly sessionId:string; readonly rowId:string }
  | { readonly kind:'durable-message'; readonly sessionId:string; readonly turnId:string; readonly messageId:string }
  | ({ readonly kind:'tool' } & ToolIdentity);
interface TimelineHandle {
  reveal(target:ConversationTarget):Promise<'revealed'|'missing'|'stale'>;
  scrollToBottom():void;
}
interface ViewportAnchor { readonly sessionId:string; readonly rowId:string; readonly offsetPx:number }
// Capture navigation/view ticket internally; recheck after every async mount/measure/focus phase.
```

使用virtualizer的getItemKey/measureElement/getVirtualItems/scrollToIndex，overscan8；不依赖未验证的latest-only聊天anchor API。滚动adapter只有一个scroll writer。

- [ ] 核对候选exact版本3.14.28源码/TS API后记录license/依赖/实际production bundle差值；若该版本不满足测量/keyboard需求，先修正式设计并重做版本审阅。root授权该依赖取舍后运行 `pnpm --filter @weave/studio add @tanstack/react-virtual@3.14.28`。
- [ ] 红测试/浏览器失败用例覆盖logical rows全在、mounted受限、首中尾reveal、工具第500项定位、stable keys、width resize/image/tool展开重测、following与上滚锚点；jsdom只验证range/调度，像素断言由浏览器完成。
- [ ] 实现可变高window、无collapse margin的行box、height cache按session/row/width身份，focused/selection/pending mutation pin。允许pin例外并记录数量；不对任意巨型单行声称固定DOM。
- [ ] 把file review操作latch/pending IDs/results移到session controller或等效不随虚拟row卸载的所有者；红测试正在undo时滚出窗口/回窗/切会话不重发、丢ID或给错turn；保持HTTP接口不变。
- [ ] 实现reveal先按完整Session/Turn/call或durable-message alias解析→scroll→mount→展开→remeasure→focus，所有异步步复验相同navigation/view ticket和目标owner；删除旧document.getElementById静默失败路径。
- [ ] 实现完整逻辑查找（text/reasoning/tool参数结果）与按需完整文本只读/复制。查找input urgent、结果可defer，索引只为active loaded session创建并释放；不把未mount当无结果。测试远处唯一关键词、原URL、工具引用与复制全文准确。
- [ ] 单独小aria-live状态取代整历史每token通知；检查键盘、focus、不活动窗口、读屏器及完整文本退路。结果记录实际测试范围。
- [ ] 运行source回归和browser acceptance，采 `rendering-windowed.json`。验证5000旧fixture DOM≤5000、普通无pin mounted≤64；未达goal记录原因，不削数据。保存锚点前后位置证据。

### Task 5: PR1完整验收与真实结果文档

**Files:**

- Modify正式spec/learning结果、root命令说明；所有raw JSON及引用路径。
- Test: 现有Studio/server tests + browser流程。

- [ ] 运行 `pnpm check`，确认lint边界、全部source类型与测试通过。对新增依赖build后的chunks进行实际大小对照；不拿npm unpackedSize当bundle值。
- [ ] 正式三至五次生产矩阵：旧对照、混合高度、tool stream、500工具诊断；同机before/after交错样本，完整token/order/source/selector验证。
- [ ] 输出每scenario原始samples、median、pooled rAF p95、长任务超额部分、DOM、heap可选及环境条件。分离profiling build结果与production时间。
- [ ] 写失效边界：full history仍在内存、单条大Markdown/打开全文模式、pinning例外、没有真实模型/多Agent吞吐。只有数据支持才写提升百分比。
- [ ] 独立review特别检查draft ownership、approval focus、file undo、terminal/watermark、virtual search/keyboard。root按仓库授权流程建PR，CI绿后squash；不在未授权子任务中commit/push。

## PR 2：文件树渲染（PR1合并后从最新main开始）

### Task 6: 树基线与固定高度窗口

**Files:**

- Create: `files-tree/file-tree-model.ts`, `file-tree-list.tsx`，必要的固定range helper只在此feature目录。
- Modify: `file-tree-panel.tsx`, `file-tree-api.ts`, `app.css`。
- Create/Test: `apps/studio/test/file-tree-model.test.ts`, `file-tree-window.test.tsx`；扩展 `file-tree-panel.test.tsx`。
- Modify performance `scenario.mjs/fixture.mjs/browser-probe.mjs/run.mjs`、`studio-performance-fixture.test.ts`。

**Interfaces:**

```ts
interface FileTreeRow {
  readonly path:string; readonly name:string; readonly depth:number;
  readonly isFile:boolean; readonly siblingPosition:number; readonly siblingCount:number;
}
interface FileTreeModel {
  readonly files:readonly string[]; readonly lowerPaths:readonly string[];
  readonly truncated:boolean;
}
// fetchFileTree already accepts {signal?:AbortSignal}; pass it from the panel.
// fetchFileContent gains the same optional option; response shape unchanged.
```

- [ ] 新分支先采未优化树baseline，不能用会话旧数值替代。fixture新增合成GET `/projects/benchmark-project/tree`、`/file`、`/file-diff`的现有真实HTTP形状；project假folderPath仅标记，不读取本机路径。Zod检查file count∈1000/10000/50000、shape∈wide-root/wide-src、body/response有界。
- [ ] baseline probe打开文件面板，wide-src展开目录，`.ts`广匹配，rare sentinel，滚动到首中尾并打开file检查内容。计时初树、展开、filter input、最终results、file ready，保存mounted/logical count。
- [ ] 红测试固定行range夹紧、空树、50k输入、排序/level/posinset、过滤全部匹配与无匹配、truncated提示。构建时排序一次并lowercase一次；expanded只读有序索引。
- [ ] 使用PR1已验证virtualizer的fixed estimateSize（CSS同一高度）窗口；匹配与目录共享行组件，overscan8；focused项可pin，逻辑导航先scroll再focus；deferred query有pending提示。
- [ ] 保留现有 PanelContext.fileOwnerKey=JSON.stringify(composerDraft.owner) 的 key remount 和 captured onAddFile owner；给tree/content request加每effect setup新controller、AbortSignal+epoch+project/selection比较；红测试A慢B快、project A→B→A、refresh迟到、unmount、过滤后index变化不打开错path。参考file picker的owner检查，不能用字符串path单独识别跨project归属。
- [ ] 保留splitter、附件、lazy diff/highlight及面板keepAlive=false；不加无界tree cache、不改变Server cap。运行tree/attachment/panel测试和browser键盘选择。
- [ ] 运行50k matrix，断言mounted≤ceil(viewportHeight/rowHeight)+16+focusPin，逻辑计数与sentinel准确。记录新基线/after，不预填百分比。

### Task 7: 争用、viewer诊断与最终履历证据

**Files:**

- performance fixtures/probe与正式rendering结果文档；viewer仅加test fixture，不在该PR自动换库/worker。

- [ ] 运行5000工具历史+50k树+固定stream争用场景，同时编辑composer/filter。验证精确stream、草稿、query和选中file完整身份；测frame/longtask与每阶段代理。
- [ ] 运行100KiB/400KiB/近2MB多字节/ASCII、单长行/多行viewer与diff诊断，记录plain/highlight/diff阶段；记住highlight现在检查code units。若大block主导，单独形成后续worker/行窗口设计，不把诊断完成写成已优化。
- [ ] 跑 `pnpm check`、所有production benchmark与browser acceptance。三至五次raw样本+独立review，保持无真实项目/provider访问。
- [ ] 形成两PR的真实对照表、消融commit/fixture hash、失败目标和限制；将可核验数字写入项目说明，保留合成数据、同机、median/p95定义。
- [ ] root按授权workflow提交、CI、squash；下一主题重新从最新main建分支。

## 完成标准与停止扩大范围条件

所有行为回归绿、真实浏览器窗口/锚点/查找/审批/文件撤销验证、raw before/after样本与明确指标定义齐全，才可称完成。若冷就绪瓶颈转为HTTP/JSON/历史投影，或单条Markdown/高亮主导，提交当前有证据的改善与限制；另写分页/worker设计，不通过提高server cap、删逻辑内容、隐藏失败case或换fixture达标。

本稿仅计划，未运行新的计时实验、未安装virtualizer、未开始任一PR。


## 当前源码对齐修订的执行顺序

- [ ] 先阅读修订设计 §11 并在正式仓库 spec 中冻结完整 ToolIdentity、durable alias、按 execution 多 overlay 和单调 watermark 合同，再并行派实现者。
- [ ] root 负责 App、store/controller、共享 CSS、exports、manifest/lock 的串行修改；模型纯函数和性能 fixture 可分别由 A/B 独占，禁止并行写 App。
- [ ] 在安装库前，先用实际 3.14.28 package TS/API 核对测量、scroll和key支持；当前 registry 研究记录不能代替将来版本验证。依赖理由与实际 bundle 差值落文档。
- [ ] Task2 回归覆盖 bare-ID 联结修复：两个 Turn 使用同一call ID的失败/成功结果不得互借；另Session相同ID也不影响。legacy无充分身份时不猜测。
- [ ] Task3 回归保留既有 App terminal/next-active测试并人为延迟frame：settle只删除被确认 owner；旧detail不能回退新durableSequence、新overlay或运行状态；completed事件本身不确认 durable。
- [ ] Task4 browser验收新增 root→child durable result定位、child approval focus、Session在scroll/mount/measure之间切换、重复call ID跨Turn；focus必须精确或返回stale，不能落到当前同名项。
- [ ] 文件撤销 controller测试 response丢失→row卸载→重挂→同request重试；pending ID不可被LRU清除，disabled/busy实时读取。
- [ ] PR2保持现有 keyed explorer的同项目folder ABA语义，测试 refresh重叠/文件selection竞态/StrictMode；不要额外创造新的root authority API。
- [ ] 报告区分合成历史HTTP read model、真实ExecutionService live fixture、合成50k目录组件压力与真实本机文件I/O；没有新运行不得填任何提升率。

只读复核于 Memory 提交工作区 `da9120ae174289f0650bcea13a49debe08eaf159`；未运行benchmark、未安装依赖、未改仓库。正式实施前仍从检索合并后的最新 main 重采baseline并复核源码。
