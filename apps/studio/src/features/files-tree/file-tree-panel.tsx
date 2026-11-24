import { filePathSchema } from '../file-context/file-context-types.js';
import {
  Suspense,
  lazy,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import { Folder, RotateCcw, X } from 'lucide-react';

import {
  FileTreeApiError,
  fetchFileContent,
  fetchFileTree,
  type FileContent,
} from './file-tree-api.js';
import { highlightToHtml, languageForPath } from './highlight.js';
import { createFileTreeModel, fileTreeRows, type FileTreeModel } from './file-tree-model.js';
import { FileTreeList } from './file-tree-list.js';
export { buildFileTree, flattenTree, type FileTreeNode } from './file-tree-model.js';

/**
 * The diff view pulls in `@git-diff-view` and a Shiki highlighter, so it is
 * code-split and only loaded the first time a file's "改动" view is opened.
 */
const FileDiffView = lazy(() =>
  import('./file-diff-view.js').then((module) => ({
    default: module.FileDiffView,
  })),
);

/** Which face of a selected file the viewer shows. */
type ViewMode = 'content' | 'diff';

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
  readonly onAddFile?: ((path: string) => void) | undefined;
  readonly selectedFiles?: readonly string[] | undefined;
  /** Reports the file currently open in the viewer (`null` when none). */
  readonly onViewerFileChange?: ((path: string | null) => void) | undefined;
}

/**
 * Project file explorer: a lazy-expandable tree of the current project's
 * files (ignore-filtered by the Server). Selecting a file opens its read-only
 * content next to the tree — side by side when the panel is wide, stacked when
 * narrow — with a draggable divider to set the split. Data comes from the
 * Server file routes; the browser never touches the filesystem.
 */
export function FileTreePanel({
  projectId,
  onSetFolder,
  onAddFile,
  selectedFiles = [],
  onViewerFileChange,
}: FileTreePanelProps): ReactElement {
  const [model, setModel] = useState<FileTreeModel>(() => createFileTreeModel([]));
  const [treeRevision, setTreeRevision] = useState(0);
  const treeEpoch = useRef(0);
  const contentEpoch = useRef(0);
  const ownerRef = useRef({ projectId, epoch: 0 });
  if (ownerRef.current.projectId !== projectId)
    ownerRef.current = { projectId, epoch: ownerRef.current.epoch + 1 };
  const loadedTreeOwner = useRef<typeof ownerRef.current | undefined>(undefined);
  const [treeStatus, setTreeStatus] = useState<LoadStatus>('loading');
  const [treeError, setTreeError] = useState<{
    code: string;
    message: string;
  } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [contentSelectionRevision, setContentSelectionRevision] = useState(0);
  const viewerChangeRef = useRef(onViewerFileChange);
  viewerChangeRef.current = onViewerFileChange;
  useEffect(() => {
    viewerChangeRef.current?.(selected);
  }, [selected]);
  useEffect(() => () => viewerChangeRef.current?.(null), []);
  const [content, setContent] = useState<FileContent | null>(null);
  const [contentStatus, setContentStatus] = useState<LoadStatus>('idle');
  const [contentError, setContentError] = useState('');
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('content');
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

  const loadTree = useCallback(() => setTreeRevision((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++treeEpoch.current;
    const owner = ownerRef.current;
    const valid = () =>
      !controller.signal.aborted && treeEpoch.current === epoch && ownerRef.current === owner;
    if (loadedTreeOwner.current !== owner) {
      setSelected(null);
      setContent(null);
      setExpanded(new Set());
      setFilter('');
      loadedTreeOwner.current = owner;
    }
    setModel(createFileTreeModel([]));
    if (projectId === undefined || projectId === '') {
      setTreeStatus('idle');
      return () => controller.abort();
    }
    setTreeStatus('loading');
    setTreeError(null);
    void fetchFileTree(projectId, { signal: controller.signal })
      .then((listing) => {
        if (!valid()) return;
        const nextModel = createFileTreeModel(listing.files, listing.truncated);
        setModel(nextModel);
        setTreeStatus('idle');
      })
      .catch((error: unknown) => {
        if (!valid()) return;
        setTreeError({
          code: error instanceof FileTreeApiError ? error.code : 'file-tree-failed',
          message: error instanceof Error ? error.message : '加载失败',
        });
        setTreeStatus('error');
      });
    return () => controller.abort();
  }, [projectId, treeRevision]);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++contentEpoch.current;
    const owner = ownerRef.current;
    const valid = () =>
      !controller.signal.aborted && contentEpoch.current === epoch && ownerRef.current === owner;
    setContent(null);
    setContentError('');
    if (selected === null || projectId === undefined || projectId === '') {
      setContentStatus('idle');
      return () => controller.abort();
    }
    const path = selected;
    setContentStatus('loading');
    void fetchFileContent(projectId, path, { signal: controller.signal })
      .then((result) => {
        if (!valid()) return;
        if (result.path !== path)
          throw new FileTreeApiError('file-content-owner', '返回的文件路径不匹配', 0);
        setContent(result);
        setContentStatus('idle');
      })
      .catch((error: unknown) => {
        if (valid()) {
          setContentError(error instanceof Error ? error.message : '加载失败');
          setContentStatus('error');
        }
      });
    return () => controller.abort();
  }, [projectId, selected, contentSelectionRevision]);

  useEffect(() => {
    if (selected === null || contentStatus !== 'idle' || content === null) {
      setHighlightedHtml(null);
      return;
    }
    const language = languageForPath(selected);
    if (language === undefined) {
      setHighlightedHtml(null);
      return;
    }
    let active = true;
    const owner = ownerRef.current;
    const epoch = contentEpoch.current;
    void highlightToHtml(content.content, language).then((html) => {
      if (active && ownerRef.current === owner && contentEpoch.current === epoch) {
        setHighlightedHtml(html ?? null);
      }
    });
    return () => {
      active = false;
    };
  }, [selected, content, contentStatus]);

  const openFile = useCallback(
    (path: string) => {
      if (projectId === undefined || projectId === '') return;
      contentEpoch.current += 1;
      setSelected(path);
      setContentSelectionRevision((current) => current + 1);
      setContent(null);
      setContentStatus('loading');
      setContentError('');
      setHighlightedHtml(null);
      setViewMode('content');
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

  const deferredFilter = useDeferredValue(filter);
  const query = deferredFilter.trim().toLocaleLowerCase();
  const rows = useMemo(() => fileTreeRows(model, expanded, query), [model, expanded, query]);

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
          ) : (
            <>
              {model.truncated ? (
                <p className="file-tree-hint" role="status">
                  列表未完整：仅显示服务返回的文件。
                </p>
              ) : null}
              {filter !== deferredFilter ? (
                <p className="file-tree-hint" role="status">
                  正在筛选…
                </p>
              ) : null}
              <FileTreeList
                key={JSON.stringify([projectId, ownerRef.current.epoch])}
                rows={rows}
                expanded={expanded}
                selected={selected}
                onOpen={openFile}
                onToggle={toggle}
                filterMode={query !== ''}
              />
            </>
          )}
        </div>
        {selected !== null ? (
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
                <span className="file-viewer-path" title={selected}>
                  {selected}
                </span>
                {onAddFile !== undefined ? (
                  <button
                    type="button"
                    className="file-viewer-add"
                    title={selected}
                    aria-label={`${selectedFiles.includes(selected) ? '已添加' : '添加到消息'} ${selected}`}
                    disabled={
                      selectedFiles.includes(selected) ||
                      selectedFiles.length >= 8 ||
                      !filePathSchema.safeParse(selected).success
                    }
                    onClick={() => onAddFile(selected)}
                  >
                    {selectedFiles.includes(selected) ? '已添加' : '添加到消息'}
                  </button>
                ) : null}
                <div className="file-viewer-modes" role="group" aria-label="查看模式">
                  <button
                    type="button"
                    className={`file-viewer-mode${
                      viewMode === 'content' ? ' file-viewer-mode-active' : ''
                    }`}
                    aria-pressed={viewMode === 'content'}
                    onClick={() => setViewMode('content')}
                  >
                    内容
                  </button>
                  <button
                    type="button"
                    className={`file-viewer-mode${
                      viewMode === 'diff' ? ' file-viewer-mode-active' : ''
                    }`}
                    aria-pressed={viewMode === 'diff'}
                    onClick={() => setViewMode('diff')}
                  >
                    改动
                  </button>
                </div>
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
              {viewMode === 'diff' ? (
                <div className="file-viewer">
                  <Suspense fallback={<p className="file-tree-hint">加载改动…</p>}>
                    <FileDiffView projectId={projectId} path={selected} />
                  </Suspense>
                </div>
              ) : contentStatus === 'loading' ? (
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
                  {highlightedHtml === null ? (
                    <pre className="file-viewer-content">{content?.content ?? ''}</pre>
                  ) : (
                    <div
                      className="file-viewer-content file-viewer-highlight"
                      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                    />
                  )}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
