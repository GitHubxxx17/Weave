// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginCatalogProvider } from '../src/features/plugins/plugin-catalog-context.js';
import { createPluginCatalogStore } from '../src/features/plugins/plugin-catalog-store.js';
import { PluginMarketplacePage } from '../src/features/plugins/plugin-marketplace-page.js';
import {
  firstCandidate,
  managedCatalog,
  managedGeneration,
  managedPreview,
} from './support/managed-plugin-fixtures.js';
import { declarativeManifest } from './support/declarative-plugin-fixtures.js';

const source = {
  repository: 'https://github.com/developer/plugin',
  commit: 'a'.repeat(40),
  subdirectory: 'plugin',
};
const community = {
  kind: 'github',
  category: 'community',
  id: firstCandidate.manifest.id,
  name: '社区示例工具',
  description: '分析工作区',
  publisher: 'Independent Developer',
  tags: ['分析'],
  releases: [
    {
      manifest: { ...firstCandidate.manifest, version: '2.0.0' },
      source: { ...source, commit: 'b'.repeat(40) },
      compatibility: 'incompatible',
    },
    { manifest: firstCandidate.manifest, source, compatibility: 'compatible' },
  ],
};
const official = {
  kind: 'builtin',
  category: 'official',
  id: 'tool-registry',
  name: '工具注册',
  description: '内置工具支持',
  publisher: 'Weave',
  tags: ['工具'],
  version: '1.0.0',
};
const catalog = {
  schemaVersion: 1,
  hostVersion: '0.0.0',
  communityStatus: 'ready',
  entries: [official, community],
};
const preview = {
  ...managedPreview,
  candidate: { ...managedPreview.candidate, manifest: firstCandidate.manifest },
  github: source,
  expiresAt: '2099-01-01T00:00:00.000Z',
  expectedInstallSequence: managedCatalog.heads.installSequence,
};

function setup(
  options: {
    discovery?: unknown;
    preview?: () => Response | Promise<Response>;
    history?: typeof managedCatalog;
  } = {},
) {
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit) => {
    const path = String(input);
    if (path === '/plugins/marketplace')
      return Promise.resolve(Response.json(options.discovery ?? catalog));
    if (path === '/plugins')
      return Promise.resolve(
        Response.json({
          plugins: [],
          local: {
            directory: '/plugins',
            exists: true,
            truncated: false,
            trustSequence: 1,
            generation: { ...managedGeneration, plugins: [] },
          },
          generation: managedGeneration,
        }),
      );
    if (path === '/plugins/managed')
      return Promise.resolve(Response.json(options.history ?? { ...managedCatalog, plugins: [] }));
    if (path === '/mcp')
      return Promise.resolve(
        Response.json({ authoritySequence: 2, generation: managedGeneration, servers: [] }),
      );
    if (path === '/plugins/managed/github/preview')
      return Promise.resolve(options.preview?.() ?? Response.json(preview));
    throw new Error(`Unexpected ${init.method} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  const store = createPluginCatalogStore();
  const view = render(
    <PluginCatalogProvider store={store}>
      <button data-plugin-navigation="">插件市场导航</button>
      <PluginMarketplacePage hasRunningSessions={false} />
    </PluginCatalogProvider>,
  );
  return {
    ...view,
    store,
    fetch,
    writes: () => fetch.mock.calls.filter(([, init]) => init.method !== 'GET'),
  };
}

async function selectRelease() {
  fireEvent.click(await screen.findByRole('button', { name: '查看 社区示例工具' }));
  fireEvent.change(screen.getByRole('combobox', { name: '插件版本' }), {
    target: { value: '1.0.0' },
  });
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '准备安装' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '准备安装' }));
  await screen.findByRole('textbox', { name: 'GitHub 仓库地址' });
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '预览插件' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('plugin marketplace page', () => {
  it('browses official and community entries with search and version compatibility without writes', async () => {
    const network = setup();
    await screen.findByRole('button', { name: '查看 工具注册' });
    fireEvent.click(screen.getByRole('button', { name: '社区' }));
    expect(screen.queryByRole('button', { name: '查看 工具注册' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索插件' }), {
      target: { value: 'Independent' },
    });
    expect(screen.getByRole('button', { name: '查看 社区示例工具' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '查看 社区示例工具' }));
    expect((screen.getByRole('combobox', { name: '插件版本' }) as HTMLSelectElement).value).toBe(
      '1.0.0',
    );
    fireEvent.change(screen.getByRole('combobox', { name: '插件版本' }), {
      target: { value: '2.0.0' },
    });
    expect((screen.getByRole('button', { name: '准备安装' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('与当前 Weave 不兼容')).toBeDefined();
    expect(network.writes()).toHaveLength(0);
  });

  it('supports tab navigation by keyboard and keeps discovery read only', async () => {
    const network = setup();
    await screen.findByRole('button', { name: '查看 工具注册' });
    const discovery = screen.getByRole('tab', { name: '发现插件' });
    discovery.focus();
    fireEvent.keyDown(discovery, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '已安装' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(discovery);
    expect(network.writes()).toHaveLength(0);
  });

  it('hands a fixed release to existing management without automatic acquisition', async () => {
    const network = setup();
    await selectRelease();
    expect(
      (screen.getByRole('textbox', { name: 'GitHub 仓库地址' }) as HTMLInputElement).value,
    ).toBe(source.repository);
    expect(screen.getByText(/市场发布者：Independent Developer/)).toBeDefined();
    expect(network.writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '预览插件' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/市场发布者：Independent Developer/)).toBeDefined();
    expect(within(dialog).getByRole('button', { name: '确认导入' })).toBeDefined();
    expect(network.writes()).toHaveLength(1);
    expect(JSON.parse(String(network.writes()[0]?.[1].body))).toEqual(source);
  });

  it('blocks import when actual manifest differs from the marketplace release', async () => {
    const network = setup({
      preview: () =>
        Response.json({
          ...preview,
          candidate: {
            ...preview.candidate,
            manifest: { ...preview.candidate.manifest, permissions: ['network:request'] },
          },
        }),
    });
    await selectRelease();
    fireEvent.click(screen.getByRole('button', { name: '预览插件' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('实际插件声明与市场版本不一致'),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(network.writes()).toHaveLength(1);
  });

  it('shows a text package in marketplace details and preserves its exact review handoff', async () => {
    const discovery = {
      ...catalog,
      entries: [
        {
          ...community,
          releases: [{ manifest: declarativeManifest, source, compatibility: 'compatible' }],
        },
      ],
    };
    const network = setup({
      discovery,
      preview: () =>
        Response.json({
          ...preview,
          candidate: { ...preview.candidate, manifest: declarativeManifest },
        }),
    });
    await selectRelease();
    expect(network.writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '预览插件' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Skills 文本包')).toBeTruthy();
    expect(dialog.getByText('无可执行入口')).toBeTruthy();
    expect(dialog.getByText('review-change')).toBeTruthy();
    expect(dialog.getByText(source.commit)).toBeTruthy();
    expect(dialog.getByText('导入会保存候选版本。激活与授信需要单独确认。')).toBeTruthy();
    expect(network.writes()).toHaveLength(1);
  });

  it('blocks a text-package release from being replaced by a skill-contributing executable preview', async () => {
    const executable = { ...declarativeManifest, host: 'in-process' };
    const network = setup({
      discovery: {
        ...catalog,
        entries: [
          {
            ...community,
            releases: [{ manifest: declarativeManifest, source, compatibility: 'compatible' }],
          },
        ],
      },
      preview: () =>
        Response.json({ ...preview, candidate: { ...preview.candidate, manifest: executable } }),
    });
    await selectRelease();
    fireEvent.click(screen.getByRole('button', { name: '预览插件' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('实际插件声明与市场版本不一致'),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(network.writes()).toHaveLength(1);
  });

  it('accepts identical full declarations with a different object key order', async () => {
    const manifest = Object.fromEntries(Object.entries(firstCandidate.manifest).reverse());
    setup({
      preview: () => Response.json({ ...preview, candidate: { ...preview.candidate, manifest } }),
    });
    await selectRelease();
    fireEvent.click(screen.getByRole('button', { name: '预览插件' }));
    expect(await screen.findByRole('button', { name: '确认导入' })).toBeDefined();
  });

  it('shows selected and published managed versions separately from marketplace availability', async () => {
    setup({ history: managedCatalog });
    fireEvent.click(await screen.findByRole('button', { name: '查看 社区示例工具' }));
    const record = await screen.findByRole('region', { name: '该 ID 的受管记录' });
    expect(within(record).getByText('已导入 2 个候选')).toBeDefined();
    expect(within(record).getByText('当前选择：v2.0.0')).toBeDefined();
    expect(within(record).getByText('实际发布：v1.0.0')).toBeDefined();
    expect(within(record).queryByText('已安装')).toBeNull();
  });

  it('aborts and ignores a late preview when leaving Installed', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const network = setup({ preview: () => pending });
    await selectRelease();
    fireEvent.click(screen.getByRole('button', { name: '预览插件' }));
    fireEvent.click(screen.getByRole('tab', { name: '发现插件' }));
    expect(network.writes()[0]?.[1].signal?.aborted).toBe(true);
    await act(async () => {
      finish(Response.json(preview));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps marketplace acquisition behind the shared management gate', async () => {
    const network = setup();
    await selectRelease();
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit) =>
        String(input) === '/plugins/managed' ? pending : original(input, init),
      ),
    );
    act(() => {
      void network.store.refresh();
    });
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '预览插件' });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(network.writes()).toHaveLength(0);
    await act(async () => {
      finish(Response.json({ ...managedCatalog, plugins: [] }));
    });
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('drops marketplace attribution on explicit manual source edits', async () => {
    const network = setup();
    await selectRelease();
    const repository = screen.getByRole('textbox', { name: 'GitHub 仓库地址' });
    fireEvent.change(repository, { target: { value: 'https://github.com/another/repository' } });
    expect(screen.queryByText(/市场发布者：Independent Developer/)).toBeNull();
    expect(network.writes()).toHaveLength(0);
  });

  it.each(['unconfigured', 'unavailable'])(
    'shows a truthful community %s state and keeps Installed available',
    async (communityStatus) => {
      const network = setup({ discovery: { ...catalog, communityStatus, entries: [official] } });
      await screen.findByRole('button', { name: '查看 工具注册' });
      fireEvent.click(screen.getByRole('button', { name: '社区' }));
      expect(
        screen.getByText(
          communityStatus === 'unconfigured' ? '尚未配置社区插件目录' : '社区插件目录暂不可用',
        ),
      ).toBeDefined();
      fireEvent.click(screen.getByRole('tab', { name: '已安装' }));
      await waitFor(() => expect(screen.getByRole('region', { name: '插件' })).toBeDefined());
      expect(network.writes()).toHaveLength(0);
    },
  );
});
