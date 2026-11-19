# 写前存原文 + 撤销（L6 后端）设计

状态：草案（动码前）。基线 main `9c99abd`。本篇**只做后端**：捕获原文、持久化可撤销事件、提供"把某轮改动恢复到原文"的能力。撤销按钮与 diff 视图属于 UI，留到道 1 合并后另起 lane。

## 背景与范围

`edit_file` / `write_file`（#40）写入后，面板不保存修改前内容、无法撤销。本篇让每次写入前捕获原文件内容，记成一条可撤销的 session 事件，并提供按「轮」恢复原文的能力。

**只改**：`packages/session`（事件 + 收集器）、`packages/runtime`（`workspace-file-tools` 捕获 + 新增 restore 函数）、`apps/server`（装配 + 恢复接口）。撤销事件是 session 自己的持久事件，不涉及 `protocol`。
**不碰**：`tool-pipeline`、`approval-*`（道 1）、`apps/studio/src/app/App.tsx`、审批 UI。

## 契约

**新 session 事件 `workspace.file-snapshot`**（`packages/session/src/events.ts` 两个 schema 都加）
payload：
- `path: string` — 相对工作区根的 posix 路径。
- `existedBefore: boolean` — 写入前文件是否存在。
- `previousContent: string` — 写入前的 UTF-8 原文（`existedBefore=false` 时为 `''`）。

说明：原文直接存进事件（本地 sqlite，受 `maxWriteBytes≈1MB` 上限约束）。事件由 edit/write 工具在写入前通过注入回调追加，位置落在该次工具调用的 `tool-call.created` 与 `tool-result.created` 之间。

**轮归属**：工具不知道 `turnId`。恢复侧读取事件流、跟踪"运行中的轮"（`turn.started`/`turn.completed` 之间，等价投影里的 `activeTurnId`），把快照归到当时运行的轮。投影（`projection.ts`）对未知事件类型天然忽略（if/else-if 链无终端抛错），故**不改投影**。

## 捕获（runtime `workspace-file-tools.ts`）

- `WorkspaceFileToolOptions` 新增可选 `onFileSnapshot?: (input: { sessionId?: string; path: string; existedBefore: boolean; previousContent: string }) => void | Promise<void>`。
- `writeWorkspaceFile`：`planWrite` 已知 `existed`/`target`；写入前，若 `existed` 读 `previousContent`，否则 `existedBefore=false`、`previousContent=''`；调用 `onFileSnapshot`（有回调且捕获成功时）后再写。
- `editWorkspaceFile`：`planEdit` 已读到原文 `file.content`，直接作为 `previousContent`、`existedBefore=true`。
- 回调失败不应阻断写入主流程（best-effort 记录；失败只跳过快照）。无 `onFileSnapshot` 或无 `sessionId` 时不记录（纯 runtime 单测场景）。

## 恢复

**runtime 恢复函数** `restoreFileSnapshot(snapshot, workspace)`（新 `packages/runtime/src/file-undo.ts`）：
- `existedBefore=true` → 用 `previousContent` 覆盖写回；`existedBefore=false` → 删除该文件（撤销新建）。
- 路径安全：复用工作区策略（`resolveLexicalPath` + 根内校验），拒绝越界；只写工作区内。

**session 收集器** `collectFileUndo(events)`（`packages/session`）：读事件流，按轮归属，返回 `Array<{ turnId, snapshots }>`；每个路径在一轮内只保留**第一条**快照（= 该轮触碰前的原始状态），供"撤销整轮"。

**server 恢复接口**（新 `apps/server/src/file-undo-api.ts`，挂到 `app.ts`）
`POST /projects/:projectId/sessions/:sessionId/undo`，body `{ turnId }`：读该会话事件 → `collectFileUndo` 取该轮快照 → 对每条 `restoreFileSnapshot`（用该项目工作区策略）→ 返回 `{ restored: string[] }`。只读事件 + 写回工作区文件，路径受策略约束。

## 装配（server `runtime.ts`）

`createWorkspaceFileTools({ resolveWorkspace, onFileSnapshot })`，`onFileSnapshot` 把快照作为 `workspace.file-snapshot` 事件 append 到 session store（仿 recall 的注入式 resolver）。

## 兼容性

- 新事件类型为新增；旧投影忽略；`newSessionEventSchema`/`sessionEventSchema` 加判别分支即可。
- `onFileSnapshot` 可选：不传则行为与现状一致（runtime 既有测试不受影响）。

## 测试

- runtime：edit/write 在写入前回调 `onFileSnapshot` 且参数正确（新建→existedBefore=false；覆盖/编辑→带原文）；回调抛错不阻断写入；`restoreFileSnapshot` 覆盖写回与删除新建、越界路径被拒。
- session：`collectFileUndo` 按轮归属、每路径取首条、忽略其它事件。
- server：装配后 edit/write 产生 `workspace.file-snapshot` 事件；`POST .../undo` 恢复一轮改动（覆盖写回 + 删除新建），路径安全。
- `pnpm check` 全绿。UI 未实测（本篇无 UI）。

## 分期

本篇=后端全部。UI（撤销按钮 + diff 视图）接在道 1 合并后，读 `collectFileUndo`/调用 undo 接口。
