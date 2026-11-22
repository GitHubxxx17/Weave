// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
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
    expect(mocks.fetchFileContent).toHaveBeenCalledWith('p1', 'README.md');
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
    const divider = await screen.findByRole('separator', { name: '调整文件树与内容占比' });
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
  mocks.fetchFileTree.mockResolvedValue({ files: ['a.ts'], source: 'walk', truncated: false });
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
