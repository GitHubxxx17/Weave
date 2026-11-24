# Studio Explorer 渲染实测记录

PR2 从会话渲染 PR #111 合并后的 main 单独开始。文件树 before/after 各 18 个样本、3 个同页争用样本全部通过；viewer 36 个样本中 33 个通过、3 个失败。本文保留固定产物、完整结果和真实失败，并明确大文件查看器的未解决限制。

## 环境与 fixture

Apple M4 Pro，macOS darwin/arm64，Node v24.4.0，Chrome 158.0.8127.36，1440×1000。每个样本有独立合成 fixture 和全新浏览器，资源与 JSON no-store。fixture 数据路由不调用真实 Provider、Workspace 或 Git，不读取真实项目文件，仅读取已构建 Studio 静态产物；基准元数据另读取 harness 源码、构建 manifest 和 Git 状态。tree/file/file-diff 返回现有 DTO，合成 Project folderPath 仅标记 UI 可浏览状态。

before 在 PR1 dirty HEAD `f2190032ab23165cbac94f19bbb5ed3e84abb283` 采集，文件树源码来自 `7eb4c72` 且未优化。生产 dist 为 PR1 的 `21b385eb66e5f0d358b9bf3e1c514adcbd16315f9089b697709c2d13f1f4ab1d`（逐文件 manifest 的路径+NUL+raw hash 算法）；Explorer raw 自身以序列化 metadata 算得 distHash，算法不同，不直接比较 hash 字符串。原始脚本固定于 [before-harness](artifacts/2026-11-24-studio-explorer-rendering/before-harness/explorer-runner.mjs)，没有把后续断言修改回写到这些字节。

## 冻结的 before

18/18 样本完成，1,000/10,000/50,000 文件 × wide-root/wide-src × 3 次。所有 first/middle/last 精确路径和文件内容断言通过，广筛选逻辑数与挂载数相等，rare 查询最后精确为 1 条。下表为三次样本中位数；打开首/中/尾文件属于计时外正确性遍历，每个 fileReady 另在 raw 保存。

|   文件 | 形状      | 初树 ms | 展开 ms | 筛选 fill→paint ms | 筛选结果 ms | rare 结果 ms | 广匹配 DOM |
| -----: | --------- | ------: | ------: | -----------------: | ----------: | -----------: | ---------: |
|  1,000 | wide-root |     164 |       — |                 33 |          66 |           32 |      5,527 |
|  1,000 | wide-src  |     163 |      82 |                 51 |          83 |           31 |      5,527 |
| 10,000 | wide-root |     316 |       — |                102 |         135 |          319 |     50,527 |
| 10,000 | wide-src  |     162 |     365 |                198 |         232 |          320 |     50,527 |
| 50,000 | wide-root |   1,084 |       — |                510 |         545 |       12,202 |    250,527 |
| 50,000 | wide-src  |     166 |   3,534 |                882 |         916 |       11,656 |    250,527 |

`fill()` 到两次 rAF 是输入代理，不能称 INP；rAF 间隔不等于 FPS；超过 50ms 的 long-task 片段只作实验代理。50k 完整 DOM 的 Playwright 正确性遍历本身可耗费约 3 分钟，不把全部 CLI wall time 当作筛选或打开文件耗时。

首次失败保留于 [explorer-before-first-failure.json](artifacts/2026-11-24-studio-explorer-rendering/explorer-before-first-failure.json) 和对应 log：380px 侧栏中路径 label 可为零宽，但其完整路径 title 和内容有效。原探针将该 span 的 visible 当作就绪条件而超时，改为 attached+准确内容后重跑完整矩阵。另保留 [aborted-load log](artifacts/2026-11-24-studio-explorer-rendering/explorer-before-aborted-load.log)：并行检查启动后主动中止该次采样，未产生可用样本，没有混入中位数。

## PR2 验证合同

正式 harness 使用仓库相对路径发现 dist，无本机绝对 checkout 或 `/tmp` 默认依赖。Vitest 在 Server test 目录运行 fixture、输入上限、HTTP exact-path、UTF-8 字节/hash、Diff 实体行和独立 fixture/browser 清理回归。timing threshold 留在诊断之外。

相对 before 探针，after 保持初树、展开、`.ts`、rare 与 first/middle/last 动作口径；额外记录 broad 和每次 sentinel scroll 的挂载上限及实际 28px 行高，并在计时外执行 End/Home/ArrowDown 精确焦点验收。挂载上限为 `ceil(viewportHeight/28)+17+focusPin`，focusPin 至多 1 行。before/after harness hash 会不同，这些合同加强不得解释为同字节脚本。

争用探针在同一次 5,000 条工具历史 + 50,000 文件 + 100×20ms tools stream 中顺序编辑 composer 和文件筛选。两次编辑前后 ExecutionService 必须仍为 running；真实键盘只有一个焦点，禁止并发 `fill()` 抢占焦点。验证编辑后的草稿、query、完整 Project/path；工具汇总以 HTTP durable projection 验证，browser reload 后再次核对完整 transcript 与 durable 工具 summary，不把该项冒称 UI 工具徽章验收。

Viewer 诊断默认 36 样本（36 个 fresh fixture/browser 样本，每个样本依次 plain→TypeScript→Diff 三阶段，共 108 个 phase；同一样本的后两阶段受浏览器/模块 warm 顺序影响，报告需保留该顺序，不把阶段当独立 cold samples）：102,400/409,600/1,992,294 UTF-8 bytes × ASCII/多字节 × 单长行/多行 × 3 次。400KiB 指 409,600 bytes；现有高亮 gate 按 UTF-16 code.length≤400,000，二者单位不同。txt/ts sibling 返回同一精确内容，plain/content/diff 独立阶段，HTTP 内容需匹配预期 bytes、code units 与 SHA-256，Diff 实际旧/新第 1 行出现后才算 ready，表头不算。ready 时间戳在 hash 校验前记录，validationStart/End 单列，校验不伪装成渲染耗时。long-task 原始时间戳保留，并按与 render/validation 区间重叠分别列出；跨边界 task 可出现在两组，禁止相加声称独立 CPU 总量。每次 readiness wait 上限 120s、每个阶段 CLI 上限 240s，不冒称整个阶段的总 deadline 为 120s。同步 patch/highlighter/library 准备仍可能主导主线程；本 PR 不添加 worker 或 viewer 行窗口，也不声称已优化。当前 diff DTO 缺少 content.truncated 标记的既有限制保留。

## 当前产物

- [explorer-before.json](artifacts/2026-11-24-studio-explorer-rendering/explorer-before.json)：完整 18 样本及原 fixture/harness/dist/environment 元数据。
- [explorer-before.log](artifacts/2026-11-24-studio-explorer-rendering/explorer-before.log)：采样进度。
- [before-build-manifest.json](artifacts/2026-11-24-studio-explorer-rendering/before-build-manifest.json)：PR1 冻结生产产物逐文件指纹。
- before failure/abort 和固定 harness 均与成功结果并存。

Harness 预检已完成：1k wide-src tree 的首/中/尾及 Home/End/ArrowDown、102,400-byte 多字节多行 viewer 的 plain/highlight/diff、完整 contention 含 reload 均通过。预检与重型检查可能重叠，仅用于断言/选择器验证，不混入正式性能样本。预检暴露的 host URL/TextEncoder 缺失与并发键盘竞态均保留失败证据后修正，没有提高 timeout。fixture/validation/sample-lifetime 与原性能 fixture 共 22 项 Vitest 测试、Server tsc、所改 ESLint 与格式检查通过。

正式结果见以下章节；预检数据不参与正式中位数。

## 正式 after 与同页争用

全部 18 个 tree after 样本与 3 个 contention 样本使用同一冻结生产 dist：`77834acaf4229ce4e5e3c5a780d1951497085426644f5d539c3ec9849679610d`，起始 source hash 为 `76d2f31f3d10068bdf22ab13718b8ea8983d116dbf990d3f0bcb46ff13232e10`，HEAD `eb5f33a3627ad9cccb151068a453224d39cbbd9e`、dirty=true。详见 [after-build-manifest.json](artifacts/2026-11-24-studio-explorer-rendering/after-build-manifest.json)。tree harness hash 为 `d484d110b209326c18c9f98fdfa009031f2e8ffb34c997a67c928c1e9eeaa3bf`；contention 为 `55f2ff02bbd778b058cee57589b7ec551795cf5b8648cb3967e60f2b3942da0d`。前后按阶段采样，没有随机交错或消融 checkpoint，不能分拆索引和窗口各自贡献。

|   文件 | 形状      | 初树 before→after ms | 展开 before→after ms | fill→paint before→after ms | results before→after ms | rare before→after ms | 广匹配 DOM before→after |
| -----: | --------- | -------------------: | -------------------: | -------------------------: | ----------------------: | -------------------: | ----------------------: |
|  1,000 | wide-root |              164→172 |                    — |                      33→33 |                   66→67 |                32→27 |               5,527→733 |
|  1,000 | wide-src  |              163→165 |                82→67 |                      51→33 |                   83→67 |                31→28 |               5,527→733 |
| 10,000 | wide-root |              316→166 |                    — |                     102→33 |                  135→66 |               319→28 |              50,527→733 |
| 10,000 | wide-src  |              162→174 |               365→66 |                     198→34 |                  232→67 |               320→29 |              50,527→733 |
| 50,000 | wide-root |            1,084→179 |                    — |                     510→33 |                  545→66 |            12,202→28 |             250,527→733 |
| 50,000 | wide-src  |              166→213 |             3,534→67 |                     882→33 |                  916→67 |            11,656→30 |             250,527→733 |

18/18 after 通过，fixtureHash 与 before 逐 cell、逐 repeat 相等。广筛选均挂载 41 行；包括首/中/尾和键盘导航的 144 个窗口观测最多挂载 49 行、最多 1 个 roving pin，5,346 个已挂载行高观测均为 28px。54 个首/中/尾文件路径与完整 body 精确一致；54 个 End/Home/ArrowDown 精确焦点通过；rare 精确为 1 条。页面 DOM 的 733 是此固定视口和合成内容的观察值，不是任意附件、viewer 或焦点状态的上界。

初树并非全部加快：1k root 164→172ms、1k src 163→165ms、10k src 162→174ms、50k src 166→213ms 均有回退。折叠目录原本只挂载根目录，而新实现接纳 listing 后需要构建完整浏览器索引；本次不声称消除 HTTP/JSON/全索引成本。主要有证据的改善是大树展开、广匹配/rare 筛选和挂载数量。

同页争用 3/3 通过，联合两次输入到两 rAF 的代理中位 45ms，筛选结果就绪中位 46ms。每轮都确认编辑前后同一 execution 仍为 running，草稿和 `.ts` query 保持、选中的 Project/path 及正文中的准确 identity 标记保持，100 个有序 text token 与 10 个 HTTP durable 工具结果一致，reload 后完整 transcript 包含准确本轮 stream、工具 summary 不变。三轮各一个 59/61/61ms long task，最大 rAF 间隔均为 50ms；这些是此合成负载的观察，不是用户 INP/FPS 或 UI 工具徽章验证。

## Viewer 正式诊断结果与缺口

修订后的 viewer harness hash 为 `9c774e76d7219f1a0857c1c0cc0b057f41bc65aa8fc6194c6e70ef0346412f80`。修订只将已安装 DiffView 的普通/高亮两种真实正文节点都纳入 exact old/new 第 1 行断言；改前首个单行样本的尝试已中止，已完成阶段、DOM 检查与原因保留在 [viewer-first-attempt](artifacts/2026-11-24-studio-explorer-rendering/viewer-first-attempt/failure.json)，未混入正式 36 样本。修订后 source hash 为 `9e42e3f2a3039f1182aa1abc5edcb8e0beb521f5904c58213097cd48e389f4c7`，生产 dist 与 tree/contention 相同；正式 36 样本结束后复算两者一致，见 [viewer-revised-build-manifest.json](artifacts/2026-11-24-studio-explorer-rendering/viewer-revised-build-manifest.json)。

36 个样本完整运行，33 passed、3 failed；108 个 phase 中 102 passed、6 failed。下表只对三次均成功的阶段取中位数；H 为高亮最终就绪、F 为按原有字符 gate 的纯文本 fallback。失败阶段没有 ready 值，30 秒控件定位失败不填成渲染耗时。每个样本的新旧内容 hash 均由同一固定合成 fixture 决定；成功阶段另核对 HTTP 与实际渲染完整文本及 Diff 实际行。

| UTF-8 bytes | 编码   | 行形状 | UTF-16 units | plain 中位 ms | TS 最终中位 ms | Diff 中位 ms |
| ----------: | ------ | ------ | -----------: | ------------: | -------------: | -----------: |
|     102,400 | ASCII  | single |      102,400 |            75 |          607 H |        2,408 |
|     102,400 | ASCII  | multi  |      102,400 |            91 |          326 H |          393 |
|     102,400 | 多字节 | single |       69,632 |            91 |          620 H |        4,379 |
|     102,400 | 多字节 | multi  |       69,632 |            92 |          295 H |          392 |
|     409,600 | ASCII  | single |      409,600 |            92 |           81 F |        2,648 |
|     409,600 | ASCII  | multi  |      409,600 |            92 |           86 F |          397 |
|     409,600 | 多字节 | single |      278,528 |           108 |          689 H |       35,602 |
|     409,600 | 多字节 | multi  |      278,528 |           125 |          841 H |          491 |
|   1,992,294 | ASCII  | single |    1,992,294 |           141 |          127 F |        3,140 |
|   1,992,294 | ASCII  | multi  |    1,992,294 |           208 |          209 F |          464 |
|   1,992,294 | 多字节 | single |    1,354,766 |           328 |       3/3 失败 |     3/3 失败 |
|   1,992,294 | 多字节 | multi  |    1,354,766 |           307 |          291 F |          592 |

成功的 TS 阶段为 18 次 highlight、15 次 fallback。409,600-byte 多字节单行 Diff 三次为约 35 秒，远高于同尺寸多行场景；内容高亮的 400,000-code-unit gate 不约束独立 DiffView，同步 patch/高亮仍可能主导。本次只记录产品现有成本，不引入 worker、换库或行窗口，也不将诊断完成称为性能优化。

plain 的 36 个成功阶段记录了 12 个 render 区间重叠 long task（最大 219ms）和 3 个 validation 区间 long task（最大 140ms）；TS 的 33 个成功阶段为 20 个 render task（最大 510ms）；Diff 的 33 个成功阶段为 54 个 render task（最大 2,659ms）。这按各 phase 数组统计，包括失败样本中已成功的 plain 阶段；不只汇总最终 sample.longTasks，否则会漏掉前置阶段。任务按时间区间重叠归属，不相加成标准 TBT。

近 2MB 多字节单行的三次 plain 均通过，随后 TS 找不到筛选框、Diff 找不到文件标题，均默认 30s 定位超时。独立诊断显示同一次 CLI 调用结束时 URL 为 fixture、title=Weave Studio、filter=1，只有正常 fixture navigation、无 pageerror/crash/close；紧接下一次 CLI 调用却只看到 about:blank。这先将缺失定位到调用之间的页面丢失；后续补充证据进一步确认有 renderer target crash，因此不能只归因于 CLI 页面重选。六个 locator timeout 仍不能当作 Diff 准备耗时。正式 36 原始失败保持不变。

独立同调用三阶段补充验收 3/3 失败，没有混入原矩阵或生成成功中位数。最初三次只留下 CLI 错误；单次补充 debug 保存 CLI stdout 的 `Error: page.evaluate: Target crashed`，最后一次定位则保存 fixture navigation 后的真实 `crash` 事件，失败发生在 plain-content 阶段、尚无 completed phase。这里的 page.evaluate 同时包含页面就绪和完整内容校验，不能凭此再细分产品布局、高亮、合成输入、校验传输或浏览器资源的具体根因。补充验收可能与最终检查重叠，只用作错误/完整性诊断，不用于性能比较。

近 2MB 多字节长单行存在未解决的 renderer 崩溃与内容后续验证缺口；本 PR 的 viewer 工作属于诊断，不声称修复全部大文件性能。本轮没有修改产品来掩盖失败，没有提高既定 timeout，也没有继续无限重试。

## 复现与验证履历

从干净 checkout 先构建内部依赖，再运行生产 browser runner：

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/server/test/performance/explorer-runner.mjs --tree-counts=1000,10000,50000 --tree-shapes=wide-root,wide-src --repeats=3 --output=dist/performance/explorer-after.json
node apps/server/test/performance/contention-runner.mjs --repeats=3 --output=dist/performance/explorer-contention.json
node apps/server/test/performance/viewer-runner.mjs --sizes=102400,409600,1992294 --encodings=ascii,multibyte --line-shapes=single,multi --repeats=3 --output=dist/performance/viewer-diagnostic.json
```

正式采样顺序为 tree18→contention3→viewer36，期间保持生产 dist 不变且没有并行重型检查。before 只保留本轮原始结果，不用会话性能数字代替 Explorer。最终入口 JS 为 1,010,041 bytes、Node gzip 303,092 bytes；相对此 before 冻结 PR1 产物的入口 1,004,046 bytes 增加 5,995 bytes（0.60%）。这里 before 产物早于 PR1 最终 App 生命周期修订，不能将这全部差额独归 Explorer 代码。

结果归档后再次核对的 [final-build-manifest.json](artifacts/2026-11-24-studio-explorer-rendering/final-build-manifest.json)
与 viewer 修订后的源码、全部正式样本的生产 dist 一致；归档和文档编辑没有改变被测产品。

检查曾出现两次未修改代码的失败：MemoryPage 的确认取消焦点断言得到 body 而不是 disabled cancel；随后 official-skills 的真实 Skill 导入/交付测试 5,790ms 超过既定 5s。Memory 隔离 17/17、相关 panel/window 串行 46/46、目标 12/12 通过；Skill 单目标 1 passed/2 skipped、1,042ms。没有修改对应 source/test 或提高 timeout。归档后的最终 `pnpm check` 完整通过格式、lint、typecheck、测试与 build；Server 1,911、Studio 943 测试通过。完整原始日志留在本地 `/tmp/weave-explorer-fullcheck*.log`，报告不把隔离通过解释为证明从未不稳定。

| 原始证据                                                                                                                                                                            | 内容                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [explorer-after.json](artifacts/2026-11-24-studio-explorer-rendering/explorer-after.json) / [log](artifacts/2026-11-24-studio-explorer-rendering/explorer-after.log)                | 18 个正式树样本                                 |
| [explorer-contention.json](artifacts/2026-11-24-studio-explorer-rendering/explorer-contention.json) / [log](artifacts/2026-11-24-studio-explorer-rendering/explorer-contention.log) | 3 个争用样本                                    |
| [viewer-diagnostic.json](artifacts/2026-11-24-studio-explorer-rendering/viewer-diagnostic.json) / [log](artifacts/2026-11-24-studio-explorer-rendering/viewer-diagnostic.log)       | 36 个 viewer 样本，含 3 个失败                  |
| [after-harness](artifacts/2026-11-24-studio-explorer-rendering/after-harness/viewer-runner.mjs)                                                                                     | 实际脚本快照，供 hash 审计                      |
| [viewer-call-boundary-diagnostic.json](artifacts/2026-11-24-studio-explorer-rendering/viewer-call-boundary-diagnostic.json)                                                         | 同调用页面有效、下次调用 about:blank 的独立证据 |

| 补充失败证据                                                                                                                              | 内容                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [viewer-supplemental.json](artifacts/2026-11-24-studio-explorer-rendering/viewer-supplemental.json)                                       | 同调用三阶段的 3 次独立失败，不合并原矩阵            |
| [viewer-supplemental-debug.json](artifacts/2026-11-24-studio-explorer-rendering/viewer-supplemental-debug.json)                           | 单次 debug 保留 CLI stdout 的 Target crashed         |
| [viewer-supplemental-crash-localization.json](artifacts/2026-11-24-studio-explorer-rendering/viewer-supplemental-crash-localization.json) | 单次定位：plain 阶段 crash 事件与失败 phase          |
| [viewer-supplemental-harness.mjs](artifacts/2026-11-24-studio-explorer-rendering/viewer-supplemental-harness.mjs)                         | 最初 3 次补充验收的固定脚本；scriptHash 对应原始字节 |
