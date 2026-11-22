import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { sameComposerOwner, type ComposerOwner } from '../composer/use-composer-draft.js';
import { fetchFileTree } from '../files-tree/file-tree-api.js';
import { findFileMention, rankFileCandidates, type FileMention } from './file-mention.js';
interface PickerOptions {
  readonly owner: ComposerOwner;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly projectId: string;
  readonly rootKey: string;
  readonly disabled?: boolean;
  readonly onSelect: (path: string, owner: ComposerOwner) => unknown;
}
/** Path discovery is lazy and bound to the full interaction owner, including ABA epochs. */
export function useFilePicker(options: PickerOptions) {
  const listId = useId();
  const latest = useRef(options);
  latest.current = options;
  const [menu, setMenu] = useState<{
    owner: ComposerOwner;
    text: string;
    mention?: FileMention;
    query: string;
  } | null>(null);
  const latestMenu = useRef(menu);
  latestMenu.current = menu;
  const [listing, setListing] = useState<{
    owner: ComposerOwner;
    files: readonly string[];
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const epoch = useRef(0);
  const ownerKey = JSON.stringify(options.owner);
  const open =
    menu !== null &&
    menu.text === options.text &&
    sameComposerOwner(menu.owner, options.owner) &&
    options.disabled !== true;
  const query = open ? menu.query : '';
  const buttonMode = open && menu.mention === undefined;
  const listedFiles =
    open && listing !== null && sameComposerOwner(listing.owner, options.owner)
      ? listing.files
      : undefined;
  const items = useMemo(
    () => (listedFiles === undefined ? [] : rankFileCandidates(listedFiles, query)),
    [listedFiles, query],
  );
  const active = Math.min(activeIndex, Math.max(0, items.length - 1));
  function close(): void {
    setMenu(null);
  }
  useEffect(() => {
    setMenu(null);
    setListing(null);
    setError(null);
  }, [ownerKey]);
  useEffect(() => {
    if (options.disabled === true) setMenu(null);
  }, [options.disabled]);
  useEffect(() => {
    setMenu((current) => (current !== null && current.text !== options.text ? null : current));
  }, [options.text]);
  useEffect(() => {
    if (!open || options.projectId === '' || options.rootKey === '') return;
    const controller = new AbortController();
    const requestEpoch = ++epoch.current;
    const owner = options.owner;
    setLoading(true);
    setError(null);
    fetchFileTree(options.projectId, { signal: controller.signal }).then(
      (result) => {
        if (
          controller.signal.aborted ||
          requestEpoch !== epoch.current ||
          !sameComposerOwner(owner, latest.current.owner)
        )
          return;
        setListing({ owner, files: result.files, truncated: result.truncated });
        setLoading(false);
      },
      (cause: unknown) => {
        if (
          controller.signal.aborted ||
          requestEpoch !== epoch.current ||
          !sameComposerOwner(owner, latest.current.owner)
        )
          return;
        setError(cause instanceof Error ? cause.message : '无法读取项目文件');
        setLoading(false);
      },
    );
    return () => {
      controller.abort();
    };
  }, [open, ownerKey, options.projectId, options.rootKey]);
  function updateSelection(
    text = options.text,
    start = options.inputRef.current?.selectionStart ?? 0,
    end = options.inputRef.current?.selectionEnd ?? start,
  ): void {
    const mention = findFileMention(text, start, end);
    setActiveIndex(0);
    setMenu((current) =>
      latest.current.disabled === true
        ? null
        : mention !== undefined
          ? { owner: latest.current.owner, text, mention, query: mention.query }
          : current?.mention === undefined && current?.text === text
            ? current
            : null,
    );
  }
  function openFromButton(): void {
    setMenu({ owner: options.owner, text: options.text, query: '' });
    setActiveIndex(0);
  }
  function setQuery(value: string): void {
    if (!open || menu === null || menu.mention !== undefined) return;
    const query = value.slice(0, 256);
    setMenu((current) =>
      current === menu &&
      current !== null &&
      current.mention === undefined &&
      current.text === latest.current.text &&
      sameComposerOwner(current.owner, latest.current.owner)
        ? { ...current, query }
        : current,
    );
    setActiveIndex(0);
  }
  function select(path: string): void {
    if (
      !open ||
      menu === null ||
      menu !== latestMenu.current ||
      menu.text !== latest.current.text ||
      !sameComposerOwner(menu.owner, latest.current.owner) ||
      !items.includes(path)
    )
      return;
    const result = options.onSelect(path, menu.owner);
    if (result === 'stale' || result === 'full') return;
    const mention = menu.mention;
    if (mention !== undefined) {
      options.setText(menu.text.slice(0, mention.start) + menu.text.slice(mention.end));
      const owner = menu.owner;
      requestAnimationFrame(() => {
        if (sameComposerOwner(owner, latest.current.owner)) {
          options.inputRef.current?.focus();
          options.inputRef.current?.setSelectionRange(mention.start, mention.start);
        }
      });
    } else {
      options.inputRef.current?.focus();
    }
    close();
  }
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): boolean {
    if (!open || event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length > 0)
        setActiveIndex(
          (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length,
        );
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      event.preventDefault();
      if (items[active] !== undefined) select(items[active]);
      return true;
    }
    return false;
  }
  return {
    open,
    query,
    buttonMode,
    setQuery,
    items,
    activeIndex: active,
    setActiveIndex,
    openFromButton,
    handleKeyDown,
    close,
    updateSelection,
    select,
    listId,
    optionId: (index: number) => `${listId}-${index}`,
    loading,
    error,
    truncated: listing?.truncated === true,
    noRoot: options.projectId === '' || options.rootKey === '',
  };
}
export type FilePickerController = ReturnType<typeof useFilePicker>;
