import { useCallback, useMemo, useState } from 'react';
import { z } from 'zod';

import {
  defaultPanelKinds,
  isPanelKind,
  panelDescriptor,
  type PanelKind,
} from './panel-registry.js';

const storageKey = 'weave.studio.panelTabs.v1';

const panelKindSchema = z.string().refine(isPanelKind);

const storedLayoutSchema = z.object({
  open: z.array(panelKindSchema),
  pinned: z.array(panelKindSchema),
  active: panelKindSchema,
});

export interface PanelLayout {
  /** Open tabs in display order. */
  readonly open: readonly PanelKind[];
  /** Pinned tabs (a subset of `open`) that cannot be closed. */
  readonly pinned: readonly PanelKind[];
  readonly active: PanelKind;
}

function defaultLayout(): PanelLayout {
  return {
    open: [...defaultPanelKinds],
    pinned: [...defaultPanelKinds],
    active: defaultPanelKinds[0] ?? 'overview',
  };
}

/** Drops unknown/openable-only inconsistencies so a stored layout is always usable. */
function normalize(layout: PanelLayout): PanelLayout {
  const open = layout.open.filter(
    (kind, index) =>
      layout.open.indexOf(kind) === index && panelDescriptor(kind)?.comingSoon === false,
  );
  const safeOpen = open.length > 0 ? open : [...defaultPanelKinds];
  const pinned = safeOpen.filter((kind) => layout.pinned.includes(kind));
  const active = safeOpen.includes(layout.active) ? layout.active : (safeOpen[0] as PanelKind);
  return { open: safeOpen, pinned, active };
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
  readonly activate: (kind: PanelKind) => void;
  /** Opens a kind (if openable) and activates it. */
  readonly open: (kind: PanelKind) => void;
  readonly close: (kind: PanelKind) => void;
  readonly togglePin: (kind: PanelKind) => void;
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
    (kind: PanelKind) => {
      setLayout({ ...layout, active: kind });
    },
    [layout, setLayout],
  );

  const open = useCallback(
    (kind: PanelKind) => {
      if (panelDescriptor(kind)?.comingSoon !== false) {
        return;
      }
      setLayout({
        ...layout,
        open: layout.open.includes(kind) ? layout.open : [...layout.open, kind],
        active: kind,
      });
    },
    [layout, setLayout],
  );

  const close = useCallback(
    (kind: PanelKind) => {
      if (layout.pinned.includes(kind) || !layout.open.includes(kind)) {
        return;
      }
      const open = layout.open.filter((candidate) => candidate !== kind);
      const active =
        layout.active === kind ? (open.at(-1) ?? open[0] ?? 'overview') : layout.active;
      setLayout({ ...layout, open, pinned: layout.pinned, active });
    },
    [layout, setLayout],
  );

  const togglePin = useCallback(
    (kind: PanelKind) => {
      if (!layout.open.includes(kind)) {
        return;
      }
      const pinned = layout.pinned.includes(kind)
        ? layout.pinned.filter((candidate) => candidate !== kind)
        : [...layout.pinned, kind];
      setLayout({ ...layout, pinned });
    },
    [layout, setLayout],
  );

  return useMemo(
    () => ({ layout, activate, open, close, togglePin }),
    [layout, activate, open, close, togglePin],
  );
}
