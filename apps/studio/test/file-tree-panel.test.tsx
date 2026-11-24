// @vitest-environment jsdom

import { Profiler, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  fetchFileTree: vi.fn(),
  fetchFileContent: vi.fn(),
}));

vi.mock('../src/features/files-tree/file-tree-api.js', async () => {
  const actual = await vi.importActual('../src/features/files-tree/file-tree-api.js');
  return {
    ...actual,
    fetchFileTree: mocks.fetchFileTree,
    fetchFileContent: mocks.fetchFileContent,
  };
});

vi.mock('../src/features/files-tree/highlight.js', () => ({
  languageForPath: (path: string) => (/\.tsx?$/.test(path) ? 'typescript' : undefined),
  highlightToHtml: async () => '<pre class="shiki"><code><span>const b = 1</span></code></pre>',
}));

vi.mock('../src/features/files-tree/file-diff-view.js', () => ({
  FileDiffView: ({ projectId, path }: { projectId: string; path: string }) => (
    <div data-testid="file-diff-view">{`改动预览 ${projectId}:${path}`}</div>
  ),
}));

import { FileTreeApiError } from '../src/features/files-tree/file-tree-api.js';
import {
  FileTreePanel,
  buildFileTree,
  flattenTree,
} from '../src/features/files-tree/file-tree-panel.js';

let restoreViewportGeometry = () => {};

afterEach(() => {
  cleanup();
  restoreViewportGeometry();
  vi.clearAllMocks();
});

beforeEach(() => {
  const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(280);
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  HTMLElement.prototype.scrollTo = function (options) {
    this.scrollTop = typeof options === 'object' ? (options.top ?? 0) : 0;
    this.dispatchEvent(new Event('scroll'));
  };
  restoreViewportGeometry = () => {
    height.mockRestore();
    width.mockRestore();
    if (previousScroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', previousScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  };
  localStorage.clear();
});

function renderPanel(projectId: string | undefined = 'p1') {
  return render(<FileTreePanel projectId={projectId} onSetFolder={vi.fn()} />);
}

describe('buildFileTree / flattenTree', () => {
  it('nests paths and flattens with directories first, following expansion', () => {
    const tree = buildFileTree(['src/a.ts', 'src/b.ts', 'README.md']);
    expect(flattenTree(tree, new Set()).map((row) => row.node.name)).toEqual(['src', 'README.md']);
    expect(flattenTree(tree, new Set(['src'])).map((row) => row.node.name)).toEqual([
      'src',
      'a.ts',
      'b.ts',
      'README.md',
    ]);
  });
});

describe('FileTreePanel', () => {
  it('renders the tree and expands a directory on click', async () => {
    mocks.fetchFileTree.mockResolvedValue({
      files: ['src/a.ts', 'README.md'],
      source: 'git',
      truncated: false,
    });
    renderPanel();

    expect(await screen.findByRole('treeitem', { name: /src/ })).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: /a\.ts/ })).toBeNull();

    fireEvent.click(screen.getByRole('treeitem', { name: /src/ }));
    expect(await screen.findByRole('treeitem', { name: /a\.ts/ })).toBeTruthy();
  });

  it('opens a file in the viewer while keeping the tree visible', async () => {
    mocks.fetchFileTree.mockResolvedValue({
      files: ['README.md'],
      source: 'git',
      truncated: false,
    });
    mocks.fetchFileContent.mockResolvedValue({
      path: 'README.md',
      content: '# Hello',
      bytes: 7,
      truncated: false,
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }));
    expect(await screen.findByText('# Hello')).toBeTruthy();
    expect(mocks.fetchFileContent).toHaveBeenCalledWith(
      'p1',
      'README.md',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // The tree stays visible alongside the file content.
    expect(screen.getByRole('treeitem', { name: /README\.md/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '关闭文件' }));
    expect(screen.queryByText('# Hello')).toBeNull();
    expect(screen.getByRole('treeitem', { name: /README\.md/ })).toBeTruthy();
  });

  it('filters files by name', async () => {
    mocks.fetchFileTree.mockResolvedValue({
      files: ['src/a.ts', 'src/b.ts', 'README.md'],
      source: 'git',
      truncated: false,
    });
    renderPanel();
    await screen.findByRole('treeitem', { name: /src/ });

    fireEvent.change(screen.getByRole('textbox', { name: '筛选文件' }), {
      target: { value: 'a.ts' },
    });
    expect(screen.getByRole('treeitem', { name: 'src/a.ts' })).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: 'src/b.ts' })).toBeNull();
  });

  it('prompts to set a folder when the project has none', async () => {
    mocks.fetchFileTree.mockRejectedValue(
      new FileTreeApiError('project-folder-unset', 'no folder', 409),
    );
    const onSetFolder = vi.fn();
    render(<FileTreePanel projectId="p1" onSetFolder={onSetFolder} />);

    fireEvent.click(await screen.findByRole('button', { name: '设置项目文件夹' }));
    expect(onSetFolder).toHaveBeenCalled();
  });

  it('shows an empty state and fetches nothing without a project', () => {
    render(<FileTreePanel projectId={undefined} onSetFolder={vi.fn()} />);
    expect(screen.getByText(/打开一个项目/)).toBeTruthy();
    expect(mocks.fetchFileTree).not.toHaveBeenCalled();
  });

  it('shows a draggable divider and adjusts the split with the keyboard', async () => {
    mocks.fetchFileTree.mockResolvedValue({
      files: ['README.md'],
      source: 'git',
      truncated: false,
    });
    mocks.fetchFileContent.mockResolvedValue({
      path: 'README.md',
      content: 'x',
      bytes: 1,
      truncated: false,
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }));
    const divider = await screen.findByRole('separator', {
      name: '调整文件树与内容占比',
    });
    expect(divider.getAttribute('aria-valuenow')).toBe('42');

    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(divider.getAttribute('aria-valuenow')).toBe('47');
  });

  it('syntax-highlights a known-language file in the viewer', async () => {
    mocks.fetchFileTree.mockResolvedValue({
      files: ['src/b.ts'],
      source: 'git',
      truncated: false,
    });
    mocks.fetchFileContent.mockResolvedValue({
      path: 'src/b.ts',
      content: 'const b = 1;',
      bytes: 12,
      truncated: false,
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('treeitem', { name: /src/ }));
    fireEvent.click(await screen.findByRole('treeitem', { name: /b\.ts/ }));
    await waitFor(() => {
      expect(document.querySelector('.file-viewer-highlight')).not.toBeNull();
    });
  });

  it('toggles between the content and diff views of a file', async () => {
    mocks.fetchFileTree.mockResolvedValue({
      files: ['src/b.ts'],
      source: 'git',
      truncated: false,
    });
    mocks.fetchFileContent.mockResolvedValue({
      path: 'src/b.ts',
      content: 'const b = 1;',
      bytes: 12,
      truncated: false,
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('treeitem', { name: /src/ }));
    fireEvent.click(await screen.findByRole('treeitem', { name: /b\.ts/ }));
    // Content view is shown first, highlighted.
    await waitFor(() => {
      expect(document.querySelector('.file-viewer-highlight')).not.toBeNull();
    });
    expect(screen.queryByTestId('file-diff-view')).toBeNull();

    // Switching to 改动 lazy-loads the diff view for the selected path.
    fireEvent.click(screen.getByRole('button', { name: '改动' }));
    const diffView = await screen.findByTestId('file-diff-view');
    expect(diffView.textContent).toContain('p1:src/b.ts');
    expect(document.querySelector('.file-viewer-highlight')).toBeNull();

    // Switching back shows the content again.
    fireEvent.click(screen.getByRole('button', { name: '内容' }));
    await waitFor(() => {
      expect(document.querySelector('.file-viewer-highlight')).not.toBeNull();
    });
    expect(screen.queryByTestId('file-diff-view')).toBeNull();
  });
});

it('adds the selected file from its viewer header and disables already selected refs', async () => {
  mocks.fetchFileTree.mockResolvedValue({
    files: ['a.ts'],
    source: 'walk',
    truncated: false,
  });
  mocks.fetchFileContent.mockResolvedValue({
    path: 'a.ts',
    content: 'value',
    bytes: 5,
    truncated: false,
  });
  const onAddFile = vi.fn();
  const { rerender } = render(
    <FileTreePanel projectId="p1" onSetFolder={vi.fn()} onAddFile={onAddFile} selectedFiles={[]} />,
  );
  fireEvent.click(await screen.findByRole('treeitem', { name: 'a.ts' }));
  fireEvent.click(await screen.findByRole('button', { name: '添加到消息 a.ts' }));
  expect(onAddFile).toHaveBeenCalledWith('a.ts');
  rerender(
    <FileTreePanel
      projectId="p1"
      onSetFolder={vi.fn()}
      onAddFile={onAddFile}
      selectedFiles={['a.ts']}
    />,
  );
  expect((screen.getByRole('button', { name: '已添加 a.ts' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(document.querySelector('button button')).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const listing = (files: string[], truncated = false) => ({
  files,
  source: 'walk',
  truncated,
});
const content = (path: string, text: string) => ({
  path,
  content: text,
  bytes: text.length,
  truncated: false,
});

describe('FileTreePanel request ownership', () => {
  it('aborts old tree refresh and ignores a late response even when fetch ignores abort', async () => {
    const first = deferred<ReturnType<typeof listing>>(),
      second = deferred<ReturnType<typeof listing>>();
    mocks.fetchFileTree.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderPanel();
    const signal = mocks.fetchFileTree.mock.calls[0]?.[1]?.signal as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: '刷新文件树' }));
    expect(signal.aborted).toBe(true);
    second.resolve(listing(['latest.txt']));
    expect(await screen.findByRole('treeitem', { name: 'latest.txt' })).toBeTruthy();
    first.resolve(listing(['stale.txt']));
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: 'stale.txt' })).toBeNull());
  });
  it('does not let a slow file A overwrite a faster selected file B', async () => {
    mocks.fetchFileTree.mockResolvedValue(listing(['a.txt', 'b.txt']));
    const a = deferred<ReturnType<typeof content>>(),
      b = deferred<ReturnType<typeof content>>();
    mocks.fetchFileContent.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    renderPanel();
    fireEvent.click(await screen.findByRole('treeitem', { name: 'a.txt' }));
    const signal = mocks.fetchFileContent.mock.calls[0]?.[2]?.signal as AbortSignal;
    fireEvent.click(screen.getByRole('treeitem', { name: 'b.txt' }));
    expect(signal.aborted).toBe(true);
    b.resolve(content('b.txt', 'LATEST FILE B'));
    expect(await screen.findByText('LATEST FILE B')).toBeTruthy();
    a.resolve(content('a.txt', 'STALE FILE A'));
    await waitFor(() => expect(screen.queryByText('STALE FILE A')).toBeNull());
    expect(screen.getByText('LATEST FILE B')).toBeTruthy();
  });

  it('retries a failed selected file when the same logical row is opened again', async () => {
    mocks.fetchFileTree.mockResolvedValue(listing(['retry.txt']));
    mocks.fetchFileContent
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce(content('retry.txt', 'FRESH RETRIED BODY'));
    renderPanel();
    fireEvent.click(await screen.findByRole('treeitem', { name: 'retry.txt' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'temporary read failure',
    );
    const firstSignal = mocks.fetchFileContent.mock.calls[0]![2].signal as AbortSignal;

    fireEvent.click(screen.getByRole('treeitem', { name: 'retry.txt' }));

    expect(await screen.findByText('FRESH RETRIED BODY')).toBeTruthy();
    expect(mocks.fetchFileContent).toHaveBeenCalledTimes(2);
    expect(firstSignal.aborted).toBe(true);
    expect(mocks.fetchFileContent.mock.calls[1]![2].signal).not.toBe(firstSignal);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['plain', 'highlighted', 'error'] as const)(
    'clears the previous %s file in the first commit that selects another path',
    async (previousView) => {
      const firstPath = previousView === 'highlighted' ? 'a.ts' : 'a.txt';
      mocks.fetchFileTree.mockResolvedValue(listing([firstPath, 'b.txt']));
      if (previousView === 'error') {
        mocks.fetchFileContent.mockRejectedValueOnce(new Error('PREVIOUS FILE ERROR'));
      } else {
        mocks.fetchFileContent.mockResolvedValueOnce(content(firstPath, 'PREVIOUS FILE BODY'));
      }
      const next = deferred<ReturnType<typeof content>>();
      mocks.fetchFileContent.mockReturnValueOnce(next.promise);
      const nextPathCommits: { text: string; hasHighlight: boolean }[] = [];
      render(
        <Profiler
          id="file-viewer"
          onRender={() => {
            if (document.querySelector('.file-viewer-path')?.textContent !== 'b.txt') return;
            nextPathCommits.push({
              text: document.querySelector('.file-viewer-pane')?.textContent ?? '',
              hasHighlight: document.querySelector('.file-viewer-highlight') !== null,
            });
          }}
        >
          <FileTreePanel projectId="p1" onSetFolder={vi.fn()} />
        </Profiler>,
      );
      fireEvent.click(await screen.findByRole('treeitem', { name: firstPath }));
      if (previousView === 'error') {
        expect(await screen.findByRole('alert')).toHaveProperty(
          'textContent',
          'PREVIOUS FILE ERROR',
        );
      } else if (previousView === 'highlighted') {
        await waitFor(() =>
          expect(document.querySelector('.file-viewer-highlight')).not.toBeNull(),
        );
      } else {
        expect(await screen.findByText('PREVIOUS FILE BODY')).toBeTruthy();
      }

      fireEvent.click(screen.getByRole('treeitem', { name: 'b.txt' }));

      expect(nextPathCommits[0]).toEqual({
        text: expect.stringContaining('加载中…'),
        hasHighlight: false,
      });
      for (const commit of nextPathCommits) {
        expect(commit.text).not.toContain('PREVIOUS FILE');
        expect(commit.hasHighlight).toBe(false);
      }
      next.resolve(content('b.txt', 'CURRENT FILE BODY'));
      expect(await screen.findByText('CURRENT FILE BODY')).toBeTruthy();
    },
  );
  it('rejects late project A results after a project A to B to A transition', async () => {
    const firstA = deferred<ReturnType<typeof listing>>(),
      b = deferred<ReturnType<typeof listing>>(),
      lastA = deferred<ReturnType<typeof listing>>();
    mocks.fetchFileTree
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(lastA.promise);
    const view = renderPanel('a');
    view.rerender(<FileTreePanel projectId="b" onSetFolder={vi.fn()} />);
    view.rerender(<FileTreePanel projectId="a" onSetFolder={vi.fn()} />);
    lastA.resolve(listing(['fresh-a.txt']));
    expect(await screen.findByRole('treeitem', { name: 'fresh-a.txt' })).toBeTruthy();
    firstA.resolve(listing(['old-a.txt']));
    b.resolve(listing(['wrong-b.txt']));
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: 'old-a.txt' })).toBeNull());
    expect(screen.queryByRole('treeitem', { name: 'wrong-b.txt' })).toBeNull();
  });
  it('aborts the current content fetch on close and unmount', async () => {
    mocks.fetchFileTree.mockResolvedValue(listing(['a.txt']));
    mocks.fetchFileContent.mockReturnValue(new Promise(() => {}));
    const view = renderPanel();
    fireEvent.click(await screen.findByRole('treeitem', { name: 'a.txt' }));
    const first = mocks.fetchFileContent.mock.calls.at(-1)?.[2]?.signal as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: '关闭文件' }));
    expect(first.aborted).toBe(true);
    fireEvent.click(screen.getByRole('treeitem', { name: 'a.txt' }));
    const second = mocks.fetchFileContent.mock.calls.at(-1)?.[2]?.signal as AbortSignal;
    view.unmount();
    expect(second.aborted).toBe(true);
  });
  it('shows listing truncation and rejects content for a different exact path', async () => {
    mocks.fetchFileTree.mockResolvedValue(listing(['exact.txt'], true));
    mocks.fetchFileContent.mockResolvedValue(content('foreign.txt', 'WRONG PATH BODY'));
    renderPanel();
    expect(await screen.findByText(/列表未完整/)).toBeTruthy();
    fireEvent.click(screen.getByRole('treeitem', { name: 'exact.txt' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('WRONG PATH BODY')).toBeNull();
  });
});

it('creates fresh controllers in StrictMode and ignores the first effect result', async () => {
  const first = deferred<ReturnType<typeof listing>>(),
    second = deferred<ReturnType<typeof listing>>();
  mocks.fetchFileTree.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  render(
    <StrictMode>
      <FileTreePanel projectId="a" onSetFolder={vi.fn()} />
    </StrictMode>,
  );
  const oldSignal = mocks.fetchFileTree.mock.calls[0]?.[1]?.signal as AbortSignal;
  const currentSignal = mocks.fetchFileTree.mock.calls[1]?.[1]?.signal as AbortSignal;
  expect(oldSignal.aborted).toBe(true);
  expect(currentSignal.aborted).toBe(false);
  expect(currentSignal).not.toBe(oldSignal);
  second.resolve(listing(['live.txt']));
  expect(await screen.findByRole('treeitem', { name: 'live.txt' })).toBeTruthy();
  await act(async () => {
    first.resolve(listing(['strict-stale.txt']));
  });
  expect(screen.queryByRole('treeitem', { name: 'strict-stale.txt' })).toBeNull();
});
it('aborts a rejected current content request and hides errors once the viewer is closed', async () => {
  mocks.fetchFileTree.mockResolvedValue(listing(['a.txt']));
  const request = deferred<ReturnType<typeof content>>();
  mocks.fetchFileContent.mockReturnValue(request.promise);
  renderPanel();
  fireEvent.click(await screen.findByRole('treeitem', { name: 'a.txt' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭文件' }));
  await act(async () => request.reject(new Error('old selected error')));
  expect(screen.queryByRole('alert')).toBeNull();
});
it('surfaces malformed server listing paths as a read error without rendering a conflicting tree', async () => {
  mocks.fetchFileTree.mockResolvedValue(listing(['src', 'src/a.txt']));
  renderPanel();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('tree')).toBeNull();
});
it('refreshes the tree while retaining the current viewer and captured attachment action', async () => {
  mocks.fetchFileTree.mockResolvedValue(listing(['selected.txt']));
  mocks.fetchFileContent.mockResolvedValue(content('selected.txt', 'CURRENT SELECTED BODY'));
  const oldOwner = vi.fn();
  render(<FileTreePanel projectId="a" onSetFolder={vi.fn()} onAddFile={oldOwner} />);
  fireEvent.click(await screen.findByRole('treeitem', { name: 'selected.txt' }));
  expect(await screen.findByText('CURRENT SELECTED BODY')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '刷新文件树' }));
  expect(await screen.findByText('CURRENT SELECTED BODY')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '添加到消息 selected.txt' }));
  expect(oldOwner).toHaveBeenCalledWith('selected.txt');
  expect(mocks.fetchFileContent).toHaveBeenCalledTimes(1);
});
