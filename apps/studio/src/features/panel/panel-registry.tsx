import { type ReactElement } from 'react';
import {
  Coins,
  FileText,
  Gauge,
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
import { ContextPanel } from './context-panel.js';
import { PreviewPanel } from './preview-panel.js';
import { TerminalPanel } from './terminal-panel.js';

/** Every side-panel kind. */
export type PanelKind =
  'overview' | 'files' | 'tools' | 'usage' | 'context' | 'preview' | 'terminal';

export interface PanelDescriptor {
  readonly kind: PanelKind;
  readonly label: string;
  readonly Icon: LucideIcon;
  /** Opened in the default layout and shown without a close button. */
  readonly defaultPinned: boolean;
  /** Listed but disabled in the add menu; cannot be opened yet. */
  readonly comingSoon: boolean;
  /**
   * Keep the panel mounted while another tab is active (hidden, not
   * unmounted). Needed by panels with live content such as the preview
   * iframe, so switching tabs does not reload or reset them.
   */
  readonly keepAlive: boolean;
  /**
   * Allow more than one open tab of this kind. A multi-instance kind opens a
   * fresh tab (its own pty or iframe) every time it is added; a
   * single-instance kind is focused instead of duplicated.
   */
  readonly multi: boolean;
  readonly render?: (context: PanelContext, instanceId: string) => ReactElement;
}

export const panelDescriptors: readonly PanelDescriptor[] = [
  {
    kind: 'overview',
    label: '概览',
    Icon: LayoutGrid,
    defaultPinned: true,
    comingSoon: false,
    keepAlive: false,
    multi: false,
    render: (context) => <OverviewPanel {...context} />,
  },
  {
    kind: 'files',
    label: '文件',
    Icon: FileText,
    defaultPinned: true,
    comingSoon: false,
    keepAlive: false,
    multi: false,
    render: (context) => <FilesPanel {...context} />,
  },
  {
    kind: 'tools',
    label: '工具',
    Icon: Wrench,
    defaultPinned: true,
    comingSoon: false,
    keepAlive: false,
    multi: false,
    render: (context) => <ToolsPanel {...context} />,
  },
  {
    kind: 'usage',
    label: '用量',
    Icon: Coins,
    defaultPinned: true,
    comingSoon: false,
    keepAlive: false,
    multi: false,
    render: (context) => <UsagePanel {...context} />,
  },
  {
    kind: 'context',
    label: '上下文',
    Icon: Gauge,
    defaultPinned: true,
    comingSoon: false,
    keepAlive: false,
    multi: false,
    render: (context) => <ContextPanel {...context} />,
  },
  {
    kind: 'preview',
    label: '预览',
    Icon: Globe,
    defaultPinned: false,
    comingSoon: false,
    keepAlive: true,
    multi: true,
    render: (_context, instanceId) => <PreviewPanel instanceId={instanceId} />,
  },
  {
    kind: 'terminal',
    label: '终端',
    Icon: SquareTerminal,
    defaultPinned: false,
    comingSoon: false,
    keepAlive: true,
    multi: true,
    render: (context) => <TerminalPanel cwd={context.folderPath} />,
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
