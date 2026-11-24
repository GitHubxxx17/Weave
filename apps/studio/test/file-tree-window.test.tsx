// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTreeList, fileTreeRowHeight } from '../src/features/files-tree/file-tree-list.js';
import { createFileTreeModel, fileTreeRows } from '../src/features/files-tree/file-tree-model.js';
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 280,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 400,
  });
  HTMLElement.prototype.scrollTo = function (options) {
    this.scrollTop = typeof options === 'object' ? (options.top ?? 0) : 0;
    this.dispatchEvent(new Event('scroll'));
  };
});
afterEach(cleanup);
describe('fixed file window', () => {
  it('keeps all 50k logical paths, bounds mounted items and scrolls before focusing an off-window keyboard destination', async () => {
    const model = createFileTreeModel(
      Array.from({ length: 50000 }, (_, i) => `file-${String(i).padStart(5, '0')}.ts`),
    );
    const rows = fileTreeRows(model, new Set());
    const onOpen = vi.fn();
    const view = render(
      <FileTreeList
        rows={rows}
        expanded={new Set()}
        selected={null}
        onOpen={onOpen}
        onToggle={() => {}}
        filterMode={false}
      />,
    );
    expect(
      view.container.querySelector('[data-logical-count]')?.getAttribute('data-logical-count'),
    ).toBe('50000');
    expect(view.container.querySelectorAll('[data-file-path]').length).toBeLessThanOrEqual(
      Math.ceil(280 / fileTreeRowHeight) + 17,
    );
    const first = screen.getByRole('treeitem', { name: 'file-00000.ts' });
    first.focus();
    await act(async () => {
      fireEvent.keyDown(first, { key: 'End' });
    });
    expect(document.activeElement?.getAttribute('data-file-path')).toBe('file-49999.ts');
    fireEvent.click(document.activeElement!);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('file-49999.ts');
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    });
    expect(document.activeElement?.getAttribute('data-file-path')).toBe('file-00000.ts');
  });
  it('uses rendered exact paths after filter changes and returns focus to a logical parent', async () => {
    const model = createFileTreeModel(['src/a.ts', 'src/b.ts', 'README.md']);
    const expanded = new Set(['src']);
    const onOpen = vi.fn(),
      onToggle = vi.fn();
    const props = {
      expanded,
      selected: null,
      onOpen,
      onToggle,
      filterMode: false,
    };
    const view = render(<FileTreeList {...props} rows={fileTreeRows(model, expanded)} />);
    const child = screen.getByRole('treeitem', { name: 'a.ts' });
    child.focus();
    await act(async () => {
      fireEvent.keyDown(child, { key: 'ArrowLeft' });
    });
    expect(document.activeElement?.getAttribute('data-file-path')).toBe('src');
    view.rerender(
      <FileTreeList {...props} filterMode={true} rows={fileTreeRows(model, expanded, 'b.ts')} />,
    );
    fireEvent.click(screen.getByRole('treeitem', { name: 'src/b.ts' }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('src/b.ts');
  });
});

it('keeps at most one exact focused path outside the visible range and reports flat filtered siblings', async () => {
  const rows = fileTreeRows(
    createFileTreeModel(
      Array.from({ length: 100 }, (_, index) => `src/file-${String(index).padStart(3, '0')}.ts`),
    ),
    new Set(),
    '.ts',
  );
  const view = render(
    <FileTreeList
      rows={rows}
      expanded={new Set()}
      selected={null}
      onOpen={() => {}}
      onToggle={() => {}}
      filterMode={true}
    />,
  );
  const first = screen.getByRole('treeitem', { name: 'src/file-000.ts' });
  first.focus();
  const scroll = view.container.querySelector<HTMLElement>('[data-row-height]')!;
  await act(async () => {
    scroll.scrollTop = 28 * 50;
    fireEvent.scroll(scroll);
  });
  expect(first.isConnected).toBe(true);
  expect(first.getAttribute('aria-level')).toBe('1');
  expect(first.getAttribute('aria-posinset')).toBe('1');
  expect(first.getAttribute('aria-setsize')).toBe('100');
  expect(view.container.querySelectorAll('[data-file-path]').length).toBeLessThanOrEqual(
    Math.ceil(280 / fileTreeRowHeight) + 17,
  );
  const middle = view.container.querySelector('[data-file-path="src/file-050.ts"]');
  expect(middle).toBeTruthy();
  expect(middle?.getAttribute('aria-posinset')).toBe('51');
});

it('keeps keyboard focus in the tree after the focused logical path disappears without stealing focus from the filter', async () => {
  const model = createFileTreeModel(['a.ts', 'b.ts']);
  const props = {
    expanded: new Set<string>(),
    selected: null,
    onOpen: () => {},
    onToggle: () => {},
    filterMode: true,
  };
  const view = render(
    <>
      <input aria-label="filter" />
      <FileTreeList {...props} rows={fileTreeRows(model, props.expanded)} />
    </>,
  );
  await act(async () => {
    screen.getByRole('treeitem', { name: 'a.ts' }).focus();
  });
  view.rerender(
    <>
      <input aria-label="filter" />
      <FileTreeList {...props} rows={fileTreeRows(model, props.expanded, 'b.ts')} />
    </>,
  );
  expect(document.activeElement?.getAttribute('data-file-path')).toBe('b.ts');
  await act(async () => {
    screen.getByRole('textbox', { name: 'filter' }).focus();
  });
  view.rerender(
    <>
      <input aria-label="filter" />
      <FileTreeList {...props} rows={fileTreeRows(model, props.expanded, 'a.ts')} />
    </>,
  );
  expect(document.activeElement?.getAttribute('aria-label')).toBe('filter');
});

it.each([false, true])(
  'restores row keyboard navigation after an empty focused tree receives files (previous rows: %s)',
  async (previousRows) => {
    const model = createFileTreeModel(['a.ts', 'b.ts']);
    const rows = fileTreeRows(model, new Set());
    const props = {
      expanded: new Set<string>(),
      selected: null,
      onOpen: () => {},
      onToggle: () => {},
      filterMode: true,
    };
    const view = render(<FileTreeList {...props} rows={previousRows ? rows : []} />);
    if (previousRows) {
      await act(async () => {
        screen.getByRole('treeitem', { name: 'a.ts' }).focus();
      });
      view.rerender(<FileTreeList {...props} rows={[]} />);
    } else {
      await act(async () => {
        screen.getByRole('tree').focus();
      });
    }
    expect(document.activeElement).toBe(screen.getByRole('tree'));
    view.rerender(<FileTreeList {...props} rows={rows} />);
    expect(document.activeElement?.getAttribute('data-file-path')).toBe('a.ts');
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    });
    expect(document.activeElement?.getAttribute('data-file-path')).toBe('b.ts');
  },
);
