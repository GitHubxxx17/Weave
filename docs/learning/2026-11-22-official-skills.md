# Weave 维护的使用与开发 Skills

首批包位于 `plugins/official/weave-official-skills/`，包含四项可以独立选择的指南：

| Skill               | 用途                                                   |
| ------------------- | ------------------------------------------------------ |
| weave-guide         | Studio/Runtime 的现有功能、安装生效、来源与回合状态    |
| weave-plugin-author | 真实 SDK、Tool/Command/声明式面板、本地 CLI 和发行准备 |
| weave-skill-author  | SKILL.md、触发描述、渐进资源、文本包及精确身份         |
| weave-mcp-guide     | 本地 stdio MCP 配置、启动信任、调用审批与排查          |

内容由 Weave 维护，采用已核对的 Codex、DeepSeek Harness、Kimi 固定版本与 Kiro 官方文档
参考原则；原文归属与取舍见[参考审计](2026-11-22-official-plugin-references.md)。
包内是原创、可独立安装阅读的版本快照，记录已合并的产品契约 SHA。不是 upstream
Skills 的复制，也不继承其它产品的沙箱、权限或认证保证。

## 本地使用

本目录就是 schema-2、`host:declarative` 的 payload，无可执行入口、权限声明或
自动下载脚本。每项正文仅引用同 bundle 的资源，资源中的源码路径用于维护溯源。
示例源码和配置是惰性文本，加载不会执行，也不会授权管理操作。

从实际 Weave checkout 根目录检查与打包，替换为实际绝对路径和新的输出目录：

```sh
pnpm plugin:validate --artifact /absolute/path/to/weave/plugins/official/weave-official-skills
pnpm plugin:pack --artifact /absolute/path/to/weave/plugins/official/weave-official-skills --out /absolute/path/to/new-release
```

在左侧“插件市场 → 已安装”导入真实 payload，审阅 manifest、摘要和内容，再独立
激活。在 Session Composer 选择相应 Skill，或由模型按本轮目录的精确引用按需读取。
导入、信任、激活、请求、准备正文和模型工具交付是不同事实。显式选择记录 user /
prepared；模型通过正常工具完整读取正文并持久保存对应 EOF 结果后，才有 model /
delivered。不能因为助手回复中提到指南就声称完成交付。

## “官方”标识如何确定

内置插件由宿主代码提供。需要安装的官方 GitHub 插件则必须匹配宿主固定发行表中
的完整 manifest、规范化仓库地址、40 位 commit 与精确子目录。对象字段顺序无关，
数组顺序和显式可选字段仍是完整身份的一部分。索引没有 `category` 输入字段。
发布者写 `Weave`、包 ID 使用 `weave-` 前缀或索引取名“官方”，都不能取得官方标识。

准确发行被自定义索引转载时，内容仍显示 Weave 维护，索引源另行展示。宿主提供
官方名称、描述、署名和标签；索引不能覆盖这些展示文字。GitHub 官方包仍显示
“需要安装”，经过同一获取、预览、导入、独立审阅激活和审批流程，没有特殊权限。
受管目录中的当前选择和实际激活版本始终来自本地 authority，不能从市场条目推断。

受保护官方 ID 的未知版本、错误来源、变更 manifest 或混合未知 release 会使整个
索引无效。旧宿主遇到未来发行时保留最后有效快照并显示 stale/unavailable；首次
拉取即无效时没有该源条目。随构建发布的目录与宿主发行表同步。该保护仅限市场
发现，不把安装包 ID 加入内置保留集合；明确本地导入仍走普通命名空间和审阅规则，
包内署名本身不提供官方来源证明。

## 固定版本发行与验证范围

内容先合并，然后另一个发行索引 PR 使用真实内容合并 SHA。维护者先核对该提交
中的实际 descriptor 并登记完整发行元组，再用 `marketplace:entry` 实际获取固定
GitHub 内容并检验，成功后生成 submission/index。不能填写未来 SHA、分支、标签
或全零占位，也不能用本地 receipt 替代实际远程获取。内容提交和索引提交 SHA 可以
不同；source-notes 记录已存在的产品契约，避免要求文档写入自身未来提交 SHA。

当前内容/机制主题不会预填尚不存在的发行元组；真实固定来源与索引合并记录由后续
发行主题补充。随构建携带的默认 index 不等于已部署外部在线市场。

## 内容与机制验证记录

全仓 `pnpm check` 通过，共 4,172 项测试；`marketplace:check` 通过。四项正文、
25 份资源和17条显式相对引用均经真实 Host/CLI 校验；Tool/Command 示例通过真实
CLI 编译和打包，Panel 与 MCP 示例通过实际 schema。31个文件格式化后的发行摘要
为 `2676bbc50d704184cc3eddfc414d1ede981fc7f6a137c5f1046db213b38548be`。

23个内容场景经过独立前向练习或知情源码审阅，两种方法明确区分；当前 Panel 指南
另经实际 SDK 创建、编译、打包与 Kernel/Server 绑定核验。这里没有宣称任意模型
必然遵循指南。

真实临时 Server/HTTP/SSE/SQLite 验收覆盖四项内容的精确正文和资源 EOF/hash、
惰性导入、独立激活、请求/准备/模型交付的持久区别，以及删除来源后的重启恢复。
另验证项目同名来源隔离、资源更新后旧引用 stale、旧回合保留旧资源、回滚、停用
和撤销。固定 SHA 的 GitHub 实际获取属于下一发行主题，不能以这些离线测试替代。
