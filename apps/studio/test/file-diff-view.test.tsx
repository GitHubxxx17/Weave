// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

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
  DiffView: (props: { diffViewMode: number; diffViewTheme: string }) => (
    <div
      data-testid="diff-view"
      data-mode={String(props.diffViewMode)}
      data-theme={props.diffViewTheme}
    />
  ),
}));

vi.mock('@git-diff-view/react/styles/diff-view-pure.css', () => ({}));

vi.mock('@git-diff-view/file', () => ({
  generateDiffFile: mocks.generateDiffFile,
}));

vi.mock('@git-diff-view/shiki', () => ({
  getDiffViewHighlighter: mocks.getDiffViewHighlighter,
}));

import { CapturedFileDiffView, FileDiffView } from '../src/features/files-tree/file-diff-view.js';

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
  delete document.documentElement.dataset.theme;
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
    mocks.getDiffViewHighlighter.mockResolvedValue({
      name: 'shiki',
      type: 'class',
    });

    render(<FileDiffView projectId="p1" path="src/b.ts" />);

    const diffView = await screen.findByTestId('diff-view');
    // Unified mode (DiffModeEnum.Unified === 4).
    expect(diffView.getAttribute('data-mode')).toBe('4');
    expect(mocks.fetchFileDiff).toHaveBeenCalledWith(
      'p1',
      'src/b.ts',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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
    mocks.getDiffViewHighlighter.mockResolvedValue({
      name: 'shiki',
      type: 'class',
    });

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

  it('follows the resolved page theme and switches when it changes', async () => {
    document.documentElement.dataset.theme = 'dark';
    mocks.fetchFileDiff.mockResolvedValue({
      path: 'src/b.ts',
      oldContent: 'a\n',
      newContent: 'b\n',
      changed: true,
      tracked: true,
    });
    mocks.generateDiffFile.mockReturnValue(fakeDiffFile());
    mocks.getDiffViewHighlighter.mockResolvedValue({ name: 'shiki', type: 'class' });

    render(<FileDiffView projectId="p1" path="src/b.ts" />);

    const diffView = await screen.findByTestId('diff-view');
    expect(diffView.getAttribute('data-theme')).toBe('dark');
    // MutationObserver callbacks run as microtasks.
    await act(async () => {
      document.documentElement.dataset.theme = 'light';
      await Promise.resolve();
    });
    expect(screen.getByTestId('diff-view').getAttribute('data-theme')).toBe('light');
  });

  it('renders captured turn diffs in the resolved page theme', async () => {
    document.documentElement.dataset.theme = 'dark';
    mocks.generateDiffFile.mockReturnValue(fakeDiffFile());
    mocks.getDiffViewHighlighter.mockResolvedValue({ name: 'shiki', type: 'class' });

    render(
      <CapturedFileDiffView path="README.md" oldContent="a\n" newContent="b\n" existedBefore />,
    );

    expect((await screen.findByTestId('diff-view')).getAttribute('data-theme')).toBe('dark');
  });

  it('surfaces a fetch error', async () => {
    mocks.fetchFileDiff.mockRejectedValue(new Error('加载失败'));

    render(<FileDiffView projectId="p1" path="src/b.ts" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('加载失败');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
it('aborts stale diff requests across project ABA and never prepares foreign path content', async () => {
  const a = deferred<{
    path: string;
    oldContent: string;
    newContent: string;
    changed: boolean;
    tracked: boolean;
  }>();
  const b = deferred<{
    path: string;
    oldContent: string;
    newContent: string;
    changed: boolean;
    tracked: boolean;
  }>();
  const fresh = deferred<{
    path: string;
    oldContent: string;
    newContent: string;
    changed: boolean;
    tracked: boolean;
  }>();
  mocks.fetchFileDiff
    .mockReturnValueOnce(a.promise)
    .mockReturnValueOnce(b.promise)
    .mockReturnValueOnce(fresh.promise);
  const view = render(<FileDiffView projectId="a" path="same.txt" />);
  const firstSignal = mocks.fetchFileDiff.mock.calls[0]?.[2]?.signal as AbortSignal;
  view.rerender(<FileDiffView projectId="b" path="same.txt" />);
  view.rerender(<FileDiffView projectId="a" path="same.txt" />);
  expect(firstSignal.aborted).toBe(true);
  fresh.resolve({
    path: 'same.txt',
    oldContent: 'same',
    newContent: 'same',
    changed: false,
    tracked: true,
  });
  expect(await screen.findByText('该文件无未提交改动。')).toBeTruthy();
  await act(async () => {
    a.resolve({
      path: 'same.txt',
      oldContent: 'a',
      newContent: 'STALE',
      changed: true,
      tracked: false,
    });
    b.resolve({
      path: 'same.txt',
      oldContent: 'b',
      newContent: 'STALE B',
      changed: true,
      tracked: false,
    });
  });
  expect(mocks.generateDiffFile).not.toHaveBeenCalled();
  expect(screen.getByText('该文件无未提交改动。')).toBeTruthy();
});
it('aborts an active diff fetch on unmount', () => {
  mocks.fetchFileDiff.mockReturnValue(new Promise(() => {}));
  const view = render(<FileDiffView projectId="a" path="one.txt" />);
  const signal = mocks.fetchFileDiff.mock.calls[0]?.[2]?.signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});
it('rejects mismatched exact diff path before preparing syntax', async () => {
  mocks.fetchFileDiff.mockResolvedValue({
    path: 'foreign.txt',
    oldContent: 'a',
    newContent: 'b',
    changed: true,
    tracked: true,
  });
  render(<FileDiffView projectId="a" path="expected.txt" />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(mocks.generateDiffFile).not.toHaveBeenCalled();
});

it('does not run synchronous diff generation after an aborted highlighter wait', async () => {
  const highlighter = deferred<{ name: string; type: string }>();
  mocks.fetchFileDiff.mockResolvedValue({
    path: 'same.txt',
    oldContent: 'a',
    newContent: 'b',
    changed: true,
    tracked: true,
  });
  mocks.getDiffViewHighlighter.mockReturnValue(highlighter.promise);
  const view = render(<FileDiffView projectId="a" path="same.txt" />);
  await act(async () => {
    await Promise.resolve();
  });
  view.unmount();
  await act(async () => highlighter.resolve({ name: 'shiki', type: 'class' }));
  expect(mocks.generateDiffFile).not.toHaveBeenCalled();
});
