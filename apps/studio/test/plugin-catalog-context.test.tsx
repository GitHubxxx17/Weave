// @vitest-environment jsdom

import { StrictMode, type ReactElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PluginCatalogProvider,
  PluginPendingBadge,
  usePluginCatalogState,
  usePluginCatalogStore,
} from '../src/features/plugins/plugin-catalog-context.js';
import { createPluginCatalogStore } from '../src/features/plugins/plugin-catalog-store.js';

const digest = 'a'.repeat(64);
const row = {
  id: 'echo',
  name: 'Echo',
  version: '1',
  origin: 'local',
  host: 'in-process',
  state: 'pending-trust',
  capabilities: [],
  provides: {
    tools: [],
    providers: [],
    promptSections: [],
    events: [],
    commands: [],
    hooks: [],
    services: [],
  },
  local: { directory: '/plugins/echo', enabled: false, digest },
};
const local = {
  directory: '/plugins',
  exists: true,
  truncated: false,
  trustSequence: 0,
  generation: { id: 1, acceptingRuns: true, plugins: [] },
};
function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}
function CatalogProbe(): ReactElement {
  const state = usePluginCatalogState();
  const store = usePluginCatalogStore();
  return (
    <output aria-label="catalog">
      {state.initialLoading
        ? 'loading'
        : (state.catalog?.plugins[0]?.state ?? state.error?.code ?? 'empty')}
      {store.getSnapshot() === state ? ':shared' : ':different'}
    </output>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('plugin catalog React context', () => {
  it('deduplicates StrictMode reads for all consumers and only reads at startup', async () => {
    let resolve!: (value: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((r) => {
        resolve = r;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = createPluginCatalogStore();
    render(
      <StrictMode>
        <PluginCatalogProvider store={store}>
          <CatalogProbe />
          <PluginPendingBadge />
        </PluginCatalogProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('catalog').textContent).toBe('loading:shared');
    await act(async () => {
      resolve(response({ plugins: [row] }));
    });
    expect(screen.getByLabelText('catalog').textContent).toBe('pending-trust:shared');
    expect(screen.getByLabelText('1 个插件待审阅').textContent).toBe('1');
    expect(fetchMock.mock.calls[0][1]).toEqual({ method: 'GET' });
  });

  it('counts only local pending-trust and changed rows and hides zero', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          plugins: [
            row,
            { ...row, id: 'changed', state: 'changed' },
            { ...row, id: 'future', state: 'future' },
            { ...row, id: 'host', origin: 'registered' },
            { ...row, id: 'loaded', state: 'loaded' },
          ],
          local,
        }),
      )
      .mockResolvedValueOnce(
        response({
          plugins: [{ ...row, state: 'loaded' }],
          local,
          result: { generation: 1, unchanged: false, failed: [] },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const store = createPluginCatalogStore();
    render(
      <PluginCatalogProvider store={store}>
        <PluginPendingBadge />
      </PluginCatalogProvider>,
    );
    expect(await screen.findByLabelText('2 个插件待审阅')).toBeTruthy();
    await act(async () => {
      await store.trust('echo', digest);
    });
    expect(screen.queryByLabelText(/个插件待审阅/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps shared GET alive after the provider unmounts and reuses its cached result', async () => {
    let resolve!: (value: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((r) => {
        resolve = r;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = createPluginCatalogStore();
    const view = render(
      <PluginCatalogProvider store={store}>
        <CatalogProbe />
      </PluginCatalogProvider>,
    );
    view.unmount();
    resolve(response({ plugins: [row] }));
    await store.ensureLoaded();
    render(
      <PluginCatalogProvider store={store}>
        <CatalogProbe />
      </PluginCatalogProvider>,
    );
    expect(screen.getByLabelText('catalog').textContent).toBe('pending-trust:shared');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal).toBeUndefined();
  });

  it('preserves an in-flight write after provider unmount and exposes its completion after remount', async () => {
    let resolve!: (value: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ plugins: [row], local }))
      .mockReturnValueOnce(
        new Promise<Response>((r) => {
          resolve = r;
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const store = createPluginCatalogStore();
    const view = render(
      <PluginCatalogProvider store={store}>
        <CatalogProbe />
      </PluginCatalogProvider>,
    );
    await screen.findByText('pending-trust:shared');
    let operation!: Promise<void>;
    act(() => {
      operation = store.trust('echo', digest);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    view.unmount();
    resolve(
      response({
        plugins: [{ ...row, state: 'loaded' }],
        local,
        result: { generation: 1, unchanged: false, failed: [] },
      }),
    );
    await operation;
    render(
      <PluginCatalogProvider store={store}>
        <CatalogProbe />
        <PluginPendingBadge />
      </PluginCatalogProvider>,
    );
    expect(screen.getByLabelText('catalog').textContent).toBe('loaded:shared');
    expect(screen.queryByLabelText(/个插件待审阅/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('catches the published startup error without retrying provider replay', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response({ error: { code: 'plugin-host-closed', message: 'closed' } }, 503),
      );
    vi.stubGlobal('fetch', fetchMock);
    const store = createPluginCatalogStore();
    render(
      <StrictMode>
        <PluginCatalogProvider store={store}>
          <CatalogProbe />
          <PluginPendingBadge />
        </PluginCatalogProvider>
      </StrictMode>,
    );
    await screen.findByText('plugin-host-closed:shared');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText(/个插件待审阅/)).toBeNull();
  });
});
