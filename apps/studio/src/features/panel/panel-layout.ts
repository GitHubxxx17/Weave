import { z } from 'zod';
import {
  defaultPanelKinds,
  isPanelKind,
  panelDescriptor,
  type PanelKind,
} from './panel-registry.js';
export type SavedPanelTab =
  | { readonly id: string; readonly kind: 'builtin'; readonly builtinKind: PanelKind }
  | { readonly id: string; readonly kind: 'plugin'; readonly panelId: string };
export interface SavedPanelLayout {
  readonly schemaVersion: 3;
  readonly tabs: readonly SavedPanelTab[];
  readonly pinned: readonly string[];
  readonly active: string;
}
const shell = z.object({
  tabs: z.array(z.unknown()).max(128),
  pinned: z.array(z.string().max(256)).max(128),
  active: z.string().max(256),
});
const tab = z.discriminatedUnion('kind', [
  z.strictObject({
    id: z.string().min(1).max(256),
    kind: z.literal('builtin'),
    builtinKind: z.string(),
  }),
  z.strictObject({
    id: z.string().min(1).max(256),
    kind: z.literal('plugin'),
    panelId: z
      .string()
      .max(256)
      .regex(/^plugin:[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/),
  }),
]);
export function defaultPanelLayout(): SavedPanelLayout {
  return {
    schemaVersion: 3,
    tabs: defaultPanelKinds.map((k) => ({ id: k, kind: 'builtin', builtinKind: k })),
    pinned: [...defaultPanelKinds],
    active: defaultPanelKinds[0] ?? 'overview',
  };
}
export function normalizePanelLayout(v3: unknown, v2: unknown): SavedPanelLayout {
  const current = shell.extend({ schemaVersion: z.literal(3) }).safeParse(v3);
  const old = shell.safeParse(v2);
  const input = current.success ? current.data : old.success ? old.data : null;
  if (input === null) return defaultPanelLayout();
  const tabs: SavedPanelTab[] = [];
  const ids = new Set<string>();
  for (const candidate of input.tabs) {
    const legacy = z
      .object({ id: z.string().min(1).max(256), kind: z.string() })
      .safeParse(candidate);
    const parsed = tab.safeParse(
      current.success
        ? candidate
        : legacy.success
          ? { id: legacy.data.id, kind: 'builtin', builtinKind: legacy.data.kind }
          : null,
    );
    if (!parsed.success) continue;
    const t = parsed.data;
    if (t.kind === 'plugin') {
      if (t.id !== t.panelId || ids.has(t.id)) continue;
      ids.add(t.id);
      tabs.push(t);
      continue;
    }
    if (!isPanelKind(t.builtinKind)) continue;
    const d = panelDescriptor(t.builtinKind);
    if (d === undefined || d.comingSoon) continue;
    const safeId = d.multi ? t.id : t.builtinKind;
    if (ids.has(safeId)) continue;
    ids.add(safeId);
    tabs.push({ id: safeId, kind: 'builtin', builtinKind: t.builtinKind });
  }
  if (tabs.length === 0) return defaultPanelLayout();
  return {
    schemaVersion: 3,
    tabs,
    pinned: [...new Set(input.pinned)].filter((id) => ids.has(id)),
    active: ids.has(input.active) ? input.active : tabs[0]!.id,
  };
}
