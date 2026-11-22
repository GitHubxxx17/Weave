// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeclarativePluginPanel } from '../src/features/panel/declarative-plugin-panel.js';
import { useComposerDraft } from '../src/features/composer/use-composer-draft.js';
import {
  declarativePanelSchema,
  type PanelData,
  type PluginPanelDescriptor,
} from '../src/features/panel/plugin-panel-types.js';
vi.mock('../src/features/panel/plugin-panel-api.js', () => ({
  fetchPanelData: vi.fn(),
  preparePanelCommand: vi.fn(),
}));
import { fetchPanelData } from '../src/features/panel/plugin-panel-api.js';
const authority = { serverEpoch: 'a'.repeat(32), generation: 1, authorityEpoch: 1 };
const descriptor: PluginPanelDescriptor = {
  panelId: 'plugin:p/report',
  panelRef: 'b'.repeat(32),
  pluginId: 'p',
  pluginName: 'Owner',
  pluginVersion: '1.0.0',
  state: 'available',
  definition: declarativePanelSchema.parse({
    schemaVersion: 1,
    id: 'report',
    title: 'Report',
    icon: 'table',
    placement: 'right',
    sources: [{ id: 'report', eventType: 'p/report', payloadVersion: 1 }],
    blocks: [
      { id: 'heading', type: 'heading', text: 'Summary' },
      { id: 'text', type: 'text', value: { literal: '<img src=x onerror=alert(1)>' } },
      {
        id: 'status',
        type: 'status',
        label: 'Status',
        value: { binding: { source: 'report', path: ['status'] } },
      },
      {
        id: 'metric',
        type: 'metric',
        label: 'Score',
        value: { binding: { source: 'report', path: ['score'] } },
        unit: 'points',
      },
      {
        id: 'kv',
        type: 'key-value',
        rows: [{ label: 'Branch', value: { binding: { source: 'report', path: ['branch'] } } }],
      },
      {
        id: 'table',
        type: 'table',
        rows: { source: 'report', path: ['checks'] },
        columns: [{ id: 'name', title: 'Check name', path: ['name'] }],
      },
      {
        id: 'form',
        type: 'form',
        fields: [
          { id: 'target', type: 'text', label: 'Target', required: true, default: 'src' },
          { id: 'tests', type: 'boolean', label: 'Include tests', default: true },
          {
            id: 'mode',
            type: 'select',
            label: 'Mode',
            required: true,
            options: [{ value: 'full', label: 'Full' }],
            default: 'full',
          },
        ],
        submit: { type: 'prepare-command', command: 'report', label: 'Prepare' },
      },
    ],
  }),
};
const data: PanelData = {
  ...authority,
  schemaVersion: 1,
  panelId: descriptor.panelId,
  panelRef: descriptor.panelRef,
  sessionId: 'a',
  lastSequence: 2,
  state: 'ready',
  sources: [
    {
      id: 'report',
      eventType: 'p/report',
      payloadVersion: 1,
      state: 'ready',
      latest: { sequence: 2, occurredAt: '2026-11-22T00:00:00.000Z', payloadVersion: 1 },
    },
  ],
  blocks: [
    { id: 'text', type: 'text', cell: { state: 'ready', value: '<img src=x onerror=alert(1)>' } },
    { id: 'status', type: 'status', cell: { state: 'ready', value: 'passed' } },
    { id: 'metric', type: 'metric', cell: { state: 'ready', value: 97 } },
    { id: 'kv', type: 'key-value', cells: [{ state: 'ready', value: 'main' }] },
    {
      id: 'table',
      type: 'table',
      state: 'ready',
      rows: Array.from({ length: 100 }, () => [{ state: 'ready', value: 'lint' }]),
      totalRows: 105,
      truncatedRows: 5,
    },
  ],
};
function Host({ sessionId = 'a' }: { sessionId?: string }) {
  const composer = useComposerDraft({ sessionId, projectId: 'p', rootKey: 'root' });
  return (
    <DeclarativePluginPanel
      descriptor={descriptor}
      authority={authority}
      owner={composer.owner}
      visible
      composer={composer}
    />
  );
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
describe('native declarative rendering', () => {
  it('renders every closed block and literal form field accessibly with escaped author strings', async () => {
    vi.mocked(fetchPanelData).mockResolvedValue(data);
    const view = render(<Host />);
    expect(await screen.findByText('passed')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('a')).toBeNull();
    expect(screen.getByText('97')).toBeTruthy();
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Check name' })).toBeTruthy();
    expect(screen.getByText('显示前 100 行，另有 5 行未显示')).toBeTruthy();
    expect((screen.getByLabelText('Target') as HTMLInputElement).value).toBe('src');
    expect((screen.getByLabelText('Include tests') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('full');
  });
  it.each(['empty', 'incompatible', 'invalid-data', 'data-too-large'] as const)(
    'shows %s markers while preserving static text',
    async (state) => {
      vi.mocked(fetchPanelData).mockResolvedValue({
        ...data,
        state,
        sources: [{ ...data.sources[0]!, state }],
        blocks: data.blocks.map((b) =>
          b.type === 'table'
            ? { ...b, state, rows: [], totalRows: 0, truncatedRows: 0 }
            : b.type === 'key-value'
              ? { ...b, cells: [{ state }] }
              : { ...b, cell: { state } },
        ),
      });
      render(<Host />);
      await waitFor(() =>
        expect(
          screen.getAllByText(
            {
              empty: '暂无数据',
              incompatible: '数据版本不兼容',
              'invalid-data': '数据格式无效',
              'data-too-large': '数据超过显示限制',
            }[state],
          ).length,
        ).toBeGreaterThan(1),
      );
      expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    },
  );
  it('rejects malformed projection correspondence instead of rendering unvalidated cells', async () => {
    vi.mocked(fetchPanelData).mockResolvedValue({
      ...data,
      blocks: [{ id: 'wrong', type: 'text', cell: { state: 'ready', value: 'unsafe wrong cell' } }],
    });
    render(<Host />);
    expect(await screen.findByText('面板数据暂不可用')).toBeTruthy();
    expect(screen.queryByText('unsafe wrong cell')).toBeNull();
  });
  it('disables preparation before a real Session exists', () => {
    render(<Host sessionId="" />);
    const button = screen.getByRole('button', { name: 'Prepare' }) as HTMLButtonElement;
    expect(button.closest('fieldset')?.disabled).toBe(true);
    expect(fetchPanelData).not.toHaveBeenCalled();
  });
});
