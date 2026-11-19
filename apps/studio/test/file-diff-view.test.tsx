// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  fetchFileDiff: vi.fn(),
  generateDiffFile: vi.fn(),
  getDiffViewHighlighter: vi.fn(),
}));

vi.mock('../src/features/files-tree/file-diff-api.js', () => ({
  fetchFileDiff: mocks.fetchFileDiff,
}));

vi.mock('@git-diff-view/react', () => ({
  DiffModeEnum: { SplitGitHub: 1, SplitGitLab: 2, Split: 3, Unified: 4 },
  DiffView: (props: { diffViewMode: number }) => (
    <div data-testid="diff-view" data-mode={String(props.diffViewMode)} />
  ),
}));

vi.mock('@git-diff-view/react/styles/diff-view-pure.css', () => ({}));

vi.mock('@git-diff-view/file', () => ({ generateDiffFile: mocks.generateDiffFile }));

vi.mock('@git-diff-view/shiki', () => ({ getDiffViewHighlighter: mocks.getDiffViewHighlighter }));

import { FileDiffView } from '../src/features/files-tree/file-diff-view.js';

/** A DiffFile stub whose build steps are inert no-ops. */
function fakeDiffFile() {
  return {
    initTheme: vi.fn(),
    initRaw: vi.fn(),
    initSyntax: vi.fn(),
    buildSplitDiffLines: vi.fn(),
    buildUnifiedDiffLines: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FileDiffView', () => {
  it('renders a unified diff for a changed tracked file', async () => {
    mocks.fetchFileDiff.mockResolvedValue({
      path: 'src/b.ts',
      oldContent: 'const b = 1;\n',
      newContent: 'const b = 2;\n',
      changed: true,
      tracked: true,
    });
    const instance = fakeDiffFile();
    mocks.generateDiffFile.mockReturnValue(instance);
    mocks.getDiffViewHighlighter.mockResolvedValue({ name: 'shiki', type: 'class' });

    render(<FileDiffView projectId="p1" path="src/b.ts" />);

    const diffView = await screen.findByTestId('diff-view');
    // Unified mode (DiffModeEnum.Unified === 4).
    expect(diffView.getAttribute('data-mode')).toBe('4');
    expect(mocks.fetchFileDiff).toHaveBeenCalledWith('p1', 'src/b.ts');
    // Built from the two contents with a resolved language on both sides.
    expect(mocks.generateDiffFile).toHaveBeenCalledWith(
      'src/b.ts',
      'const b = 1;\n',
      'src/b.ts',
      'const b = 2;\n',
      'typescript',
      'typescript',
    );
    expect(instance.initSyntax).toHaveBeenCalledWith({
      registerHighlighter: { name: 'shiki', type: 'class' },
    });
    // No new-file note for a tracked file.
    expect(screen.queryByText(/新文件/)).toBeNull();
  });

  it('notes a new (untracked) file above its diff', async () => {
    mocks.fetchFileDiff.mockResolvedValue({
      path: 'new.ts',
      oldContent: '',
      newContent: 'export const x = 1;\n',
      changed: true,
      tracked: false,
    });
    mocks.generateDiffFile.mockReturnValue(fakeDiffFile());
    mocks.getDiffViewHighlighter.mockResolvedValue({ name: 'shiki', type: 'class' });

    render(<FileDiffView projectId="p1" path="new.ts" />);

    expect(await screen.findByTestId('diff-view')).toBeTruthy();
    expect(screen.getByText(/新文件：基线（HEAD）中不存在/)).toBeTruthy();
  });

  it('shows a no-changes message without building a diff', async () => {
    mocks.fetchFileDiff.mockResolvedValue({
      path: 'src/b.ts',
      oldContent: 'same\n',
      newContent: 'same\n',
      changed: false,
      tracked: true,
    });

    render(<FileDiffView projectId="p1" path="src/b.ts" />);

    expect(await screen.findByText('该文件无未提交改动。')).toBeTruthy();
    expect(screen.queryByTestId('diff-view')).toBeNull();
    expect(mocks.generateDiffFile).not.toHaveBeenCalled();
  });

  it('surfaces a fetch error', async () => {
    mocks.fetchFileDiff.mockRejectedValue(new Error('加载失败'));

    render(<FileDiffView projectId="p1" path="src/b.ts" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('加载失败');
  });
});
