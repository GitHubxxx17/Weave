import { type ReactElement } from 'react';
import {
  Coins,
  FileText,
  Globe,
  LayoutGrid,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import type { PanelContext } from './panel-data.js';
import { OverviewPanel } from './overview-panel.js';
import { FilesPanel } from './files-panel.js';
import { ToolsPanel } from './tools-panel.js';
import { UsagePanel } from './usage-panel.js';

/** Every side-panel kind. Data kinds render now; `preview`/`terminal` are stubs. */
export type PanelKind = 'overview' | 'files' | 'tools' | 'usage' | 'preview' | 'terminal';

export interface PanelDescriptor {
  readonly kind: PanelKind;
  readonly label: string;
  readonly Icon: LucideIcon;
  /** Opened in the default layout and shown without a close button. */
  readonly defaultPinned: boolean;
  /** Listed but disabled in the add menu; cannot be opened yet. */
  readonly comingSoon: boolean;
  readonly render?: (context: PanelContext) => ReactElement;
}

export const panelDescriptors: readonly PanelDescriptor[] = [
  {
    kind: 'overview',
    label: '概览',
    Icon: LayoutGrid,
    defaultPinned: true,
    comingSoon: false,
    render: (context) => <OverviewPanel {...context} />,
  },
  {
    kind: 'files',
    label: '文件',
    Icon: FileText,
    defaultPinned: true,
    comingSoon: false,
    render: (context) => <FilesPanel {...context} />,
  },
  {
    kind: 'tools',
    label: '工具',
    Icon: Wrench,
    defaultPinned: true,
    comingSoon: false,
    render: (context) => <ToolsPanel {...context} />,
  },
  {
    kind: 'usage',
    label: '用量',
    Icon: Coins,
    defaultPinned: true,
    comingSoon: false,
    render: (context) => <UsagePanel {...context} />,
  },
  {
    kind: 'preview',
    label: '预览',
    Icon: Globe,
    defaultPinned: false,
    comingSoon: true,
  },
  {
    kind: 'terminal',
    label: '终端',
    Icon: SquareTerminal,
    defaultPinned: false,
    comingSoon: true,
  },
];

const descriptorByKind = new Map(
  panelDescriptors.map((descriptor) => [descriptor.kind, descriptor]),
);

export function panelDescriptor(kind: PanelKind): PanelDescriptor | undefined {
  return descriptorByKind.get(kind);
}

export function isPanelKind(value: string): value is PanelKind {
  return descriptorByKind.has(value as PanelKind);
}

/** Kinds opened in a fresh layout, in tab order. */
export const defaultPanelKinds: readonly PanelKind[] = panelDescriptors
  .filter((descriptor) => descriptor.defaultPinned)
  .map((descriptor) => descriptor.kind);
