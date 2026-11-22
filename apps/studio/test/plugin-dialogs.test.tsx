// @vitest-environment jsdom

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { PluginApiError } from '../src/features/plugins/plugin-api.js';
import { PluginDecisionDialog } from '../src/features/plugins/plugin-decision-dialog.js';
import type { PluginReview } from '../src/features/plugins/plugin-review.js';
import { PluginTrustDialog } from '../src/features/plugins/plugin-trust-dialog.js';
import type { PluginListItem } from '../src/features/plugins/plugin-types.js';

const warning =
  '信任后，这个插件的代码会以和 Weave 相同的权限在你的电脑上运行。它可以读写你能访问的文件、联网、读取所有会话内容。下面是插件自己的声明，Weave 无法限制进程内插件的实际行为。只信任你了解其来源的插件。';

function review(over: Partial<PluginReview> = {}): PluginReview {
  return {
    id: 'local.demo',
    name: '演示插件',
    version: '2.0.0',
    description: '演示说明',
    directory: '/tmp/plugins/demo',
    digest: 'a'.repeat(64),
    manifest: {
      id: 'local.demo',
      name: '演示插件',
      version: '2.0.0',
      apiVersion: '1',
      capabilities: ['tool', 'future-capability'],
      contributes: {
        tools: ['echo'],
        providers: ['provider.demo'],
        promptSections: ['style'],
        events: ['event.demo'],
        commands: ['hello'],
        hooks: ['weave.tools.policy', 'weave.tools.result', 'weave.llm.request', 'future.hook'],
        services: ['service.demo'],
      },
      permissions: ['workspace:read', 'process:spawn'],
    },
    ...over,
  };
}

function plugin(): PluginListItem {
  return {
    id: 'local.demo',
    name: '演示插件',
    version: '2.0.0',
    origin: 'local',
    host: 'in-process',
    state: 'loaded',
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
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('PluginTrustDialog', () => {
  it('shows the complete warning, identity, every declaration and keyboard-readable digest', () => {
    render(
      <PluginTrustDialog
        review={review()}
        busy={false}
        onCancel={vi.fn()}
        onTrust={async () => {}}
        getFallbackFocus={() => null}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: '信任插件「演示插件」？' });
    const content = within(dialog);
    expect(content.getByText(warning)).toBeTruthy();
    expect(
      document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe(warning);
    expect(content.getByText('local.demo')).toBeTruthy();
    expect(content.getByText('2.0.0')).toBeTruthy();
    expect(content.getByText('演示说明')).toBeTruthy();
    expect(content.getByText('/tmp/plugins/demo')).toBeTruthy();
    for (const name of [
      'echo',
      'provider.demo',
      'style',
      'event.demo',
      'hello',
      'service.demo',
      'future-capability',
    ]) {
      expect(content.getByText(name)).toBeTruthy();
    }
    const digest = content.getByRole('textbox', { name: '完整摘要' }) as HTMLInputElement;
    expect(digest.value).toBe('a'.repeat(64));
    expect(digest.readOnly).toBe(true);
    expect(content.getByText('aaaaaaaaaaaa')).toBeTruthy();
  });

  it('sorts high impact before medium and low, explicitly marks unknown and new high entries', () => {
    const next = review();
    render(
      <PluginTrustDialog
        review={{
          ...next,
          previousTrusted: {
            digest: 'b'.repeat(64),
            manifest: {
              ...next.manifest,
              version: '1.0.0',
              contributes: { hooks: ['weave.tools.policy'] },
              permissions: [],
            },
          },
        }}
        busy={false}
        onCancel={vi.fn()}
        onTrust={async () => {}}
        getFallbackFocus={() => null}
      />,
    );
    const rows = screen
      .getByRole('list', { name: '钩子与权限影响' })
      .querySelectorAll('li[data-category="hooks"]');
    expect([...rows].map((row) => row.querySelector('code')?.textContent)).toEqual([
      'weave.llm.request',
      'future.hook',
      'weave.tools.result',
      'weave.tools.policy',
    ]);
    expect(rows[0]?.textContent).toContain('新增高影响');
    expect(rows[1]?.textContent).toContain('未识别');
    expect(screen.getByText('1.0.0 → 2.0.0')).toBeTruthy();
    expect(screen.getByText('声明差异')).toBeTruthy();
    expect(screen.getAllByText(/新增/).length).toBeGreaterThan(0);
  });

  it('explains a code update when declarations did not change', () => {
    const next = review();
    render(
      <PluginTrustDialog
        review={{ ...next, previousTrusted: { digest: 'b'.repeat(64), manifest: next.manifest } }}
        busy={false}
        onCancel={vi.fn()}
        onTrust={async () => {}}
        getFallbackFocus={() => null}
      />,
    );
    expect(screen.getByText('声明没有变化，但代码已更新')).toBeTruthy();
  });

  it('keeps the originally displayed review after replacement and permanently invalidates a stale 409', async () => {
    const onTrust = vi.fn(async () => {
      throw new PluginApiError('plugin-digest-mismatch', '目录已变化', 409);
    });
    const props = { busy: false, onCancel: vi.fn(), onTrust, getFallbackFocus: () => null };
    const captured = review();
    const { rerender } = render(<PluginTrustDialog {...props} review={captured} />);
    rerender(
      <PluginTrustDialog
        {...props}
        review={review({ name: '新的名称', digest: 'c'.repeat(64) })}
      />,
    );
    expect(screen.queryByText(/新的名称/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '信任并启用' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onTrust).toHaveBeenCalledWith(captured);
    expect((screen.getByRole('button', { name: '信任并启用' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole('alert').textContent).toContain('关闭后重新审阅');
    fireEvent.click(screen.getByRole('button', { name: '信任并启用' }));
    expect(onTrust).toHaveBeenCalledTimes(1);
  });

  it('blocks duplicate submissions and permits Escape while a shared mutation is pending', async () => {
    const pending = deferred();
    const onTrust = vi.fn(() => pending.promise);
    const onCancel = vi.fn();
    const { unmount } = render(
      <PluginTrustDialog
        review={review()}
        busy={false}
        onCancel={onCancel}
        onTrust={onTrust}
        getFallbackFocus={() => null}
      />,
    );
    const trust = screen.getByRole('button', { name: '信任并启用' });
    fireEvent.click(trust);
    fireEvent.click(trust);
    expect(onTrust).toHaveBeenCalledTimes(1);
    expect((trust as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(trust, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows removed declarations and permits retry after a non-stale error', async () => {
    const next = review();
    const onTrust = vi
      .fn()
      .mockRejectedValueOnce(new Error('暂时无法保存'))
      .mockResolvedValueOnce(undefined);
    const onCancel = vi.fn();
    render(
      <PluginTrustDialog
        review={{
          ...next,
          previousTrusted: {
            digest: 'b'.repeat(64),
            manifest: { ...next.manifest, contributes: { tools: ['removed-tool'] } },
          },
        }}
        busy={false}
        onCancel={onCancel}
        onTrust={onTrust}
        getFallbackFocus={() => null}
      />,
    );
    expect(screen.getByText('removed-tool').closest('p')?.textContent).toContain('移除');
    fireEvent.click(screen.getByRole('button', { name: '信任并启用' }));
    expect((await screen.findByRole('alert')).textContent).toBe('暂时无法保存');
    expect((screen.getByRole('button', { name: '信任并启用' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: '信任并启用' }));
    await act(async () => {});
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated declarations for readable rows without duplicate React keys', () => {
    const next = review();
    render(
      <PluginTrustDialog
        review={{ ...next, manifest: { ...next.manifest, capabilities: ['tool', 'tool'] } }}
        busy={false}
        onCancel={vi.fn()}
        onTrust={async () => {}}
        getFallbackFocus={() => null}
      />,
    );
    expect(screen.getAllByText('tool')).toHaveLength(1);
  });

  it('uses global busy for the trust button but keeps Cancel enabled and tab reachable', () => {
    const onTrust = vi.fn(async () => {});
    const onCancel = vi.fn();
    render(
      <PluginTrustDialog
        review={review()}
        busy={true}
        onCancel={onCancel}
        onTrust={onTrust}
        getFallbackFocus={() => null}
      />,
    );
    const trust = screen.getByRole('button', { name: '信任并启用' }) as HTMLButtonElement;
    expect(trust.disabled).toBe(true);
    fireEvent.click(trust);
    expect(onTrust).not.toHaveBeenCalled();
    const cancel = screen.getByRole('button', { name: '取消' });
    screen.getByRole('textbox').focus();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab', shiftKey: true });
    const body = screen.getByRole('region', { name: '审查内容' });
    expect(document.activeElement).toBe(body);
    fireEvent.keyDown(body, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('PluginDialog keyboard and focus lifecycle', () => {
  it('portals outside root, makes background inert, focuses Cancel and traps both Tab directions', () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    const opener = document.createElement('button');
    opener.textContent = '审阅';
    root.append(opener);
    opener.focus();
    const onCancel = vi.fn();
    const onTrust = vi.fn(async () => {});
    const mount = document.createElement('div');
    root.append(mount);
    const { unmount } = render(
      <PluginTrustDialog
        review={review()}
        busy={false}
        onCancel={onCancel}
        onTrust={onTrust}
        getFallbackFocus={() => null}
      />,
      { container: mount },
    );
    const dialog = screen.getByRole('dialog');
    expect(root.contains(dialog)).toBe(false);
    expect(root.hasAttribute('inert')).toBe(true);
    const cancel = screen.getByRole('button', { name: '取消' });
    const trust = screen.getByRole('button', { name: '信任并启用' });
    const body = within(dialog).getByRole('region', { name: '审查内容' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    // Cancel is followed by the trust action, and the digest is before Cancel.
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '完整摘要' }));
    trust.focus();
    fireEvent.keyDown(trust, { key: 'Tab' });
    expect(document.activeElement).toBe(body);
    fireEvent.keyDown(body, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '完整摘要' }));
    const digest = screen.getByRole('textbox', { name: '完整摘要' });
    fireEvent.keyDown(digest, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(body);
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Enter' });
    expect(onTrust).not.toHaveBeenCalled();
    unmount();
    expect(root.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('stops Escape before the App window listener and restores fallback after opener removal', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const fallback = document.createElement('button');
    fallback.textContent = '插件标签';
    document.body.append(fallback);
    const appEscape = vi.fn();
    window.addEventListener('keydown', appEscape);
    const onCancel = vi.fn();
    const { unmount } = render(
      <PluginTrustDialog
        review={review()}
        busy={false}
        onCancel={onCancel}
        onTrust={async () => {}}
        getFallbackFocus={() => fallback}
      />,
    );
    opener.remove();
    fireEvent.keyDown(screen.getByRole('button', { name: '取消' }), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(appEscape).not.toHaveBeenCalled();
    unmount();
    expect(document.activeElement).toBe(fallback);
    window.removeEventListener('keydown', appEscape);
  });

  it('preserves existing inert values through StrictMode and skips a collapsed origin', () => {
    const root = document.createElement('div');
    root.setAttribute('inert', 'prior');
    document.body.append(root);
    const panel = document.createElement('div');
    const opener = document.createElement('button');
    panel.append(opener);
    document.body.append(panel);
    opener.focus();
    const fallback = document.createElement('div');
    fallback.tabIndex = -1;
    document.body.append(fallback);
    const { unmount } = render(
      <StrictMode>
        <PluginTrustDialog
          review={review()}
          busy={false}
          onCancel={vi.fn()}
          onTrust={async () => {}}
          getFallbackFocus={() => fallback}
        />
      </StrictMode>,
    );
    panel.setAttribute('inert', '');
    panel.hidden = true;
    unmount();
    expect(root.getAttribute('inert')).toBe('prior');
    expect(document.activeElement).toBe(fallback);
    expect(document.querySelectorAll('[data-plugin-dialog-portal]')).toHaveLength(0);
  });

  it('skips a disabled opener and restores background added while open', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const fallback = document.createElement('button');
    document.body.append(fallback);
    const { unmount } = render(
      <PluginTrustDialog
        review={review()}
        busy={false}
        onCancel={vi.fn()}
        onTrust={async () => {}}
        getFallbackFocus={() => fallback}
      />,
    );
    const anotherBackground = document.createElement('div');
    document.body.append(anotherBackground);
    await act(async () => {});
    expect(anotherBackground.hasAttribute('inert')).toBe(true);
    opener.disabled = true;
    unmount();
    expect(document.activeElement).toBe(fallback);
    expect(anotherBackground.hasAttribute('inert')).toBe(false);
  });
});

describe('PluginDecisionDialog', () => {
  it('defaults to next-turn effect and exposes global cancellation only while sessions run', async () => {
    const onConfirm = vi.fn(async () => {});
    const props = {
      plugin: plugin(),
      action: 'disable' as const,
      busy: false,
      onCancel: vi.fn(),
      onConfirm,
      getFallbackFocus: () => null,
    };
    const { rerender } = render(<PluginDecisionDialog {...props} hasRunningSessions={true} />);
    expect(screen.getByText(/下一回合起生效/)).toBeTruthy();
    expect(screen.getByText(/当前代和已退役代/)).toBeTruthy();
    const checkbox = screen.getByRole('checkbox', {
      name: '立即生效（取消进行中的回合）',
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    rerender(<PluginDecisionDialog {...props} hasRunningSessions={false} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    rerender(<PluginDecisionDialog {...props} hasRunningSessions={true} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    await act(async () => {});
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('passes checked immediate choice, blocks duplicates, and renders failures without dismissing', async () => {
    const pending = deferred();
    const onConfirm = vi.fn(() => pending.promise);
    render(
      <PluginDecisionDialog
        plugin={plugin()}
        action="revoke"
        hasRunningSessions={true}
        busy={false}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        getFallbackFocus={() => null}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    const button = screen.getByRole('button', { name: '确认撤销信任' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(true);
    await act(async () => {
      pending.reject(new Error('存储失败'));
      await pending.promise.catch(() => {});
    });
    expect(screen.getByRole('alert').textContent).toContain('存储失败');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('submits false when runs finish before the chosen operation is sent', async () => {
    const onConfirm = vi.fn(async () => {});
    const props = {
      plugin: plugin(),
      action: 'disable' as const,
      busy: false,
      onCancel: vi.fn(),
      onConfirm,
      getFallbackFocus: () => null,
    };
    const { rerender } = render(<PluginDecisionDialog {...props} hasRunningSessions={true} />);
    fireEvent.click(screen.getByRole('checkbox'));
    rerender(<PluginDecisionDialog {...props} hasRunningSessions={false} />);
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    await act(async () => {});
    expect(onConfirm).toHaveBeenCalledWith(false);
  });
});
