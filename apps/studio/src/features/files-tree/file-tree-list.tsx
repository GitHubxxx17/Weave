import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, File, Folder } from 'lucide-react';
import type { FileTreeRow } from './file-tree-model.js';

/** Must equal .file-tree-window-row's height in the integration CSS. */
export const fileTreeRowHeight = 28;
export interface FileTreeListProps {
  readonly rows: readonly FileTreeRow[];
  readonly expanded: ReadonlySet<string>;
  readonly selected: string | null;
  readonly onOpen: (path: string) => void;
  readonly onToggle: (path: string) => void;
  readonly filterMode: boolean;
}
interface PendingFocus {
  readonly path: string;
  readonly ticket: number;
}
/** One fixed window shared by directory rows and flat filter results. */
export function FileTreeList({
  rows,
  expanded,
  selected,
  onOpen,
  onToggle,
  filterMode,
}: FileTreeListProps): ReactElement {
  const scroll = useRef<HTMLDivElement | null>(null);
  const latest = useRef<ReadonlyMap<string, number>>(new Map());
  const navigationTicket = useRef(0);
  const focusWithin = useRef(false);
  const [focusedPath, setFocusedPath] = useState<string | undefined>();
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | undefined>();
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.path, index])), [rows]);
  latest.current = rowIndex;
  const activePath =
    focusedPath !== undefined && rowIndex.has(focusedPath)
      ? focusedPath
      : selected !== null && rowIndex.has(selected)
        ? selected
        : rows[0]?.path;
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const pinned = activePath === undefined ? undefined : rowIndex.get(activePath);
      return [
        ...new Set([...defaultRangeExtractor(range), ...(pinned === undefined ? [] : [pinned])]),
      ].sort((a, b) => a - b);
    },
    [activePath, rowIndex],
  );
  const getScrollElement = useCallback(() => scroll.current, []);
  const getItemKey = useCallback((index: number) => rows[index]!.path, [rows]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLButtonElement>({
    count: rows.length,
    getScrollElement,
    getItemKey,
    estimateSize: () => fileTreeRowHeight,
    overscan: 8,
    rangeExtractor,
    useFlushSync: false,
  });
  const items = virtualizer.getVirtualItems();
  const focusRow = useCallback(
    (path: string) => {
      const index = rowIndex.get(path);
      if (index === undefined) return;
      const ticket = ++navigationTicket.current;
      setFocusedPath(path);
      setPendingFocus({ path, ticket });
      virtualizer.scrollToIndex(index, { align: 'auto', behavior: 'auto' });
    },
    [rowIndex, virtualizer],
  );
  useLayoutEffect(() => {
    if (pendingFocus === undefined) return;
    const current = latest.current.has(pendingFocus.path);
    if (!current || pendingFocus.ticket !== navigationTicket.current) {
      setPendingFocus(undefined);
      return;
    }
    const element = [
      ...(scroll.current?.querySelectorAll<HTMLButtonElement>('[data-file-path]') ?? []),
    ].find((button) => button.dataset.filePath === pendingFocus.path);
    if (element !== undefined) {
      element.focus({ preventScroll: true });
      setPendingFocus(undefined);
    }
  }, [pendingFocus, items]);
  // Clamp the logical focus and viewport when a new listing/query removes paths.
  useLayoutEffect(() => {
    if (focusedPath !== undefined && !rowIndex.has(focusedPath)) {
      const ticket = ++navigationTicket.current;
      setFocusedPath(activePath);
      setPendingFocus(
        focusWithin.current && activePath !== undefined ? { path: activePath, ticket } : undefined,
      );
      if (focusWithin.current && activePath === undefined)
        scroll.current?.focus({ preventScroll: true });
    }
    const element = scroll.current;
    if (
      element !== null &&
      element.ownerDocument.activeElement === element &&
      activePath !== undefined
    )
      focusRow(activePath);
    if (
      element !== null &&
      element.scrollTop > Math.max(0, rows.length * fileTreeRowHeight - element.clientHeight)
    )
      element.scrollTop = Math.max(0, rows.length * fileTreeRowHeight - element.clientHeight);
  }, [rows, rowIndex, focusedPath, activePath, focusRow]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, row: FileTreeRow): void => {
    const index = rowIndex.get(row.path);
    if (index === undefined) return;
    let target: string | undefined;
    switch (event.key) {
      case 'ArrowDown':
        target = rows[Math.min(rows.length - 1, index + 1)]?.path;
        break;
      case 'ArrowUp':
        target = rows[Math.max(0, index - 1)]?.path;
        break;
      case 'Home':
        target = rows[0]?.path;
        break;
      case 'End':
        target = rows.at(-1)?.path;
        break;
      case 'ArrowRight':
        if (filterMode || row.isFile) return;
        if (!expanded.has(row.path)) onToggle(row.path);
        else if (rows[index + 1]?.parentPath === row.path) target = rows[index + 1]?.path;
        break;
      case 'ArrowLeft':
        if (filterMode) return;
        if (!row.isFile && expanded.has(row.path)) onToggle(row.path);
        else target = row.parentPath;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (target !== undefined) focusRow(target);
  };
  return (
    <div
      ref={scroll}
      className="file-tree-list file-tree-window"
      role="tree"
      tabIndex={rows.length === 0 ? 0 : -1}
      onFocusCapture={() => {
        focusWithin.current = true;
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget !== null &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          focusWithin.current = false;
      }}
      aria-label={filterMode ? '筛选结果' : '项目文件'}
      data-row-height={fileTreeRowHeight}
      data-logical-count={rows.length}
      data-range-start={items[0]?.index ?? -1}
      data-range-end={items.at(-1)?.index ?? -1}
    >
      {rows.length === 0 ? (
        <p className="file-tree-hint">{filterMode ? '没有匹配的文件' : '项目文件列表为空'}</p>
      ) : (
        <div
          className="file-tree-window-space"
          style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
        >
          {items.map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            return (
              <button
                key={item.key}
                type="button"
                role="treeitem"
                data-index={item.index}
                data-file-path={row.path}
                data-file-index={item.index}
                aria-level={row.depth + 1}
                aria-posinset={row.siblingPosition}
                aria-setsize={row.siblingCount}
                aria-selected={row.path === selected}
                aria-expanded={row.isFile || filterMode ? undefined : expanded.has(row.path)}
                tabIndex={row.path === activePath ? 0 : -1}
                title={row.path}
                className={`file-tree-row file-tree-window-row ${row.isFile ? 'file-tree-file' : 'file-tree-dir'}${row.path === selected ? ' file-tree-row-active' : ''}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: fileTreeRowHeight,
                  boxSizing: 'border-box',
                  transform: `translateY(${item.start}px)`,
                  paddingLeft: 8 + row.depth * 14,
                }}
                onFocus={() => setFocusedPath(row.path)}
                onKeyDown={(event) => onKeyDown(event, row)}
                onClick={() => (row.isFile ? onOpen(row.path) : onToggle(row.path))}
              >
                {row.isFile ? (
                  <File aria-hidden="true" />
                ) : (
                  <>
                    {expanded.has(row.path) ? (
                      <ChevronDown aria-hidden="true" />
                    ) : (
                      <ChevronRight aria-hidden="true" />
                    )}
                    <Folder aria-hidden="true" />
                  </>
                )}
                <span className="file-tree-name">{filterMode ? row.path : row.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
