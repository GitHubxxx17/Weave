# Studio 大规模渲染优化设计草案

日期：2026-11-23。状态：已批准实施设计；正式实施从混合检索合并后的最新 main 重新定位并采集基线。研究位置为 `background-executions/weave`，当时 `feat/web-plugin` HEAD 为 `ab68223df86e9119023ea723dc5fad5bbb8f4554`，该分支仍在变化。用户路线中，此项排在多 Agent、长期记忆与检索之后；实施时必须从当时最新 `origin/main` 重新审计代码与采集基线，不能沿用当前功能分支。

## 1. 目标与证据边界

交付可复现的大规模 Studio 渲染能力：长会话只挂载窗口附近的消息；流式输出不使稳定历史和输入区反复工作；大量工具记录在展开时才创建正文；50,000 文件列表可筛选、滚动和选择。保留完整逻辑内容、来源、精确重试、审批检查、取消与执行恢复语义。工程产出包括结构性回归测试、生产浏览器原始样本、优化前后对照和明确限制，适合作为真实简历项目依据。

现有观察来自 `docs/learning/2026-11-23-studio-performance-baseline.md` 及其 raw JSON。其代码基线为 `2d5586eab65f35c3e47e02bcb6fa1b7bd929a492`，dirty=true，M4 Pro/macOS arm64/Node24.4.0/Chrome158.0.8127.36/1440×1000，3次重复。这些数值只描述那次实验，不代表当前分支，也不能用于计算本提案尚未实现的提升率。

| 场景 | 数量（用户/助手消息） | 初次就绪中位数 | 切回会话中位数 | 输入代理中位数 | stream rAF 间隔 p95 | DOM 元素 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Markdown | 100 | 131ms | 102ms | 32ms | 16.7ms | 2,171 |
| Markdown | 5,000 | 1,209ms | 1,694ms | 2,494ms | 466.6ms | 95,271 |
| 工具历史 | 100 | 137ms | 100ms | 46ms | 16.8ms | 4,171 |
| 工具历史 | 5,000 | 1,535ms | 1,702ms | 1,949ms | 516.6ms | 195,271 |

“输入代理”是 fill 到两次 rAF，不能称为 INP；rAF 间隔不是用户可见 FPS；长任务超出50ms部分的求和不是标准页面 TBT；可选 usedJSHeapSize 不是泄漏证明。没有采样 profile 之前，下节均为代码上可解释、需要消融实验验证的成本来源。

## 2. 当前路径与具体成本

行号对应研究时 checkout；实施前以符号重新定位。

| 位置 | 已确认源码行为 | 预期成本与限制 |
| --- | --- | --- |
| `apps/studio/src/app/App.tsx:957,1003,3763,3996` | draft hook在App执行，textarea变更更新同一App；历史直接 `messages.map` | 输入也遍历历史与创建行JSX。历史Markdown本体已经memo，不能说每次都重新解析全部Markdown |
| `App.tsx:1006,1022,3876,3910` | 每次建立turn索引；每行 `messages.some`；footer通过 `submissionForTurn` 对turn/messages执行find | 某些完整渲染含二次扫描；预计算userByTurn、retryByTurn等索引可改成每个版本一次遍历与每行O(1)查找 |
| `App.tsx:648,665,691` | 每个tool通过全部messages找结果；多step合并用 `result.indexOf(existing)` | 工具历史投影/多step历史加载可能退化；投影应在数据版本改变时做一次，用ID Map完成关联 |
| `App.tsx:1481,1530,1540,1574` 与 `agent-execution-view.ts:7,21` | 每个生产SSE event追加/压缩快照，重新遍历整个live-turn events，重新构造tools，再filter全部历史messages与turns | 非相邻text事件多、工具多时重放成本累积；即使React批处理，event到projection的CPU仍已发生。相邻delta已有压缩，应保留 |
| `conversation/markdown-message.tsx:37` | `memo`，remark插件和components提升到模块级；ReactMarkdown对正在变化的text做完整解析 | 稳定历史已有隔离；当前长回复仍随每个可见更新重新解析完整text。先降发布频率，只有profile证明必要才研究增量Markdown |
| `conversation/tool-step.tsx:85,115`、`App.tsx:3804` | 原生details折叠但全部children仍创建；JSON参数每render解析/pretty print | 不可见工具正文仍占React/DOM/字符串工作；折叠过程容器也创建所有工具行 |
| `conversation/use-auto-scroll.ts:77,87` | 每messages版本layout effect读取scrollHeight并滚底；session切换滚底 | 必须与动态高度/测量统一，否则会产生重复layout、错误上滚判定和视口跳动 |
| `files-tree/file-tree-panel.tsx:76,333,336,412,434` | 树/flatten已useMemo；flatten每次排序访问目录；filter每次lowercase全部paths；全部matches/expanded rows挂载 | 生产文件上限50,000，宽目录或宽筛选可造成大DOM；只有折叠的深树不能证明优化有效 |
| `file-tree-panel.tsx:195,245` | tree/content fetch没有request epoch/abort；highlight有active标志丢弃旧HTML | 并发/延迟工作增加时必须保证最新project/selection归属；性能工作不能让旧请求覆盖新内容 |
| `files-tree/highlight.ts:83,103`、`file-diff-view.tsx:36` | Shiki懒加载/单promise、语言按需；highlight门槛实际是code.length；diff主线程生成raw/syntax/两种line数据 | 这些不是历史DOM虚拟化能解决的CPU；先加诊断负载，worker/diff库改动单独评估。不能把400k code units称作byte上限 |

保留已有优点：Markdown memo、diff和terminal的动态导入、按需语言、拖分隔条时直接style更新、稳定消息/turn/execution ID、外部输入Zod校验、Composer owner epoch、执行快照重建与durable watermark规则。Vite当前只有plugin-react，未配置React Compiler；不能假设编译器已替代memo。

## 3. 边界与分期

第一阶段仅 `apps/studio` 浏览器渲染与 `apps/server/test/performance` 合成工具、文档。Studio仍只通过HTTP/SSE访问Server，无 `@weave/*`、Node或Electron import；渲染缓存没有执行权，不能重放工具、取消producer或写Session事实。完整durable history和有界live snapshot仍是权威；UI窗口不是Session截断，也不修改LLM上下文。

建议以两个独立主题PR顺序交付：

1. `feat/studio-conversation-rendering`：测试/benchmark契约、投影与更新隔离、消息窗口、工具正文按需挂载、滚动/查找/审批定位兼容。这是主简历亮点。
2. 从合并后的最新main创建 `feat/studio-explorer-rendering`：固定高度文件行窗口、过滤隔离、归属防护和50k benchmark。避免一条PR同时重构App和文件浏览器。

历史HTTP分页、Session索引/存储分页、任意长度单条Markdown/代码块的增量解析、跨线程Shiki/diff、十万级Session sidebar搜索、所有屏幕统一state framework暂不纳入。消息虚拟化仍会下载/校验/保存全部逻辑历史，因此不会宣称网络/解析/常驻数据内存变成O(窗口)。新基线若证明JSON/投影主导冷就绪，再另开跨包分页设计，先写Server/Session/HTTP契约。

## 4. 方案取舍与依赖

| 方案 | 优点 | 不足/决定 |
| --- | --- | --- |
| `content-visibility:auto` + 行memo | 改动小；原生find与完整DOM还在；可作profile消融对照 | 不减少React创建、projection或DOM数量；不足以满足大规模挂载边界。作为比较实验，不作为最终核心 |
| 自研固定/可变高度virtualizer | 文件单行实现很小、零依赖 | 变量消息高度、ResizeObserver、跳转/宽度变化/锚点/滚底的长期维护成本大；不建议把简历项目变成通用虚拟列表库 |
| headless TanStack Virtual + Weave语义adapter（推荐） | 同一测量/窗口核心覆盖动态消息与固定文件行，不引入视觉组件/状态平台 | 新增直接runtime依赖，必须记录理由、license、exact版本、bundle差值和lockfile；聊天锚点/审批/草稿语义仍由Weave验证 |

只读时npm registry返回 `@tanstack/react-virtual@3.14.28`，MIT，唯一声明依赖 `@tanstack/virtual-core@3.19.13`，wrapper解包65103bytes；这不是gzip/实际bundle成本。实施时核对并固定选定版本，先验证其TS API和浏览器行为再锁定；不要在研究分支安装。若最终仅做文件列表，可以自研固定range helper，无需为文件树单独新增包；推荐是先完成聊天需求后共享已验证的headless核心。

2026-11-23实际读取官方 React `useSyncExternalStore` 文档和 TanStack Virtualizer API（链接见第10节）。采用cached immutable snapshot、stable subscribe、stable getItemKey、overscan和动态measureElement原则；不采用文档或skill里的“10x”等示例数字作为Weave证据。新库不是性能保证。

## 5. 会话投影、发布频率与组件隔离

将数据投影从App内联移到 `features/conversation/conversation-model.ts`：`ConversationSnapshot`保存stable row IDs/rowsById、turnById、userByTurn、toolOwnerByKey、durableOwnerByKey、retryByTurn、latestAssistantId、revision。首次load/权威replacement一次O(messages+toolCalls+turns)；没有每tool的全量find或每row的some。未改变行保留对象身份；新的全量history版本只因真实内容变动重建。

新增App生命周期的browser-only `conversation-store.ts`，仿照现有plugin-catalog store，但只服务会话渲染。`getSnapshot(sessionId)`返回cached immutable对象；`subscribeSession(sessionId,listener)`稳定并可unsubscribe；空snapshot模块级常量。完整历史索引在stream期间保持引用，同一 Session 尚未被 durable history 确认的各个 execution 放到按 executionId 区分的小 immutable `liveOverlays`（每项 rows/turns/owner）中，读取时仅对各自 exact Turn 使用 overlay；上一 execution 等待终态确认期间下一轮可已开始；不得每个token复制一个5,000项Map，也不能原地修改已发布snapshot。rowIds只在接纳/替换/删除消息时更新，每次被准确 watermark 确认时只清理该 execution 的 overlay，并按单调 lastSequence 合并历史；保留尚未确认的其它 overlays。不要每次getSnapshot创建新对象或传所有session组成的大对象给每个consumer。`ConversationPane`自己订阅active session；composer、sidebar、context/footer按实际需要订阅轻量选择结果。App里的`useComposerDraft`所有权/epoch继续是同一对象，避免以“输入隔离”为由打断附件/插件插入/ABA防护。

SSE原始输入仍即时校验cursor、身份和顺序；把每个event按顺序更新browser内存的live-turn accumulator，工具以ID map更新，text/reasoning chunk追加。UI只在至多一个待处理rAF中发布当前snapshot；多个帧内delta可以合并展示，不能丢字、重排或吞工具状态。外部执行snapshot可完整replace accumulator。terminal/cancel/error/reconcile先撤销旧rAF并flush当前buffer，再使用现有durable watermark流程，迟到callback必须校验session/execution/run epoch，不可覆盖terminal history。不可在请求读取层用debounce丢掉事件，后台tab无rAF时保留待发布事实并在可见/终态刷新；只安排一个fallback任务，不能为每delta创建timer。

初版仍对变化中的整条Markdown用现有安全renderer，但最多每帧一次。不引入innerHTML、不启用远程图/原始HTML、不新增Markdown parser。completed历史row `memo`，props为稳定row/turn引用、primitive状态和stable action dispatcher；callback按ID解析最新session数据，避免闭包捕获旧draft/权限。工具summary的参数解析按arguments字符串memo；body首次展开才pretty print/挂载，关闭可卸载body，open IDs保存在pane外按完整 session/Turn/toolCall identity 索引，row/process 展开另按 session/row identity。

## 6. 消息窗口与交互正确性

`ConversationTimeline`的virtual key使用完整 `sessionId + message.id`，绝不用index。保留当前消息合并规则（一轮多个assistant step合并成card）；窗口围绕可见区，overscan初值8项。动态行使用ResizeObserver/measureElement测量；宽度变化、Markdown完成、图片加载、工具展开、文件审阅展开都触发重测。消息CSS用flow-root或显式gap避免外margin不计入测量；图像加载不能把阅读位置推走。

滚动只有一个owner，替换/适配 `useAutoScroll`，不用新旧两个layout effect同时写scrollTop：

- 接近底部80px时following；尺寸更新后在一次layout协调中保持底部；流刷新不使用smooth造成追赶队列。
- 用户上滚时固定 `{messageId, offsetWithinRow}`；上方行测量变动补偿同一可见锚点。连续stream不改变阅读锚点；“回到底部”恢复following。
- session切换沿用当前产品“到该会话底部”行为；不夹带按会话scroll restore的新行为。缓存height按session/row/widthClass管理，session/root变化不能串用。
- `jumpToMessage`、任务 durable result 和审批 `inspectToolCall` 均先以完整结构目标解析逻辑 owner，再scrollToIndex，再等待目标mount/measurement，设置过程/tool展开，再第二阶段focus参数。不能继续直接getElementById后静默return。每次 await/observer/frame 后仍须核验 active Session、navigation ticket、view epoch、exact Turn/tool 或 durable-message owner，最后才 focus；不能以 toolCallId 全局唯一为前提。
- 活动focus/选择区、未完成文件撤销操作的行可被pin，防止卸载夺走焦点/丢失交互。pin是明确的额外挂载例外，不宣称任意数量同时pending undo时都有固定DOM上限。文件审阅的请求latch/pending operationId/results归属于pane/session controller，组件卸载不等于取消/重发mutation；session切换仍用现有归属校验。
- 过程展开、tool展开保存在pane UI-state索引；普通历史row卸载/remount仍还原。缓存按session有界；pending mutation或focused条目不能被LRU淘汰。关闭pane时撤销observer/frame listener，不改变Runtime producer。

虚拟窗口会减少native browser Find可搜索的DOM，也会影响跨未挂载行拖选和辅助技术浏览。这是必须显式解决的产品约束：保留逐消息copy/quote，并提供“查找会话”对完整逻辑text/reasoning/tool arguments/results搜索与定位；提供按需“完整文本”只读视图/复制完整会话文本供浏览器查找与连续选择。打开时从同一snapshot生成，不发模型/工具请求，不改变Session；这个模式允许大文本成本，不能计入虚拟窗口性能结论。普通模式history使用list/listitem逻辑序号；高频token不让整个历史aria-live反复播报，单独的小status区域宣布运行/完成。实测键盘、VoiceOver或可用读屏器后再声称无障碍兼容。

单条超长Markdown仍可比视口大，单行窗口不能保证这条内部DOM恒定；工具body同理。目标benchmark分别测“很多常规条目”和“单条超长内容”，不能通过默默截断text制造好成绩。若一个过程有500+工具，先按需body+工具heading窗口（固定heading，展开body需要动态高度）；只在其profile有意义时加入，测试审批能定位第500项。

## 7. 文件树

沿用现有Server目录/文件接口及上限：`workspace-file-index.ts:35`为50,000文件，`workspace-browse.ts:32`为2,000,000bytes内容。保留 `listing.truncated` 到view并展示“列表未完整”，不能把cap称为整个仓库。

树构建时目录/文件按现有规则排序一次，path小写检索值随listing生成一次。expanded变化只flatten有序节点；filter输入保持urgent，匹配列表可用useDeferredValue，旧结果显示pending状态，最终点击读取的是所呈现行的完整path，不能以新index解释旧列表。defer不把50k扫描搬到后台，也不是减少算法成本的证据。

普通tree rows与filter matches共享固定高度窗口，CSS高度与测量常量一致；视口range + 每侧8行overscan + pinned focused item。通过path稳定key，保留directory-first、depth、expanded、selected、title、附件入口和splitter。现有树尚无完整 roving focus/Arrow/Home/End导航；这是为虚拟化新增并验收的能力，不能写成已存在的完整键盘支持。树role加level/posinset/setsize按逻辑兄弟组；支持键盘导航至下个逻辑项并先scroll后focus，不让Tab/Arrow因未mount跳过数据。filter/project切换重置/夹紧range，并在过期request完成时拒绝发布。

fetchFileTree已有可选AbortSignal但panel尚未传入；fetchFileContent增加同等选项。两条panel调用用每个 effect setup 新建的 AbortController、request epoch 与当前 project/selected identity 校验（参考 `features/file-context/use-file-picker.ts`），确保旧 refresh 或旧 file 不覆盖新内容。现有 App 已将 `JSON.stringify(composerDraft.owner)` 作为 `PanelContext.fileOwnerKey`，registry 以它为 FileTreePanel 的 key；onAddFile 也捕获 exact ComposerOwner。必须保留这些 session/project/root/epoch 与 ABA 防护，不新增另一个 root-owner API。面板当前keepAlive=false，初版不修改其生命周期；重复打开的网络/重建成本单独记录，不能靠无界cache掩盖。

## 8. 基准矩阵与验收目标

修改现有harness，不另写手工React benchmark。它目前已经通过真实 `createAgentExecutionService` 的接受/观察/queue边界运行合成producer，不能退回只测legacy POST SSE。保留100/1000/5000消息、markdown/tools、100个20ms文本delta、1440×1000、production/no-store/fresh-browser-per-sample、逐sample清理和raw output；旧count/内容不可为优化削减。新报告schemaVersion=2，保留legacy字段但把visibleMessages拆成logicalMessageCount/mountedMessageCount（均指合并后的用户/助手 conversation rows），另记 rawHistoryRecordCount/historyBytes；tools fixture的额外tool records不计作conversation rows。记录harness版本/fixture hash及API路径模式，避免跨版本误比。

就绪从“DOM中存在全部timeline-item”改为：逻辑计数正确；当前session身份正确；最后sentinel已mount且内容正确；range稳定并经过两次rAF。生产组件可加无权力的data属性 `data-logical-count/start/end/message-id` 供诊断，不能为了benchmark暴露整份global state。测试再跳首/中/尾并核对sentinel，防止伪装只保留最后N条。

| 组 | 数据 | 操作/完整性 |
| --- | --- | --- |
| 旧对照 | 100/1000/5000 markdown/tools | 初次/切回/输入/100×20ms stream，最终全文逐字匹配 |
| 混合高度 | 5000条，确定性短文/表格/代码/图像/可展开tool | 首中尾跳转、上滚时stream、宽度resize、展开后锚点偏移 |
| 工具流 | 100条工具call/executing/result穿插reasoning/text，另有1turn500工具诊断 | 顺序/状态/结果精确，审批检查远处tool，cancel+terminal+reconnect不漏内容 |
| 文件树 | 1k/10k/50k，wide-root及wide-src +浅兄弟目录 | 展开/收起、`.ts`广匹配与rare query、首中尾path选择、完整路径/内容准确 |
| 争用 | 5000工具历史+50k文件，100×20ms stream | 同时编辑草稿与filter，逻辑计数、完整stream、选中path都正确 |
| viewer诊断 | 100KiB/400KiB/近2MB，ASCII/多字节、长单行/多行 | plain/highlight/diff阶段、主线程长任务；只报告，不把worker纳入本期 |

**以下是待验证目标，不是测量结果**，最终设计在同机新基线完成后冻结；机器时延不放普通CI硬门槛：

- 标准5000条旧fixture默认窗口DOM≤5,000，常规无pin mounted rows≤64；普通closed工具body DOM为0。定长文件mounted rows≤ceil(viewportHeight/rowHeight)+16+focusPin，50k也成立。
- 同机5k旧fixture coldReady/warmSwitch中位数各≤600ms、输入fill-to-two-rAF中位数≤100ms、stream rAF gap p95≤50ms；100条小场景不得超过对照中位数max(20%,20ms)。如果数据parse主导导致冷就绪没达标，报告失败/拆分页，不调小fixture。
- 50k tree在新的同机基线后对照：tree/filter/input各阶段中位数，目标filter输入代理≤100ms、结果就绪≤300ms；扩展/滚动阶段rAF p95≤50ms。没有树现有数值，不能写相对提升率。
- 同一锚点在stream/重测/上方展开后位移≤2 CSS px（字体/浏览器一致且静止后）；keyboard focus最终落到逻辑目标；不丢/重排token、工具状态、引用URL或精确重试参数。

raw保留每sample时延、frame gaps、longtask start/duration、DOM、可选heap、project/session/row计数、stream bytes/order摘要、浏览器console错误。每case至少3次；最终简历主张建议5次及顺序交错before/after运行，记录机器负载条件，不挑最快一条。独立profiling build采React commits/actualDuration或Chrome trace，用于定位，不与普通production时延混算。

## 9. 验证与可交付叙述

离线CI验证纯projection输出、stable row引用、frame flush完整性、epoch/cancel/reconnect、range/scroll anchor、focus/审批检查、lazy tool body和file ownership；这些是行为测试，不写只镜像实现细节的微测试。真实布局/ResizeObserver/Markdown高度/滚动/键盘测试走browser acceptance，jsdom不能证明像素锚点或帧流畅。

分层记录消融checkpoint：同一harness下 A新基线 → B索引/稳定行/工具lazy → Cframe发布与组件订阅隔离 → D消息窗口 → E文件窗口。保留每个commit/fixture hash，而不是只报混合大改最终分数。每步完成行为回归后再采样，未测的不填数值。

未来简历可以如实写“设计并实现具有动态高度测量、流式更新隔离和稳定锚点的Agent会话窗口，覆盖5,000条工具会话与50,000文件；以隔离生产浏览器benchmark记录DOM、输入代理、长任务和raw样本”。只有真实对照完成后才加“DOM从X降到Y、输入代理从Xms到Yms”等数字，并明确合成数据/同机/中位数；不能写真实多Agent吞吐、模型速度、INP、无内存泄漏或恒定总内存。

## 10. 实际读取的参考与后续工作

- 本仓库foundation、ADR0001、2026-11-14 foundation design、2026-11-23 performance baseline design/learning/raw JSON与现有source/tests。遵守Session事实与live-control分离、HTTP-only Studio、无执行权缓存。
- React official [`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)，2026-11-23实际读取：snapshot需cached immutable、subscribe身份稳定；采用局部store契约，不新增通用状态库。临时正文 `/tmp/weave-react-external-store.txt`。
- TanStack official [`Virtualizer`](https://tanstack.com/virtual/latest/docs/api/virtualizer)，2026-11-23实际读取：stable getItemKey、overscan、measureElement、scroll APIs。`latest`是会变化的参考，实施需对照选定package源码/API，不能声称研究时已验证exact版完整功能。临时正文 `/tmp/weave-virtualizer-docs.txt`。
- 已读取本地 `vercel-react-best-practices` 的memo/ref/content-visibility/split-hook规则；采用测量后隔离、稳定引用、lazy可选内容，拒绝把示例提升数字当实验。
- 未新核对Codex/Kiro/Harness的渲染实现，不为它们声称React方案或性能数据；本提案是Weave已有基线与官方React/virtualizer契约导出的取舍。后续若借鉴具体竞品交互，必须先读取官方文档或固定源码并记录。

实施前由root在顺序功能启动时审阅依赖/全文查找/文件审阅生命周期，更新正式architecture/spec再动代码。此研究未授权抢先开始优化或混入web/release PR。


## 11. 当前源码对齐后的强制澄清

本轮复核位置是 `/Users/mi/.codex/worktrees/agent-tasks/weave` 的 Memory 提交工作区，复核时 `HEAD=da9120ae174289f0650bcea13a49debe08eaf159`。未重新访问外部参考，§10 的官方文档读取来自原研究记录；未运行新的性能实验。实施仍应在检索合并后的最新 main 上重新定位并采集基线。本节收敛上文的接口含义，不宣称新接口已经存在。

### 11.1 完整目标身份，不降级现有审批和任务导航

当前 `App.TaskTranscriptTarget` 的工具分支已含 sessionId/turnId/toolCallId，审批通过 `taskForApproval` 核对 child Session/execution/Turn，任务结果为含 session/execution/Turn/message/terminalSequence 的 durable pointer。现有 `inspectToolCall(toolCallId, turnId?)` 至少在审批与跨 Session 任务路径携带 Turn，虚拟化不得退回草案原来的 `revealTool(toolCallId)`。

新 Studio-local `ToolIdentity` 为 `{sessionId,turnId,toolCallId}`，canonical key 使用 JSON tuple 等无分隔歧义编码。`toolOwnerByKey`、状态/结果索引、展开和 focus 都使用该完整 key。durable-result alias 使用 `{sessionId,turnId,messageId}` 指向合并后的 card；不得把多个 assistant steps 合并造成的 `durableMessageIds` 丢弃。`TimelineHandle.reveal(target)` 接受 discriminated row/durable-message/tool 目标，不提供只收 toolCallId 的入口。row target 也显式含 Session。legacy 缺 Turn 的记录可显示、查找和以准确 row 定位；不能猜测为当前同名工具并 focus。

投影同时修正当前 `messageToolResult(messages, toolCallId)` 与 `toStudioSession` 的 bare status map：有 Turn metadata 时只在同一 Session+Turn 联结。测试两个 Turn 复用相同 call ID、第一轮失败/后一轮成功且正文不同，必须各保留原结果/状态；再在不同 Session 复用相同 ID，验证旧 reveal callback、查找、审批和任务 citation 都不能跳错。没有充分 legacy provenance 时保持未知/缺结果，不从其它 Turn 借数据。

reveal 是一个可取消的 presentation transaction：解析当前 snapshot owner→scroll→等 mount→展开→等测量→focus，所有异步阶段重验相同 navigation/view ticket 与逻辑目标。Session 改变、row alias 改变、dispose 或目标消失均返回 stale/missing；不能在目标 Session 尚未激活时清除待办 target，也不能因初次未 mount 静默丢弃。打开子会话仍由原 App origin/result 校验负责，viewport 不获得导航或权限权威。

### 11.2 多个执行 overlay 与单调 durable watermark

当前 `reconcileExecution` 允许上一 terminal read 尚在等待时下一 execution 已开始，并用 `appliedDurableSequences`、`settledExecutionSequences`、`confirmedExecutionTurn` 与 `mergeExecutionHistory` 保留新 overlay。新 store 不能将 Session 简化成只拥有一个 LiveOwner。

内部以 executionId 保留每个 exact `{sessionId,executionId,turnId,userMessageId,runId,epoch}` owner 的 accumulator/overlay；terminal snapshot 和 completed event 不直接清空内容。`settle(owner, detail)` 必须同时验证 owner 仍被登记、detail.id 相同、detail.lastSequence 不低于该 Session 已接受 durable sequence、snapshot 已 terminal 且 watermark 可见、exact Turn/userMessage 匹配且 terminal，才清理这个 overlay。accepted-but-never-started failed/cancelled/interrupted 的既有无 Turn 分支保持原规则，不能强造 Turn。较老 read 可以帮助确认其 handle 已 durable，却不得回滚更高序列历史、最新状态或清掉其它 overlays。

每个 execution 只有一个待发布 frame；snapshot replace 先使旧 frame generation 失效。terminal/error/reconciliation 先按 owner flush 已接纳事件，再经过原 durable confirmation；迟到 frame 不能复活已经 settlement 的 owner。append 的事件已由原 client 校验 cursor/epoch/order，store 不重接协议、不对事件 debounce 丢弃。暂停展示不停止 producer。测试沿用现有 App 的“previous terminal read pending while next active”和“earlier terminal read returns after newer settled”矩阵，再把 rAF 人为延迟到各个边界之后。

### 11.3 虚拟卸载与文件撤销的持久请求身份

当前 `TurnFileReview` 的 busy ref、pending `{turnId,operationId,requestId}`、review/results 与错误都在 row-local state。新窗口会主动卸载 row，因此必须先将这些移到 App 生命周期的精确 `{projectId,sessionId,turnId}` controller，或保持等价的受管实例；仅 pin 一个 DOM 节点不能替代 mutation 所有权。unmount 不取消或重发 restore，响应丢失保留原请求。成功/失败后仅向同一 owner 发布，不给新 Session/Turn 使用结果；新点击仍读取当前 busy/disabled/compose 状态。LRU 不得淘汰未确认请求身份；不在浏览器持久存储写入新执行权。

### 11.4 Explorer 已有 owner，不另造权限层

现有 `PanelContext.fileOwnerKey` 与 registry 的 component key 已使 explorer 在 ComposerOwner 改变时重新挂载，包含同项目 folder A→B→A 的 epoch。App 的 onAddFile 捕获相同 owner，`composerDraft.addFile` 实时复核；正式设计必须保留。局部新增的 request epoch 解决的是同一实例内 refresh 重叠、A 文件慢/B 文件快、关闭后异步完成；每次 effect setup 创建 fresh controller 以支持 StrictMode。selected row/path 的点击使用呈现时精确 path，deferred filter 不能以新 index 解释旧行。rootKey 及 fileOwnerKey 是浏览器交互归属，不是安全目录 binding；Server 仍负责真正 workspace 访问。

### 11.5 Benchmark 的 durable 工具事实和证据分类

当前历史 scenario 是合成 HTTP read model，只有新增 live execution 经真实 ExecutionService；不能将整份5000条历史说成真实模型/Session存储产生。当前 fixture 动态 Turn 映射将 toolCalls/failedToolCalls/toolResults 写死为0/0/[]，只适用于原 text-only producer。新增 tools stream 不能只 yield transient events：必须追加匹配的 durable Tool call/result/Step事实，并从投影输出准确 Turn summary，终态重载后逐一检查完整 identity、状态、参数、结果与顺序。否则现场看见工具而 reconciliation 后丢失，benchmark应失败。

新 baseline 在先行主题合并之后采集，报告 head/dirty/fixture hash/API mode。原历史数值保留，不重新标成当前基线。文件树50k仍是合成现有HTTP形状与生产组件压力实验，不证明磁盘枚举或安全 capture速度。固定数据/字节/动作、raw samples和失败样本均保留，最终 DOM/输入/锚点主张仅由实际新运行支持。

### 11.6 实施所有权

两个独立主题 PR 仍按先会话后 explorer。每个 PR 开始 root 先冻结 DTO无变化的 presentation types、目标 identity 与测试fixture合同。PR1 可并行：A仅负责 pure conversation-model/keys及单元测试；B仅负责 performance fixture/probe schema及确定性测试；root串行负责 App/controller/store接线和 durable overlay合同。之后 A可负责 ToolStep/row受控lazy正文，B可负责 timeline/viewport与browser像素验证，但共享 App、CSS、exports、manifest和lock由root串行。文件撤销 controller先由root冻结接口再交 row实现者消费。审查者不改实现。PR2中 model/range与fixture可并行，panel/PanelContext/App仅一个所有者；保持原 keyed owner，避免为性能改造新权限层。
