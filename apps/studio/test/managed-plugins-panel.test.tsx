// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ManagedCatalog,
  ManagedMutationResponse,
  ManagedPreview,
} from '../src/features/plugins/managed-plugin-types.js';
import { PluginCatalogProvider } from '../src/features/plugins/plugin-catalog-context.js';
import { createPluginCatalogStore } from '../src/features/plugins/plugin-catalog-store.js';
import type { PluginListItem } from '../src/features/plugins/plugin-types.js';
import { PluginsPanel } from '../src/features/plugins/plugins-panel.js';
import {
  firstActive,
  firstCandidate,
  firstDigest,
  firstSelection,
  managedCatalog,
  managedDecision,
  managedGeneration,
  managedPlugin,
  managedPluginId,
  managedPreview,
  secondCandidate,
  secondDigest,
} from './support/managed-plugin-fixtures.js';

const generation = managedGeneration;
const local = {
  directory: '/plugins',
  exists: true,
  truncated: false,
  trustSequence: 1,
  generation: { ...generation, plugins: [] },
};
const emptyHistory = { ...managedCatalog, plugins: [] };
const publishedKernel: PluginListItem = {
  id: managedPluginId,
  name: 'Published kernel row',
  version: '1.0.0',
  origin: 'kernel',
  host: 'in-process',
  state: 'loaded',
  capabilities: ['tool'],
  provides: {
    tools: ['published-tool'],
    providers: [],
    promptSections: [],
    events: [],
    commands: [],
    hooks: [],
    services: [],
  },
};
const manualRow: PluginListItem = {
  ...publishedKernel,
  name: 'Manual row',
  origin: 'local',
  state: 'pending-trust',
  provides: { ...publishedKernel.provides, tools: [] },
  local: {
    directory: '/plugins/manual',
    digest: firstDigest,
    manifest: firstCandidate.manifest,
    enabled: false,
  },
};
const validPreview: ManagedPreview = {
  ...managedPreview,
  expectedInstallSequence: managedCatalog.heads.installSequence,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

type Handler = (path: string, init: RequestInit) => Response | Promise<Response> | undefined;
function installFetch({
  managed = () => managedCatalog,
  plugins = [],
  handle = () => undefined,
}: {
  readonly managed?: () => ManagedCatalog;
  readonly plugins?: readonly PluginListItem[];
  readonly handle?: Handler;
} = {}) {
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit) => {
    const path = String(input);
    const response = handle(path, init);
    if (response !== undefined) return response;
    if (init.method === 'GET') {
      if (path === '/plugins') return Response.json({ plugins, local, generation });
      if (path === '/mcp') return Response.json({ authoritySequence: 2, generation, servers: [] });
      if (path === '/plugins/managed') return Response.json(managed());
    }
    throw new Error(`Unexpected fetch ${init.method} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return {
    fetch,
    writes: () => fetch.mock.calls.filter(([, init]) => init.method !== 'GET'),
  };
}

function renderPanel(store = createPluginCatalogStore(), hasRunningSessions = true) {
  return render(
    <StrictMode>
      <PluginCatalogProvider store={store}>
        <button data-plugin-navigation="">插件标签</button>
        <PluginsPanel hasRunningSessions={hasRunningSessions} />
      </PluginCatalogProvider>
    </StrictMode>,
  );
}

function pendingResponse() {
  let finish: (response: Response) => void = () => undefined;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  return { response, finish };
}

function failure(status: number, code: string) {
  return Response.json({ error: { code, message: code } }, { status });
}

function openManagedRow() {
  return within(screen.getByRole('region', { name: '受管插件' }));
}

async function managedRow() {
  await screen.findByRole('region', { name: '受管插件' });
  const summary = openManagedRow().getByText(managedPluginId, { selector: '.plugin-name' });
  fireEvent.click(summary);
  return within(summary.closest('details')!);
}

function writePath(value: string) {
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: '插件来源目录' });
  fireEvent.change(input, { target: { value } });
  return input;
}

function previewPath() {
  fireEvent.click(screen.getByRole('button', { name: '预览插件' }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Studio managed plugins', () => {
  it('keeps the raw path and discards a late preview after the user edits the input', async () => {
    const first = pendingResponse();
    const second = pendingResponse();
    const requests = [first.response, second.response];
    const network = installFetch({
      managed: () => emptyHistory,
      handle: (path) => (path === '/plugins/managed/preview' ? requests.shift() : undefined),
    });
    const store = createPluginCatalogStore();
    const panel = renderPanel(store);
    await screen.findByText('尚无受管插件');
    expect(network.writes()).toHaveLength(0);
    writePath('/first');
    previewPath();
    const path = '/next folder/with trailing space ';
    writePath(path);
    previewPath();
    expect(network.writes().map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      { sourceDirectory: '/first' },
      { sourceDirectory: path },
    ]);
    expect(network.writes()[0]?.[1].signal?.aborted).toBe(true);
    await act(async () => {
      second.finish(Response.json(validPreview));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('.managed-source-path')?.textContent).toBe(path);
    expect(within(dialog).getByText(secondDigest)).toBeTruthy();
    expect(within(dialog).queryByText(validPreview.previewId)).toBeNull();
    await act(async () => {
      first.finish(
        Response.json({
          ...validPreview,
          candidate: { ...validPreview.candidate, digest: firstDigest },
        }),
      );
    });
    expect(within(dialog).queryByText(firstDigest)).toBeNull();
    panel.unmount();
    renderPanel(store);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '插件来源目录' }).value).toBe('');
    expect(network.writes()).toHaveLength(2);
  });

  it('restores focus to the source path after Escape from a deferred preview', async () => {
    const deferred = pendingResponse();
    installFetch({
      managed: () => emptyHistory,
      handle: (path) => (path === '/plugins/managed/preview' ? deferred.response : undefined),
    });
    renderPanel();
    await screen.findByText('尚无受管插件');
    const source = writePath('/local');
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: '预览插件' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger.disabled).toBe(true);
    // JSDOM does not automatically drop focus when the focused button becomes disabled.
    trigger.blur();
    expect(document.activeElement).toBe(document.body);
    await act(async () => deferred.finish(Response.json(validPreview)));
    const cancel = within(screen.getByRole('dialog')).getByRole('button', { name: '取消' });
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(source);
  });

  it('opts into a validated plugin picker and ignores cancelled, invalid and stale results', async () => {
    const network = installFetch({ managed: () => emptyHistory });
    const picker = vi.fn();
    vi.stubGlobal('weaveDesktop', { isDesktop: true, serverUrl: '', pickDirectory: picker });
    const panel = renderPanel();
    await screen.findByText('尚无受管插件');
    expect(screen.queryByRole('button', { name: '选择插件文件夹' })).toBeNull();
    panel.unmount();
    vi.stubGlobal('weaveDesktop', {
      isDesktop: true,
      serverUrl: '',
      pluginDirectoryPicker: true,
      pickDirectory: picker,
    });
    renderPanel();
    await screen.findByText('尚无受管插件');
    const input = writePath('/manual');
    const choose = screen.getByRole('button', { name: '选择插件文件夹' });
    picker.mockResolvedValueOnce(null);
    await act(async () => fireEvent.click(choose));
    expect(input.value).toBe('/manual');
    picker.mockResolvedValueOnce({ path: '/valid', name: 'valid', extra: true });
    await act(async () => fireEvent.click(choose));
    expect(screen.getByText('文件夹选择器返回了无效的目录。')).toBeTruthy();
    expect(input.value).toBe('/manual');
    let finish: (value: unknown) => void = () => undefined;
    picker.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(choose);
    writePath('/new manual');
    await act(async () => finish({ path: '/late', name: 'late' }));
    expect(input.value).toBe('/new manual');
    picker.mockResolvedValueOnce({ path: 'C:\\Folder With Space ', name: 'Folder With Space' });
    await act(async () => fireEvent.click(choose));
    expect(input.value).toBe('C:\\Folder With Space ');
    expect(picker.mock.calls).toEqual(Array.from({ length: 4 }, () => ['plugin-import']));
    expect(network.writes()).toHaveLength(0);
  });

  it('merges only the published kernel row and distinguishes equal digests by activation sequence', async () => {
    installFetch({
      plugins: [publishedKernel, manualRow],
      managed: () => ({
        ...managedCatalog,
        plugins: [
          { ...managedPlugin, selection: { ...firstSelection, activationSequence: 3 } },
        ].map((row) => ({ ...row, trust: { digest: firstDigest, enabled: true } })),
      }),
    });
    renderPanel();
    const row = await managedRow();
    expect(row.getByText('当前选择尚未发布')).toBeTruthy();
    expect(row.getByText('激活序号 3')).toBeTruthy();
    expect(row.getByText('激活序号 2')).toBeTruthy();
    expect(row.getByText('published-tool')).toBeTruthy();
    expect(screen.queryByText('Published kernel row')).toBeNull();
    expect(screen.getByText('Manual row')).toBeTruthy();
  });

  it('uses the selected digest and import sequence for the current version and enable review', async () => {
    const network = installFetch({
      managed: () => ({
        ...managedCatalog,
        plugins: [
          {
            ...managedPlugin,
            candidates: [
              { ...secondCandidate, importSequence: firstCandidate.importSequence },
              firstCandidate,
            ],
            selection: firstSelection,
            trust: { digest: firstDigest, enabled: false },
            active: null,
          },
        ],
      }),
    });
    renderPanel();
    const row = await managedRow();
    const selection = within(row.getByText('当前选择').parentElement!);
    expect(selection.getByText('v1.0.0 · 导入序号 1')).toBeTruthy();

    fireEvent.click(row.getByRole('button', { name: '启用' }));
    const dialog = within(screen.getByRole('dialog', { name: `启用插件「${managedPluginId}」` }));
    expect(dialog.getByText('v1.0.0')).toBeTruthy();
    expect(dialog.getByText(firstDigest)).toBeTruthy();
    expect(
      within(dialog.getByRole('region', { name: '插件声明' })).getByText('notes.writer'),
    ).toBeTruthy();
    expect(network.writes()).toHaveLength(0);
  });

  it.each(['activate', 'rollback'] as const)(
    'reviews %s before sending with the captured prior selection',
    async (intent) => {
      const previousSelection = intent === 'activate' ? null : secondDigest;
      const current =
        intent === 'activate'
          ? {
              ...managedCatalog,
              plugins: [{ ...managedPlugin, selection: null, trust: null, active: null }],
            }
          : managedCatalog;
      const network = installFetch({
        managed: () => current,
        handle: (path, init) => {
          if (path !== `/plugins/managed/${managedPluginId}/activate`) return;
          const body = JSON.parse(String(init.body)) as { requestId: string };
          return Response.json({
            kind: 'replayed',
            decision: {
              ...managedDecision({ kind: 'activate', digest: firstDigest, intent }),
              requestId: body.requestId,
            },
            current,
            application: { status: 'unknown' },
          } satisfies ManagedMutationResponse);
        },
      });
      renderPanel();
      const row = await managedRow();
      const candidate = within(
        row.getByText(firstDigest, { selector: '.managed-candidate code' }).closest('li')!,
      );
      const action = intent === 'activate' ? '激活' : '回退';
      const trigger = candidate.getByRole('button', { name: action });
      trigger.focus();
      fireEvent.click(trigger);
      const dialog = within(screen.getByRole('dialog'));
      const cancel = dialog.getByRole('button', { name: '取消' });
      const confirm = dialog.getByRole('button', { name: `确认${action}` });
      for (const value of [
        'Notes',
        'Local notes commands',
        '1.0.0',
        'in-process',
        '>=0.1.0 <2.0.0',
        'notes.writer',
        'workspace:write',
      ]) {
        expect(dialog.getByText(value)).toBeTruthy();
      }
      expect(document.activeElement).toBe(cancel);
      fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
      const body = dialog.getByRole('region', { name: '审查内容' });
      expect(document.activeElement).toBe(body);
      fireEvent.keyDown(body, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(confirm);
      fireEvent.keyDown(confirm, { key: 'Escape' });
      expect(document.activeElement).toBe(trigger);
      expect(network.writes()).toHaveLength(0);
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole('button', { name: `确认${action}` }));
      await screen.findByText('决定已保存');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(network.writes()).toHaveLength(1);
      expect(JSON.parse(String(network.writes()[0]?.[1].body))).toMatchObject({
        intent,
        previousSelection,
        digest: firstDigest,
        manifest: firstCandidate.manifest,
        expectedInstallSequence: current.heads.installSequence,
        expectedTrustSequence: current.heads.trustSequence,
      });
    },
  );

  it('describes expiry and preserves a review after a recoverable rejection but retires its stale token', async () => {
    let attempt = 0;
    const network = installFetch({
      managed: () => emptyHistory,
      handle: (path) => {
        if (path === '/plugins/managed/preview') return Response.json(validPreview);
        if (path === '/plugins/managed/import')
          return ++attempt === 1
            ? failure(409, 'plugin-managed-namespace-unavailable')
            : failure(409, 'plugin-preview-stale');
      },
    });
    renderPanel();
    await screen.findByText('尚无受管插件');
    writePath('/from disk');
    previewPath();
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/预览有效至/)).toBeTruthy();
    const confirm = dialog.getByRole<HTMLButtonElement>('button', { name: '确认导入' });
    fireEvent.click(confirm);
    await dialog.findByText(/plugin-managed-namespace-unavailable/);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await screen.findByText(/plugin-preview-stale/);
    expect(screen.queryByRole('button', { name: '确认导入' })).toBeNull();
    expect(screen.getByRole('button', { name: '重新预览' })).toBeTruthy();
    expect(network.writes().map(([, init]) => init.signal !== undefined)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('recovers an unresolved request across remount and offers re-preview after a rejected exact retry', async () => {
    let attempt = 0;
    const network = installFetch({
      managed: () => emptyHistory,
      plugins: [manualRow],
      handle: (path) => {
        if (path === '/plugins/managed/preview') return Response.json(validPreview);
        if (path === '/plugins/managed/import')
          return ++attempt === 1
            ? failure(503, 'response-lost')
            : failure(409, 'plugin-managed-namespace-unavailable');
      },
    });
    const store = createPluginCatalogStore();
    const panel = renderPanel(store);
    await screen.findByText('尚无受管插件');
    writePath('/private source');
    previewPath();
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    panel.unmount();
    renderPanel(store);
    expect(screen.queryByDisplayValue('/private source')).toBeNull();
    const read = screen.getByRole<HTMLButtonElement>('button', { name: '读取目录' });
    const reads = () => network.fetch.mock.calls.filter(([, init]) => init.method === 'GET').length;
    const before = reads();
    expect(read.disabled).toBe(false);
    fireEvent.click(read);
    await waitFor(() => expect(reads()).toBe(before + 3));
    expect(store.getSnapshot().consistency.kind).toBe('ready');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '预览插件' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '添加 MCP 服务' }).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByText('Manual row'));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '审阅并信任' }).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '重试原请求' }));
    expect(network.writes()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '确认重试' }));
    const repreview = await screen.findByRole('button', { name: '重新预览' });
    await waitFor(() => expect((repreview as HTMLButtonElement).disabled).toBe(false));
    expect(network.writes()[1]).toEqual(network.writes()[2]);
    fireEvent.click(repreview);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '插件来源目录' }));
    expect(network.writes()).toHaveLength(3);
  });

  it('closes the stop-tracking review and offers a catalog read when the follow-up read fails', async () => {
    let failRead = false;
    const network = installFetch({
      managed: () => emptyHistory,
      handle: (path, init) => {
        if (path === '/plugins/managed/preview') return Response.json(validPreview);
        if (path === '/plugins/managed/import') return failure(503, 'response-lost');
        if (failRead && init.method === 'GET') return failure(503, 'catalog-offline');
      },
    });
    renderPanel();
    await screen.findByText('尚无受管插件');
    writePath('/local');
    previewPath();
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    const stop = await screen.findByRole('button', { name: '停止跟踪' });
    fireEvent.click(stop);
    failRead = true;
    fireEvent.click(screen.getByRole('button', { name: '确认停止跟踪' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('alert').textContent).toContain('catalog-offline');
    expect(screen.queryByRole('button', { name: '重试原请求' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停止跟踪' })).toBeNull();
    failRead = false;
    fireEvent.click(screen.getByRole('button', { name: '读取目录' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(network.writes()).toHaveLength(2);
  });

  it('keeps receipt-time publication independent from a later catalog and preserves history after uninstall', async () => {
    let current: ManagedCatalog = managedCatalog;
    const network = installFetch({
      managed: () => current,
      handle: (path, init) => {
        if (path !== `/plugins/managed/${managedPluginId}/uninstall`) return;
        const body = JSON.parse(String(init.body)) as { requestId: string; immediate: boolean };
        const removed = { ...managedPlugin, selection: null, trust: null };
        current = { ...managedCatalog, plugins: [removed] };
        return Response.json({
          kind: 'committed',
          decision: {
            ...managedDecision({
              kind: 'uninstall',
              digest: secondDigest,
              immediate: body.immediate,
            }),
            requestId: body.requestId,
            selection: null,
            trust: null,
          },
          current,
          application: {
            status: 'failed',
            issue: { code: 'plugin-load-failed', message: 'Managed plugin preparation failed' },
            generation,
            active: firstActive,
          },
        } satisfies ManagedMutationResponse);
      },
    });
    renderPanel();
    const row = await managedRow();
    fireEvent.click(row.getByRole('button', { name: '卸载' }));
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /立即生效/ }).checked).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: '确认卸载' }));
    await screen.findByText('决定已保存');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    current = {
      ...current,
      plugins: [
        {
          ...current.plugins[0]!,
          active: { ...firstActive, digest: secondDigest, version: '2.0.0', activationSequence: 4 },
        },
      ],
    };
    fireEvent.click(screen.getByRole('button', { name: '读取目录' }));
    const ticket = within(screen.getByRole('region', { name: '受管插件操作回执' }));
    expect(ticket.getByText('票据记录的发布')).toBeTruthy();
    expect(ticket.getByText(firstDigest)).toBeTruthy();
    await row.findByText('激活序号 4');
    expect(row.getByText('最新发布')).toBeTruthy();
    expect(row.getAllByRole('button', { name: '激活' })).toHaveLength(2);
    expect(
      row.getByText(`v${secondCandidate.manifest.version}`, {
        selector: '.managed-candidate span',
      }),
    ).toBeTruthy();
    expect(JSON.parse(String(network.writes()[0]?.[1].body))).toMatchObject({ immediate: false });
  });

  it.each([
    {
      kind: 'disable',
      action: '停用',
      selection: managedPlugin.selection,
      trust: { digest: secondDigest, enabled: false },
    },
    { kind: 'revoke', action: '撤销信任', selection: managedPlugin.selection, trust: null },
    { kind: 'uninstall', action: '卸载', selection: null, trust: null },
  ] as const)(
    'reviews a fresh immediate $kind after the normal decision is applied',
    async ({ kind, action, selection, trust }) => {
      const endpoint = `/plugins/managed/${managedPluginId}/${kind}`;
      const afterNormalHeads = {
        installSequence: kind === 'uninstall' ? 5 : 4,
        trustSequence: 6,
        operationSequence: 7,
      };
      let current: ManagedCatalog = managedCatalog;
      const network = installFetch({
        managed: () => current,
        handle: (path, init) => {
          if (path !== endpoint) return;
          const body = JSON.parse(String(init.body)) as {
            requestId: string;
            selectedDigest: string | null;
            immediate: boolean;
          };
          const firstWrite = current === managedCatalog;
          const heads = firstWrite
            ? afterNormalHeads
            : { ...afterNormalHeads, operationSequence: 8 };
          current = {
            ...managedCatalog,
            heads,
            plugins: [{ ...managedPlugin, selection, trust, active: null }],
          };
          return Response.json({
            kind: 'committed',
            decision: {
              ...managedDecision({ kind, digest: body.selectedDigest, immediate: body.immediate }),
              ...heads,
              requestId: body.requestId,
              changed: firstWrite,
              selection,
              trust,
              installEventSequence:
                firstWrite && kind === 'uninstall' ? heads.installSequence : null,
              trustEventSequence: firstWrite ? heads.trustSequence : null,
            },
            current,
            application: { status: 'applied', generation, active: null },
          } satisfies ManagedMutationResponse);
        },
      });
      renderPanel();
      const row = await managedRow();
      const confirmName = `确认${action}`;
      const confirm = () => fireEvent.click(screen.getByRole('button', { name: confirmName }));
      fireEvent.click(row.getByRole('button', { name: action }));
      expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /立即生效/ }).checked).toBe(
        false,
      );
      confirm();
      await screen.findByText('决定已保存');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await row.findByText('未发布');
      expect(network.writes()).toHaveLength(1);

      fireEvent.click(row.getByRole('button', { name: action }));
      const immediate = screen.getByRole<HTMLInputElement>('checkbox', { name: /立即生效/ });
      expect(immediate.checked).toBe(false);
      fireEvent.click(immediate);
      confirm();
      const receipt = within(screen.getByRole('region', { name: '受管插件操作回执' }));
      await receipt.findByText(/无变化/);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      const writes = network.writes();
      expect(writes.map(([path, init]) => [path, init.method])).toEqual([
        [endpoint, 'POST'],
        [endpoint, 'POST'],
      ]);
      const [normal, followUp] = writes.map(([, init]) => JSON.parse(String(init.body)));
      expect(normal).toEqual({
        requestId: expect.any(String),
        immediate: false,
        selectedDigest: secondDigest,
        expectedInstallSequence: managedCatalog.heads.installSequence,
        expectedTrustSequence: managedCatalog.heads.trustSequence,
      });
      expect(followUp).toEqual({
        requestId: expect.any(String),
        immediate: true,
        selectedDigest: selection?.digest ?? null,
        expectedInstallSequence: afterNormalHeads.installSequence,
        expectedTrustSequence: afterNormalHeads.trustSequence,
      });
      expect(followUp.requestId).not.toBe(normal.requestId);
    },
  );

  it('blocks destructive actions on an uninstalled row while a shared catalog read is pending', async () => {
    const current = {
      ...managedCatalog,
      plugins: [{ ...managedPlugin, selection: null, trust: null, active: null }],
    };
    const pending = pendingResponse();
    let holdRead = false;
    const network = installFetch({
      managed: () => current,
      handle: (path) => (holdRead && path === '/plugins/managed' ? pending.response : undefined),
    });
    const store = createPluginCatalogStore();
    renderPanel(store);
    const row = await managedRow();
    const actions = ['停用', '撤销信任', '卸载'].map((name) =>
      row.getByRole<HTMLButtonElement>('button', { name }),
    );
    expect(actions.map(({ disabled }) => disabled)).toEqual([false, false, false]);
    expect(row.queryByRole('button', { name: '启用' })).toBeNull();

    holdRead = true;
    act(() => {
      void store.refresh();
    });
    expect(actions.map(({ disabled }) => disabled)).toEqual([true, true, true]);
    for (const button of actions) fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(network.writes()).toHaveLength(0);

    await act(async () => pending.finish(Response.json(current)));
    await waitFor(() =>
      expect(actions.map(({ disabled }) => disabled)).toEqual([false, false, false]),
    );
  });

  it('discloses conditional Server-wide cancellation and preserves confirmation keyboard controls', async () => {
    const network = installFetch();
    renderPanel(createPluginCatalogStore(), false);
    const row = await managedRow();
    const trigger = row.getByRole('button', { name: '停用' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = within(screen.getByRole('dialog'));
    const cancel = dialog.getByRole('button', { name: '取消' });
    const body = dialog.getByRole('region', { name: '审查内容' });
    const immediate = dialog.getByRole<HTMLInputElement>('checkbox', {
      name: /立即生效.*可能取消所有进行中的回合/,
      description:
        /插件仍在.*保留.*代际.*Server 中所有会话在当前代和已退役代进行中的回合.*与此插件无关.*当前界面不可见/,
    });
    expect(dialog.getByText(/已保存的状态无需改变.*立即生效.*再次确认/)).toBeTruthy();
    expect(immediate.checked).toBe(false);
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(immediate);
    fireEvent.keyDown(immediate, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(body);
    fireEvent.keyDown(body, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
    expect(network.writes()).toHaveLength(0);
  });

  it('retains a locally stale review after confirmation without sending a durable write', async () => {
    let current: ManagedCatalog = managedCatalog;
    const network = installFetch({ managed: () => current });
    const store = createPluginCatalogStore();
    renderPanel(store);
    const row = await managedRow();
    fireEvent.click(row.getAllByRole('button', { name: '激活' })[0]!);
    current = {
      ...current,
      heads: { ...current.heads, trustSequence: current.heads.trustSequence + 1 },
    };
    await act(async () => {
      await store.refresh();
    });
    fireEvent.click(screen.getByRole('button', { name: '确认激活' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(await dialog.findByText(/本次审查已失效/)).toBeTruthy();
    expect(dialog.getByRole<HTMLButtonElement>('button', { name: '确认激活' }).disabled).toBe(true);
    expect(network.writes()).toHaveLength(0);
  });

  it('leaves an existing legacy review focused when a detached preview finishes', async () => {
    const deferred = pendingResponse();
    const network = installFetch({
      managed: () => emptyHistory,
      plugins: [manualRow],
      handle: (path) => (path === '/plugins/managed/preview' ? deferred.response : undefined),
    });
    renderPanel();
    await screen.findByText('尚无受管插件');
    writePath('/local');
    previewPath();
    fireEvent.click(screen.getByText('Manual row'));
    fireEvent.click(screen.getByRole('button', { name: '审阅并信任' }));
    const review = screen.getByRole('dialog');
    const cancel = within(review).getByRole('button', { name: '取消' });
    await act(async () => deferred.finish(Response.json(validPreview)));
    expect(document.querySelectorAll('[data-plugin-dialog-portal]')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toBe(review);
    expect(document.activeElement).toBe(cancel);
    expect(network.writes()).toHaveLength(1);
  });

  it('reads independently and offers a separate explicit reload after managed authority lag', async () => {
    let current: ManagedCatalog = managedCatalog;
    const advanced = {
      ...managedCatalog,
      heads: {
        ...managedCatalog.heads,
        operationSequence: managedCatalog.heads.operationSequence + 1,
      },
    };
    const network = installFetch({
      managed: () => current,
      handle: (path, init) => {
        if (path === `/plugins/managed/${managedPluginId}/activate`) {
          const { requestId } = JSON.parse(String(init.body)) as { requestId: string };
          return Response.json({
            kind: 'replayed',
            decision: {
              ...managedDecision({ kind: 'activate', digest: firstDigest, intent: 'activate' }),
              requestId,
            },
            current: advanced,
            application: { status: 'unknown' },
          } satisfies ManagedMutationResponse);
        }
        if (path === '/mcp/reload' && init.method === 'POST') {
          current = advanced;
          return Response.json({
            authoritySequence: 2,
            generation,
            servers: [],
            result: { decisionSequence: 2, applied: true, unchanged: true, failed: [] },
          });
        }
      },
    });
    renderPanel();
    const row = await managedRow();
    fireEvent.click(row.getAllByRole('button', { name: '激活' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: '确认激活' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '读取目录' }));
    const reload = await screen.findByRole('button', { name: '重新发现并加载扩展', hidden: false });
    expect(screen.getByText('受管插件目录等待同步')).toBeTruthy();
    expect(network.writes()).toHaveLength(1);
    fireEvent.click(reload);
    await waitFor(() =>
      expect(network.writes().map(([path]) => path)).toEqual([
        `/plugins/managed/${managedPluginId}/activate`,
        '/mcp/reload',
      ]),
    );
    await waitFor(() => expect(screen.queryByText('受管插件目录等待同步')).toBeNull());
    expect(screen.getByText('决定已保存')).toBeTruthy();
  });

  it('routes the legacy handoff to the caller ID after reconciliation', async () => {
    let available: ManagedCatalog = emptyHistory;
    const network = installFetch({
      managed: () => available,
      plugins: [manualRow],
      handle: (path) => {
        if (path !== `/plugins/${managedPluginId}/trust`) return;
        available = managedCatalog;
        return failure(409, 'plugin-managed-review-required');
      },
    });
    renderPanel();
    fireEvent.click(await screen.findByText('Manual row'));
    fireEvent.click(screen.getByRole('button', { name: '审阅并信任' }));
    fireEvent.click(screen.getByRole('button', { name: '信任并启用' }));
    await within(screen.getByRole('dialog')).findByText('plugin-managed-review-required');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: `查看受管插件 ${managedPluginId}` }));
    const row = screen.getByText(managedPluginId, { selector: '.plugin-name' }).closest('details');
    expect(row?.open).toBe(true);
    expect(document.activeElement).toBe(row?.querySelector('summary'));
    expect(network.writes().map(([path]) => path)).toEqual([`/plugins/${managedPluginId}/trust`]);
  });
});

const githubSource = {
  repository: 'https://github.com/weave/plugins',
  commit: 'a'.repeat(40),
  subdirectory: 'packages/notes',
};
const githubPreview = {
  ...validPreview,
  candidate: { ...validPreview.candidate, manifest: firstCandidate.manifest },
  github: githubSource,
};
function writeGithubSource(commit = githubSource.commit) {
  fireEvent.click(screen.getByRole('radio', { name: 'GitHub 仓库' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'GitHub 仓库地址' }), {
    target: { value: 'https://github.com/Weave/Plugins' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '完整提交 SHA' }), {
    target: { value: commit },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '插件子目录（可选）' }), {
    target: { value: githubSource.subdirectory },
  });
}

describe('GitHub managed plugin source', () => {
  it('validates before requesting and reviews canonical source, actual manifest and declarations before import', async () => {
    const network = installFetch({
      managed: () => emptyHistory,
      handle: (path) =>
        path === '/plugins/managed/github/preview' ? Response.json(githubPreview) : undefined,
    });
    renderPanel();
    await screen.findByText('尚无受管插件');
    writeGithubSource('main');
    previewPath();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(network.writes()).toHaveLength(0);
    fireEvent.change(screen.getByRole('textbox', { name: '完整提交 SHA' }), {
      target: { value: githubSource.commit },
    });
    previewPath();
    const dialog = within(await screen.findByRole('dialog'));
    expect(network.writes().map(([path, init]) => [path, JSON.parse(String(init.body))])).toEqual([
      ['/plugins/managed/github/preview', githubSource],
    ]);
    expect(dialog.getByText(githubSource.repository)).toBeTruthy();
    expect(dialog.getByText(githubSource.commit)).toBeTruthy();
    expect(dialog.getByText(githubSource.subdirectory)).toBeTruthy();
    expect(dialog.getByText(firstCandidate.manifest.name)).toBeTruthy();
    expect(dialog.getByText(firstCandidate.manifest.description)).toBeTruthy();
    expect(dialog.getByText('workspace:write')).toBeTruthy();
    expect(dialog.getByText(secondDigest)).toBeTruthy();
    expect(dialog.getByText(/激活与授信需要单独确认/)).toBeTruthy();
    const sourceInput = screen.getByRole('textbox', { name: 'GitHub 仓库地址' });
    fireEvent.keyDown(dialog.getByRole('button', { name: '取消' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(sourceInput);
  });

  it('cancels pending previews and discards responses after cancellation, edits or source changes', async () => {
    const pending = [pendingResponse(), pendingResponse(), pendingResponse()];
    const responses = pending.map(({ response }) => response);
    const network = installFetch({
      managed: () => emptyHistory,
      handle: (path) =>
        path === '/plugins/managed/github/preview' ? responses.shift() : undefined,
    });
    renderPanel();
    await screen.findByText('尚无受管插件');
    writeGithubSource();
    previewPath();
    expect(screen.getByText('正在预览插件…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消预览' }));
    expect(network.writes()[0]?.[1].signal?.aborted).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'GitHub 仓库地址' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '预览插件' }).disabled).toBe(
      false,
    );
    await act(async () => pending[0]!.finish(Response.json(githubPreview)));
    expect(screen.queryByRole('dialog')).toBeNull();
    previewPath();
    fireEvent.change(screen.getByRole('textbox', { name: '插件子目录（可选）' }), {
      target: { value: 'next' },
    });
    expect(network.writes()[1]?.[1].signal?.aborted).toBe(true);
    await act(async () => pending[1]!.finish(Response.json(githubPreview)));
    expect(screen.queryByRole('dialog')).toBeNull();
    previewPath();
    fireEvent.click(screen.getByRole('radio', { name: '本地目录' }));
    expect(network.writes()[2]?.[1].signal?.aborted).toBe(true);
    await act(async () => pending[2]!.finish(Response.json(githubPreview)));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('textbox', { name: '插件来源目录' })).toBeTruthy();
  });

  it('aborts and discards a preview when the App management gate invalidates it', async () => {
    const pending = pendingResponse();
    const read = pendingResponse();
    let holdRead = false;
    const network = installFetch({
      managed: () => emptyHistory,
      handle: (path) => {
        if (path === '/plugins/managed/github/preview') return pending.response;
        if (holdRead && path === '/plugins/managed') return read.response;
      },
    });
    const store = createPluginCatalogStore();
    renderPanel(store);
    await screen.findByText('尚无受管插件');
    writeGithubSource();
    previewPath();
    let refresh: Promise<void>;
    act(() => {
      holdRead = true;
      refresh = store.refresh();
    });
    expect(network.writes()[0]?.[1].signal?.aborted).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'GitHub 仓库地址' }).disabled,
    ).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '预览插件' }).disabled).toBe(true);
    await act(async () => {
      read.finish(Response.json(emptyHistory));
      await refresh!;
    });
    await act(async () => pending.finish(Response.json(githubPreview)));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(network.writes()).toHaveLength(1);
  });

  it('ignores a GitHub preview completing after the panel closes', async () => {
    const pending = pendingResponse();
    const network = installFetch({
      managed: () => emptyHistory,
      handle: (path) => (path === '/plugins/managed/github/preview' ? pending.response : undefined),
    });
    const store = createPluginCatalogStore();
    const panel = renderPanel(store);
    await screen.findByText('尚无受管插件');
    writeGithubSource();
    previewPath();
    panel.unmount();
    expect(network.writes()[0]?.[1].signal?.aborted).toBe(true);
    await act(async () => pending.finish(Response.json(githubPreview)));
    renderPanel(store);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the first GitHub source in candidate history after refresh and remount', async () => {
    const catalog = {
      ...managedCatalog,
      plugins: [
        {
          ...managedPlugin,
          candidates: [
            { ...firstCandidate, provenance: 'github' as const, github: githubSource },
            secondCandidate,
          ],
        },
      ],
    };
    installFetch({ managed: () => catalog });
    const store = createPluginCatalogStore();
    const panel = renderPanel(store);
    let row = await managedRow();
    expect(row.getByText(githubSource.repository)).toBeTruthy();
    expect(row.getByText(githubSource.commit)).toBeTruthy();
    expect(row.getByText(githubSource.subdirectory)).toBeTruthy();
    fireEvent.click(row.getAllByRole('button', { name: '激活' })[0]!);
    const activation = within(screen.getByRole('dialog'));
    expect(activation.getByText(githubSource.repository)).toBeTruthy();
    expect(activation.getByText(githubSource.commit)).toBeTruthy();
    fireEvent.keyDown(activation.getByRole('button', { name: '取消' }), { key: 'Escape' });
    await act(async () => {
      await store.refresh();
    });
    panel.unmount();
    renderPanel(createPluginCatalogStore());
    row = await managedRow();
    expect(row.getByText(githubSource.repository)).toBeTruthy();
    expect(row.getByText(githubSource.commit)).toBeTruthy();
    expect(row.getByText(/本地目录/)).toBeTruthy();
  });
});
