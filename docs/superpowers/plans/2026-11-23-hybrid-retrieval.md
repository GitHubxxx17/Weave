# Weave 混合检索实施计划

> **For agentic workers:** Use `superpowers:subagent-driven-development` to execute the reviewed tasks. The parent owns shared exports/manifests, integration, commits and PR workflow; workers do not commit or switch branches.

**Goal:** 提供默认离线可用的项目代码与已审阅记忆检索，并以明确逐操作授权支持真实 embedding 混合检索。

**Architecture:** 新 retrieval leaf 依赖 Protocol；Runtime 经结构端口编排 authority、capture、job 和查询；Server 装配 store、Memory/Project 与独立 LLM embedding client；Studio 仅走 HTTP。

**Tech Stack:** TypeScript strict ESM、Zod、Node24.4 内置 SQLite/FTS5、现有 React/Vitest；无新增三方依赖。

**Spec:** `docs/superpowers/specs/2026-11-23-hybrid-retrieval-design.md`，§12/§13 最终合同收敛上文宽泛描述。

## Global Constraints

- 基线为最新 origin/main 的 `8535429`；单主题分支 `feat/hybrid-retrieval`，独立 PR，CI 全绿后 squash。
- 只含项目安全捕获代码与显式至多48个 current user-reviewed 项目 memory refs；无聊天、个人 memory、附件索引。
- `protocol -> retrieval -> server`；Runtime 不导入 retrieval/memory；Studio 不导入内部包或 Node。
- 本地 lexical 完整可用；真实 closed OpenAI embedding512维，独立 key；index/query 分别 explicit egress，无假向量和隐藏重试。
- 最多2000文件/16MiB捕获/20000chunks/40MiB chunk text；HTTP POST16KiB、完整响应24KiB、shared Pipeline/Runner实际双预算。
- durable job facts append-only；短同步guard/事务；后台job独立生命期；unknown outcome保留资源和capacity，restart不发网。
- 测试在各包test目录；行为先RED再GREEN；外部输入Zod校验；独立审查。

## Execution checklist

- [x] Task1 合同/设计/ADR/包边界。
- [x] Task2 Protocol/leaf结构端口。
- [x] Task3 确定性chunks/词法。
- [x] Task4 SQLite/FTS5/receipts/generations。
- [x] Task5 安全capture与@file回归。
- [x] Task6 独立embedding适配器。
- [x] Task7 vector worker/RRF。
- [x] Task8 Runtime service/jobs。
- [x] Task9 Pipeline工具/egress。
- [x] Task10 Server/HTTP/lifecycle。
- [x] Task11 Studio Search。
- [x] Task12 本地集成/浏览器/质量/规模/独立审查。
- [ ] PR 的完整 CI 通过后 squash merge。

本地完整 `pnpm check` 于 2026-11-24 通过；浏览器、固定质量集、规模测量和
真实 provider 未执行的证据边界见
[验证报告](../../verification/2026-11-24-hybrid-retrieval.md)。最终独立审查发现并
修复 Agent uncertain acceptance 确认 absent 后未释放旧预览的问题，新增测试先复现
`retrieval-busy` 再验证 exact retry 创建唯一 durable job。

## Task 1 — 合同、来源与包方向先行

重读最新AGENTS/foundation/ADR0001/foundation spec、长期记忆和multi-agent最终接口，核对干净工作区，不复用已合并feature branch。把设计和此计划落入`docs/superpowers/{specs,plans}/2026-11-23-hybrid-retrieval-*.md`（按实际日期），增加未占用编号的ADR。

更新foundation Product references、索引代次/job/authority vs derived data/egress图、AGENTS边界：`protocol -> retrieval -> server`，Runtime端口编排，Server具体adapter；LLM独立embedding client保持既有方向。不将新package塞入Session或Workspace，不让Runtime导入检索concrete store。

记录决定：只包含项目代码+显式选择至多48个exact current user-reviewed项目memory refs、无全聊索引；lexical默认、closed real provider、无hash vectors；exact preview授权与paged正文审查；opaque host egress permit由Pipeline获准execute admission产生、不能靠JSON IDs假定approved；query和index两个不同egress操作；旧active代持续可用，取消不发布部分代。文件捕获是cooperative checks，不承诺原子全项目快照或OS sandbox。复用multi-agent Project-folder authority/folderRevision/root pins与可信execution provenance，Memory beforeMemoryCommit同步fence port，不另造可被JSON选中的权限角色。

在 Task1 冻结设计 §12 的所有端口与所有权；现有 `ProjectFolderAuthority` 仅 Session入口、Memory caller仅WeakMap bridge、scope级epoch和可用预算都已真实核对，禁止按 plain view/JSON 接线。验证设计review无关键未知；所有来源为实际读取的固定官方代码/docs，403/timeout/未运行liveprovider如实注明。

## Task 2 — Protocol与新检索叶子包

新增`packages/protocol/src/retrieval.ts` strict Zod DTO：source/ref、generation identity、preview token+digest/paged metadata+text、explicit memoryRefs<=48、job accepted/status/terminal/committed receipt、mode/filter、bounded query/hits/citations、safe errors/capabilities。schema禁止客户端提交原始vectors/任意absolute root/provider URL。冻结build `{requestId,previewId,mode,manifestDigest}`、Manifest显式canonical normalized selection、bounded lexicalMetadata.tags，以及capture coverage counters与leaf prepared metrics的不同shape；Runtime唯一合成完整counts（设计§12.7）。

新增`packages/retrieval/{package.json,tsconfig.json,src/index.ts,src/types.ts,test/}`，只依赖protocol+已有Zod。更新root ESLint workspace names/layer、Server manifest、lock；Runtime只依赖既有protocol/LLM。新增内部包的query/index/store cohesion理由在ADR。

先写`packages/protocol/test/retrieval.test.ts`：unknown keys拒绝；mode/source union；UTF-8/数量/query/UUID/digest/line边界；project/path/ref不能混淆；结果实际mode不可冒充；query512 codepoints/2048bytes、非法controls/surrogate拒绝、完整JSON最坏escaping预算。补build缺mode拒绝、新preview mode不符拒绝、same bytes但不同selection的canonical digest不同、capture time变化不改digest、Memory tags bounds/metadata与ref一致；测试schema再导出。

验证protocol+retrieval定向typecheck/lint/test和boundary rule negative fixture。

## Task 3 — 确定性分块与词法tokens

新增`packages/retrieval/src/{chunking,lexical-query}.ts`，先写`test/{chunking,lexical-query}.test.ts`：

- <=2048UTF-8bytes、<=80行、<=8行且256bytes overlap；CRLF、emoji、中文、无换行、长单行、空文件；source exact hash不因search normalization变化。
- deterministic chunk ID/version/line+fragment，重复chunk不碰撞；source key隔离。
- identifier camel/snake/dot拆词，Han单字+bigram，NFKC+locale-independent toLowerCase search normalization（带tokenizerVersion，不冒称完整casefold）；最多32term/query512 codepoints、2048 bytes。
- 引号、FTS运算符、括号、SQL片段均作为literal，不抛原生MATCH语法；无raw query interpolation。

实现纯函数并经`RetrievalIndexPort.prepareDocuments`由Server注入Runtime，Runtime不反向import leaf。返回只含sources/chunks/versions与`RetrievalPreparedMetrics`，不能从documents猜discovered/selected/skipped；全部输入整体准备，chunk/aggregate超限拒绝，不静默丢source。title/path/bounded lexicalMetadata.tags只参与FTS辅助terms，embedding exact chunk text只来自body。保留原文本与line provenance；不得先写实现再用快照仅镜像返回值，fixture预先声明想检出的符号/中文代码段。

## Task 4 — SQLite FTS5、代次与job日志

新增`packages/retrieval/src/{sqlite-store,projection,errors}.ts`及`test/sqlite-store.test.ts`。单独sidecar自有migration；data WAL前持独立rollback owner BEGIN EXCLUSIVE lease，规范化/检查data+owner身份。第二真实进程busy、SIGKILL恢复、partial startup branded cleanup和data→owner关闭顺序按设计 §12.4 测试。启动实际FTS5probe，只有精确FTS缺失属于capability unavailable但不让整个Server失败；owner/schema/identity错误不能伪装FTS unavailable。

权威job events只追加；generation/doc/chunk/FTS/vector/current是派生。SQLite事务原子publish+completed事实，requestId/digest和权威accepted receipt幂等，active+previous+1 staging/retired最多3份；reader lease使GC不删正在读的代，超cap明确busy。独立read/query连接与write连接按SQLite忙策略明确；不让worker持有连接阻止shutdown/GC而未追踪。

先测：

1. lexical build→publish→close/reopen查询，BM25升序及stabletie；source/path filters在candidate前应用。
2. staging失败/取消/崩溃不替换旧active；重启unfinished job追加interrupted，无capture bytes也不自动恢复/网络；derived generation缺失/损坏返回unavailable，不靠job事实重新embed。
3. publish事务中途故障回滚pointer+terminal；COMMIT-then-throw exact readback认领原job/terminal；readback uncertain保留reservation/fence不重复producer；requestId重试samejob，改payload冲突。
4. 权威eventUPDATE/DELETE被拒，projection重建一致；malformed row/newerversion故障明确。
5. 各project/folderRevision/root/generation互不混；每generation独立FTS表/统计，添加他项目documents不能改变本项目BM25/ranks；source/path SQL filter在top50前，IDF明确固定本generation；GC不删active/previous或leased代，release/reader cleanup后才回收，第4份前busy。
6. 真实Node最低版本/CI FTS5创建，包build后查询功能；缺FTS5注入故障只禁retrieval。

FTS表保存title/path/body/terms，SQL值全部绑定参数；per-generation table标识符只由strict host UUID编码生成，不从输入插值。没有向量仍是完整可用lexicalstore，不生成假vector列。

## Task 5 — 安全工作区capture窄重构

在Runtime提取`workspace-text-capture.ts`中立有界helper；`workspace-file-capture.ts`保持外部@file契约/错误code不变。公开窄workspace listing接口复用`workspace-file-index.ts`，不跨包相对import，不把整个private模块全导出。

先跑并保留所有现有@file/capture/undo/grep测试。新增`packages/runtime/test/retrieval-capture.test.ts`覆盖：

- 正常git tracked/untracked、gitignore与walk fallback；相对include/excludeprefix、builtins、.env/privatekey/credential排除。
- symlink leaf/parent、hardlink、FIFO/directory/device、rootreplacement、文件open/read期间替换、nlink变化、cancel、非UTF-8/NUL/binary安全拒绝。
- root canonical+objectidentity+folderRevision pin、目录A→B→A不可复用旧token；unsafe target不泄到错误/preview。
- 2000files+48 explicit memory refs/256KiB perfile/16MiB total/2048sources/20000chunks且chunktext总40MiB边界；skipreason/partialcoverage明确。capture describe给discoveredFiles/selectedFiles/skippedFiles：selected是selection+source-cap准入后、safety/size读取前计数，发现=捕获+跳过；skip详情最多2000示例，裁剪不改完整aggregate/reason counts，detail/discovery truncated flags分开。
- 两项capture并发受mutationqueue、metadata recheck、旧@file<=8引用、64KiB/单文件和256KiB batch仍限制，无归约扩大。

首版不新增.weaveignore parser；include/exclude相对prefix+gitignore+builtins+versioned secret-path规则，无绕过系统排除。capture/重验最多16MiB、逐批合作queue，gate不持有审批或网络；限制通过sharedconstants与schema引用避免drift。失效索引的新鲜度read也走同一安全primitive；不得用gitlisting当安全读证明。

## Task 6 — 真embedding adapter（独立chat client）

新增`packages/llm/src/{embedding-types,openai-embedding}.ts`并导出。Serverenv配置工厂只读取`WEAVE_EMBEDDING_PROVIDER=openai`+独立key（1..512 printable ASCII，拒空白/controls，不保留process.env）；public vector identity无key/keyhash，private epoch绑定preview/permit；固定URL/model/dimensions512/float，redirect:error。无SDK/npm依赖，无任意baseURL、chatkeyfallback。

先写`packages/llm/test/openai-embedding.test.ts`，注入test transport不打公网：

- 精确endpoint/header/body、batch16/input2048bytes/实际JSON request40KiB；控制字符/quotes/backslash导致escaping超量时拆小batch、不截chunk；key不进入日志/errors，query512多字节仍不超过input2048。
- streaming response2MiB上限，timeout30s、abort、nonJSON/HTTP401/429/network安全错误；无自动retry/redirect。
- count/index唯一且complete，固定responsemodel/dim512、finite floats、zero/overflow norm、Float32 normalize可复现；scrambleddata按index正确还原，不靠数组顺序。
- query与documentbatch是explicit相同embedding接口，不发chat/completions；2jobs+queries共用全局2请求semaphore，每job顺序batch1请求，等待受原deadline/abort；无自动retry、cache或备用chatkey。

fixture向量明确手写且测试用，不提供生产hash/randomprovider。adapter说明只证明协议，不宣称live语义质量/计费已测。

## Task 7 — 向量worker与RRF

新增`packages/retrieval/src/{vector-search,vector-worker,rrf}.ts`及相应test。queryvector+config校验后worker持exact generation read lease在指定project/folderRevision/root/activegeneration/sourcefilters内exactcosine扫描最多20kunitvectors；使用只读连接/限定SQL或一次受限snapshot，禁止每query无限复制整个多project库。

预先手算fixture至少包括：两个ranker顺序相反、只命中一个通道、cosine负数、tie、filter排除原top1、同源重叠chunks、stale后候选不足。断言`sum1/(60+rank)` rank1，结果不是BM25+cosine加总，过滤在rank前，不让其他project占窗口。纯lexical不参与空RRF。

测试worker source与dist URL、timeout/cancel terminate且settle一次、readconnection关闭、错误不挂promise、内存/20k上限。记录20kchunk fixture冷暖p50/p95、峰值RSS、硬件/Node，避免未测性能承诺；本地query/source全局4、5s deadline、semantic总35s（网络30s+本地5s）和实际cleanup有测试。

## Task 8 — Runtime RetrievalService、预览与后台jobs

新增`packages/runtime/src/{retrieval-types,retrieval-service,retrieval-tools}.ts`和可能的capturehelper文件。ports由protocol DTO描述，Server注入store/memorysource/embedding/projectresolver/clock。Runtime不importleafconcrete。

实现prepareBuild→consumeexactpreview→acceptedjob→backgroundproducer→atomicpublish；预览TTL5min、全局2/每项目1，source text受16MiB/chunktext含overlap40MiB上限，按所有权转移不复制全文，拒绝/expire/abort/stop释放。绑定可信execution/session/turn/toolCall与opaque invocation+inputdigest和exactmanifest；execute不能替换批准内容。无summaryautoapproval时lexical在executeprepare，hybrid由hostpolicyforceask确保summary必运行。

先写`packages/runtime/test/retrieval-service.test.ts`：

- 唯一project/folderRevision/rootpin、folderchange A→B→A/rootreplacement fence+cancel/invalidate；不能指定他project，gates不包capture/Approval/network/drain。
- source/preview/memoryreview/access settingRevision/config epoch在Approval期间变化拒绝；accept前重读全capture<=16MiB，发布前重验source digests；冻结job只发capturedbytes，源变更failed且旧active仍在。Manifest显式保存canonical selection，leaf从完整manifest可重算hash，same bytes/different bound filters产生不同digest。
- beforeMemoryCommit同步epoch/fence、锁外abort；在batch1后删除/修订/unreview/disable对应memory，batch2必须0新调用，in-flight合作abort不声称未计费；失败mutation也不复活旧permit；publish前再次epoch检查。
- denied/expired/cancelledpreview无网络；token一次消费、wrongproject/invocation拒绝；先authority→exact request receipt（同host caller/Agent invocation，host生成tool requestId；Agent digest只含normalized tool intent，accepted另存exact manifestDigest；UI digest含payload.mode与manifestDigest但不含preview token/time，新preview核对mode；响应丢失后preview过期及真实close/reopen均能先算exact key返回原receipt）→新preview/CAS，响应丢失即使preview失效也找回samejob，revokedcaller不泄露旧结果。
- job1/project、global2、busy；accepted后HTTP/工具断连仍生产，explicitcancel或root/memory/config撤销/shutdown才停止；cancel race不晚publish；shutdowncancel/drain先于storeclose。
- 每phaseprogresslive，不写Session百分比；durableaccepted/terminal一次，权威accepted重建receipt；accepted/started/finished commit-then-throw/reconcile，uncertain不启动重复producer、不释放容量；restartinterrupted不重发。
- config/mode/incompletegeneration不能semantic；embedding失败不默默变lexical，不发布部分vectors。Memory tag-only query可命中FTS，adapter只收到exact body chunks；metadata跟exact ref/manifest绑定。
- Runtime唯一合成capture coverage+prepared metrics，equal documents但不同发现/跳过数量的preview保留不同正确counts，skip示例裁剪不改aggregate；leaf chunk-limit整体拒绝无局部成功代。
- 查询候选安全重读digest/root；memorydelete/unreview/accessdisable立即省略；<=20files/5MiBvalidation、oversample<=50、hits<=10/excerpt1200/total24KiB；工具另符合effective Pipeline bytes和Runner token双预算（设计 §12.6）。
- query不持久存进retrieval日志（AgentSession原有args不改）；sourcecitationexactref可验证；4个reader上限、5s/35s截止、lease finally cleanup，3代cap/GC/backpressure；shutdown有未清理writer/unknownappend时保留Store与bounded capture/reservation供重试（不因普通preview TTL丢失），不用Promise.race丢工作。

## Task 9 — Pipeline工具与egress policy组合

通过现有kernel注册`build_project_index`、status/cancel、`search_project`、`semantic_search_project`，不要新建私有toolrunner或ApprovalBroker。

build/cancel非readOnly；lexical/status只读；semanticreadOnly但protected，`retrieval.semantic_query`summary显示精确query/destination。Serverhostpolicy对hybridbuild+semanticquery强制ask，deny优先，与pluginpolicies组合更严格，yolo也不隐式外发。Memory项目访问和subagentcapabilities实时检验：首版所有child（含workspace）只允许localsearch/status，在最终Provider schema与Pipeline lookup取父exactauthority子集，并由service复核origin和pinnedroot；不允许index/cancel/semantic。正常工具结果按现有Runnerdurablelogging再给模型。

先写`packages/runtime/test/retrieval-tools.test.ts`和`apps/server/test/retrieval-policy.test.ts`：所有mode/policy矩阵；ask/trust/yolo、forcedask/deny、Approval拒绝与cancel无网；pluginhook不能改变operation/invocation/root借preview；read-onlyrun排build/cancel；subagent不能升级；safeerrors只对exact classified Retrieval定义的品牌错误透传，最坏escaping完整JSON同时<=min(24KiB,effective Pipeline bytes)及effective Runner token budget，分条/截excerpt后仍合法JSON，最小receipt预算effect前拒绝。以1900byte/600token真实Pipeline/Runner回归证明无单结果截断。另测试host-only execution admission marker只在强制ask实际approved、execute前签发；summary、JSON approved=true、假IDs、plugin around变参都不能产生/移用egress permit；不公开SDK通用审批凭据。accepted时permit只转为job-owned frozen-manifest grant，后续batch核验grant，不能Pipeline正常finally abort误撤销，也不能重用到其他bytes。

特别测试Pipelinefinally总会aborttoolcontext：未consumepreview释放，acceptedjob不因工具正常返回后的signalabort被误取消。job拥有独立controller，可由explicitcancel/shutdown/root/memory/config invalidation终止。

## Task 10 — Server组合、HTTP与生命周期

新增`apps/server/src/{retrieval-composition,retrieval-api,retrieval-guard,embedding-config}.ts`；复用memoryPR的唯一projectresolver，memorysourceadapter通过MemoryService host reviewed-source port读取/验证明确选择<=48个current user-reviewed项目refs/access settingRevision，不能直接读store绕过Service。补 host-only captureAccess/assertAccessCurrentSync exact-object证据：disabled在ranker前过滤memory，逐候选唯一record refs:[ref]捕获以省略单条stale，最终同步复验所有capture。Memory组合新增beforeMemoryCommit option并在Main预先建同步fanout，按整个Project scope epoch保守fence所有memory-consuming工作（不是只看同memoryId），排队到锁外abort，不反向取检索gate。ProjectFolderAuthority新增captureProject/checkpointProject/withProjectAuthority用于无Session的Studio项目页；Agent复用membership marker+真实durable执行事实+retrieval专用caller bridge，child复用原task pinned binding。主入口、app、kernel、shutdown仅所需接线；rootOnlyTool predicate合并Memory+Retrieval而非覆盖；retrieval fence/drain/close先于Memory和依赖，incomplete/partial startup保留同一branded cleanup资源。

guard在CORS前，所有GET/POST需localHost/Origin/Sec-Fetch-Site、no-store，POSTJSONstreambody<=16KiB。routescapabilities/preview/build/status/cancel/query/source只调Runtime服务。backgroundstatus采用polling，不为首轮重造SSE。build输入`{requestId,previewId,mode,manifestDigest}`：由payload.mode计算exact requestDigest，先查receipt，再仅对新mutation核对preview.mode；preview过期/重启后的响应丢失仍可exactretry；preview metadata<=50sources/页和<=24KiB完整JSON，preview exact text<=8KiB/页并按JSON缩量，不dump16MiB或暴露任意路径，Approval summary<=12KiB并给详情入口；jobs<=20 metadata/页、source open<=8KiB验证窗口/<=24KiBJSON。

`apps/server/test/retrieval-api.test.ts`用临时目录、真实SQLite、actualRuntime：

1. 无key端到端构建TS+中文项目→query→sourceopen→restartquery；另一project不可见；build响应丢失后preview过期及close/reopen用原含mode body重试返回same receipt、零新capture/network/producer，改mode/manifest冲突。
2. reviewedmemory命中→delete/unreview/accessoff即不命中，原sourcebody不返回；不索引聊天/附件。
3. invalidbody/Host/Origin/crosssite、无contentlengthoversize、未知provider/pathescape/vectorinjection拒绝。
4. sourceopen精确root/digest不符stale，不把新文本伪装旧citation；safe currentopen需explicit。
5. hybridfixturepreview→Approval→background→complete→knownRRFranking；query需单独egress批准；capture/embeddingcalls按授权bytes对照。
6. disconnect/requestId恢复status、cancel/publish竞态、startupfailure、shutdown incomplete/retry、activegeneration lease/3代GC顺序；per-batch memory撤销0后续网络；metadata/text分页和最坏JSON；坏derived索引明确unavailable。

不使用真实key或公网作为CI必要条件，不把envsecret输出到测试failure。

## Task 11 — Studio Search与构建管理

新增`apps/studio/src/features/retrieval/{types,client,SearchPage,BuildPreview,JobStatus,ResultList}.ts(x)`及styles，App只nav/projectwiring。浏览器独立runtimevalidator，不import@weave。

UI必须实际可用：sources/pathfilters、localdefault、明确hybrid能力/目的地、explicitbuildpreview分页可展开exact capturetext/skipreasons与<=48 reviewed-memory选择器、cancel/status、旧active仍可查、sourcecitation跳文件/Memory精确ref、stale/empty/busy/unconfigured/failure恢复。poll前台1s，hidden/unmount清timer；job继续而非viewunsubscribe取消。切project/query抛弃旧response，sourceopen先服务验证。

`apps/studio/test/retrieval-client.test.ts`、`retrieval-page.test.tsx`覆盖：无keylocal可用、semantic键入/debounce/filter/reconnect无网、按钮“发送查询并语义搜索”/表单Enter发送快照query且持续显示目的地，改input不换旧request字节、previewchanged需重新确认、cancel、rootchanged、sourcefilter、latequery不会覆盖、malformeddto拒绝、error/retry保留input、keyboard/focus/label、safeMarkdown/filelink。

用当前browser技能实际验收：选择项目→localbuild→status→querysymbol/中文→sourceopen→编辑源后stale→rebuild→cancelhybridfixture（仅开发测试配置）→切项目。记录artifact；不要宣称fixture是liveprovider。真实provider验收沿用用户已授权的工作顺序，在已提供key和确切语料/查询外发动作的环境执行，并记录provider/model/内容范围与结果，不保存key。

## Task 12 — 完整验收、质量限制与review

用户文档和PR说明写明：只索引选定项目代码/当前reviewedmemory；localdefault；genuineembedding需独立配置与逐操作egress；secretpath排除非内容秘密检测；删除历史/旧derivedtext不宣称erase；root/citationstale；20kchunkexactscan上限；无hiddenresume/reembed。

定向behavior测试通过后运行`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`或`pnpm check`完整一次。确认build后的worker、FTS5与packagedruntime smoke不只Vitestsource有效。存在新修改再跑受影响checks。

固定至少24条ground-truth fixture（8 identifier/path+8中文+4 memory+4同名/跨scope），逐条标source/line/ref，local top5 source recall>=20/24作为该fixture门槛；scope泄漏、deleted/unreviewed memory、错误citation均0。记录20kchunk fixture build、query p50/p95、峰值RSS、cancel-to-cleanup和机器/Node信息，不能拿手写vector推导live语义提升。

独立review至少覆盖：captureescape/rootrace限制、previewapprovalbytebinding、policyforceask组合、jobcancel/publish/shutdown、FTS参数与pre-filter、realvectors/configspace/RRF、sourcefreshness、Studioactualmode与staleidentity。修复后同步设计/ADR/测试，沿用既有授权中文commit（例`feat: 增加项目代码混合检索`）、push/PR、CI、squash。没有liveprovider证据必须明确标为未执行，不以fakevectors补验收。

## 交付验收矩阵

| 目标 | 必要证据 |
| --- | --- |
| 有用的项目代码检索 | 无key真实临时workspace+FTS5+TS/中文/identifier命中+source行范围 |
| 真正hybrid | 手算显式fixturevectors+cosine+独立rank+RRF，并标fixture；配置adapter合同固定官方来源 |
| egress可控 | previewexactbytes+index/query分别授权+deny/cancel/yolo forceask无绕过 |
| 本地来源可信 | rootpin/nosymlink/hardlink+bounds+digestfreshness+memoryreview当前校验 |
| 生命周期完整 | 权威receipts/uncertain fence、restartinterrupted、旧active保留、cancel不publish、reader lease/3代cap、shutdown incomplete可重试 |
| 边界正确 | protocol叶子DAG、Runtimeports、薄HTTP、Pipeline、Studio无内部包 |
| 用户可管理 | 六条实际Search链路、明确semantic发送动作、paged exact preview、stale/conflict/late-response测试 |
| 可衡量质量 | 24条固定ground truth/top5>=20/24，安全错误0，20kchunk性能实测且标机器；liveprovider未执行如实列出 |


## 实施调度与任务归属（冻结接口后执行）

1. 根：Task1+Task2协议/结构端口/依赖脚手架，发布 `RetrievalIndexPort`、prepared chunks、exact serializer/batchdescriptor、safeerror预算及Project/Memoryhost port；只这一步涉及共享exports/manifest/lock。
2. 并行A：Task3+Task4+Task7（retrieval leaf与测试，严格不碰Runtime/Main）；并行B：Task6（LLMadapter与purebatchpacker）；并行C：Task5（Runtimecapture窄重构，旧@file行为不变）。根串行执行Task8+Task9的Service/attempt/Pipeline与Serverhostpolicy骨架。
3. A先发布Store结构、B先发布adapter/packer结构，根完成真实适配与Task10。C完成capture后接Service；并行agent完成任务后可转Task11 Studio功能，独占features/tests，App由根接线。
4. Task12真实集成/浏览器/规模质量测量和独立review；review不可用未来实现假设替代源码。所有实现分支仍是同一个独立主题PR，不在并行agent内自行commit/merge。

### 新增必需回归（合并到对应Task）

- Project-only UI无Session也能capture真实Project binding；unknown project/missingfolder拒绝；folder A→B→A、external root replace和invalid direct binding均拒绝旧preview/citation；Task现有Session入口不变。
- Manifest携带canonical selection可独立重算，equal bytes/different filters不同digest；capture counters与prepared metrics不同shape、Runtime唯一合成，skip detail裁剪保持aggregate，chunk超限整体拒绝；bounded Memory tags可单独lexical命中而不进入embedding input。
- Memory exact owner captures不能clone或JSON构造；disabled pre-ranker排除、单stale memory仅省略该条、无关同scope mutation保守失效、回滚不复活capture、exact replay不额外fence；beforeMemoryCommit consumer不反向取锁。
- Agent summary不能直接调用现有 memoryCallerAuthority，也不能借execute context；新retrieval branding+durablefacts正确；child原pinnedroot不被freshcapture换成新folder；MemoryrootOnly分类仍保留。
- Agent around.next同一normalizedintent在文件变化/新previewtime后只返回原jobreceipt，改normalizedargs或跨project冲突；uncertain accepted readback不重复producer；UI同requestId换mode/manifest冲突，原body在preview过期/重启后仍先exact replay。
- 最小build/cancelreceipt预算不足零effect；escapedUnicode搜索经真实Pipeline1900byte/Runner600token成功结果完整JSON；summary/execute异形pluginerror不泄露rawcause。
- Retrieval partialstartup data.close失败保owner，retry观察isOpen不重新迁移；shutdownincomplete保Memory+Project+Session依赖；FTS缺失与ownerbusy错误分开。


实施裁定（2026-11-23）：保留可选 `selectedPaths`，domain最多2000个互异相对文件路径，支持逐文件缩小语料。实际HTTP POST仍以完整JSON UTF-8 <=16384bytes为更早硬界；Studio发送前计算exact body字节，超限明确显示“所选路径过长，请用目录prefix缩小范围”，不得截断列表或扩大到all files。较长workspace路径仍完整保存在source.path/sourceKey作为身份；title只是<=160 codepoints/640 UTF-8bytes的独立display label，可安全截短basename，绝不能用截短title生成source identity、chunkId、digest或文件打开路径。协议实现先写RED schema行为测试，完整manifest/event跨字段验证在实现期补齐。
