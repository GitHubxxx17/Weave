import { describe, expect, it } from 'vitest';
import {
  buildFileTree,
  createFileTreeModel,
  fileTreeRows,
  flattenTree,
} from '../src/features/files-tree/file-tree-model.js';
describe('indexed file tree', () => {
  it('orders directories before files once and carries logical sibling accessibility metadata', () => {
    const model = createFileTreeModel(
      ['z.ts', 'src/z.ts', 'src/a.ts', 'alpha/file.ts', 'README.md'],
      true,
    );
    const rows = fileTreeRows(model, new Set(['src']));
    expect(
      rows.map((row) => [
        row.path,
        row.depth,
        row.siblingPosition,
        row.siblingCount,
        row.parentPath,
      ]),
    ).toEqual([
      ['alpha', 0, 1, 4, ''],
      ['src', 0, 2, 4, ''],
      ['src/a.ts', 1, 1, 2, 'src'],
      ['src/z.ts', 1, 2, 2, 'src'],
      ['README.md', 0, 3, 4, ''],
      ['z.ts', 0, 4, 4, ''],
    ]);
    expect(model.truncated).toBe(true);
    expect(
      flattenTree(buildFileTree(['src/a.ts', 'src/b.ts', 'README.md']), new Set()).map(
        (row) => row.node.name,
      ),
    ).toEqual(['src', 'README.md']);
    expect(rows.find((row) => row.path === 'src')?.node).toBe(model.nodeByPath.get('src'));
  });
  it('matches the full logical listing by full path independent of expansion and preserves every wide listing entry', () => {
    const files = Array.from(
      { length: 50000 },
      (_, index) => `src/file-${String(index).padStart(5, '0')}.ts`,
    );
    files.push('notes/RARE_SENTINEL.md');
    const model = createFileTreeModel(files);
    expect(fileTreeRows(model, new Set(), '.ts')).toHaveLength(50000);
    expect(fileTreeRows(model, new Set(), 'rare_sentinel').map((row) => row.path)).toEqual([
      'notes/RARE_SENTINEL.md',
    ]);
    expect(fileTreeRows(model, new Set(), 'missing')).toEqual([]);
    expect(fileTreeRows(createFileTreeModel([]), new Set())).toEqual([]);
    const rows = fileTreeRows(model, new Set(['src']));
    expect(rows.at(-1)?.path).toBe('src/file-49999.ts');
    expect(rows.at(-1)?.siblingPosition).toBe(50000);
    expect(rows.at(-1)?.siblingCount).toBe(50000);
  });
});

it.each([
  ['src', 'src/a.ts'],
  ['src/a.ts', 'src'],
])('rejects a listing that claims one exact path is both a file and directory: %j', (...files) => {
  expect(() => createFileTreeModel(files)).toThrow('file-tree-path-conflict');
});
it.each(['', '/absolute.ts', 'src//a.ts', 'src/../a.ts', './a.ts', 'trailing/', 'bad\0name.ts'])(
  'rejects noncanonical path %j instead of silently rewriting its click identity',
  (path) => {
    expect(() => createFileTreeModel([path])).toThrow('file-tree-invalid-path');
  },
);
it('builds and flattens a deeply nested listing without recursion and preserves final exact path', () => {
  const depth = 300;
  const parts = Array.from({ length: depth }, (_, index) => `d${index}`);
  const path = [...parts, 'file.ts'].join('/');
  const model = createFileTreeModel([path]);
  const expanded = new Set(parts.map((_, index) => parts.slice(0, index + 1).join('/')));
  const rows = fileTreeRows(model, expanded);
  expect(rows).toHaveLength(depth + 1);
  expect(rows.at(-1)).toMatchObject({
    path,
    depth,
    isFile: true,
    siblingPosition: 1,
    siblingCount: 1,
  });
});

it('preserves valid Server listing names that are ineligible for attachment without normalizing their click identities', () => {
  const paths = [
    'colon:name.ts',
    'back\\slash.ts',
    'line\nname.ts',
    'café.ts',
    'e\u0301.ts',
    'x'.repeat(1100),
  ];
  const model = createFileTreeModel(paths);
  expect(new Set(model.files)).toEqual(new Set(paths));
  for (const path of paths) {
    const row = fileTreeRows(model, new Set(), path).find((row) => row.path === path);
    expect(row?.path).toBe(path);
    expect(row?.isFile).toBe(true);
  }
});

it('preserves mixed-case and accented Server listing order for filtered results while sorting tree siblings once', () => {
  const paths = ['Z.ts', 'a.ts', 'e\u0301.ts', 'É.ts', 'a.ts'];
  const model = createFileTreeModel(paths);
  expect(model.files).toEqual(['Z.ts', 'a.ts', 'e\u0301.ts', 'É.ts']);
  expect(fileTreeRows(model, new Set(), '.ts').map((row) => row.path)).toEqual([
    'Z.ts',
    'a.ts',
    'e\u0301.ts',
    'É.ts',
  ]);
  expect(fileTreeRows(model, new Set()).map((row) => row.path)).toEqual([
    'a.ts',
    'e\u0301.ts',
    'É.ts',
    'Z.ts',
  ]);
});
