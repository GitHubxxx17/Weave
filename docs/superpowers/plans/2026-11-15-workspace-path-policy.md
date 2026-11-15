# Workspace Path Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `@weave/runtime` 增加一个只负责 Workspace 路径边界判断的可测试策略模块。

**Architecture:** `workspace-policy.ts` 使用 Node `path` 做词法路径解析，
`workspace-types.ts` 暴露稳定的类型、Zod Schema 和错误类。策略不执行文件
系统操作，后续文件工具和 Shell 工具通过它统一判断路径是否位于 Workspace
根目录内。

**Tech Stack:** TypeScript、ESM、Node.js 内置 `node:path`、Zod、Vitest、pnpm workspace、Turborepo。

**Spec:** `docs/superpowers/specs/2026-11-15-workspace-path-policy-design.md`

## Global Constraints

- TypeScript、ESM、strict typing。
- Workspace 根目录必须是绝对路径。
- 外部路径只接受相对路径，并且解析后不能逃逸 Workspace 根目录。
- 只做词法路径校验，不读取、写入或执行文件系统对象。
- 不处理符号链接、文件类型、权限、TOCTOU 或 Approval。
- 复用 `@weave/runtime` 现有包，不创建新的 Workspace 包。
- 不增加外部依赖。
- 测试放在 `packages/runtime/test/`。
- 每个行为先写失败测试，再实现最小代码。
- 提交信息使用中文 Conventional Commits。

## 文件地图

- Create: `packages/runtime/src/workspace-types.ts`
  - 操作类型、输入 Schema、结果类型和稳定错误类。
- Create: `packages/runtime/src/workspace-policy.ts`
  - Workspace 根目录校验和相对路径解析算法。
- Create: `packages/runtime/test/workspace-policy.test.ts`
  - 路径边界和错误行为测试。
- Modify: `packages/runtime/src/index.ts`
  - 导出 Workspace 公共 API。
- Modify: `README.md`
  - 说明当前 Workspace 阶段的边界和后续接入顺序。
- Modify: `docs/architecture/foundation.md`
  - 增加 Workspace Policy 与 Tool Pipeline 的关系。
- Modify: `docs/superpowers/specs/2026-11-15-workspace-path-policy-design.md`
  - 设计文档已在实现前创建，完成后只补充实际验证信息。
- Modify: `docs/superpowers/plans/2026-11-15-workspace-path-policy.md`
  - 按实施进度勾选步骤。

### Task 1: Define Workspace Contract

**Files:**

- Create: `packages/runtime/src/workspace-types.ts`
- Create: `packages/runtime/test/workspace-policy.test.ts`

**Interfaces:**

```ts
export type WorkspaceOperation = 'read' | 'write' | 'execute';

export interface WorkspacePolicyOptions {
  readonly root: string;
}

export interface WorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly operation: WorkspaceOperation;
}

export type WorkspacePolicyErrorCode =
  | 'workspace-invalid-input'
  | 'workspace-invalid-root'
  | 'workspace-absolute-path-not-allowed'
  | 'workspace-path-outside-root';

export class WorkspacePolicyError extends Error {
  readonly code: WorkspacePolicyErrorCode;
}
```

- [ ] **Step 1: Write failing contract tests**

Add tests that import the not-yet-existing exports and express these behaviors:

```ts
it('accepts only absolute Workspace roots', () => {
  expect(() => createWorkspacePolicy({ root: '/workspace' })).not.toThrow();
  expect(() => createWorkspacePolicy({ root: 'workspace' })).toThrowError(
    expect.objectContaining({ code: 'workspace-invalid-root' }),
  );
});

it('rejects absolute input paths and unknown operations', () => {
  const policy = createWorkspacePolicy({ root: '/workspace' });

  expect(() => policy.resolve('/tmp/file.txt', 'read')).toThrowError(
    expect.objectContaining({ code: 'workspace-absolute-path-not-allowed' }),
  );
  expect(() => policy.resolve('src/index.ts', 'invalid' as never)).toThrowError(
    expect.objectContaining({ code: 'workspace-invalid-input' }),
  );
});
```

Add tests for valid resolution, safe normalization, root resolution, traversal
rejection, empty input, null byte, frozen output, stable error code, and no
file-system dependency. Keep all roots as strings; do not create files.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
pnpm exec vitest run packages/runtime/test/workspace-policy.test.ts --config vitest.config.ts
```

Expected: FAIL because `createWorkspacePolicy` and the Workspace types do not
exist yet.

- [ ] **Step 3: Implement the contract types**

In `workspace-types.ts`:

```ts
const workspaceOperationSchema = z.enum(['read', 'write', 'execute']);

export const workspacePolicyOptionsSchema = z.object({
  root: z.string().min(1),
});

export const workspacePathRequestSchema = z.object({
  inputPath: z.string().min(1),
  operation: workspaceOperationSchema,
});
```

Define the public inferred types and `WorkspacePolicyError`. The constructor
must accept an optional `ErrorOptions` and preserve `cause`. Export the schemas
only when they are useful to later adapters; keep internal helpers private.

- [ ] **Step 4: Run the focused test and verify the contract behavior**

Run the same Vitest command. The tests for schemas and error construction should
pass; path-resolution tests may still fail until Task 2.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/runtime/src/workspace-types.ts packages/runtime/test/workspace-policy.test.ts
git commit -m "feat: 增加工作区路径契约"
```

### Task 2: Implement Lexical Workspace Resolution

**Files:**

- Create: `packages/runtime/src/workspace-policy.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/test/workspace-policy.test.ts`

**Interfaces:**

```ts
export interface WorkspacePolicy {
  readonly root: string;
  resolve(inputPath: string, operation: WorkspaceOperation): WorkspacePath;
}

export function createWorkspacePolicy(options: WorkspacePolicyOptions): WorkspacePolicy;
```

- [ ] **Step 1: Add one failing traversal test**

Add a test that proves this path must fail:

```ts
it('rejects a path that escapes the Workspace root after normalization', () => {
  const policy = createWorkspacePolicy({ root: '/workspace/project' });

  expect(() => policy.resolve('../secrets.txt', 'read')).toThrowError(
    expect.objectContaining({ code: 'workspace-path-outside-root' }),
  );
});
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing policy**

Run:

```bash
pnpm exec vitest run packages/runtime/test/workspace-policy.test.ts --config vitest.config.ts
```

Expected: FAIL because `workspace-policy.ts` has not been implemented.

- [ ] **Step 3: Implement the minimal path algorithm**

Use `node:path`:

```ts
const root = path.resolve(options.root);
const candidate = path.resolve(root, inputPath);
const relativePath = path.relative(root, candidate);
const outsideRoot =
  relativePath === '..' ||
  relativePath.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relativePath);
```

Before resolving:

- validate `{ inputPath, operation }` with `workspacePathRequestSchema`;
- reject `inputPath.includes('\0')`;
- reject `path.isAbsolute(inputPath)`;
- map each failure to the specified `WorkspacePolicyErrorCode`.

Return:

```ts
Object.freeze({
  absolutePath: candidate,
  relativePath: relativePath === '' ? '.' : relativePath,
  operation,
})
```

Validate the root with `workspacePolicyOptionsSchema`, then explicitly reject
non-absolute roots with `workspace-invalid-root`. Do not call `stat`, `lstat`,
`realpath`, `mkdir`, `readFile`, or `writeFile`.

- [ ] **Step 4: Export the public API**

Update `packages/runtime/src/index.ts`:

```ts
export {
  workspacePathRequestSchema,
  workspacePolicyOptionsSchema,
  WorkspacePolicyError,
} from './workspace-types.js';
export type {
  WorkspaceOperation,
  WorkspacePath,
  WorkspacePolicyErrorCode,
  WorkspacePolicyOptions,
} from './workspace-types.js';
export { createWorkspacePolicy } from './workspace-policy.js';
export type { WorkspacePolicy } from './workspace-policy.js';
```

- [ ] **Step 5: Run the focused test and verify all path behaviors**

Run:

```bash
pnpm exec vitest run packages/runtime/test/workspace-policy.test.ts --config vitest.config.ts
```

Expected: all Workspace Policy tests pass.

- [ ] **Step 6: Commit the implementation**

```bash
git add packages/runtime/src/workspace-types.ts packages/runtime/src/workspace-policy.ts packages/runtime/src/index.ts packages/runtime/test/workspace-policy.test.ts
git commit -m "feat: 增加工作区路径解析策略"
```

### Task 3: Update Architecture Learning Material

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture/foundation.md`
- Modify: `docs/superpowers/specs/2026-11-15-workspace-path-policy-design.md`
- Modify: `docs/superpowers/plans/2026-11-15-workspace-path-policy.md`

**Interfaces:**

- Documentation must describe the implemented Workspace Policy without
  claiming that it is a complete Sandbox.
- Documentation must preserve the distinction between lexical path validation,
  real filesystem checks, and Approval.

- [ ] **Step 1: Update README**

Add a Workspace Policy section after Tool Pipeline. Explain that current
`createWorkspacePolicy()` returns normalized paths and rejects traversal, while
file tools, symlink checks, Shell, and Approval are not implemented yet.

- [ ] **Step 2: Update the architecture guide**

Add a boundary paragraph and flow:

```text
Tool Pipeline
  -> Workspace Path Policy
    -> future File/Shell Executor
      -> future Approval/Sandbox
```

State that the policy does not perform I/O and that the executor must repeat
security checks before touching the filesystem.

- [ ] **Step 3: Record verification evidence**

After implementation, append a short implementation note to the spec and mark
the plan checkboxes completed only after the commands in Task 4 pass.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/architecture/foundation.md docs/superpowers/specs/2026-11-15-workspace-path-policy-design.md docs/superpowers/plans/2026-11-15-workspace-path-policy.md
git commit -m "docs: 补充工作区路径策略说明"
```

### Task 4: Verify the Branch

**Files:**

- No source changes expected unless verification exposes an implementation
  defect.

- [ ] **Step 1: Run focused tests**

```bash
pnpm exec vitest run packages/runtime/test/workspace-policy.test.ts --config vitest.config.ts
```

Expected: all Workspace Policy tests pass.

- [ ] **Step 2: Run package checks**

```bash
pnpm --filter @weave/runtime lint
pnpm --filter @weave/runtime typecheck
pnpm --filter @weave/runtime test
pnpm --filter @weave/runtime build
```

Expected: lint, typecheck, tests, and build exit successfully.

- [ ] **Step 3: Run the repository verification chain**

```bash
pnpm check
git diff --check
```

Expected: formatting, lint, typecheck, tests, build, and whitespace checks all
pass with exit code 0.

- [ ] **Step 4: Inspect the final diff**

```bash
git status --short
git diff origin/main...HEAD --stat
git log --oneline origin/main..HEAD
```

Confirm that only Workspace Policy implementation, tests, and related
documentation are included.
