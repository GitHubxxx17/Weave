/** Browser-local index of a validated Server file listing. No filesystem authority. */
export interface FileTreeNode {
  readonly name: string;
  readonly path: string;
  readonly isFile: boolean;
  readonly children: ReadonlyMap<string, FileTreeNode>;
  readonly sortedChildren: readonly FileTreeNode[];
}
export interface FileTreeModel {
  readonly root: FileTreeNode;
  readonly files: readonly string[];
  readonly lowerPaths: readonly string[];
  readonly truncated: boolean;
  readonly nodeByPath: ReadonlyMap<string, FileTreeNode>;
}
export interface FileTreeRow {
  readonly path: string;
  readonly name: string;
  readonly parentPath: string;
  readonly depth: number;
  readonly isFile: boolean;
  readonly siblingPosition: number;
  readonly siblingCount: number;
  /** Compatibility for former buildFileTree/flattenTree callers. */
  readonly node: FileTreeNode;
}
interface MutableNode {
  name: string;
  path: string;
  isFile: boolean;
  children: Map<string, MutableNode>;
}
const parentPath = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const compare = (a: FileTreeNode, b: FileTreeNode): number =>
  Number(a.isFile) - Number(b.isFile) || a.name.localeCompare(b.name);
export class FileTreeModelError extends Error {
  constructor(
    readonly code: 'file-tree-invalid-path' | 'file-tree-path-conflict',
    readonly path: string,
  ) {
    super(code);
    this.name = 'FileTreeModelError';
  }
}
function requireCanonicalPath(path: string): void {
  if (
    path === '' ||
    path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new FileTreeModelError('file-tree-invalid-path', path);
}
function indexFiles(files: readonly string[]): {
  root: FileTreeNode;
  nodeByPath: ReadonlyMap<string, FileTreeNode>;
} {
  const root: MutableNode = {
    name: '',
    path: '',
    isFile: false,
    children: new Map(),
  };
  for (const path of files) {
    let current = root;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]!;
      let child = current.children.get(name);
      if (child === undefined) {
        child = {
          name,
          path: current.path === '' ? name : `${current.path}/${name}`,
          isFile: index === parts.length - 1,
          children: new Map(),
        };
        current.children.set(name, child);
      } else if (
        (index < parts.length - 1 && child.isFile) ||
        (index === parts.length - 1 && !child.isFile)
      )
        throw new FileTreeModelError('file-tree-path-conflict', path);
      current = child;
    }
  }
  const byPath = new Map<string, FileTreeNode>();
  // Postorder without recursive call depth limits for a deeply nested listing.
  const stack: { node: MutableNode; visited: boolean }[] = [{ node: root, visited: false }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (!item.visited) {
      stack.push({ ...item, visited: true });
      for (const node of item.node.children.values()) stack.push({ node, visited: false });
      continue;
    }
    const children = [...item.node.children.values()].map((node) => byPath.get(node.path)!);
    children.sort(compare);
    const node: FileTreeNode = {
      name: item.node.name,
      path: item.node.path,
      isFile: item.node.isFile,
      children: new Map(children.map((child) => [child.name, child])),
      sortedChildren: children,
    };
    byPath.set(node.path, node);
  }
  return { root: byPath.get('')!, nodeByPath: byPath };
}
export function createFileTreeModel(files: readonly string[], truncated = false): FileTreeModel {
  for (const file of files) requireCanonicalPath(file);
  // Server listing order is already authoritative for flat filter results.
  // Only nested siblings use the pre-existing directory-first locale order.
  const uniqueFiles = [...new Set(files)];
  return {
    ...indexFiles(uniqueFiles),
    files: uniqueFiles,
    lowerPaths: uniqueFiles.map((path) => path.toLocaleLowerCase()),
    truncated,
  };
}
export function buildFileTree(files: readonly string[]): FileTreeNode {
  return createFileTreeModel(files).root;
}
/** Reuses sorted sibling arrays; expansion never sorts or lowercases paths. */
export function flattenTree(
  root: FileTreeNode,
  expanded: ReadonlySet<string>,
  depth = 0,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const pending: {
    node: FileTreeNode;
    depth: number;
    siblingPosition: number;
    siblingCount: number;
  }[] = [];
  const pushChildren = (node: FileTreeNode, nextDepth: number): void => {
    for (let index = node.sortedChildren.length - 1; index >= 0; index--)
      pending.push({
        node: node.sortedChildren[index]!,
        depth: nextDepth,
        siblingPosition: index + 1,
        siblingCount: node.sortedChildren.length,
      });
  };
  pushChildren(root, depth);
  while (pending.length > 0) {
    const item = pending.pop()!;
    const { node } = item;
    rows.push({
      ...item,
      path: node.path,
      name: node.name,
      parentPath: parentPath(node.path),
      isFile: node.isFile,
    });
    if (!node.isFile && expanded.has(node.path)) pushChildren(node, item.depth + 1);
  }
  return rows;
}
/** Filter is a flat set of exact full paths. UI clicks always close over the row path. */
export function fileTreeRows(
  model: FileTreeModel,
  expanded: ReadonlySet<string>,
  query = '',
): readonly FileTreeRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return flattenTree(model.root, expanded);
  const found: FileTreeNode[] = [];
  for (let index = 0; index < model.files.length; index++)
    if (model.lowerPaths[index]!.includes(needle))
      found.push(model.nodeByPath.get(model.files[index]!)!);
  return found.map((node, index) => ({
    node,
    path: node.path,
    name: node.name,
    parentPath: parentPath(node.path),
    depth: 0,
    isFile: true,
    siblingPosition: index + 1,
    siblingCount: found.length,
  }));
}
