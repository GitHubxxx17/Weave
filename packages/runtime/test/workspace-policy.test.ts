import { describe, expect, it } from 'vitest';
import {
  createWorkspacePolicy,
  WorkspacePolicyError,
  workspacePathRequestSchema,
  workspacePolicyOptionsSchema,
  type WorkspaceOperation,
} from '../src/index.js';

describe('Workspace Policy contracts', () => {
  it('accepts absolute roots and rejects relative roots', () => {
    expect(() => createWorkspacePolicy({ root: '/workspace' })).not.toThrow();
    expect(() => createWorkspacePolicy({ root: 'workspace' })).toThrowError(
      expect.objectContaining({
        code: 'workspace-invalid-root',
      }),
    );
  });

  it('validates public input schemas', () => {
    expect(workspacePolicyOptionsSchema.parse({ root: '/workspace' })).toEqual({
      root: '/workspace',
    });
    expect(
      workspacePathRequestSchema.parse({
        inputPath: 'src/index.ts',
        operation: 'read',
      }),
    ).toEqual({
      inputPath: 'src/index.ts',
      operation: 'read',
    });
    expect(() => workspacePathRequestSchema.parse({ inputPath: '', operation: 'read' })).toThrow();
    expect(() =>
      workspacePathRequestSchema.parse({ inputPath: 'src/index.ts', operation: 'invalid' }),
    ).toThrow();
  });

  it('constructs a stable typed error with a cause', () => {
    const cause = new Error('invalid input');
    const error = new WorkspacePolicyError('workspace-invalid-input', 'Workspace input is invalid', {
      cause,
    });

    expect(error).toMatchObject({
      name: 'WorkspacePolicyError',
      code: 'workspace-invalid-input',
      cause,
    });
  });
});

describe('Workspace Policy path resolution', () => {
  it('resolves relative paths under the Workspace root', () => {
    const policy = createWorkspacePolicy({ root: '/workspace/project' });

    expect(policy.resolve('src/index.ts', 'read')).toEqual({
      absolutePath: '/workspace/project/src/index.ts',
      relativePath: 'src/index.ts',
      operation: 'read',
    });
  });

  it('normalizes the root and safe parent traversal', () => {
    const policy = createWorkspacePolicy({ root: '/workspace/project/.' });

    expect(policy.root).toBe('/workspace/project');
    expect(policy.resolve('./src/../README.md', 'write')).toEqual({
      absolutePath: '/workspace/project/README.md',
      relativePath: 'README.md',
      operation: 'write',
    });
  });

  it('allows the Workspace root itself', () => {
    const policy = createWorkspacePolicy({ root: '/workspace/project' });

    expect(policy.resolve('.', 'execute')).toEqual({
      absolutePath: '/workspace/project',
      relativePath: '.',
      operation: 'execute',
    });
  });

  it('rejects a path that escapes the Workspace root after normalization', () => {
    const policy = createWorkspacePolicy({ root: '/workspace/project' });

    expect(() => policy.resolve('../secrets.txt', 'read')).toThrowError(
      expect.objectContaining({
        code: 'workspace-path-outside-root',
      }),
    );
    expect(() => policy.resolve('src/../../secrets.txt', 'read')).toThrowError(
      expect.objectContaining({
        code: 'workspace-path-outside-root',
      }),
    );
  });

  it('rejects absolute input paths', () => {
    const policy = createWorkspacePolicy({ root: '/workspace/project' });

    expect(() => policy.resolve('/tmp/secrets.txt', 'read')).toThrowError(
      expect.objectContaining({
        code: 'workspace-absolute-path-not-allowed',
      }),
    );
  });

  it('rejects empty and null-byte paths', () => {
    const policy = createWorkspacePolicy({ root: '/workspace/project' });

    expect(() => policy.resolve('', 'read')).toThrowError(
      expect.objectContaining({
        code: 'workspace-invalid-input',
      }),
    );
    expect(() => policy.resolve('src/\0index.ts', 'read')).toThrowError(
      expect.objectContaining({
        code: 'workspace-invalid-input',
      }),
    );
  });

  it('rejects unknown operations before path resolution', () => {
    const policy = createWorkspacePolicy({ root: '/workspace/project' });

    expect(() =>
      policy.resolve('src/index.ts', 'invalid' as WorkspaceOperation),
    ).toThrowError(
      expect.objectContaining({
        code: 'workspace-invalid-input',
      }),
    );
  });

  it('freezes returned path metadata', () => {
    const policy = createWorkspacePolicy({ root: '/workspace/project' });
    const resolved = policy.resolve('src/index.ts', 'read');

    expect(Object.isFrozen(resolved)).toBe(true);
  });
});
