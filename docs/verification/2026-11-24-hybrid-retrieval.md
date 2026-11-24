# Hybrid retrieval verification

验证日期为 2026-11-24。实验运行在 Apple M4 Pro、12 核、24 GiB 内存、macOS
Darwin 24.6.0、Node v24.4.0 和 SQLite 3.50.2 上。实验使用确定性的 512 维单位向量
检查存储、排序、取消和资源回收，无需 OpenAI 凭据。真实服务的语义质量、可用性和计费
未实测。

## Store and worker

`@weave/retrieval` 的 SQLite 测试包含 9 个 Store 场景和算法测试的 10 个场景，
共 19 个测试通过。覆盖内容包括：

- accepted、started、staging、原子 publish、完成回执、关闭后重开和 active projection 重建。
- append-only 事件的 UPDATE/DELETE 拒绝、损坏派生状态、回执提交确认丢失和
  不确定写入期间的写入冻结。
- active、previous 和 staging 代次的 reader lease 保留与 generation cap。
- FTS5 capability probe、部分启动清理、第二进程 owner 排他、SIGKILL 后恢复。
- Worker 的 lexical/hybrid 查询、project/root/generation 隔离、source/path 过滤、
  RRF、取消和真实 Worker exit 后的容量释放。

24 条固定 ground-truth 样例全部在 top 5 找到目标，包含 8 条代码标识符和路径、
8 条中文、4 条 project Memory 标签、4 条同名跨 scope 样例。每条结果都重新读取
citation，并验证错误 chunk digest 被拒绝。禁用 Memory access 后，Memory 查询返回
空结果，跨 project 内容不会进入候选。

## 20,000 chunk benchmark

执行 `pnpm --filter @weave/retrieval build` 后运行
`node packages/retrieval/test/benchmark.mjs`。构建计时一次，随后执行 20 轮查询。
每轮先关闭并重开 Store，再依次测 hybrid、warm hybrid 和 warm lexical。
重开完成后开始查询计时，操作系统页缓存保留。下表时间单位为毫秒，
RSS 记录整个 Node 进程峰值，单位为 MiB。

| 指标                    |          结果 |
| ----------------------- | ------------: |
| 构建 20,000 chunks      |       2,888.3 |
| 重开后 hybrid p50 / p95 | 156.4 / 159.6 |
| warm hybrid p50 / p95   | 154.5 / 158.7 |
| warm lexical p50 / p95  |   79.8 / 82.6 |
| cancel 到 Worker exit   |           2.1 |
| 进程峰值 RSS            |         360.1 |

脚本生成测试语料与向量，并输出设备、Node 和 SQLite 版本。

## Studio browser acceptance

通过 Playwright Chromium 操作 Studio 开发页面和构建后的本地 Server。使用两个独立的
临时项目，第一个项目的 TypeScript 文件包含 `normalizeCacheKey` 和中文注释。

- 未配置向量服务时，确认默认使用本地词法模式。创建预览并展开采集正文后构建索引，
  通过符号和中文查询命中文件，并打开已验证的正文、定位到命中行。
- 修改磁盘文件后，重新打开原引用显示来源已变更。重建发布后查询到新增文本，
  切换到另一个项目后界面清除了原项目结果，并显示该项目尚未构建索引。
- 混合流程向实际 Server 注入离线 embedding 传输替身。展开混合预览后核对显示的
  目标和正文，点击发送确认后替身收到预览中的精确片段，随后点击取消。替身观察到
  abort，历史记录显示已取消，索引未发布。

截图保留在本机临时目录。词法搜索和来源定位位于
`/tmp/weave-retrieval-browser.png`，混合预览与已取消状态分别位于
`/tmp/weave-retrieval-hybrid-preview.png` 和
`/tmp/weave-retrieval-hybrid-cancelled.png`。浏览器验收使用临时语料和离线替身，
未使用真实提供商密钥或向外部服务发送数据。
