# MCP Server Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本地 stdio MCP 配置、精确信任、启动与 Generation 管理接入现有 Server 唯一协调器。

**Architecture:** 单独 append-only authority log 保存规范启动配置与决定，source读取授权后创建每代独立连接/合成插件；HTTP只是校验后调用manager。协调器统一 ESM/MCP，管理变更同步阻断失去授权的当前代。

**Tech Stack:** strict TypeScript ESM、Zod、node:sqlite、node:fs/path/crypto、现有 Hono/Kernel/coordinator。

**Spec:** [Stage5](../specs/2026-11-21-mcp-stdio-design.md) §4/7/8。

## Global Constraints

- Config <=8服务/64KiB，id lowercase hyphen<=24，label<=80，command/cwd规范realpath绝对存在，args<=64每项4096bytes。
- env<=32目标到fromHostEnv，变量名限制，目标/引用均大小写无关禁止WEAVE_；Windows各集合大小写别名拒绝/规范大写；不存值。
- 摘要canonical sorted-key JSON包括policyVersion1、不包括label和秘密值；信任配置不是代码签名。
- 所有写入CAS expectedSequence，连续事件/完整历史校验，损坏/回退不是空；remove tombstone。
- 未受信不spawn；trust精确摘要启用；enabled需当前信任；摘要改变停用失信；label-only保留信任。
- candidate/current/retired总进程32；无重连/重放；stale只标记，必须显式重建。
- HTTP读缓存；写复用JSON/Host/Origin/Sec-Fetch-Site；管理不注册model tool。
- 唯一coordinator发布完整Generation；同步observer更新authority后await前阻断；append失败不block。
- pin旧代独立连接到最后回合释放；立即撤销取消全部session/退役代；source先关，DB最后关。

### Task1: canonical config/environment/authority

**Files:** apps/server/src/mcp-{management-types,environment,authority-store}.ts,test/相应文件。

- [ ] 配置路径/shape/digest/env引用/Windows别名/WEAVE前缀失败测试，真实临时路径与symlink消失。
- [ ] schema+canonicalizeConfig异步stat/realpath再digest；resolveEnvironment只读取明确引用返回env/redactValues，不扩散整个宿主环境；缺变量安全失败。
- [ ] 独立SQLite表事件流，append(command,expectedSequence)事务读取完整历史fold校验后追加；高水位/prefix回放保证。
- [ ] store重启/CAS/损坏/回退/无秘密/label-only/config变化/tombstone行为测试。

### Task2: source and unified generation

**Files:** mcp-source.ts,extension-types/coordinator/local-plugin-host.ts,test/mcp-source.test.ts与extension-coordinator扩展。

- [ ] 写未受信绝不连接、每代新连接、单服务隔离、processbudget及旧pin测试。
- [ ] source同步observer、revision stamp、prepare/recheck/close幂等，管理mutation封装coordinator队列。attempt绑定closed/stale；当前health失败不被registry掩盖。
- [ ] coordinator显式force rebuild，公开保留generation成员/发布通知以health映射当前/retired归属；不伪造authority身份变化。
- [ ] 跨来源durable撤销+失败+ESMreload不复活、append失败不取消、immediate retry取消退役、close取消候选/全部回合、cleanup各一次。

### Task3: guarded HTTP/startup/restart

**Files:** mcp-api.ts,app.ts,main.ts,plugin-write-guard.ts,test/mcp-api.test.ts,test/mcp-integration.test.ts。

- [ ] GET缓存不会spawn，配置与信任CAS/digest409，所有写守卫覆盖，错误无环境值/原异常。
- [ ] 启动注册source+manager，store与连接所有权纳入shutdown，ESM可禁用但MCP仍可管理。
- [ ] 路由create/put/trust/enable/disable/revoke/remove/reload薄适配；响应真实generation/admission及applied/failed。
- [ ] 真实stdio fixture HTTP添加→trust→reload→restart，加source/协调器测试覆盖旧pin、stale及立即撤销；工具调用已在5.2验证，完整UI生命周期于5.4验收，源码无管理工具贡献。
- [ ] spec/Foundation更新具体跨包契约先于代码，独立审查+rootcheck+CI，PR squash，再Studio分支。

### Preflight decisions to incorporate before implementation

- Coordinator explicit force for management reload/mutate, preserve CAS per request queue, no fake authority revision changes for stale/EOF.
- Prepared items gain optional host-only instanceId plus synchronous readiness guard; final no-await guard fails attributable item before commit if EOF occurred during another source await. Coordinator retains instanceId in per-generation members and exposes current/draining member snapshots. MCP source owns ledger keyed exact instanceId; facade projects generation by those retained members, avoiding async postcommit callbacks.
- Shared budget reserves complete eligible set before first spawn (max32 allocations). No early release on onClosed; successful awaited dispose releases, failed cleanup quarantines. Client connect close-failure code must remain observable so source can quarantine failed initialization allocation; update contract/design before editing client.
- Main creates independent MCP authority store even ESM disabled; closes after coordinator/source. Thin App adds MCP manager and PUT CORS. shared write guard gets generic extension management wording.
- Config creation rejects pluginId collision with current/configured/discovered ESM IDs; kernel assembly collision attribution still rejects later conflicts without overwrite.
