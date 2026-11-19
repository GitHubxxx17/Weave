import { useCallback, useMemo, useState } from 'react';
import { z } from 'zod';

import {
  defaultPanelKinds,
  isPanelKind,
  panelDescriptor,
  type PanelKind,
} from './panel-registry.js';

const storageKey = 'weave.studio.panelTabs.v2';

const panelKindSchema = z.string().refine(isPanelKind);

const storedTabSchema = z.object({ id: z.string().min(1), kind: panelKindSchema });

const storedLayoutSchema = z.object({
  tabs: z.array(storedTabSchema),
  pinned: z.array(z.string()),
  active: z.string(),
});

/**
 * One open tab. A single-instance kind uses `id === kind`; a multi-instance
 * kind (terminal, preview) gets a unique id so two tabs of the same kind each
 * keep their own pty or iframe.
 */
export interface PanelTab {
  readonly id: string;
  readonly kind: PanelKind;
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

function defaultLayout(): PanelLayout {
  const tabs = defaultPanelKinds.map((kind) => ({ id: kind, kind }));
  return {
    tabs,
    pinned: tabs.map((tab) => tab.id),
    active: tabs[0]?.id ?? 'overview',
  };
}

/**
 * Drops unknown/coming-soon kinds, collapses accidental duplicate
 * single-instance tabs, and repairs the pinned set and active id so a stored
 * layout is always usable.
 */
function normalize(layout: PanelLayout): PanelLayout {
  const seenIds = new Set<string>();
  const seenSingletonKinds = new Set<PanelKind>();
  const tabs: PanelTab[] = [];
  for (const tab of layout.tabs) {
    const descriptor = panelDescriptor(tab.kind);
    if (descriptor === undefined || descriptor.comingSoon || seenIds.has(tab.id)) {
      continue;
    }
    if (!descriptor.multi) {
      // Single-instance kinds always use id === kind and appear at most once.
      if (seenSingletonKinds.has(tab.kind)) {
        continue;
      }
      seenSingletonKinds.add(tab.kind);
      seenIds.add(tab.kind);
      tabs.push({ id: tab.kind, kind: tab.kind });
      continue;
    }
    seenIds.add(tab.id);
    tabs.push({ id: tab.id, kind: tab.kind });
  }
  const safeTabs = tabs.length > 0 ? tabs : defaultLayout().tabs;
  const ids = new Set(safeTabs.map((tab) => tab.id));
  const pinned = [...new Set(layout.pinned)].filter((id) => ids.has(id));
  const active = ids.has(layout.active) ? layout.active : (safeTabs[0]?.id ?? 'overview');
  return { tabs: safeTabs, pinned, active };
}

function readLayout(): PanelLayout {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    if (raw === null || raw === undefined) {
      return defaultLayout();
    }
    const parsed = storedLayoutSchema.safeParse(JSON.parse(raw));
    return parsed.success ? normalize(parsed.data) : defaultLayout();
  } catch {
    return defaultLayout();
  }
}

function saveLayout(layout: PanelLayout): void {
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(layout));
  } catch {
    // Storage can be unavailable (private mode, quota); the layout still applies.
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
  readonly close: (id: string) => void;
  readonly togglePin: (id: string) => void;
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
        setLayout({ ...layout, tabs: [...layout.tabs, { id: kind, kind }], active: kind });
        return;
      }
      const tab = { id: newTabId(kind), kind };
      setLayout({ ...layout, tabs: [...layout.tabs, tab], active: tab.id });
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

  return useMemo(
    () => ({ layout, activate, open, close, togglePin }),
    [layout, activate, open, close, togglePin],
  );
}
