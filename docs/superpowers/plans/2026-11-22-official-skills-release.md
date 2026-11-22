# 首个固定版本官方 Skills 市场发行

设计依据：`docs/superpowers/specs/2026-11-22-official-skills-design.md`。
本主题完成官方 Skills 总计划的 Task 5，内容与身份机制已在 PR #98 合并。

## 发行身份

- 独立分支：`feat/official-skills-marketplace-release`。
- 起点与制品来源均为真实内容合并提交 `5809b6a8fe2d987735a3dbd782df1bff1fd5af43`。
- 仓库 `https://github.com/githubxxx17/weave`，子目录 `plugins/official/weave-official-skills`。
- 版本 `1.0.0`；完整 manifest 必须与该提交中的 descriptor 一致。
- 内容目录保持不变；source-notes 保留已存在的产品契约 SHA，避免自引用未来提交。

## 执行与验证

- [x] 从最新实际 `origin/main` 创建独立主题分支，保留其它工作区。
- [x] 读取已提交 descriptor，先登记宿主完整发行身份，不加入安装器或内置保留 ID。
- [x] 使用真实 GitHub 获取器运行市场条目准备，校验提交、目录、31 个文件的 blob SHA、大小和内容；公网失败保留证据，后续重试成功，无本地替代数据。
- [x] 生成 submission 和确定性默认 index；`marketplace:generate`、`marketplace:check` 通过。
- [x] 新增实际发行身份测试：默认目录、完整 manifest/source、修改/未来发行拒绝、自定义镜像来源、最后有效缓存、普通本地导入仍无激活权限。
- [x] 更新旧目录测试：禁用本地覆盖项后读取默认 Weave 目录，官方发行仍可发现，自定义社区项不出现。
- [x] 实际临时 Server、SQLite、Vite 浏览器：默认市场详情、固定来源交接、桌面与窄屏通过；真实远程预览被网络超时和随后匿名配额阻断，保持空候选并正确展示错误。单独使用同提交/摘要本地包完成惰性导入、独立激活、四项技能选择、显式发送、重启与 user/prepared 审计；不将其冒充远程完整安装成功。
- [x] 同步使用指南、发行证据和验证范围；发行不等同外部在线市场部署。
- [x] 独立复核通过；完整 `pnpm check` 4,185 项测试通过，市场校验通过。公网浏览器验证限制明确记录，不修改生产传输规则绕过。
- [ ] 中文 Conventional Commit、显式推送同名功能分支、创建并附加 PR；CI 通过、绑定精确 HEAD 的 squash merge、删除远程功能分支。

## 边界与证据

离线发行测试使用实际宿主表、已提交 payload 和生成目录，不把测试表注入生产。
真实网络获取是独立门槛；内容交付、重启、回滚和旧回合资源保持另由已合并的真实
HTTP/SSE/SQLite 验收测试覆盖。市场官方归属不改变信任、审批、工具管线或运行边界。
