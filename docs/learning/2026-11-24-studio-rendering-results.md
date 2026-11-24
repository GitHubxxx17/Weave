# Studio 会话渲染：2026-11-24 实测记录

本记录保存实施前后各 18 个生产浏览器对照样本，以及新增工具 stream、混合高度/500 工具诊断和最终源码的 5,000 条混合高度验证。数据来自同一机器、Chrome 和视口，前后按阶段顺序采样，并非随机交错样本。旧实验 `2026-11-23-studio-performance-baseline.md` 保留原始观察，不作为本轮 before。

## 环境与可复现边界

- 源码起点为最新 main 的 `7eb4c72`；采样 HEAD 为仅增加正式设计文档的 `f2190032ab23165cbac94f19bbb5ed3e84abb283`，`dirty=true`。dirty 包含本轮 harness 和并行实施文件；生产浏览器读取的是实施前已构建、采样期间没有重建的 Studio dist。
- Apple M4 Pro，macOS `darwin/arm64`，Node `v24.4.0`，Chrome `158.0.8127.36`，1440×1000。
- 每个样本独立启动 fixture 与全新 Chrome，资源和 JSON 都使用 `Cache-Control: no-store`。每个 matrix cell 重复 3 次，共 18 个样本；无真实 Provider、Workspace 或插件 I/O。
- before harness SHA-256 为 `281b89658159201f97bfba450d3d304a798c955911db3307e85d0cf30fe3f1af`；历史/stream 的 fixtureHash、UTF-8 historyBytes、逻辑条数和 raw record 数逐样本写在 raw JSON。
- 生产静态产物的逐文件 SHA-256 及聚合 hash 见 [before-build-manifest.json](artifacts/2026-11-24-studio-rendering/before-build-manifest.json)。聚合 hash 按文件相对路径排序，以 UTF-8 路径、NUL、SHA-256 原始字节依次输入 SHA-256。

```sh
node apps/server/test/performance/run.mjs \
  --counts=100,1000,5000 --variants=markdown,tools \
  --stream-variants=text --history-shapes=standard --tools-per-turn=1 \
  --repeats=3 --output=dist/performance/rendering-before.json
```

此命令直接使用已构建 dist；通常首次运行可用 `pnpm studio:benchmark` 构建后调用 runner。对照运行必须明确所读 dist 的源码版本，避免并行实施时无意覆盖 before。

## 冻结的实施前结果

| 历史类型 | 逻辑消息 | 冷就绪中位 ms | 切回中位 ms | 输入代理中位 ms | stream rAF 间隔 p95 ms | 冷 DOM 元素 |
| -------- | -------: | ------------: | ----------: | --------------: | ---------------------: | ----------: |
| markdown |      100 |           143 |         100 |              48 |                   16.8 |       2,306 |
| markdown |    1,000 |           299 |         433 |             401 |                  100.0 |      20,306 |
| markdown |    5,000 |          1074 |        2899 |            1746 |                 1516.6 |     100,306 |
| tools    |      100 |           148 |         117 |              48 |                   16.8 |       4,306 |
| tools    |    1,000 |           361 |         566 |             510 |                  150.0 |      40,306 |
| tools    |    5,000 |          1368 |        4610 |            2268 |                 3066.5 |     200,306 |

100/1,000/5,000 表示合并后的 user/assistant conversation rows；tools 历史还分别包含 50/500/2,500 条额外 tool records，因此 rawHistoryRecordCount 为 150/1,500/7,500。所有 before 样本的 readinessMode 均为 `full-dom`，冷 mountedMessageCount 与逻辑数精确相等；stream 完成后精确为 count+2。

输入代理测量从 Playwright `fill()` 调用到两次 rAF，不能称为 INP。rAF 间隔不等于用户可见 FPS。long task 超过 50ms 部分之和保留为实验代理，不作为标准页面 TBT。可选 usedJSHeapSize 不证明内存泄漏。浏览器录制和控制命令自身有成本，比较需使用相同 harness、浏览器与视口。

每个样本在计时外滚动并核对第 0、floor(count/2)、count−1 条 sentinel，raw 保存其完整 textContent；最后一条流式回复必须精确匹配原有 100×20ms 的 `benchmark-stream-000` 至 `099`，不允许缺失、重复或重排。最终 Session HTTP 投影再次核对 durableText 和工具 summary；raw 保留全文。所有 18 个样本均通过这些断言。

## 合同与 fixture 修正

- runner report 为 schemaVersion 2，新增逻辑数、挂载数、raw record 数、historyBytes、fixtureHash、executionApiMode、readinessMode、harnessHash。保留原冷就绪/切回/输入/rAF/long task 字段。逻辑 readiness 使用 timeline 根的 `data-session-id/data-logical-count`，row 的 `data-message-id/data-message-index` 定位；完整 DOM 路径仍精确断言 `.timeline-item` 数量。
- 原 runner 在 repeat 外复用一个 fixture。第一个 stream 写入两条 durable 消息后，第二个浏览器面对 count+2 条，旧 count readiness 永久不满足。新 async generator 让每个样本拥有独立 fixture，在结束、异常或提前停止时关闭。行为测试先复现 100→102，再验证每次恰为 100。
- 默认 `createScenario(count, variant)` 的历史内容与原 100 个 text token 不变。可选 `--history-shapes=standard,mixed` 加入短文、长段落、表格/列表不同高度；`--tools-per-turn=500` 支持一条回复 500 工具，Zod 限制 1..500。
- 可选 `--stream-variants=text,tools` 默认仍 text。tools stream 使用真实 `createAgentExecutionService`、`createAgentRunner`、共享 Tool Pipeline 和 Session event store；仅 LLM 是确定性生成器。10 个 reasoning、10 个 call/executing/result 生命周期与原 100 个 text token 交错；真实 model/tool step、tool-call、tool-result、message、turn 事实均追加。终态 snapshot 事件清空后，Session 重载仍恢复 11 个 model steps、10 个有序工具 ID 和 completed results，summary 不再固定为 0/0/[]。

## 验证与原始产物

- `pnpm exec vitest run apps/server/test/studio-performance-fixture.test.ts`：10 个行为测试通过，包含 repeat 隔离、输入上限、ExecutionService replay/conflict、原 token 精确序列、工具 durable/reload、queue、审批订阅与未知路由 404。
- `pnpm exec eslint apps/server/test/performance apps/server/test/studio-performance-fixture.test.ts` 通过。
- `pnpm exec tsc -p apps/server/tsconfig.json --noEmit` 通过。
- 生产 smoke：100 条 Markdown 的 text/tools stream 均通过；2 条逻辑消息、mixed 高度、一条回复 500 工具、tools stream 场景通过。smoke 只有一次，不用于中位数对比。

| 产物                                                                                                                                                                               | 作用                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [rendering-before.json](artifacts/2026-11-24-studio-rendering/rendering-before.json)                                                                                               | 最终同版 harness 的完整 18 个样本及聚合                        |
| [rendering-before.log](artifacts/2026-11-24-studio-rendering/rendering-before.log)                                                                                                 | 最终采样进度原始输出                                           |
| [before-initial-failure.log](artifacts/2026-11-24-studio-rendering/before-initial-failure.log) / [partial JSON](artifacts/2026-11-24-studio-rendering/before-initial-partial.json) | 原 runner 的第二次 repeat 超时，保留失败证据                   |
| [rendering-before-first-pass.json](artifacts/2026-11-24-studio-rendering/rendering-before-first-pass.json)                                                                         | 修复隔离后第一轮 18 样本，最终合同加强后又完整重跑，未混用汇总 |
| [before-harness](artifacts/2026-11-24-studio-rendering/before-harness/run.mjs) / [final-harness](artifacts/2026-11-24-studio-rendering/final-harness/run.mjs)                      | 两轮采样所用脚本快照，供 hash 与合同审计                       |
| [rendering-stream-smoke.json](artifacts/2026-11-24-studio-rendering/rendering-stream-smoke.json)                                                                                   | text/tools stream 生产 smoke                                   |
| [rendering-dense-smoke.json](artifacts/2026-11-24-studio-rendering/rendering-dense-smoke.json)                                                                                     | mixed/500 工具生产 smoke                                       |

本轮仅声明会话渲染改善，不包含文件树 50,000 行、全局浏览器 Find 恢复、网络/JSON 分页或任意长单条 Markdown 解析成本的改善。文件树 baseline 草稿与原始样本暂存在 `/tmp/weave-explorer-benchmark-draft/`，将在独立 Explorer PR 中复核后迁入；它们不计入本 PR 的性能提升。

## 实现验证与边界

完整会话仍保留在浏览器内存。浏览器原生 Find 只覆盖当前挂载行，产品提供完整逻辑
查找（每页 50 条结果，不删逻辑匹配）及按需完整只读文本/复制。单条巨大 Markdown、
展开的巨大工具列表、完整文本和 focused/selection/pending pin 都有额外成本；
不能声称总内存恒定。展开状态在同一 Session 的窗口卸载后保留，切换 Session 重建。

生产浏览器验收 [conversation-acceptance.json](artifacts/2026-11-24-studio-rendering/conversation-acceptance.json)
使用 100 条混合高度消息、每轮 500 个工具：初始挂载 9 行，bottom gap 0；第 49 行的
第 500 个工具参数可见且获得焦点（top 325px，viewport 119–811px）。流式输出前后
阅读锚点 offset 均为 −86px，宽度变化后仍为 −86px；回到底部 gap 0；完整文本
14,467,591 字符，页面异常列表为空。初期固定帧数的定位与 ResizeObserver 验收曾
不稳定，修复了 CSS spacer 压缩、跟随与导航争用，并改用最多 45 帧、连续 5 帧稳定的
有界布局收敛。更迟的异步内容变化不包含在这一次定位保证内。

图片加载专项后来在最终构建完成，见文末受控 data URL 验收；VoiceOver 未完成。真实任务子会话来源、
完整 durable alias、审批焦点、不同 Turn 复用 call ID、终态重连、迟到 history、
exact retry 和文件撤销身份由 Studio 行为回归覆盖。该浏览器样本并非读屏器验收。

本次模型、store、组件隔离及窗口实现并行集成，没有单独采集 indexed/isolated
消融 checkpoint，不为这两步填写计时数字。完整 windowed before/after 是正式对照。

## 实施后对照与生产验收

after 的 HEAD 仍为 `f2190032ab23165cbac94f19bbb5ed3e84abb283`、dirty=true；实际生产 dist 聚合 SHA-256 为 `21b385eb66e5f0d358b9bf3e1c514adcbd16315f9089b697709c2d13f1f4ab1d`，采样开始时 Studio source 与 performance harness 的目录内容 hash 为 `1b3d1d315cb1b2dafba5149cf8c6fe96acf055edcbc1132b74c608815980eb94`，逐文件详情见 [after-build-manifest.json](artifacts/2026-11-24-studio-rendering/after-build-manifest.json)。生产 dist 在全部 27 个会话样本期间保持不变，未并行运行重型测试。后续 pending reveal hook 的一帧重试、Session 删除和终态 observation 生命周期修订发生在此 dist 构建之后。最终源码重建后的 smoke、5,000 条 mixed/tools stream 和专项验收在下节独立记录，未覆盖或改写这 27 个已采样样本；本次没有用最终 dist 重跑完整 18 格对照，因此对照性能表的实现版本边界仍是此处的 dist。

after harness hash 为 `dacbcb553c37f35b40481f156c61802568c3392b1b6938faad639263250207d7`，与 before 的差异仅为逻辑虚拟窗口中的搜索控件适配：优先 `role=searchbox`，fallback `textbox`；before 使用完整 DOM 路径，不执行该分支。before/after 的标准 fixtureHash 逐项相等，历史内容、stream token、动作和计时口径不变。脚本快照见 [after-harness](artifacts/2026-11-24-studio-rendering/after-harness/run.mjs)。

| 历史     | 逻辑条数 | 冷就绪 before→after ms | 切回 before→after ms | 输入代理 before→after ms | rAF p95 before→after ms | DOM before→after |
| -------- | -------: | ---------------------: | -------------------: | -----------------------: | ----------------------: | ---------------: |
| markdown |      100 |                143→124 |               100→67 |                    48→34 |               16.8→16.7 |        2,306→587 |
| markdown |    1,000 |                299→130 |               433→68 |                   401→31 |              100.0→16.7 |       20,306→587 |
| markdown |    5,000 |               1074→159 |              2899→80 |                  1746→26 |             1516.6→16.7 |      100,306→587 |
| tools    |      100 |                148→132 |               117→68 |                    48→32 |               16.8→16.7 |        4,306→707 |
| tools    |    1,000 |                361→140 |               566→69 |                   510→31 |              150.0→16.7 |       40,306→707 |
| tools    |    5,000 |               1368→174 |              4610→70 |                  2268→33 |             3066.5→16.8 |      200,306→707 |

18 个 after 样本全部为 `readinessMode=logical-selector`；冷态每个样本挂载 13 条，完整逻辑消息为 100/1,000/5,000 条。首、中、尾 reveal 与完整 token/durableText 都通过。DOM 是全页面元素总数，受具体内容和初始滚动位置影响；13 条是这组固定视口/数据的观察，并非任意高度和焦点 pin 情况下的通用常数。

5,000 条 Markdown 的冷就绪中位降低 85.2%，切回降低 97.2%，输入代理降低 98.5%，DOM 元素减少 99.4%；5,000 条工具历史的对应值为 87.3%、98.5%、98.5%、99.6%。这些比例只比较此处固定合成负载，不推广到真实项目、网络传输、JSON 校验或全部长文场景。

新增工具 stream 在 100/5,000 条 tools 历史上各重复 3 次，共 6 样本；输入代理中位均为 32ms，rAF p95 分别为 16.8/16.7ms。mixed 高度、2 条逻辑消息、每回复 500 历史工具的独立诊断重复 3 次：冷就绪中位 132ms、切回 68ms、输入代理 33ms、rAF p95 16.8ms、冷 DOM 364。工具 stream 与 dense 诊断未采集同版 before 矩阵，因此不计算提升率。全部 9 个附加样本均核对 10 个 tool ID/结果/状态/顺序与精确原 100 个 text token。

```sh
node apps/server/test/performance/run.mjs --counts=100,1000,5000 --variants=markdown,tools --stream-variants=text --history-shapes=standard --tools-per-turn=1 --repeats=3 --output=dist/performance/rendering-after.json
node apps/server/test/performance/run.mjs --counts=100,5000 --variants=tools --stream-variants=tools --history-shapes=standard --tools-per-turn=1 --repeats=3 --output=dist/performance/rendering-after-tools-stream.json
node apps/server/test/performance/run.mjs --counts=2 --variants=tools --stream-variants=tools --history-shapes=mixed --tools-per-turn=500 --repeats=3 --output=dist/performance/rendering-after-dense.json
```

浏览器专项 [conversation-acceptance.json](artifacts/2026-11-24-studio-rendering/conversation-acceptance.json) 记录 passed=true、errors=[]、failures=[]：500 个工具中的最后一项参数在窗口内可见、只有一个工具正文挂载；上滚锚点在持续 stream 后保留同一 ID/像素 offset，宽度变化后 offset 保持；恢复 following 后底部 gap=0；完整 transcript 长度 14,467,591 字符。该专项运行器将失败断言保存在 raw，并不将某次焦点 pin 快照的 false 字段解释为单独通过的保证。

| 新产物                                                                                                       | 作用                     |
| ------------------------------------------------------------------------------------------------------------ | ------------------------ |
| [rendering-after.json](artifacts/2026-11-24-studio-rendering/rendering-after.json)                           | 18 个正式 after 对照样本 |
| [rendering-after-tools-stream.json](artifacts/2026-11-24-studio-rendering/rendering-after-tools-stream.json) | 6 个 tools stream 样本   |
| [rendering-after-dense.json](artifacts/2026-11-24-studio-rendering/rendering-after-dense.json)               | 3 个 mixed/500 工具样本  |
| [after-build-manifest.json](artifacts/2026-11-24-studio-rendering/after-build-manifest.json)                 | 采样产物与目录内容 hash  |

独立审查还促成两个正确性修复：terminal cancel receipt 传递 status/watermark 并要求 store settlement 确认后才删除 observation handle；文件撤销 controller 对已关闭、无订阅、已确认的审阅采用 max32 LRU，保护 loading/open/subscribed/pending，并以完整 operationId/requestId 确认 completed readback。后者的 store+UI 测试共 10 项通过，删除 Session 与真实 App dispose 清理缓存，虚拟卸载不取消或重发 mutation。

## 最终源码构建与附加验证

最终生产 dist 聚合 SHA-256 为 `c34d8d5c9648ee6c5fd6f1b0ef0577e3b6e739e02f1411d8eec44fb4486dd979`，Studio source 与 performance harness 的目录内容 hash 为 `5bde88bf79332fbd0c8b396d0975cd70c2dd9dff3def9c878e949725bc2e1958`。本节 4 个计时样本与随后会话专项验收前后再次计算指纹，源码与 dist 均一致。采样 HEAD 仍为 `f2190032ab23165cbac94f19bbb5ed3e84abb283`、dirty=true。逐文件证据及 hash 算法见 [final-build-manifest.json](artifacts/2026-11-24-studio-rendering/final-build-manifest.json)。

- 100 条标准 Markdown、text stream 的最终 smoke 通过一次：冷就绪 140ms、切回 67ms、输入代理 35ms、rAF p95 16.7ms、冷 DOM 587、挂载 13 条。单次 smoke 用于最终构建回归验证，不计算相对提升。
- 5,000 条 mixed 高度 tools 历史、tools stream、每回复 1 个历史工具，重复 3 次全部通过：冷就绪中位 190ms、切回 76ms、输入代理 33ms、rAF p95 16.8ms；冷态挂载均为 17 条，页面 DOM 为 949/949/1,022。每个 fixture 含 7,500 raw records、6,171,161 UTF-8 historyBytes，fixtureHash 均为 `fdde4e36da364a67b9287d60fc785d87d4575adf703bfadc83eab3c3c190af74`。完整首/中/尾 reveal、原 100 个 text token，以及 10 个有序工具 ID/状态/结果/durable reload 断言全部通过。这里没有同场景 before，因此不报告提升率。
- 最终构建会话专项 [conversation-final-acceptance.json](artifacts/2026-11-24-studio-rendering/conversation-final-acceptance.json) 为 passed=true、errors=[]、failures=[]。100 条 mixed/500 工具场景初始挂载 9 条、底部间距 0；第 49 行第 500 个工具获得焦点且可见，只挂载 1 个工具正文。stream 前后和宽度变化后的阅读锚点均为同一消息且 offset=−86px；恢复 following 后 gap=0。此次 tools stream 的完整文本长 14,468,342 字符。此结果与前一份专项的 text stream 内容不同，分别保留原始证据。

```sh
node apps/server/test/performance/run.mjs --counts=100 --variants=markdown --stream-variants=text --history-shapes=standard --tools-per-turn=1 --repeats=1 --output=dist/performance/rendering-final-smoke.json
node apps/server/test/performance/run.mjs --counts=5000 --variants=tools --stream-variants=tools --history-shapes=mixed --tools-per-turn=1 --repeats=3 --output=dist/performance/rendering-final-mixed5000.json
```

打包成本：before 的主入口 JS 为 939,470 bytes，最终为 1,004,883 bytes，增加 65,413 bytes（6.96%）；Vite build 日志中的 gzip 为 280.96→301.11 kB，增加约 20.15 kB（7.17%，日志精度为 0.01 kB）。最终 manifest 另以 Node gzip 实测为 301,114 bytes；before 原文件未另存，gzip 对照采用保留的 Vite 日志精度，不能冒称两侧都有精确字节。主 CSS 为 121,593→123,468 bytes，增加 1,875 bytes；另一个 `index-*.js` chunk 两侧均为 57,038 bytes。这是本次静态产物成本，不能只列渲染时延改善而省略入口增长。

| 最终产物                                                                                                                                                                                        | 作用                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [rendering-final-smoke.json](artifacts/2026-11-24-studio-rendering/rendering-final-smoke.json) / [log](artifacts/2026-11-24-studio-rendering/rendering-final-smoke.log)                         | 最终 dist 的标准 100 条回归 smoke                  |
| [rendering-final-mixed5000.json](artifacts/2026-11-24-studio-rendering/rendering-final-mixed5000.json) / [log](artifacts/2026-11-24-studio-rendering/rendering-final-mixed5000.log)             | 最终 dist 的 mixed 5,000 条、tools stream 三次样本 |
| [conversation-final-acceptance.json](artifacts/2026-11-24-studio-rendering/conversation-final-acceptance.json) / [log](artifacts/2026-11-24-studio-rendering/conversation-final-acceptance.log) | 最终 dist 的真实布局专项                           |
| [final-build.log](artifacts/2026-11-24-studio-rendering/final-build.log)                                                                                                                        | 最终生产 build 与 gzip 输出                        |

图片异步加载专项见下节；VoiceOver 仍未验证。Explorer 的 18 个 baseline 样本全部通过，原始 JSON、失败尝试和固定 harness 继续只保存在 `/tmp/weave-explorer-benchmark-draft/`，不计入 PR1 性能结果。

最终 App 生命周期复核另修复了两项边界：永久删除会话后保留 deleted-ID 与活动版本
栅栏，迟到的 detail、任务导航和恢复观察不能重新填充缓存；exact durable settlement
确认后先移除 handle 再 abort observation controller，释放仍挂起的 SSE reader，
不发送额外 producer cancellation。两个回归均先失败、修复后通过；完整 App 的
136 项测试通过。它们与 pending reveal 的一帧重试一起进入最终构建，原 27 个
正式计时样本仍保留原 dist 指纹。

## 图片加载布局专项

[conversation-image-acceptance.json](artifacts/2026-11-24-studio-rendering/conversation-image-acceptance.json)
在最终生产 dist、Chrome 158.0.8127.36 上通过，errors=[]、failures=[]。生产会话图片
使用 data URL；测试通过现有 SessionDetail 响应加入真实 300×180 PNG，只在浏览器
测试闭包中延迟该 exact data URL 的 src 赋值，在捕获锚点后释放。它验证真实的
load/decode/ResizeObserver 布局过程，不代表慢网络图片测试。

上方已挂载的第 38 行高度从 129.5156px 增至 238.3125px，图片显示高度从 24px
增至 132.7969px，naturalWidth/Height 为 300/180。ResizeObserver 观察的内容高度
从 99.5156px 增至 208.3125px。首个可见锚点保持 benchmark-message-10040
（逻辑 index 40），offset −86→−86px，scrollTop 16349→16457px，挂载 17 行。
完整逻辑列表仍为 100 条、raw records 25,100、每回复 500 工具。

## 最终仓库验证

最终 `pnpm check` 完整通过格式、lint、typecheck、测试和生产构建；Studio 904 项
（79 个文件）、Server 1,899 项（111 个文件）通过。全量并发检查曾暴露 App 精确
定位测试依赖墙钟 rAF 的偶发超时；三项集成测试改为测试内逐帧 act 推进真实组件，
仍检查 exact target，未提高 timeout。另一次服务端既有检索集成测试在默认 1 秒
轮询内未观察到 terminal；隔离文件 6 项通过（目标用例 664ms），随后完整链全部
通过，未修改该无关测试或 Runtime 行为。初次最后检查还曾碰到图片脚本写入期间
的 lint 错误，脚本 globals/import 完成后检查通过。这些失败没有计入性能样本。
