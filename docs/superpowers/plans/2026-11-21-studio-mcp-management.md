# Studio MCP Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** 在Studio维护本地MCP启动配置，独立审阅信任并管理完整生命周期，复用现有工具执行体验。

**Architecture:** 现有app-owned PluginCatalogStore扩展MCP联合目录及统一写门，浏览器仅HTTP。MCP组件复用PluginDialog焦点外壳，信任只使用Server规范配置的捕获快照。/mcp健康权威与/plugins注册表通过完整generation/admission投影有界配对后原子显示。

**Tech Stack:** React19、strict TypeScript ESM、Zod4.6.7、fetch、Vitest/TestingLibrary，现有CSS和浏览器工具；不新增依赖。

**Spec:** ../specs/2026-11-21-mcp-stdio-design.md §9/10.5。

## Global constraints

- Studio不导入@weave/*、Node、Electron、Server源码或SDK；不读取环境或Provider凭据，不计算信任摘要。
- DTO逐字段验证；preserve own **proto** JSON/env字段；展示纯文本，schema/annotations不执行。
- 保存配置与信任分离；信任绑定捕获的authoritySequence/configDigest/canonical config，409 refetch+review失效，绝不补新token重投。
- GET配对最多3轮，完整比较generation id/acceptingRuns/blocked；失败保留上一致快照并标旧/禁操作，持久决定结果另存。
- App单写门协调ESM/MCP；卸载不取消持久请求；初始/旧GET不得覆盖新mutation；面板激活GET-only，显式reload才创建新代。
- 立即停用/撤销/移除选项始终可用，明确取消所有session和退役回合，不按当前可见running状态隐去或改写。
- 规范配置<=8live、args<=64每项4096bytes、env<=32只允许目标/宿主引用名；Server规范路径和平台规则最终权威。

### Task1 HTTP DTO + joint store

Files features/mcp/mcp-{types,api,review}.ts, plugins/{plugin-types,plugin-catalog-store,plugin-catalog-context}.tsx/.ts, tests/mcp-{api,store}.test.ts + affected plugin tests.

- [x] RED读/写保留topgeneration、准确路由method/body、JSON特殊键。
- [x] 实现browser DTO与API，typed MCP errors及safeChinese fallbacks，保留200 appliedfalse。
- [x] RED联合目录generation一致/同id不同admission不一致/3轮停/失败保留durableoutcome/409不重投/旧GET不覆盖/全局写门。
- [x] 单store扩展mcp/consistency/reviewEpoch/lastMcpResult/actions，初始并行GET并原子publish。兼容明确mcp-management-disabled404的旧server。
- [x] 暴露refresh()只GET，reload()MCPavailable时POST/mcp/reload；ESMactions原路由并seed后配对。
- [x] scoped tests+typecheck/lint，独立审查。

### Task2 config/trust/decision dialogs

Files features/mcp/mcp-{config-dialog,trust-dialog,decision-dialog}.tsx, mcp-dialog.css, test/mcp-dialogs.test.tsx.

- [x] RED保存精确argv空值/顺序、env行重复/特殊键、校验、保存不会自动信任。
- [x] Config收集ID,label,command,cwd,argsJSONarray和target/reference rows；保存捕获sequence，编辑ID只读，409保留draft但禁止旧token重试。
- [x] Trust显示完整canonical命令/argv/cwd/envreferences/digest及reviewed字段diff，说明系统环境继承、普通进程权限、配置摘要不证明代码、启动后工具高风险。
- [x] Decision说明disable保留trust/revoke清除/remove留历史，默认下一回合，immediate始终可选并原样提交。
- [x] 复用PluginDialog的Cancel默认焦点/Escape/Tab/inert/返回焦点，pending卸载仍保留store请求，短窗口滚动。
- [x] scoped tests+typecheck/lint，独立审查。

### Task3 MCP panel + application integration

Files features/mcp/mcp-panel.tsx, plugins/plugins-panel.tsx, panels/panel-container.tsx, badge/App minimal, test/mcp-panel.test.tsx + affected tests.

- [x] RED同代MCP健康优先/registry只一次/孤立行只读/failed+stale/disabled仍active/draining。
- [x] panel可添加/编辑/信任/启用/停用/撤销/移除/全量重载，统一busy+consistency gate；显示持久sequence/resultfailure和实际generation。
- [x] 面板激活只GET；store在App存活，MCPpending审阅badge；所有组件仅共享store，未通过组件发工具请求。
- [x] root完整check和独立wholebranch审查。

### Task4 real browser and Electron acceptance

- [x] 自有stdio fixture通过真实浏览器保存→untrusted→取消审阅零启动→trust→工具审批/调用→stale→显式reload→配置差异→撤销/立即取消→重启恢复。
- [x] 360x640和640x420无document横溢出，dialog按钮可达，键盘focus正确。
- [x] 真正Electron主进程启动Server/stdio并关闭与重启恢复，不声称安装包验证；用临时userData不动用户持久库。
- [x] fullcheck通过，review修复。

交付采用独立功能 PR，CI 通过后 squash 合入 main，下一项另建分支；合入状态以 GitHub PR 为准。
