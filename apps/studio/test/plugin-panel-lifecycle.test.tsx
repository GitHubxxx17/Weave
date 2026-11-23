// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { fetchPanelData, preparePanelCommand } from '../src/features/panel/plugin-panel-api.js';
const authority = { serverEpoch: 'a'.repeat(32), generation: 1, authorityEpoch: 1 };
const descriptor: PluginPanelDescriptor = {
  panelId: 'plugin:p/report',
  panelRef: 'b'.repeat(32),
  pluginId: 'p',
  pluginName: 'P',
  pluginVersion: '1.0.0',
  state: 'available',
  definition: declarativePanelSchema.parse({
    schemaVersion: 1,
    id: 'report',
    title: 'Report',
    icon: 'info',
    placement: 'right',
    sources: [{ id: 'report', eventType: 'p/report', payloadVersion: 1 }],
    blocks: [
      { id: 'text', type: 'text', value: { binding: { source: 'report', path: ['value'] } } },
      {
        id: 'one',
        type: 'form',
        fields: [{ id: 'target', type: 'text', label: 'Target', required: true, default: 'src' }],
        submit: { type: 'prepare-command', command: 'report', label: 'Prepare one' },
      },
      {
        id: 'two',
        type: 'form',
        fields: [{ id: 'check', type: 'boolean', label: 'Check', default: true }],
        submit: { type: 'prepare-command', command: 'report', label: 'Prepare two' },
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
  lastSequence: 1,
  state: 'ready',
  sources: [
    { id: 'report', eventType: 'p/report', payloadVersion: 1, state: 'ready', latest: null },
  ],
  blocks: [{ id: 'text', type: 'text', cell: { state: 'ready', value: 'current' } }],
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function Host({
  sessionId = 'a',
  visible = true,
  mounted = true,
  refValue = descriptor.panelRef,
  rootKey = 'root',
  authorityEpoch = 1,
}: {
  sessionId?: string;
  visible?: boolean;
  mounted?: boolean;
  refValue?: string;
  rootKey?: string;
  authorityEpoch?: number;
}) {
  const draft = useComposerDraft({ sessionId, projectId: 'p', rootKey });
  return (
    <>
      <textarea
        aria-label="Draft"
        value={draft.draft.text}
        onChange={(e) => draft.setText(e.target.value)}
      />
      {mounted ? (
        <DeclarativePluginPanel
          descriptor={{ ...descriptor, panelRef: refValue }}
          authority={{ ...authority, authorityEpoch }}
          owner={draft.owner}
          visible={visible}
          composer={draft}
        />
      ) : null}
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
describe('actual panel lifecycle', () => {
  it('does not paint late A data after A B A transitions despite ignored abort', async () => {
    const old = deferred<PanelData>();
    vi.mocked(fetchPanelData).mockReturnValueOnce(old.promise).mockResolvedValue(data);
    const view = render(<Host />);
    view.rerender(<Host sessionId="b" />);
    view.rerender(<Host sessionId="a" />);
    await act(async () =>
      old.resolve({
        ...data,
        blocks: [{ id: 'text', type: 'text', cell: { state: 'ready', value: 'old A value' } }],
      }),
    );
    await waitFor(() => expect(screen.queryByText('old A value')).toBeNull());
  });
  it('rejects pending prepare after hide show and across remount', async () => {
    vi.mocked(fetchPanelData).mockResolvedValue(data);
    const pending = deferred<never>();
    vi.mocked(preparePanelCommand).mockReturnValue(pending.promise);
    const view = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare one' }));
    view.rerender(<Host visible={false} />);
    view.rerender(<Host />);
    await act(async () =>
      pending.resolve({
        ...data,
        formId: 'one',
        command: 'report',
        text: 'old prepared',
        requiresUserSend: true,
      } as never),
    );
    expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('');
  });
  it('uses one global token across two forms and appends to latest draft', async () => {
    vi.mocked(fetchPanelData).mockResolvedValue(data);
    const first = deferred<never>(),
      second = deferred<never>();
    vi.mocked(preparePanelCommand)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare one' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare two' }));
    expect(screen.getByRole('button', { name: 'Prepare one' }).closest('fieldset')?.disabled).toBe(
      false,
    );
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'edited' } });
    await act(async () =>
      second.resolve({
        ...data,
        formId: 'two',
        command: 'report',
        text: 'new',
        requiresUserSend: true,
      } as never),
    );
    await act(async () =>
      first.resolve({
        ...data,
        formId: 'one',
        command: 'report',
        text: 'old',
        requiresUserSend: true,
      } as never),
    );
    expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('edited\n\nnew');
  });
});

it('clears ready data on hide show before a new read settles and rejects remount prepare', async () => {
  vi.mocked(fetchPanelData).mockResolvedValueOnce(data);
  const view = render(<Host />);
  await screen.findByText('current');
  const next = deferred<PanelData>();
  vi.mocked(fetchPanelData).mockReturnValue(next.promise);
  view.rerender(<Host visible={false} />);
  view.rerender(<Host />);
  expect(screen.queryByText('current')).toBeNull();
  const pending = deferred<never>();
  vi.mocked(preparePanelCommand).mockReturnValue(pending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare one' }));
  view.rerender(<Host mounted={false} />);
  view.rerender(<Host />);
  await act(async () =>
    pending.resolve({
      ...data,
      formId: 'one',
      command: 'report',
      text: 'remount stale',
      requiresUserSend: true,
    } as never),
  );
  expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('');
});
it('starts polling two seconds after completion and never overlaps pending reads', async () => {
  vi.useFakeTimers();
  try {
    const pending = deferred<PanelData>();
    vi.mocked(fetchPanelData).mockReturnValueOnce(pending.promise).mockResolvedValue(data);
    const view = render(<Host />);
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(fetchPanelData).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(data));
    expect(screen.getByText('current')).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1999));
    expect(fetchPanelData).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchPanelData).toHaveBeenCalledTimes(2);
    view.rerender(<Host visible={false} />);
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(fetchPanelData).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it.each(['ref', 'authority', 'root'])(
  'rejects prepared insertion after exact %s replacement',
  async (kind) => {
    vi.mocked(fetchPanelData).mockResolvedValue(data);
    const pending = deferred<never>();
    vi.mocked(preparePanelCommand).mockReturnValue(pending.promise);
    const view = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare one' }));
    view.rerender(
      <Host
        refValue={kind === 'ref' ? 'c'.repeat(32) : descriptor.panelRef}
        authorityEpoch={kind === 'authority' ? 2 : 1}
        rootKey={kind === 'root' ? 'other' : 'root'}
      />,
    );
    await act(async () =>
      pending.resolve({
        ...data,
        formId: 'one',
        command: 'report',
        text: 'old',
        requiresUserSend: true,
      } as never),
    );
    expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('');
  },
);

it('prepares in StrictMode while the initial data read remains pending', async () => {
  const read = deferred<PanelData>();
  vi.mocked(fetchPanelData).mockReturnValue(read.promise);
  // Request admission and the eventual draft commit are separate observable states.
  const prepare = deferred<Awaited<ReturnType<typeof preparePanelCommand>>>();
  vi.mocked(preparePanelCommand).mockReturnValue(prepare.promise);
  const prepared = {
    ...authority,
    schemaVersion: 1,
    panelId: descriptor.panelId,
    panelRef: descriptor.panelRef,
    sessionId: 'a',
    lastSequence: 1,
    formId: 'one',
    command: 'report',
    text: 'prepared',
    requiresUserSend: true,
  } as const;
  render(
    <StrictMode>
      <Host />
    </StrictMode>,
  );
  const submit = screen.getByRole('button', { name: 'Prepare one' });
  const draft = screen.getByLabelText<HTMLTextAreaElement>('Draft');
  fireEvent.click(submit);
  expect(preparePanelCommand).toHaveBeenCalledTimes(1);
  expect(vi.mocked(preparePanelCommand).mock.calls[0]?.[3].aborted).toBe(false);
  expect(draft.value).toBe('');
  expect(submit.closest('fieldset')?.disabled).toBe(true);

  await act(async () => prepare.resolve(prepared));
  await waitFor(() => expect(draft.value).toBe('prepared'));
  expect(screen.getByRole('status').textContent).toBe('已准备文本，请检查并点击发送');
  expect(submit.closest('fieldset')?.disabled).toBe(false);
  expect(screen.queryByText('current')).toBeNull();
  expect(preparePanelCommand).toHaveBeenCalledTimes(1);
});
