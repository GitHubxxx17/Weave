import { useCallback, useMemo, useState } from 'react';
import { normalizePanelLayout, type SavedPanelLayout } from './panel-layout.js';

import { panelDescriptor, type PanelKind } from './panel-registry.js';

const storageKey = 'weave.studio.panelTabs.v3';
/**
 * One open tab. A single-instance kind uses `id === kind`; a multi-instance
 * kind (terminal, preview) gets a unique id so two tabs of the same kind each
 * keep their own pty or iframe.
 */
export interface PanelTab {
  readonly id: string;
  readonly kind: PanelKind | 'plugin';
  readonly panelId?: string;
}

export interface PanelLayout {
  /** Open tabs in display order. */
  readonly tabs: readonly PanelTab[];
  /** Ids of pinned tabs (a subset of `tabs`) that cannot be closed. */
  readonly pinned: readonly string[];
  readonly active: string;
}

let instanceCounter = 0;

/** A unique id for a multi-instance tab, e.g. `terminal:ab12…`. */
function newTabId(kind: PanelKind): string {
  const unique =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(instanceCounter += 1)}`;
  return `${kind}:${unique}`;
}

function toRuntime(saved: SavedPanelLayout): PanelLayout {
  return {
    tabs: saved.tabs.map((tab) =>
      tab.kind === 'plugin'
        ? { id: tab.id, kind: 'plugin', panelId: tab.panelId }
        : { id: tab.id, kind: tab.builtinKind },
    ),
    pinned: saved.pinned,
    active: saved.active,
  };
}
function toSaved(layout: PanelLayout): SavedPanelLayout {
  return {
    schemaVersion: 3,
    tabs: layout.tabs.map((tab) =>
      tab.kind === 'plugin'
        ? { id: tab.id, kind: 'plugin', panelId: tab.panelId ?? tab.id }
        : { id: tab.id, kind: 'builtin', builtinKind: tab.kind },
    ),
    pinned: layout.pinned,
    active: layout.active,
  };
}
function normalize(layout: PanelLayout): PanelLayout {
  return toRuntime(normalizePanelLayout(toSaved(layout), null));
}
function readLayout(): PanelLayout {
  function read(key: string): unknown {
    try {
      return JSON.parse(globalThis.localStorage?.getItem(key) ?? 'null') as unknown;
    } catch {
      return null;
    }
  }
  return toRuntime(normalizePanelLayout(read(storageKey), read('weave.studio.panelTabs.v2')));
}
function saveLayout(layout: PanelLayout): void {
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(toSaved(layout)));
  } catch {
    /* Storage is optional. */
  }
}

export interface PanelTabsController {
  readonly layout: PanelLayout;
  /** Activates an open tab by id. */
  readonly activate: (id: string) => void;
  /**
   * Opens a kind. A single-instance kind is focused when already open and
   * created otherwise; a multi-instance kind always opens a new tab.
   */
  readonly open: (kind: PanelKind) => void;
  readonly openPlugin: (panelId: string) => void;
  readonly close: (id: string) => void;
  readonly togglePin: (id: string) => void;
  /** Moves `draggedId` to just before or after `targetId` in the tab order. */
  readonly reorder: (draggedId: string, targetId: string, after: boolean) => void;
}

/** Persisted side-panel tab state: which tabs are open, pinned, and active. */
export function usePanelTabs(): PanelTabsController {
  const [layout, setLayoutState] = useState<PanelLayout>(() => readLayout());

  const setLayout = useCallback((next: PanelLayout) => {
    const normalized = normalize(next);
    setLayoutState(normalized);
    saveLayout(normalized);
  }, []);

  const activate = useCallback(
    (id: string) => {
      setLayout({ ...layout, active: id });
    },
    [layout, setLayout],
  );

  const open = useCallback(
    (kind: PanelKind) => {
      const descriptor = panelDescriptor(kind);
      if (descriptor === undefined || descriptor.comingSoon) {
        return;
      }
      if (!descriptor.multi) {
        const existing = layout.tabs.find((tab) => tab.kind === kind);
        if (existing !== undefined) {
          setLayout({ ...layout, active: existing.id });
          return;
        }
        if (layout.tabs.length >= 128) return;
        setLayout({ ...layout, tabs: [...layout.tabs, { id: kind, kind }], active: kind });
        return;
      }
      if (layout.tabs.length >= 128) return;
      const tab = { id: newTabId(kind), kind };
      setLayout({ ...layout, tabs: [...layout.tabs, tab], active: tab.id });
    },
    [layout, setLayout],
  );

  const openPlugin = useCallback(
    (panelId: string) => {
      const existing = layout.tabs.find((t) => t.id === panelId);
      if (existing === undefined && layout.tabs.length >= 128) return;
      setLayout({
        ...layout,
        tabs:
          existing === undefined
            ? [...layout.tabs, { id: panelId, kind: 'plugin', panelId }]
            : layout.tabs,
        active: panelId,
      });
    },
    [layout, setLayout],
  );
  const close = useCallback(
    (id: string) => {
      if (layout.pinned.includes(id) || !layout.tabs.some((tab) => tab.id === id)) {
        return;
      }
      const tabs = layout.tabs.filter((tab) => tab.id !== id);
      const active =
        layout.active === id ? (tabs.at(-1)?.id ?? tabs[0]?.id ?? 'overview') : layout.active;
      setLayout({ ...layout, tabs, active });
    },
    [layout, setLayout],
  );

  const togglePin = useCallback(
    (id: string) => {
      if (!layout.tabs.some((tab) => tab.id === id)) {
        return;
      }
      const pinned = layout.pinned.includes(id)
        ? layout.pinned.filter((candidate) => candidate !== id)
        : [...layout.pinned, id];
      setLayout({ ...layout, pinned });
    },
    [layout, setLayout],
  );

  const reorder = useCallback(
    (draggedId: string, targetId: string, after: boolean) => {
      if (draggedId === targetId) {
        return;
      }
      const dragged = layout.tabs.find((tab) => tab.id === draggedId);
      if (dragged === undefined) {
        return;
      }
      const without = layout.tabs.filter((tab) => tab.id !== draggedId);
      const targetIndex = without.findIndex((tab) => tab.id === targetId);
      if (targetIndex < 0) {
        return;
      }
      const insertAt = after ? targetIndex + 1 : targetIndex;
      const tabs = [...without.slice(0, insertAt), dragged, ...without.slice(insertAt)];
      setLayout({ ...layout, tabs });
    },
    [layout, setLayout],
  );

  return useMemo(
    () => ({ layout, activate, open, openPlugin, close, togglePin, reorder }),
    [layout, activate, open, openPlugin, close, togglePin, reorder],
  );
}
