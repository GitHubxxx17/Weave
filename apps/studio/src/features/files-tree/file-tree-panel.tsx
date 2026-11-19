import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import { ChevronDown, ChevronRight, File, Folder, RotateCcw, X } from 'lucide-react';

import {
  FileTreeApiError,
  fetchFileContent,
  fetchFileTree,
  type FileContent,
} from './file-tree-api.js';

/** One node of the project file tree, keyed by path segment. */
export interface FileTreeNode {
  readonly name: string;
  readonly path: string;
  readonly isFile: boolean;
  readonly children: Map<string, FileTreeNode>;
}

/** Builds a nested tree from a flat set of POSIX-relative file paths. */
export function buildFileTree(files: readonly string[]): FileTreeNode {
  const root: FileTreeNode = { name: '', path: '', isFile: false, children: new Map() };
  for (const file of files) {
    const parts = file.split('/').filter((part) => part !== '');
    let node = root;
    let prefix = '';
    parts.forEach((part, index) => {
      prefix = prefix === '' ? part : `${prefix}/${part}`;
      const existing = node.children.get(part);
      if (existing === undefined) {
        const created: FileTreeNode = {
          name: part,
          path: prefix,
          isFile: index === parts.length - 1,
          children: new Map(),
        };
        node.children.set(part, created);
        node = created;
      } else {
        node = existing;
      }
    });
  }
  return root;
}

interface FlatRow {
  readonly node: FileTreeNode;
  readonly depth: number;
}

/** Flattens the tree into display rows, following the expanded directory set. */
export function flattenTree(
  root: FileTreeNode,
  expanded: ReadonlySet<string>,
  depth = 0,
): FlatRow[] {
  const children = [...root.children.values()];
  const directories = children
    .filter((child) => !child.isFile)
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = children
    .filter((child) => child.isFile)
    .sort((left, right) => left.name.localeCompare(right.name));
  const rows: FlatRow[] = [];
  for (const directory of directories) {
    rows.push({ node: directory, depth });
    if (expanded.has(directory.path)) {
      rows.push(...flattenTree(directory, expanded, depth + 1));
    }
  }
  for (const file of files) {
    rows.push({ node: file, depth });
  }
  return rows;
}

type LoadStatus = 'idle' | 'loading' | 'error';

/** Fraction of the split taken by the tree pane. */
const splitRatioLimits = { min: 0.15, max: 0.85, default: 0.42 } as const;
const splitStorageKey = 'weave.studio.fileTreeSplit';
/** Below this panel width the tree and file stack vertically instead of side by side. */
const rowModeMinWidth = 480;
const splitKeyboardStep = 0.05;

function clampRatio(value: number): number {
  return Math.min(Math.max(value, splitRatioLimits.min), splitRatioLimits.max);
}

function readSplitRatio(): number {
  try {
    const raw = globalThis.localStorage?.getItem(splitStorageKey);
    const parsed = raw === null || raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? clampRatio(parsed) : splitRatioLimits.default;
  } catch {
    return splitRatioLimits.default;
  }
}

function saveSplitRatio(value: number): void {
  try {
    globalThis.localStorage?.setItem(splitStorageKey, String(value));
  } catch {
    // Storage can be unavailable (private mode, quota); the ratio still applies.
  }
}

export interface FileTreePanelProps {
  readonly projectId: string | undefined;
  readonly onSetFolder: () => void;
}

/**
 * Project file explorer: a lazy-expandable tree of the current project's
 * files (ignore-filtered by the Server). Selecting a file opens its read-only
 * content next to the tree — side by side when the panel is wide, stacked when
 * narrow — with a draggable divider to set the split. Data comes from the
 * Server file routes; the browser never touches the filesystem.
 */
export function FileTreePanel({ projectId, onSetFolder }: FileTreePanelProps): ReactElement {
  const [files, setFiles] = useState<readonly string[] | null>(null);
  const [treeStatus, setTreeStatus] = useState<LoadStatus>('loading');
  const [treeError, setTreeError] = useState<{ code: string; message: string } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<FileContent | null>(null);
  const [contentStatus, setContentStatus] = useState<LoadStatus>('idle');
  const [contentError, setContentError] = useState('');
  const [mode, setMode] = useState<'row' | 'column'>('column');
  const [ratio, setRatio] = useState<number>(() => readSplitRatio());
  const [resizing, setResizing] = useState(false);

  const splitRef = useRef<HTMLDivElement>(null);
  const treePaneRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const dragRef = useRef<{ axis: 'x' | 'y'; ratio: number } | null>(null);

  /** Watches the panel width and switches between side-by-side and stacked. */
  const panelCallbackRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (node === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setMode(width >= rowModeMinWidth ? 'row' : 'column');
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  const loadTree = useCallback(() => {
    if (projectId === undefined || projectId === '') {
      setFiles(null);
      setTreeStatus('idle');
      return;
    }
    setTreeStatus('loading');
    setTreeError(null);
    fetchFileTree(projectId)
      .then((listing) => {
        setFiles(listing.files);
        setTreeStatus('idle');
      })
      .catch((error: unknown) => {
        setTreeError({
          code: error instanceof FileTreeApiError ? error.code : 'file-tree-failed',
          message: error instanceof Error ? error.message : '加载失败',
        });
        setTreeStatus('error');
      });
  }, [projectId]);

  useEffect(() => {
    setSelected(null);
    loadTree();
  }, [loadTree]);

  const openFile = useCallback(
    (path: string) => {
      if (projectId === undefined) {
        return;
      }
      setSelected(path);
      setContent(null);
      setContentStatus('loading');
      setContentError('');
      fetchFileContent(projectId, path)
        .then((result) => {
          setContent(result);
          setContentStatus('idle');
        })
        .catch((error: unknown) => {
          setContentError(error instanceof Error ? error.message : '加载失败');
          setContentStatus('error');
        });
    },
    [projectId],
  );

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const commitRatio = useCallback((value: number) => {
    const clamped = clampRatio(value);
    setRatio(clamped);
    saveSplitRatio(clamped);
  }, []);

  function handleResizerPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { axis: mode === 'row' ? 'x' : 'y', ratio };
    setResizing(true);
  }

  function handleResizerPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const state = dragRef.current;
    const container = splitRef.current;
    const pane = treePaneRef.current;
    if (state === null || container === null || pane === null) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const raw =
      state.axis === 'x'
        ? (event.clientX - rect.left) / rect.width
        : (event.clientY - rect.top) / rect.height;
    if (!Number.isFinite(raw)) {
      return;
    }
    const next = clampRatio(raw);
    state.ratio = next;
    // Update the pane directly during the drag so the tree does not re-render per move.
    pane.style.flex = `0 0 calc(${next} * 100%)`;
  }

  function finishResize(event: PointerEvent<HTMLDivElement>): void {
    const state = dragRef.current;
    if (state === null) {
      return;
    }
    dragRef.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId) === true) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    commitRatio(state.ratio);
  }

  function handleResizerKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      commitRatio(ratio - splitKeyboardStep);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      commitRatio(ratio + splitKeyboardStep);
    } else if (event.key === 'Home') {
      event.preventDefault();
      commitRatio(splitRatioLimits.default);
    }
  }

  const tree = useMemo(() => buildFileTree(files ?? []), [files]);
  const rows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);
  const query = filter.trim().toLowerCase();
  const matches = useMemo(
    () =>
      query === '' ? null : (files ?? []).filter((file) => file.toLowerCase().includes(query)),
    [files, query],
  );

  if (projectId === undefined || projectId === '') {
    return (
      <div className="panel-body file-tree-panel" role="region" aria-label="文件">
        <div className="file-tree-empty">
          <Folder aria-hidden="true" />
          <p>打开一个项目后查看它的文件树。</p>
        </div>
      </div>
    );
  }

  const showViewer = selected !== null;

  return (
    <div
      className="panel-body file-tree-panel"
      role="region"
      aria-label="文件"
      ref={panelCallbackRef}
    >
      <div
        ref={splitRef}
        className={`file-tree-split file-tree-split-${mode}${showViewer ? ' file-tree-split-active' : ''}`}
      >
        <div
          className="file-tree-pane"
          ref={treePaneRef}
          style={showViewer ? { flex: `0 0 calc(${ratio} * 100%)` } : undefined}
        >
          <div className="file-tree-toolbar">
            <input
              type="text"
              className="file-tree-filter"
              aria-label="筛选文件"
              placeholder="筛选文件…"
              spellCheck={false}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button
              type="button"
              className="icon-button"
              aria-label="刷新文件树"
              title="刷新"
              onClick={loadTree}
            >
              <RotateCcw aria-hidden="true" />
            </button>
          </div>
          {treeStatus === 'loading' ? (
            <p className="file-tree-hint">加载中…</p>
          ) : treeStatus === 'error' ? (
            treeError?.code === 'project-folder-unset' ? (
              <div className="file-tree-empty">
                <Folder aria-hidden="true" />
                <p>该项目还没有设置文件夹。</p>
                <button type="button" className="file-tree-set-folder" onClick={onSetFolder}>
                  设置项目文件夹
                </button>
              </div>
            ) : (
              <p className="file-tree-error" role="alert">
                {treeError?.message ?? '加载失败'}
              </p>
            )
          ) : matches !== null ? (
            <div className="file-tree-list" role="tree" aria-label="筛选结果">
              {matches.length === 0 ? (
                <p className="file-tree-hint">没有匹配的文件</p>
              ) : (
                matches.map((path) => (
                  <button
                    key={path}
                    type="button"
                    role="treeitem"
                    aria-selected={path === selected}
                    className={`file-tree-row file-tree-file${
                      path === selected ? ' file-tree-row-active' : ''
                    }`}
                    onClick={() => openFile(path)}
                    title={path}
                  >
                    <File aria-hidden="true" />
                    <span className="file-tree-name">{path}</span>
                  </button>
                ))
              )}
            </div>
          ) : rows.length === 0 ? (
            <p className="file-tree-hint">目录为空</p>
          ) : (
            <div className="file-tree-list" role="tree" aria-label="项目文件">
              {rows.map(({ node, depth }) => (
                <button
                  key={node.path}
                  type="button"
                  role="treeitem"
                  aria-expanded={node.isFile ? undefined : expanded.has(node.path)}
                  aria-selected={node.isFile ? node.path === selected : undefined}
                  className={`file-tree-row${node.isFile ? ' file-tree-file' : ' file-tree-dir'}${
                    node.isFile && node.path === selected ? ' file-tree-row-active' : ''
                  }`}
                  style={{ paddingLeft: `${8 + depth * 12}px` }}
                  onClick={() => (node.isFile ? openFile(node.path) : toggle(node.path))}
                  title={node.name}
                >
                  {node.isFile ? (
                    <File aria-hidden="true" />
                  ) : expanded.has(node.path) ? (
                    <ChevronDown aria-hidden="true" />
                  ) : (
                    <ChevronRight aria-hidden="true" />
                  )}
                  <span className="file-tree-name">{node.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {showViewer ? (
          <>
            <div
              className={`file-tree-resizer${resizing ? ' file-tree-resizer-active' : ''}`}
              role="separator"
              tabIndex={0}
              aria-orientation={mode === 'row' ? 'vertical' : 'horizontal'}
              aria-label="调整文件树与内容占比"
              aria-valuemin={Math.round(splitRatioLimits.min * 100)}
              aria-valuemax={Math.round(splitRatioLimits.max * 100)}
              aria-valuenow={Math.round(ratio * 100)}
              title="拖动调整占比，方向键微调"
              onPointerDown={handleResizerPointerDown}
              onPointerMove={handleResizerPointerMove}
              onPointerUp={finishResize}
              onPointerCancel={finishResize}
              onDoubleClick={() => commitRatio(splitRatioLimits.default)}
              onKeyDown={handleResizerKeyDown}
            />
            <div className="file-viewer-pane" role="region" aria-label="文件内容">
              <div className="file-viewer-bar">
                <span className="file-viewer-path" title={selected ?? undefined}>
                  {selected}
                </span>
                <button
                  type="button"
                  className="icon-button file-viewer-close"
                  aria-label="关闭文件"
                  title="关闭"
                  onClick={() => setSelected(null)}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
              {contentStatus === 'loading' ? (
                <p className="file-tree-hint">加载中…</p>
              ) : contentStatus === 'error' ? (
                <p className="file-tree-error" role="alert">
                  {contentError}
                </p>
              ) : (
                <div className="file-viewer">
                  {content?.truncated === true ? (
                    <p className="file-viewer-note">文件较大，仅显示前一部分。</p>
                  ) : null}
                  <pre className="file-viewer-content">{content?.content ?? ''}</pre>
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
