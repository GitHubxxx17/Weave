# Workspace Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `@weave/runtime` 增加经过 Workspace Policy 和 Tool Pipeline 保护的 UTF-8 文件读取与写入工具。

**Architecture:** `workspace-file-tools.ts` 返回标准 `ToolDefinition`。每次执行先
通过 `WorkspacePolicy` 做词法校验，再用 `realpath`、`lstat` 和 `stat` 检查真实
文件边界，最后调用 Node 文件 API。文件工具不实现 Approval、Shell 或 Agent
多步循环。

**Tech Stack:** TypeScript、ESM、Node.js 内置 `node:fs/promises` 和 `node:path`、Zod、Vitest、pnpm workspace、Turborepo。

**Spec:** `docs/superpowers/specs/2026-11-15-workspace-files-design.md`

## Global Constraints

- TypeScript、ESM、strict typing。
- 文件工具必须作为 `ToolDefinition` 通过共享 `ToolPipeline` 执行。
- 外部输入先经过 Zod。
- 路径先经过 `WorkspacePolicy`，真实访问前再次检查 `realpath` 和文件类型。
- 不允许符号链接最终目标逃逸 Workspace 根目录。
- 只支持 UTF-8 文本，不支持二进制协议。
- 读取和写入有 UTF-8 字节限制。
- 写入默认不覆盖，`overwrite: true` 才允许覆盖。
- 不自动创建父目录。
- 不实现 Approval、Shell、Diff、Agent Tool Loop、HTTP/SSE。
- 不增加外部运行时依赖。
- 测试放在 `packages/runtime/test/`。
- 每个行为先写失败测试，再实现最小代码。

## 文件地图

- Create: `packages/runtime/src/workspace-file-types.ts`
  - 输入 Schema、工具选项、结果类型和错误类。
- Create: `packages/runtime/src/workspace-file-tools.ts`
  - `read_file` / `write_file` 的 Tool Definition 和文件系统边界检查。
- Create: `packages/runtime/test/workspace-file-tools.test.ts`
  - 临时目录中的读取、写入、越界、符号链接、大小和 Pipeline 测试。
- Modify: `packages/runtime/src/index.ts`
  - 导出文件工具公共 API。
- Modify: `README.md`
  - 增加 Workspace File Tools 的使用和边界说明。
- Modify: `docs/architecture/foundation.md`
  - 更新 Workspace 到 File Executor 的数据流。

### Task 1: Define File Tool Contracts

**Files:**

- Create: `packages/runtime/src/workspace-file-types.ts`
- Create: `packages/runtime/test/workspace-file-tools.test.ts`

**Interfaces:**

```ts
export interface ReadFileInput {
  readonly path: string;
  readonly maxBytes?: number;
}

export interface WriteFileInput {
  readonly path: string;
  readonly content: string;
  readonly overwrite?: boolean;
  readonly maxBytes?: number;
}

export interface WriteFileResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly overwritten: boolean;
}

export type WorkspaceFileErrorCode =
  | 'workspace-file-invalid-input'
  | 'workspace-file-not-found'
  | 'workspace-file-outside-root'
  | 'workspace-file-symlink-outside-root'
  | 'workspace-file-is-directory'
  | 'workspace-file-already-exists'
  | 'workspace-file-too-large'
  | 'workspace-file-permission-denied'
  | 'workspace-file-cancelled'
  | 'workspace-file-read-failed'
  | 'workspace-file-write-failed';
```

- [x] **Step 1: Write failing schema and error tests**

Add tests for valid `readFileInputSchema`, valid `writeFileInputSchema`,
non-empty paths, non-negative finite `maxBytes`, the `overwrite` boolean, and
the `WorkspaceFileError` name/code/cause contract.

- [x] **Step 2: Run the focused test and verify the expected failure**

```bash
pnpm exec vitest run packages/runtime/test/workspace-file-tools.test.ts --config vitest.config.ts
```

Expected: FAIL because the file tool contract exports do not exist.

- [x] **Step 3: Implement schemas and error class**

Use Zod schemas with `z.string().min(1)`, finite non-negative numeric limits,
and optional booleans. Export only public schemas, types, and the stable error
class. Preserve Node errors through `ErrorOptions.cause`.

- [x] **Step 4: Run contract tests**

Run the focused Vitest command again. Contract tests must pass before adding
filesystem behavior.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/workspace-file-types.ts packages/runtime/test/workspace-file-tools.test.ts
git commit -m "feat: 增加工作区文件工具契约"
```

### Task 2: Implement Protected Read and Write Tools

**Files:**

- Create: `packages/runtime/src/workspace-file-tools.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/test/workspace-file-tools.test.ts`

**Interfaces:**

```ts
export interface WorkspaceFileToolOptions {
  readonly workspace: WorkspacePolicy;
  readonly maxReadBytes?: number;
  readonly maxWriteBytes?: number;
}

export interface WorkspaceFileTools {
  readonly readFile: ToolDefinition<ReadFileInput, string>;
  readonly writeFile: ToolDefinition<WriteFileInput, WriteFileResult>;
}

export function createWorkspaceFileTools(options: WorkspaceFileToolOptions): WorkspaceFileTools;
```

- [x] **Step 1: Add failing filesystem behavior tests**

Use `mkdtemp` in the OS temp directory and clean it with `rm` in `afterEach`.
Register both tools in a Tool Registry and execute through a Tool Pipeline.
Test:

```ts
const tools = createWorkspaceFileTools({
  workspace: createWorkspacePolicy({ root }),
  maxReadBytes: 1024,
  maxWriteBytes: 1024,
});
registry.register(tools.readFile);
registry.register(tools.writeFile);

const result = await pipeline.execute({
  toolCallId: 'call-1',
  name: 'read_file',
  arguments: JSON.stringify({ path: 'src/index.ts' }),
});
```

Add cases for successful read/write, default overwrite rejection,
`overwrite: true`, directories, missing paths, missing parent, traversal,
absolute paths, external symlinks, internal symlinks, read and write limits,
and cancellation.

- [x] **Step 2: Run the focused tests and verify the expected failures**

```bash
pnpm exec vitest run packages/runtime/test/workspace-file-tools.test.ts --config vitest.config.ts
```

Expected: contract tests may pass, while filesystem tests fail because the
factory is not implemented.

- [x] **Step 3: Implement real path helpers**

In `workspace-file-tools.ts`:

1. Validate factory defaults as finite non-negative numbers.
2. Convert `WorkspacePolicyError` to `WorkspaceFileError`.
3. Resolve `workspace.root` and candidate targets with `realpath`.
4. Use `path.relative(realRoot, realTarget)` to reject real targets outside root.
5. Map `ENOENT`, `EACCES`, and `EPERM` to stable errors.
6. Map `EISDIR` and existing target conditions to directory/overwrite errors.
7. Preserve original Node errors as `cause`.

- [x] **Step 4: Implement `read_file`**

Before `readFile`:

- validate input;
- call `workspace.resolve(path, 'read')`;
- resolve the root and target real paths;
- `stat` the real target;
- reject directories;
- reject files whose byte size is above the effective limit;
- check `signal.throwIfAborted()`;
- call `fs.readFile(realTarget, { encoding: 'utf8', signal })`;
- check the UTF-8 byte length and return the text.

- [x] **Step 5: Implement `write_file`**

Before `writeFile`:

- validate input and UTF-8 byte size;
- call `workspace.resolve(path, 'write')`;
- resolve the root real path;
- if the target exists, resolve its real path and reject external links/directories;
- if the target does not exist, resolve the parent real path and reject a missing parent or external parent;
- use the real target path or real parent plus basename;
- use `flag: 'wx'` unless `overwrite` is true, otherwise `flag: 'w'`;
- pass the Pipeline signal;
- return relative path, bytes written, and overwritten status.

- [x] **Step 6: Export the API**

Update `packages/runtime/src/index.ts` with the schemas, error class, types,
`createWorkspaceFileTools`, and `WorkspaceFileTools`.

- [x] **Step 7: Run focused tests**

```bash
pnpm exec vitest run packages/runtime/test/workspace-file-tools.test.ts --config vitest.config.ts
```

Expected: all file tool tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/runtime/src/workspace-file-tools.ts packages/runtime/src/index.ts packages/runtime/test/workspace-file-tools.test.ts
git commit -m "feat: 增加工作区文件读写工具"
```

### Task 3: Update Architecture and Learning Material

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture/foundation.md`
- Modify: `docs/superpowers/specs/2026-11-15-workspace-files-design.md`
- Modify: `docs/superpowers/plans/2026-11-15-workspace-files.md`

- [x] **Step 1: Update README**

Document the factory, Tool Pipeline registration, UTF-8 limits, overwrite
behavior, and the fact that Approval is still not implemented.

- [x] **Step 2: Update the architecture guide**

Document the distinction between lexical Workspace policy and real filesystem
checks, including symlink handling and the remaining TOCTOU limitation.

- [x] **Step 3: Record implementation evidence**

Append the actual test count and verification status to the design document.
Mark plan steps only after the commands in Task 4 pass.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/architecture/foundation.md docs/superpowers/specs/2026-11-15-workspace-files-design.md docs/superpowers/plans/2026-11-15-workspace-files.md
git commit -m "docs: 补充工作区文件工具说明"
```

### Task 4: Verify the Branch

- [x] **Step 1: Focused tests**

```bash
pnpm exec vitest run packages/runtime/test/workspace-file-tools.test.ts --config vitest.config.ts
```

- [x] **Step 2: Package checks**

```bash
pnpm --filter @weave/runtime lint
pnpm --filter @weave/runtime typecheck
pnpm --filter @weave/runtime test
pnpm --filter @weave/runtime build
```

- [x] **Step 3: Full repository checks**

```bash
pnpm check
git diff --check
```

- [x] **Step 4: Inspect final scope**

```bash
git status --short
git diff origin/main...HEAD --stat
git log --oneline origin/main..HEAD
```

Only Workspace File Tools, tests, and related documentation should be present.
