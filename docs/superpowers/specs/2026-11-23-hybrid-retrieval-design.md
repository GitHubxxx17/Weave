# Weave 项目代码与记忆的混合检索设计

日期：2026-11-23。实施基线：长期记忆 PR #109 合并提交 `8535429730a21e6ede102022d3f9d1d52da18852`，包含 Multi Agent PR #108。检索合同先于实现落库；本主题使用从最新 `origin/main` 创建的独立 `feat/hybrid-retrieval` 分支。本轮必须交付有用的项目代码检索，不能只搜索记忆或用 hash 伪造语义向量。

## 1. 用户可见结果

用户在项目 Search 页面选择 workspace / reviewed memory 来源，明确构建本地索引，查看进度、取消任务、看到索引时间和状态，然后查询真实代码片段或已审阅记忆。结果带文件相对路径与行范围，或精确 memory ID/revision，附源摘要、索引代次和新鲜度。没有 embedding 配置时，词法检索仍可完整使用。用户明确配置并选择真实 embedding 服务后，才开放向量 + 词法 RRF 混合检索。

Agent 使用同一 Runtime 检索服务与共享 Pipeline。索引构建是可观察后台任务；语义索引和语义查询的外发内容与目标服务要有明确授权。没有隐式后台重建、自动学习、隐藏 embedding 调用或把完整索引灌入 prompt。

语料仅包括：该项目安全捕获的 UTF-8 文本/代码文件，以及长期记忆服务提供的当前 `user-reviewed` 版本。排除整个聊天、附件、工具结果、网页、其他项目、用户全局记忆（首版不纳入项目检索）。memory 本身仍可通过独立 Memory 页面/工具查阅。

## 2. 现状与新边界

现有 `workspace-search-tools.ts` 的 glob/grep 是按需扫描，无持久化 FTS/embedding。`workspace-file-index.ts` 用 git tracked+untracked/gitignore 清单，失败可 walk；列出名字不是已安全读到内容。`workspace-file-capture.ts` 已具备 root identity、路径/metadata 前后检查、拒绝 symlink/hardlink、bounded UTF-8 捕获，但绑定 @file 的 <=8个引用、64KiB/单文件和256KiB batch以及 execution error code，不宜直接当全项目索引 API。

新增 `@weave/retrieval` 叶子包，依赖仅 protocol/Zod，使用内置 SQLite FTS5 保存派生索引、管理代次、纯 chunk/tokenization/ranking、受限向量计算 worker。它不读 Workspace、不决定项目授权、不调用网络、不导入 memory/runtime/session/server。Store 接受已校验 captured documents；source 是 provider-neutral DTO。leaf只对派生storage/query负责，job状态规则与授权在Runtime；leaf事务port原子写accepted/terminal facts与derived pointer，不能在leaf再起第二个producer。

Runtime 定义 `RetrievalIndexPort`、`RetrievalMemorySourcePort`、`EmbeddingClientPort`、`RetrievalProjectResolver`（具体端口及与已实现源码的接线见 §12），拥有 `RetrievalService`、安全 Workspace capture、build job生产、查询编排和工具。Server 组合具体 retrieval store、memory-current adapter、项目根 resolver、embedding client和独立 lifecycle；Runtime 不导入 retrieval/memory concrete packages。真实 embedding adapter 放 `@weave/llm`，与 chat client 分开，不增加 SDK依赖。

设计先更新 foundation/ADR/AGENTS/ESLint，再实现。DAG 增加 `protocol -> retrieval -> server`；`protocol -> llm -> runtime`现有方向保留；Server adapter通过MemoryService的opaque host reviewed-source authority获取/验证current refs与access settingRevision，而不是直接绕过service读表；通过同一服务的beforeMemoryCommit port同步fence，再经端口交Runtime。Studio仍无内部包/Node导入。新内部包的理由是完整、可离线测试的query/index/store生命周期，避免Server变成搜索引擎。

## 3. 项目与来源身份

- 每次 prepare/build/query绑定host解析的project UUID、durable folderRevision、canonical root与root object identity，`rootIdentity=sha256(canonicalRoot + NUL + objectIdentity)`沿用现有中立helper。Agent不能传任意projectId/root/绝对路径。
- Session须唯一归属项目；歧义拒绝。复用多 Agent PR 的 Project-folder authority service、folderRevision 与 root-incarnation binding：每次成功设置目录（包括 A→B→A）都换 revision。folder mutation 在该 authority gate 内先 fence 旧 previews/jobs，原子保存 revision，锁外 abort/drain；根替换在安全读取时检测。旧 generation 标为 root-changed 不可查询，明确 rebuild；绝不动态把旧 job 改到新 root。项目 gate/索引 gate 不包 discovery/capture、审批、网络、worker 或 drain，也不从持 Store 锁的回调反向取 gate。
- file source key为 `workspace:<normalized POSIX relative path>`；禁止NUL、absolute、`.`/`..`、空段、Windows drive/UNC等绕过。memory source key为host memory ID，另带immutable project scope和current revision/digest。当前reviewed Memory的title与bounded `lexicalMetadata.tags`保留作FTS元数据（tags沿用Memory最多12个、每个40 codepoints/160 bytes）；workspace tags固定[]。tags随source summary进入manifest并受ref/manifest digest覆盖，但embedding和sourceSha256始终仅对应exact body bytes。
- 每个文件存完整source SHA256、rootIdentity、file object evidence、capture time；chunk存chunkerVersion、source key、source digest、起止行、chunk ordinal、精确UTF-8 text SHA256。memory存exact ref及review state。
- scope/source filters在候选生成和两个ranker之前执行，不先全局排名再按项目过滤。查询不能暴露别项目的总数、路径、分数或排名。

## 4. 文件清单、安全捕获与确定性分块

Runtime提取现有capture内部最小中立helper到`workspace-text-capture.ts`：保留root/path证据、nofollow/nonblock、regular file、nlink==1、metadata与root前后重检、fatal UTF-8 decode，参数化已校验的有限文件/batch上限。`captureWorkspaceFiles`仍用原protocol上限及execution错误映射；必须用现有@file行为测试防回归。不能把旧helper简单放宽到任意巨量，也不复制较弱的fs.readFile。

文件发现复用git listing/walk的公开窄API。gitignore/built-in ignored names始终生效；排除`.env`/`.env.*`、`.git`、SSH/证书/私钥/credential常见路径与扩展、依赖/构建/缓存/锁/二进制输出。首版不新增 `.weaveignore` 解释器；使用用户选择的相对目录prefix include/exclude，不发明任意用户正则或复杂gitignore解释器。允许用户进一步缩小范围，不能解除系统secret exclusions。规则清单进入 versioned discoveryPolicy，fixture 锁定并在预览显示 exclusions/coverage；只降低常见泄漏风险，不保证识别文本中的全部秘密。embedding预览提供逐文件选择与正文审阅。git listing 只能证明发现行为，不能代替安全读取。

来源默认 workspace，用户可显式加入当前 user-reviewed 的项目 memory 并从分页选择器选择至多48个 exact refs；不隐式收录全部10000条或 user scope。Agent 使用 `memoryRefs?: MemoryRef[]` 显式传入至多48个、由先前search/read取得的 current reviewed项目ref；不是一个会隐式截取前48条的 include-all 布尔值。UI与Agent都列出 selected/omitted counts；超过48需缩小选择，不能静默截断。

限制固定且通过schema/代码导出：最多2000文件+48条memory，单文件<=256KiB，文件和memory完整捕获总<=16MiB，最多20000chunks且chunk text总<=40MiB（含overlap），manifest <=2048sources，预览TTL5min，最多全局2个预览、每项目1个（超限明确busy，不自动淘汰仍被用户查看的预览）；超限给明确skip/reason或拒绝，不静默声称完整。对大文件/无效UTF-8/二进制/NUL/symlink/hardlink/变更文件给计数和相对路径，不把unsafe target暴露。

分块是可复现的行优先算法：每chunk最多2048 UTF-8 bytes，最多80行，相邻至多8行且<=256bytes overlap；超长单行按Unicode codepoint安全切分并记录同一行+片段序号。空chunk不索引；换行与原文本保持，hash以确切原始UTF-8为准。路径/标题可做search metadata，不悄悄改写嵌入正文。测试锁定CRLF/emoji/中文/长行/空文件/边界，chunker版本进入索引身份。

capture是在Weave协作mutation队列内逐批完成，根身份及所读文件前后复查。它是有界捕获清单，不声称所有文件在同一个时刻的原子快照，也不声称防住任意外部进程在最后一次检查后的目录竞态。结果新鲜度另做验证。

## 5. 索引预览、授权与不可变输入

`prepareBuild`只做本地发现/捕获/分块，产生短命不可猜测previewId和不可变manifest（project/folderRevision/root、sources/chunks/digests、精确文本、排除原因、discovery/chunker/tokenizer版本、provider public identity、memory access settingRevision、预计input bytes/按实际JSON大小计算的调用数）。manifest显式携带`selection: RetrievalNormalizedSelection`（workspace enabled、include/exclude、可选selectedPaths、exact memoryRefs）。schema默认值应用后，include/exclude去重并按locale-independent codepoint序排序；selectedPaths与memoryRefs分别按路径和memoryId排序，保留selectedPaths缺省与[]之别。同一canonical selection用于Agent normalized intent与manifest hash。manifestDigest覆盖selection、规范化metadata（含title/tags）、精确chunk text digests与有序source/chunk列表，leaf仅凭manifest即可重算，不依赖Runtime隐含的filters。内容本身留在受限内存capture，不由客户端重新上传。预览显示本地持久化范围；hybrid额外显示外发到`api.openai.com`的确切chunk集合和模型。用户可查看源内容并缩小选择；选择改变生成新preview，不复用旧批准。

`startBuild`必须消费exact previewId+mode+manifestDigest+requestId。UI builds payload显式携带mode，Service不依赖preview即可构造完整requestDigest：先检查host caller/scope authority，再exact request replay，之后才检查新preview/capacity；新mutation另核对input.mode等于preview.mode。这样首次响应丢失后即使preview过期/Server重启也可查回same receipt，不猜测原mode；同request identity更换mode或manifest明确冲突。接受新 job 前以可取消的有界安全读重验所有 sources（最多16MiB），核对 folderRevision/root、current reviewed memory refs/access settingRevision、embedding private config epoch；任何变化返回 stale-preview，不能替换批准文本。重验在 gate 外执行，之后在短 admission gate 内核对未变 authority epochs 并写 accepted；不把文件队列/项目锁持有到用户审批或网络。外部文件系统残余竞态仍按 cooperative capture 限制说明。

授权后后台只处理冻结 bytes：文件之后变化不能换发新文本，发布前重检全部 source digests，变更任务为 stale-source failed 且保留旧 active；它已经发送过的旧批准 bytes 不能撤回。每个 embedding batch 在发请求前重检 project/root/folder epoch、job fence、config epoch，以及该批 memory 仍 current/reviewed/access enabled 且 exact ref 相同；memory edit/delete/unreview/disable 由 MemoryService 的host-only同步 `beforeMemoryCommit` invalidation port先递增epoch/fence相关previews/jobs（锁内只同步置fence，锁外abort，不反向拿job gate），取消尚未发出的批次；写失败也不复活旧permit。已在途 provider 请求仅能合作式 abort，不承诺未接收/未计费。memory changes 不自动 re-embed；publish gate 内再核对这些 epochs，避免失审阅内容重新发布。

本轮不在SQLite长期保留未消费预览；内存受上限控制，失效/拒绝/取消/停机清理。hybrid preview未获授权没有网络请求。capture与chunks分别受16MiB/40MiB byte上限约束，并按preview/job所有权转移不复制全量文本；最多2 previews+2 jobs受明确保留上限。由工具summary准备的preview绑定session/turn/toolCall/输入digest和Pipeline signal，finally abort时清理未消费preview；execute消费后所有权转交job。并发同名tool call不能互借preview。UI预览token绑定项目、trusted local caller和请求identity且一次消费，客户端不能提交自己构造的chunk文本取代捕获。preview捕获 bytes 不落 durable job log，Server restart 后 token 失效；accepted fact 也不意味着可以恢复这些 bytes 或自动重发。

Runtime egress permit只由host在精确Pipeline调用通过强制ask并进入execute，或可信local-user明确HTTP动作时分配，是不可序列化对象，绑定operation、scope、invocation/requestId、preview/query digest、destination/config epoch。summary不能分配permit，client/plugin JSON不能伪造；service在接受build或发semantic query前必须consume exact permit；成功accepted build将其转为job-owned、只覆盖冻结manifest的egress grant，后续每batch核验grant/fence而不重新消费invocation token。job持独立project-only pinnedbinding和controller，host已在accept时验证caller；accept之后不再要求原Pipeline invocation仍live（正常返回会关闭它），每批仍核验job grant和当前Project/root/Memory/config fence。原调用来源仅作durable provenance，不能借grant调用其他工具或更换bytes。正常Pipeline finally abort不能撤销已转交job的授权，也不赋予它外发其他bytes的权利。Tool around变更参数/operation/authority一律重新校验，不把正常tool.execute旁路做公开egress API。当前Pipeline没有这种凭据，这是本PR显式增加的host-only内部合同：在policy/approval完成、execute前，用不可伪造的invocation authority标记exact operation/inputDigest的execution admission；强制ask的retrieval operation只有实际approved才获标记。Runtime内部permit resolver消费该标记，不向Plugin SDK或JSON暴露审批凭据，不扩张Memory review权限，也不另建Broker。不得假设现有普通sessionId/turnId/toolCallId已经能证明审批。

工具：`build_project_index`（`mode:'lexical'|'hybrid'`，受限source/path filters）带`retrieval.index` high protected Approval；summary调用prepare，execute只消费该版本。现有Pipeline自动策略下不运行summary时，lexical execute可以本地prepare后立即消费。hybrid必须由Server host policy对该operation+mode返回`ask`，即使yolo也要求此次egress审批；与插件policy合成取更严结果，任何deny优先，不能覆盖成allow。不是新增第二Approval broker。配置embedding只是具备能力，不是对全部项目内容的永久外发许可。

预览metadata分页<=50 sources/页、完整JSON<=24KiB；exact source文本按previewId+sourceKey分页读取，每页text<=8KiB且完整JSON<=24KiB，无任意路径参数。全部capture保持不变；页面明确总数、排除和未查看数量，不强迫伪造“每字已读”。Agent Approval inputSummary只含mode、destination、计数、manifestDigest、previewId和受控详情入口，总JSON<=12KiB，不把16MiB capture塞进Broker/SSE；Studio专用详情视图用同一guarded preview服务审查准确内容。没有摘要即可冒充全部字节review的说法。

UI明确review manifest并点击“构建混合索引并发送以上内容”是本次具体人类授权，调用同一Runtime service而不再制造Agent Approval卡。可重新构建lexical模式而不发网。

## 6. 后台生命周期与SQLite

采用独立`${databaseFile}.retrieval.sqlite`，自有schema版本与FTS5 startup probe，不影响Session/memory migration。当前实际本机Node内置SQLite 3.50.2有ENABLE_FTS5；最低Node24.4及CI/打包runtime要实际验证。缺少FTS5时检索明确unavailable，Server与Memory其余功能仍启动，不回退假搜索。

权威 `retrieval_job_events` append-only：accepted/started/finished，schema version:1，包含jobId、requestId+requestDigest（包含host caller class/Agent invocation identity）、project/folderRevision/root、host caller与Agent exact execution/Turn/tool-call provenance、manifestDigest、source counts、mode、provider public identity、结果代次/有限错误。Agent build requestId由host从确切invocation生成，模型不能自报；UI UUID重试保持。accepted 保存稳定 receipt（jobId、accepted sequence、project和manifestDigest）；同requestId须同caller，不能跨invocation冒领，request索引可从权威事件重建。SQLite trigger拒绝权威event UPDATE/DELETE；不能记录API key、外部raw error/body。`job_current`是可重建投影；live progress/controllers/subscribers留内存，不把每个百分比写Session或权威日志。

派生表：generations、documents、chunks、FTS、embedding vectors、active_generation。每代immutable publication identity，包括chunker/tokenizer/discoveryPolicy版本、mode、folderRevision/root、manifestDigest、embedding `{provider, endpointId, model, dimensions, adapterVersion}`。派生rows允许删改/回收；权威job facts只追加。requestId+digest幂等；accepted后断连不重复构建。job_current/request receipts可重建，不代表派生index/vectors可凭job事实重建：若已发布derived generation缺失/损坏则明确 generation-unavailable，用户重新预览/授权构建，不能暗中网络恢复。active pointer只从已completed且完整校验通过的generation重建。

接受流程在任何背景I/O开始前持久追加 accepted 并 readback 确认；COMMIT-then-throw 通过 requestId exact reconciliation 取原 receipt。若无法判定 committed/absent，保留 admission reservation/preview ownership（该受限capture不因普通preview TTL清理，直到reconcile确认或受控shutdown/restart interruption）、返回 persistence-uncertain 并 fence 新 admission；既不重复起job也不虚报failed。所有 accepted background producer 由 host持有并 drain；lost response 通过requestId找回。started/finished同样 exact reconciliation，未知 terminal 期间保留容量，不能关Store或声称成功。

每项目1个活动job、全局2个；无隐式队列（busy明确409），进度字段phase/discovered/captured/chunks/embedded而非虚构总百分比。状态 `accepted -> running -> completed|failed|cancelled|interrupted`，cancel请求进入live cancelling，终态一次。进程重启将未终结任务追加interrupted，不自动续跑或重发embedding；明确用户重试获得新job/授权。

新代写staging，不影响旧active。完成向量/FTS/metadata校验后一个事务切换active_generation并写completed事实。失败/取消不切active，旧可用代仍查询；没有旧代显示unavailable。取消终止网络/worker，等写入settle后append terminal，不能在cancelled之后异步publish。重复cancel幂等，completed不能“撤销完成”。保留active与最多1个previous完整代用于审查，更多派生代显式GC；job元数据保留。query/source读取先在短Store gate内acquire exact generation lease，再启动FTS/worker/来源读取，finally实际cleanup后release。GC只删非active/previous且lease=0的generation；每project最多active+previous+1 staging/retired，共3份，若新构建会超cap且旧lease尚未释放则明确 busy，不无限留代。本地query/source全局最多4个、每个5s deadline（包括等待reader）；semantic总调用最多35s（网络阶段沿用单请求30s，取得embedding后的本地查询阶段5s），与ToolPipeline更早的timeout/signal取最早截止；timeout/abort后必须等待worker/connection cleanup，不以Promise.race遗弃reader。publish/cancel/terminal在同一job serialization gate决定唯一赢家；gate不等待网络或cleanup。local index可能留有已删除记忆旧正文，UI删除不声称物理擦除；查询权威校验仍立即隐藏。

memory变化不自动调用网络：通过source adapter exact ref检查标示stale，review/delete/access变化的同步fence与实时校验同时生效。索引状态可显示“可能需要重建”；不要求本轮新增fs watcher。项目folder更新由composition显式invalidate/cancel，外部根替换在每次操作检查发现。

stop顺序：close admission -> fence/abort previews、jobs与queries -> await全部producer/reader/network settlement和terminal exact readback ->关worker/embedding client ->关retrieval store。存在未清理writer/uncertainappend时shutdown返回incomplete诊断并保留Store供同一owned服务reconcile重试，不关仍可能写入的Store，不用Promise.race甩掉工作。启动失败也清理。HTTP/观察断连只detach观察者，不取消已接受job；显式cancel、root/memory/config撤销或shutdown才控制job，和现有AgentExecutionService原则一致，不复用AgentExecution的Session事件或伪造Session任务。

## 7. 词法、向量与RRF

词法用SQLite FTS5，每个 exact project/root/generation 拥有独立FTS virtual table和语料统计，避免别项目文档影响BM25分数/排名；table标识符只从host生成且strict校验的generation UUID编码构造，不接受输入拼接。schema列`title,path,body,terms`，`unicode61` tokenizer；为代码标识符提供deterministic camelCase/snake_case/dot拆词，为Han提供单字+相邻bigram辅助terms。原正文独立保存用于精确excerpt。query NFKC + locale-independent `toLowerCase()` /词项化仅用于检索，不改正文或hash；最多32term、512 codepoints/2048 UTF-8 bytes，拒绝无效surrogate和非普通文本controls。生成quoted literal MATCH表达式和绑定参数，不接受原生MATCH/SQL语法；path/source过滤也参数绑定，并在LIMIT/top50之前应用；BM25文档频率统计固定为该project generation语料，source/path filters限制候选而不声称重新计算筛选子集的IDF。FTS `bm25`越小越好，按升序取top50，tie使用stable sourceKey/chunkOrdinal。

不宣称FTS是语义；中文/identifier有实际检索质量fixture，stopword/单字噪声须可解释。纯lexical模式排名直接用BM25，不把缺失vector当零向量参与RRF。

真实embedding由独立Llm adapter提供；在hybrid已完成代中按相同allow scope/filter取向量top50。向量为provider真正返回的有限float数组，固定512维，拒绝dimension/response model/count/index不符、重复/遗漏index、NaN/Infinity、zero norm、过大norm或无法安全Float32归一化。float64计算norm后存unit Float32+digest；余弦dot在worker中有界精确扫描最多20000chunk/约40MiB向量，不引入原生ANN依赖，不宣传大规模ANN性能。worker拥有取消/超时/内存上限；支持源码Vitest和build后路径，与现有grep-worker模式一致。

hybrid对lexical top50和vector top50用`score(d)=sum(1/(60+rank_i(d)))`（rank从1开始），不相加BM25和cosine原始分数。候选缺一通道只有一个贡献；按score desc、sourceKey、chunkOrdinal稳定排序，最后去同source重叠chunk/限每source最多2条。结果limit<=10，融合候选去重后内部oversample<=50，去重政策写测试。

筛选必须在两ranker前进行；top列表和result不含其他scope数据。选出candidate后通过当前source校验再返回：workspace安全重读source digest/root（按同source去重，最多20文件/<=5MiB bounded）；memory确认仍current、reviewed、scope enabled且exact revision/digest相同，查询和source打开不能只靠索引存下的review标志。scope access禁用在候选前排除该memory source类型；单record freshness检查在排名后进行，stale文档可能占top50而使结果不足，不宣称全库最新相关性召回完整。stale/deleted/unavailable项省略并回报omitted count，不把旧正文当当前文件展示。不自动外发更新的正文，不用“刷新”触发隐藏embedding。候选耗尽返回较少条并说明stale，需要用户rebuild。安全检查后的外部瞬时变化仍是普通cooperative文件读取限制，citation注明verifiedAt。

## 8. 真实embedding配置与外发边界

首个closed provider仅OpenAI：固定`https://api.openai.com/v1/embeddings`，固定`text-embedding-3-small`、dimensions512、encoding_format float；无任意baseURL/model/path，无chat endpoint fallback，不复用LLM provider selection或chat API key。配置仅host env：`WEAVE_EMBEDDING_PROVIDER=openai`和独立`WEAVE_OPENAI_EMBEDDING_API_KEY`；缺一不可用，空值/未知provider拒绝。key为独立受限 printable ASCII（1..512字节，拒绝空白/controls），只读所需两个env值，不保存完整process.env。public vector-space identity不含key或keyhash，避免泄密也不把换key误当新向量空间；host保留不公开的config epoch，key/client更新使未消费preview失效并fence旧jobs，不能沿用旧授权偷偷换连接。首版env在Server启动时解析，无热更新UI；重启会中断旧job。UI只读展示configured/unavailable、provider/model/destination，不返回key。首轮不扩张Desktop secret settings平台。

`@weave/llm`新增独立`EmbeddingClient`、`createOpenAiEmbeddingClient`。以native fetch实现闭合endpoint，redirect:error，TLS标准验证；batch<=16、每input<=2048bytes、实际序列化request<=40KiB、streaming response<=2MiB，单请求30s、总job10min（从accepted开始，含所有等待）。batch按完整 `JSON.stringify({model,input,dimensions,encoding_format})` UTF-8实际字节打包，JSON escaping超限时减少input数量，永不截断chunk；单input不适配则明确输入错误。raw UTF-8 bytes只是保守输入bounds，不声称精确token估算。所有job和semantic queries共用一个host embedding semaphore，总在途请求最多2，每job顺序batch一次1个；不出现2job各自再开2请求。获取semaphore受调用deadline/signal控制，等待不等于自动重试。Zod验证JSON与vector；错误仅safe code/status分类，不泄漏response body/key/text。401/429/网络/超时本轮不自动重试，避免不透明重复计费；UI明确用户重试是新动作，cancel会abort正在请求但不声称provider必然未计费。

不存储query embedding或原query到长期日志（正常Agent tool arguments/result已按Session现有规则保留，不能暗称绝不保存）；job日志仅config identity/hash/count。首版不跨job复用embedding缓存，降低批准字节/新鲜度/配置组合复杂度；完整generation必须有一致向量身份。后续缓存优化须另给exact source/config和egress计数合同，不作为本轮依赖。

`search_project`只做纯本地lexical。`semantic_search_project`独立tool，readOnly:true但声明`retrieval.semantic_query` protected Approval；host policy强制ask即使yolo，summary展示精确query、目标provider和使用现有index（不会发chunk）。UI选中semantic模式后在输入框旁持续显示“本次查询将发送至 api.openai.com · text-embedding-3-small”，只在点击“发送查询并语义搜索”或该表单Enter提交时发送当下 exact query；input change/debounce/filters/reconnect不发网。提交瞬间快照 query/filter/request identity，改输入不改变已提交字节，下一次查询是新的明确操作。无含糊的首次小确认或永久授权开关。Agent则每个semantic调用经现有Broker强制ask；两条入口都使用同一typed egress permit，不接受客户端自报approved=true。

选择hybrid而provider未配置、配置身份不匹配、向量代不完整或query embedding失败时，返回明确semantic unavailable；可由用户显式改为lexical，不把失败静默冒充hybrid。offline fixture adapter只在测试注入，标注fixture，生产不可选择hash/随机/假向量provider。

## 9. 输出契约、工具与Studio

protocol新增strict retrieval DTO/schema，提供build preview/status/result、query filters、citations、safe error。结果包含actualMode、generationId、indexedAt、verifiedAt、query source filters、bounded hits（每条excerpt<=1200 UTF-8 bytes，HTTP完整JSON总结果<=24KiB；工具还须符合与实际Pipeline/Runner共用的有效bytes/token预算；按序缩减摘录/条目确保预算而非交Pipeline截断），每hit的source kind、stable source/chunk/ref、workspace path+line range或memory exact ref、root/source/chunk digest、lexical/vector ranks和RRF score（可选诊断，不暗称概率）。

工具：`build_project_index`、`get_project_index_status`、`cancel_project_index`、`search_project`、`semantic_search_project`。build/cancel非readOnly，cancel只允许当前唯一项目的job，不在Agent手里接受任意jobId跨项目控制。get/search是只读；semantic只读仍需外发审批。权限在service实时检查，不只tool registration。所有child（包括workspace access）首版仅local search/status，不能构建/取消/semantic；对父工具exact authority再取此子集，在最终Provider schema/Pipeline lookup中排除，同时service复核可信task origin。child read绑定多Agent捕获的Project/folderRevision/root，不能动态切到新目录；不能仅靠semantic的readOnly:true就授予外发。Agent不能自报parent/root/execution/task IDs。结果作为normal tool output记录，不自动prompt注入；源码文本是untrusted data而非instruction。

Server routes以`/projects/:projectId/retrieval/`为前缀：capabilities、preview、builds（POST/list）、builds/:jobId（GET）、cancel、status、query、source。build status/list最多20条metadata/页、完整JSON<=24KiB，不返回source正文或manifest capture；读取也通过trusted local Host/Origin/Sec-Fetch-Site、no-store、CORS前guard；POSTJSON bounded<=16KiB；manifest/source preview响应分页并遵守完整JSON<=24KiB（必要时减少文本页字节并给next cursor），query结果/工具输出也以实际序列化bytes检查，不能只限制raw excerpt；query不能提交source text/vector或absolute path。handler只校验/调用Runtime service。

background UI首版用bounded polling job snapshot（例如前台1s，页面隐藏暂停）和explicit cancel；不要求再造SSE协议/持久百分比。断连后GET按jobId恢复。若实现SSE，必须已有cursor/epoch/slow consumer契约，不能为交付扩大本轮。

Studio新增`features/retrieval/` SearchPage/client/validators/BuildPreview/JobStatus/ResultList；App仅nav+selectedproject接线。UI展示workspace/reviewed-memory filter、path prefix、lexical/hybrid实际mode、build/rebuild preview（计数/排除/可展开source text/destination）、旧active可用提示、phase+cancel、stale/rootchanged/unconfigured/empty/error。搜索输入不会触发网络语义调用。

源打开不能信任任意file://或工具提供的URL。使用structured citation经新`source`服务exact generation/ref校验：先验证当前root/source digest；文件可打开已验证相对路径+highlight line；memory导航Memory page精确ref。source服务只返回有界验证窗口（<=8KiB且完整JSON<=24KiB）与structured open descriptor，不在一个响应dump256KiB全文；打开动作通过同一exact-ref服务复验。已有file API可复用安全reader/UI，但不能绕过这里的digest/root授权校验；旧citation失效显示stale并让用户明确“打开当前文件”，不伪装仍是原结果。页面切project/query后requestidentity拒绝晚到结果；键盘操作/label/focus/error完整。

## 10. 接受标准与规模边界

无API key：临时项目含TS、中文注释、同名符号/路径，explicit build后能找出有意义源片段；Server重启仍查lexical；其他project不可见。当前reviewed记忆可跨Session检索，删除/失审阅立即不返回。@file/glob/grep现有行为不退化。

可量化验收先固定repo fixture与ground truth：至少24条查询（8个identifier/路径、8条中文注释、4条memory、4条同名/跨scope歧义），每条声明预期source与line/ref。词法fixture目标 top5 source recall>=20/24，scope越界/已删除或失审阅memory/错误citation必须0；这是该fixture的回归门槛，不外推真实项目召回率。hybrid手算fixture逐一核验rank/RRF和filter，不用人工调fakeprovider声称模型语义更好。记录20kchunk fixture冷/暖query p50/p95、build耗时、峰值RSS、取消到cleanup耗时及硬件/Node版本，不预填未经测量的速度。

前端AI简历展示聚焦六条完整链路：选择source并精确预览→后台构建可观察/取消→local symbol/中文检索→精确citation打开→文件或memory变更显示stale→跨project切换与乱序响应防覆盖。页面和真实状态机/授权相连，避免再造知识图谱、自动Agent平台或无限大配置页。

configured测试fixture：离线explicit known vectors证明真正余弦排名、过滤前排名、RRF ranks/ties，与hash无关；取消、超时、错误、dimension/config变更不能发布部分代。live OpenAI验收可在独立授权和真实key环境执行，报告若未执行；不能用fixture宣称线上质量/计费/语义召回已经验证。

规模是本地小中型项目20k chunks的有界exact vector scan；测试记录固定fixture上build/query耗时与memory，保留响应取消性，不承诺大型monorepo全量索引。超限有显式说明。所有隐私与文件安全是Weave自身验证约束，没有外部产品sandbox保证。

## 11. 实际读取的官方来源与取舍

1. Codex `a0995c2b2b68248960c69cb812b5f4898dac7e4c` 的[thread memory](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/app-server/src/request_processors/thread_memory.rs)与[versioned memory protocol](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/app-server-protocol/src/protocol/v2/memory.rs)：采用显式已选版本、不可用不暗中回退，不照搬其自动记忆管线。
2. Harness `4b399c39a6d1479cd84ca591b4d7c88e24d38a96` 的[MCP memory guide](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/user/guide/mcp-memory.md)：它明确示例默认关闭、substring不等于semantic。采用可配置真实provider和fresh Session验收，不把装了服务或返回伪vector当语义完成。
3. Kiro官方[context](https://kiro.dev/docs/cli/chat/context/)及[Memory](https://kiro.dev/docs/memory/)（2026-11-23读取）：知识库按需检索才消耗上下文、scope/可见管理；Weave本轮明确代码+reviewed memory，独立local索引，不复制未核对的embedding实现。
4. SQLite官方[FTS5](https://sqlite.org/fts5.html)：Unicode61/trigram、MATCH语法、bm25升序；实际本机SQLite3.50.2创建FTS5成功。采用FTS5与辅助terms，仍需最低runtime/CI验证，不声称支持所有第三方Node构建。
5. Elastic官方[RRF API reference](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion)：rank从1、k=60、独立ranker后融合。只采用公开算法，无Elasticsearch依赖；原始论文请求404，不声称读过原论文。
6. OpenAI官方SDK固定`95e8fdef313b59d1b49a74665b8c87196d17bd5c`：[embeddings types](https://github.com/openai/openai-node/blob/95e8fdef313b59d1b49a74665b8c87196d17bd5c/src/resources/embeddings.ts)与[transport](https://github.com/openai/openai-node/blob/95e8fdef313b59d1b49a74665b8c87196d17bd5c/src/lib/embeddings.ts)：实际核对/embeddings、float encoding、model与dimensions、response index映射。Developer reference网页此环境403，raw master请求timeout，改从GitHub API blob读取上述固定官方源码；不声称读取失败页面。Weave自己实现closed endpoint及bounds，不引入SDK、不复用chat客户端。


## 12. 与已实现接口对齐的最终合同（本节收敛上文宽泛表述）

本节是对现有 draft 的必需澄清，实施前写入仓库的设计和 ADR；它不表示这些新增接口已存在。2026-11-23 本次复核只读了仓库及原研究草案，§11 的外部来源取自前轮已经记录的读取证据，本次没有重新访问外站。

### 12.1 不反向导入纯算法

`chunking.ts`、`lexical-query.ts`、`rrf.ts`、FTS、vector worker 都归 `@weave/retrieval`。Runtime 不能为准备预览而导入该叶子。`RetrievalIndexPort` 由 Runtime 定义结构接口，提供受限 `prepareDocuments(documents)`、`accept/lookup/reconcile`、`stage/publish`、`leaseActive/query/releaseReadLease` 等方法；Server 将 leaf 的结构等价具体实现适配到端口。`prepareDocuments`只做本地纯计算，返回不可变ordered chunks/source summaries、版本和`RetrievalPreparedMetrics`（files/memories/sources/captureBytes/chunks/chunkTextBytes），不再返回含discovery的完整counts；不接触Workspace、网络或授权。它对全部输入document整体准备，aggregate/chunk超限拒绝，不静默丢source或自行增加skip。`RetrievalCapturedDocument`与source summary携带相同bounded lexicalMetadata.tags，leaf用作FTS terms/persisted metadata；EmbeddingInput.text只取chunk exact body text。`EmbeddingClientPort.describeBatches(inputs)` 按与真实 adapter 相同的 exact serializer/batch limit 计算 byte/count，避免预览估计漂移；Server 注入 `@weave/llm` 的同一个纯 packer，不要求 retrieval leaf导入LLM。端口返回的所有数据在 Runtime 边界校验，Store 接受冻结的经验证输入，不自行重新捕获或派生另一份 embedding bytes。CLI/Test 可直接用 leaf 算法，Runtime 测试注入等价手写小 fixture，不越层 import。

### 12.2 Project-only UI 与 Agent 可信调用

现有 `apps/server/src/project-folder-authority.ts` 的 `ProjectFolderAuthority.capture/checkpoint/withAuthority` 都以 **Session** 为入口；它没有 project-only capture，不能把 UI path 的 project UUID 当 Session ID。下一 PR 窄扩展该同一 authority：`captureProject(projectId)` 和 `checkpointProject(binding)`（并在 `withProjectAuthority(binding, operation)` 的短 gate 内完成最后同步 admission）。它们要求 Project 实际存在且有有效 folder，保留同一个 `ProjectFolderBinding` opaque exact-object registry、folderRevision/rootDigest、signal、`assertEffectCurrentSync` 与 `release`；不暴露可 JSON 重建的 binding。现有 Session API 和 Task 调用保持原语义。`updateFolder` 同时撤销 session/project bindings，A→B→A 不能复活。现有 binding signal 在 authority gate 中同步 abort；retrieval listener 只能立即置 fence 并排队到 gate 外 abort 自己的 job/network controller，不在该 listener 取 gate、等待或调用 Memory。

Agent 入口先获得检索专用的 exact live caller。`memoryCallerAuthority` 只接受 Memory bridge 通过 WeakMap 生成的 caller；`memory.scopes.resolveAgentScope` 不能直接接受 `readAgentToolAuthority` 的普通 view，更不能伪造 view。下一 PR 在 `retrieval-tool-attempt.ts` 建立同等 exact-definition/summary/execute bridge，导出供 Server 使用的 `retrievalCallerAuthority`，Server `retrieval-scope.ts` 复用已有 `captureMemorySessionScope` 的 membership marker，并验证 accepted execution、started Turn、user message 与当次 tool-call facts。子 Agent 还复核 durable accepted/origin lineage、当前唯一 membership 和 `agent-task-workspace` 已持有的 pinned binding；不在每次 query 给 child 新 capture 一个可随目录改变的 binding。可将纯 durable-fact verification 提取成 Server 内部共用 helper，但不把 Memory caller branding 放宽为接受 plain JSON/view。

`apps/server/src/runtime.ts` 当前只接一个 `rootOnlyTool` predicate；新组合取 Memory 和 Retrieval exact-definition predicate 的并集，不能覆盖 Memory 分类。所有 child 排除 retrieval build/cancel/semantic，即使 semantic 标 `readOnly:true`。读取工具也要求 genuine token，且在 around/policy 之前拒绝缺 token 的 host retrieval 定义，与 Memory 保持同样入口约束。

### 12.3 Memory access 快照与保守失效

直接复用 `MemoryService.reviewedSource.capture/assertCurrentSync`，每次有 1..48 个 explicit refs；不以空 refs 偷渡 access-only 检查，不复制 capture 对象，不序列化其权限。现有 capture 的 `liveEpoch` 是 **整个 Project scope** 的保守 epoch：任一新 mutation（包括无关记录）和失败 precommit 都令全部该 scope capture 失效。retrieval 需对使用 memory 的 preview/job/query 一致保守 fence；不能仅对 `memoryId` 相等的 job 撤销，再假定其他 capture 仍 current。workspace-only job 不受无关 Memory mutation 影响。exact receipt replay不触发失效。

为了履行“disabled memory 在两个 ranker候选前排除”，下一 PR 窄增 host-only `ReviewedMemorySource.captureAccess({projectId,signal})` 与 `assertAccessCurrentSync(capture)`。`ReviewedMemoryAccessCapture` 冻结 `{projectId, level, settingRevision, liveEpoch}` 并使用私有 WeakMap绑定 exact owner；允许捕获 disabled 状态，只提供设置元数据、不含正文。`assertAccessCurrentSync` 要求 owner/open、scope epoch/settingRevision/level全等；不会把 disabled 变成可读。构建有 memory refs 仍走原 `capture`（disabled拒绝）。查询先取 access capture，若 disabled 则从 lexical/vector的source filter中排除全部memory；返回前再 assertAccessCurrentSync，防设置中途变化。不能直接读 leaf store 或用 local getAccess 的普通 DTO假装同步证据。

现有 `capture` 是 all-or-nothing；已发表索引中单条 ref stale 时，查询 freshness 对每个候选 **唯一 memory source** 单独调用 capture({refs:[ref]})，单条 stale/deleted/agent-authored只省略该项，access/owner/uncertain 等全scope失败拒绝该 memory部分，不把一个 stale source 错误扩散成其他当前条目全部 unavailable。候选去重后最多50个source（其中memory最多48），总内容仍按查询总预算；保留每个成功 exact capture，在返回的同一同步段逐一 assertCurrentSync。Memory source citation 打开也如此。任何 await 后失效都不得返回旧正文。

`createServerMemoryComposition` 当前写死 `beforeMemoryCommit:()=>undefined`。新 PR 增加同名受信 option，Main 在 Memory 构造前建立轻量同步 invalidation fanout，Memory回调先记 epoch/fence，再通知已注册 Retrieval consumer。Retrieval constructed 后注册，shutdown fence first、drain Retrieval **先于** Memory drain/close，保留失败 cleanup所需 Memory/Project/Session依赖。没有 consumer 时回调仍合法。它不是 plugin hook，不提供动态用户脚本，不从 Memory store lock反取其他 gate。

### 12.4 Single owner 与 retained cleanup

检索 sidecar虽然多数是派生数据，但 job event/receipt 是权威且后台 producer容量仅本进程内；必须限定同一 sidecar一个支持的 Server writer。沿 Memory模式，在打开/迁移 data WAL前对 `${retrievalDatabaseFile}.owner.sqlite` 的rollback-journal连接持 `BEGIN EXCLUSIVE`。路径由已 canonical 的 Session databaseFile派生，父目录 alias规范化，data/owner拒 symlink、多重hardlink、非普通文件，身份变化永久 fence。进程退出锁由SQLite释放。任何 worker/query/generation lease/uncertainappend未确认清理不得释放owner。

FTS5 capability probe失败应只禁检索；它与 owner busy、无效/未知 schema、文件身份变化不同，后者启动失败应保持安全错误与 retained cleanup，不把所有Store错误误归为“FTS不支持”然后继续另开 owner。partial startup cleanup使用 exported exact branded `RetrievalStoreStartupError` 携同一 `closeSync/drain/close` 资源，Server提前注册，data先关、owner后关；close acknowledgement丢失按真实isOpen重试。非品牌/JSON错误不得注册cleanup authority。测试第二真实进程、SIGKILL后 reopen、启动失败data.close抛错、正常close/reopen和source/distworker路径。

### 12.5 Durable 请求 identity 与 exact around retry

UI build请求digest是版本化canonical `{callerClass:'local-user', projectId, requestId, mode, manifestDigest}`。`POST builds`输入固定`{requestId,previewId,mode,manifestDigest}`，mode纳入exact requestDigest；Service在访问preview前就能计算完整key并查原receipt，预览过期/重启不会破坏响应丢失重试。仅receipt miss才检查新preview，并核对input.mode与preview.mode一致。不含transient previewId或当前epoch；同requestId换mode或manifest冲突。

Manifest显式保存`selection: RetrievalNormalizedSelection`，不是把selection留在opaque preview的隐藏字段。它覆盖normalized workspace enabled/path filters/optional selectedPaths和exact memoryRefs；规范化规则见§5。capture time只为展示，manifestDigest排除capture time/previewId/requestId，覆盖source/chunk bytes identity、title/lexicalMetadata、selection、版本和public vector-space identity。相同bytes且相同selection可有相同manifestDigest；相同bytes但不同绑定filters仍有不同digest。leaf staging可只用完整manifest重算digest，并不由此授予重用preview/permit的权利。

Agent requestId由可信 `[sessionId,executionId,turnId,toolCallId,'retrieval.index']` 派生。其 durable request digest固定为 **canonical normalized tool intent + caller/project identity**（mode、exact memoryRefs、path/source选择）；不含之后捕获的manifestDigest、preview token、私有configepoch或时间。accepted event另保存这一次被授权的exact manifestDigest，receipt同时带requestDigest/manifestDigest。每个新attempt的summary先按live authority读exact durable receipt；已完成accepted replay仅显示该既定job确认、不重新capture、审批新bytes、起producer或发网。新mutation receipt miss才准备一次preview并绑定attempt，执行核对canonical输入相同与已批准manifest。相同invocation+operation全局唯一，换project/改变mode或内容不能起第二effect；需要新tool call明确重建。receipt当前权限校验先于readback；revokedcaller不能冒领旧job。此区分避免 around.next 重试因新capture time或文件变化把原job误当新操作，也不允许readback uncertain时重新producer。

### 12.6 Pipeline审批、错误和预算

`retrieval-tool-attempt.ts` 是专用host bridge：exact definitions WeakMap、exact summary/execute contexts、每次base around.next新attempt、pin approval对象/summarize函数/operation/high risk，并在policy、summary await、Broker await、execute前及effect admission持续核验。memory bridge保持原职责。`retrieval.index` hybrid与`retrieval.semantic_query`均由不可由plugin覆盖的host policy要求ask；policy组合任何deny优先、ask优先于allow。只在**该attempt真实approved并进入execute**后签发egress permit；lexical yolo automatic可无外发permit。summary不能签发，不用session/turn/tool IDs当批准证明，不向SDK导出通用permit。

Pipeline catch分支仅对exact classified retrieval definition透传 branded finite safe RetrievalError，summary失败不创建Approval。Host定义的around入口同样保持安全错误；任意插件抛同形code不透传。所有结构结果使用完整 `JSON.stringify`、UTF8bytes以及现有 `estimateTokens`，上限为 `min(24576,effectivePipelineMaxBytes)` 和 `effectiveRunnerMaxToolResultTokens`。Main提供与Memory/实际Pipeline/Runner同一预算对象，不能为了检索另设不同默认。HTTP envelope单独<=24576bytes。Build/cancel的最小receipt、status最小metadata必须在effect前确认可放下；search按序缩excerpt/减条数，并显式 `truncated/omitted`，若有候选却连一个scalar/codepoint+完整metadata也无法前进，报 retrieval-limit而不是成功空页。全请求上下文预算仍由Runner原逻辑处理。测试1900byte Pipeline/600token Runner和escapedUnicode，确认成功tool JSON无需Pipeline单结果截断。

### 12.7 Capture coverage与纯准备metrics的唯一合成

`capture.describe`返回`RetrievalCaptureCoverageCounts`与coverage：discoveredFiles为受50k cap限制的实际listing entries，不估计截断范围外总数；selectedFiles为按用户selection及2000-file source cap准入、尚未经过安全/大小读取的条目数；skippedFiles为所有已观察但未形成captured document的条目（含system/not-selected/source-cap/safety/size原因）。须满足discoveredFiles=捕获文件数+skippedFiles、捕获文件数<=selectedFiles<=discoveredFiles，coverage.skipCounts按原因完整分割skippedFiles。memory-only/禁用workspace的这些计数均为0。

保留的skip路径详情最多2000条示例，`coverage.skippedDetailsTruncated`与discovery `coverage.truncated`分开；详情裁剪不改counts或skipCounts。`prepareDocuments`只返回对全部成功输入可计算的`RetrievalPreparedMetrics`，任一chunk/aggregate超限整体拒绝；explicit Memory refs失效也沿用Memory现有all-or-nothing拒绝，不把失败条目编成未声明的leaf skip。

Runtime是完整`RetrievalCounts`的唯一合成人：discovered=capture.discoveredFiles+metrics.memories；selected=capture.selectedFiles+metrics.memories；skipped=capture.skippedFiles；其余字段直接来自metrics。合成时校验files等于capture文档数、memories等于选定exact refs数、discovered=sources+skipped和sources<=selected<=discovered，并核对coverage原因合计。preview/manifest/accepted/generation冻结使用同一counts；leaf仅校验收到的完整值，不能从裁剪的skip examples推导discovery。

### 12.8 可并行实施所有权

根agent在设计落库后先冻结protocol DTO和Runtime结构端口，不让两个并行实现者同时改 `index.ts`、Main、App、Pipeline或根manifest。随后：A拥有retrieval leaf纯算法/store/worker及其测试；B拥有LLM独立adapter/packer及其测试；C拥有Runtime安全capture helper与旧@file回归；根拥有Runtime Service/attempt/Pipeline、Servercompositor/guard/API和跨层集成。A/B/C先发布结构接口，根按端口注入。Studio在HTTP DTO冻结后可由已完成leaf的agent承接，独占 `features/retrieval`与其tests，App接线交根。最终独立review者不改实现；有真finding由所属实现者修复再复核。共享文档/AGENTS/ESLint/manifest/lock由根串行更新。这是实施编排，不增加第二服务、额外PR主题或产品功能。


实施裁定（2026-11-23）：保留可选 `selectedPaths`，domain最多2000个互异相对文件路径，支持逐文件缩小语料。实际HTTP POST仍以完整JSON UTF-8 <=16384bytes为更早硬界；Studio发送前计算exact body字节，超限明确显示“所选路径过长，请用目录prefix缩小范围”，不得截断列表或扩大到all files。较长workspace路径仍完整保存在source.path/sourceKey作为身份；title只是<=160 codepoints/640 UTF-8bytes的独立display label，可安全截短basename，绝不能用截短title生成source identity、chunkId、digest或文件打开路径。协议实现先写RED schema行为测试，完整manifest/event跨字段验证在实现期补齐。


## 13. 实施前的最终裁定

- 检索独立的发现模式对 Git tracked/untracked 清单继续执行有界 `git check-ignore --no-index --stdin -z`，保证后来加入 ignore 的 tracked 文件也不进入语料；旧 @file/glob/grep 清单不改。Git worktree 中清单或 ignore 判定失败时，明确 workspace 检索不可用。只有确认是普通目录并且待读路径祖先及遍历范围没有无法执行的 `.gitignore` 规则时，才能使用 walk；规则无法确认则拒绝本次 workspace 捕获，memory-only 不受影响。首版不自建 gitignore 解释器。
- 不合 UTF-8 或路径 schema 的发现项只计入 `unsafe-file` 与总 skip 计数，不回显原始路径，`skippedDetailsTruncated=true`；保留现有有限 skip reason 集合。详情省略不更改完整观察计数。
- 中立 reader 接受 `expectedRootDigest`，检索每批对原 authority digest 复核，不能用每次新读根替换旧绑定。原 @file 明确选择批次首读身份并保持既有 8refs/64KiB/256KiB 入口约束。
- embedding batch ordinal 从0开始；规范化 Float32 向量中的 signed zero 统一为+0，摘要按固定 little-endian 2048 bytes计算。LLM adapter 和检索存储使用同一规则。
- 完整 manifest/accepted/journal schemas 必须核对项目、选择、source/chunk、count、mode/vector、receipt/terminal 的跨字段关系。端口中的对象品牌仅作静态帮助，运行时必须使用私有 exact-object/owner registry。


实施接线补充（2026-11-24）：`RetrievalIndexPort.manifestDigest` 注入leaf同一纯canonicalizer，Runtime不反向导入。workspace `verify(handle,signal,retainedProject?)` 可在accept后使用独立job binding，但必须先证明与原capture的project/revision/root完全相同；冻结文档不变，原attempt结束不撤销job。egress consume绑定host project/request/manifest摘要（query绑定exact序列化batch），无JSON权限。
