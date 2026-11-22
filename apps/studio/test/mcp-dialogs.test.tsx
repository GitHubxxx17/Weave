// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { McpApiError } from '../src/features/mcp/mcp-api.js';
import { McpConfigDialog } from '../src/features/mcp/mcp-config-dialog.js';
import { McpDecisionDialog } from '../src/features/mcp/mcp-decision-dialog.js';
import { createMcpReview } from '../src/features/mcp/mcp-review.js';
import { McpTrustDialog } from '../src/features/mcp/mcp-trust-dialog.js';
import type { McpServerConfig, McpServerRecord } from '../src/features/mcp/mcp-types.js';

function config(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    schemaVersion: 1,
    id: 'demo',
    label: '演示 MCP',
    transport: 'stdio',
    command: '/opt/demo/server',
    args: ['--stdio', 'a value', ''],
    cwd: '/home/demo',
    env: { TOKEN: { fromHostEnv: 'DEMO_TOKEN' } },
    ...over,
  };
}

function server(over: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    config: config(),
    configDigest: 'a'.repeat(64),
    enabled: false,
    state: 'untrusted',
    stale: false,
    drainingGenerations: [],
    tools: [],
    ...over,
  };
}

const shared = { busy: false, stale: false, onCancel: () => {}, getFallbackFocus: () => null };

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
});

describe('McpConfigDialog', () => {
  it('collects a new configuration without trimming paths or invoking launch trust', async () => {
    const onSave = vi.fn(async () => {});
    render(<McpConfigDialog {...shared} expectedSequence={0} onSave={onSave} />);
    expect((screen.getByLabelText('服务 ID') as HTMLInputElement).readOnly).toBe(false);
    fireEvent.change(screen.getByLabelText('服务 ID'), { target: { value: 'new-service' } });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '新的服务' } });
    fireEvent.change(screen.getByLabelText('启动程序'), {
      target: { value: 'C:\\Program Files\\Server.exe' },
    });
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: 'C:\\My Work' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await act(async () => {});
    expect(onSave).toHaveBeenCalledWith(
      {
        schemaVersion: 1,
        id: 'new-service',
        label: '新的服务',
        transport: 'stdio',
        command: 'C:\\Program Files\\Server.exe',
        args: [],
        cwd: 'C:\\My Work',
        env: {},
      },
      0,
    );
    expect(screen.queryByRole('button', { name: '信任并启用' })).toBeNull();
  });

  it('saves literal argv and own special environment references with the captured sequence', async () => {
    const onSave = vi.fn(async () => {});
    const { rerender } = render(
      <McpConfigDialog {...shared} initial={config()} expectedSequence={4} onSave={onSave} />,
    );
    expect((screen.getByLabelText('服务 ID') as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText('参数（JSON 字符串数组）'), {
      target: { value: JSON.stringify(['  spaces  ', '', '\\folder\\file', 'a"b']) },
    });
    fireEvent.change(screen.getByLabelText('目标变量 1'), { target: { value: '__proto__' } });
    fireEvent.change(screen.getByLabelText('宿主变量引用 1'), { target: { value: 'DEMO_TOKEN' } });
    rerender(
      <McpConfigDialog
        {...shared}
        initial={config({ label: '新目录' })}
        expectedSequence={99}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await act(async () => {});
    expect(onSave).toHaveBeenCalledOnce();
    const [saved, sequence] = onSave.mock.calls[0]! as unknown as [McpServerConfig, number];
    expect(sequence).toBe(4);
    expect(saved.label).toBe('演示 MCP');
    expect(saved.args).toEqual(['  spaces  ', '', '\\folder\\file', 'a"b']);
    expect(Object.hasOwn(saved.env, '__proto__')).toBe(true);
    expect(saved.env.__proto__).toEqual({ fromHostEnv: 'DEMO_TOKEN' });
    expect(screen.queryByRole('button', { name: '信任并启用' })).toBeNull();
  });

  it('rejects malformed argv and duplicate environment targets before saving, retaining the draft', async () => {
    const onSave = vi.fn(async () => {});
    render(<McpConfigDialog {...shared} initial={config()} expectedSequence={4} onSave={onSave} />);
    const args = screen.getByLabelText('参数（JSON 字符串数组）');
    fireEvent.change(args, { target: { value: '[1]' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    expect(screen.getByRole('alert').textContent).toContain('参数');
    expect(args.getAttribute('aria-invalid')).toBe('true');
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(args, { target: { value: '[""]' } });
    fireEvent.click(screen.getByRole('button', { name: '添加环境引用' }));
    fireEvent.change(screen.getByLabelText('目标变量 2'), { target: { value: 'TOKEN' } });
    fireEvent.change(screen.getByLabelText('宿主变量引用 2'), {
      target: { value: 'ANOTHER_TOKEN' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    expect(screen.getByRole('alert').textContent).toContain('重复');
    expect((args as HTMLTextAreaElement).value).toBe('[""]');
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it.each([
    {
      field: '参数（JSON 字符串数组）',
      value: JSON.stringify(Array.from({ length: 65 }, () => '')),
      message: '参数',
    },
    {
      field: '参数（JSON 字符串数组）',
      value: JSON.stringify(['界'.repeat(1366)]),
      message: '参数',
    },
    { field: '目标变量 1', value: 'WEAVE_TOKEN', message: '环境引用' },
    { field: '宿主变量引用 1', value: 'secret value', message: '环境引用' },
  ])(
    'rejects a syntactically invalid or oversized $field before any write',
    async ({ field, value, message }) => {
      const onSave = vi.fn(async () => {});
      render(
        <McpConfigDialog {...shared} initial={config()} expectedSequence={4} onSave={onSave} />,
      );
      fireEvent.change(screen.getByLabelText(field), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
      expect(screen.getByRole('alert').textContent).toContain(message);
      expect(onSave).not.toHaveBeenCalled();
      await act(async () => {});
    },
  );

  it('keeps row focus usable on add/remove and inherits cancel-first keyboard ownership', () => {
    const onCancel = vi.fn();
    render(
      <McpConfigDialog
        {...shared}
        initial={config()}
        expectedSequence={4}
        onSave={async () => {}}
        onCancel={onCancel}
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }));
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '保存配置' }));
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('region', { name: '审查内容' }));
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('服务 ID'));
    fireEvent.click(screen.getByRole('button', { name: '添加环境引用' }));
    expect(document.activeElement).toBe(screen.getByLabelText('目标变量 2'));
    fireEvent.click(screen.getByRole('button', { name: '移除环境引用 2' }));
    expect(document.activeElement).toBe(screen.getByLabelText('目标变量 1'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('retains the form and permanently blocks its captured token after any 409', async () => {
    const onSave = vi.fn(async () => {
      throw new McpApiError('any-conflict', 'changed', 409);
    });
    const { rerender } = render(
      <McpConfigDialog {...shared} initial={config()} expectedSequence={4} onSave={onSave} />,
    );
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '我的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toContain('重新');
    expect((screen.getByLabelText('显示名称') as HTMLInputElement).value).toBe('我的草稿');
    rerender(
      <McpConfigDialog {...shared} initial={config()} expectedSequence={5} onSave={onSave} />,
    );
    expect((screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    expect(onSave).toHaveBeenCalledOnce();
  });
});

describe('McpTrustDialog', () => {
  it('shows canonical text, exact argv/env/digest and field differences while keeping the captured review', async () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const record = server({
      config: config({ command: malicious }),
      reviewedConfig: config({ args: ['old'] }),
    });
    const review = createMcpReview(record, 4, 2);
    const onTrust = vi.fn(async () => {});
    const { rerender } = render(<McpTrustDialog {...shared} review={review} onTrust={onTrust} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('img')).toBeNull();
    expect(within(dialog).getAllByText(malicious).length).toBeGreaterThan(0);
    expect((screen.getByLabelText('完整配置摘要') as HTMLInputElement).value).toBe('a'.repeat(64));
    expect(screen.getByText('DEMO_TOKEN')).toBeTruthy();
    expect(screen.getByLabelText('启动参数').textContent).toContain('""');
    expect(screen.getByLabelText('配置差异').textContent).toContain('["old"]');
    expect(dialog.textContent).toContain('普通进程权限');
    expect(dialog.textContent).toContain('PATH');
    expect(dialog.textContent).toContain('代码');
    expect(dialog.textContent).toContain('高风险');
    rerender(
      <McpTrustDialog
        {...shared}
        review={createMcpReview(server({ configDigest: 'b'.repeat(64) }), 8, 3)}
        onTrust={onTrust}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '信任并启用' }));
    await act(async () => {});
    expect(onTrust).toHaveBeenCalledWith(review);
  });

  it('disables stale review, blocks duplicate submits, and leaves cancel usable during a pending write', async () => {
    const pending = deferred();
    const onTrust = vi.fn(() => pending.promise);
    const onCancel = vi.fn();
    const review = createMcpReview(server(), 4, 2);
    const { rerender, unmount } = render(
      <McpTrustDialog
        {...shared}
        stale={true}
        review={review}
        onTrust={onTrust}
        onCancel={onCancel}
      />,
    );
    expect((screen.getByRole('button', { name: '信任并启用' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    rerender(<McpTrustDialog {...shared} review={review} onTrust={onTrust} onCancel={onCancel} />);
    const submit = screen.getByRole('button', { name: '信任并启用' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(onTrust).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledOnce();
    unmount();
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('invalidates every 409 and displays a recoverable non-conflict failure', async () => {
    const onTrust = vi
      .fn()
      .mockRejectedValueOnce(new Error('连接暂不可用'))
      .mockRejectedValueOnce(new McpApiError('different-conflict', 'changed', 409));
    render(
      <McpTrustDialog {...shared} review={createMcpReview(server(), 4, 2)} onTrust={onTrust} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '信任并启用' }));
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toContain('连接暂不可用');
    expect((screen.getByRole('button', { name: '信任并启用' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: '信任并启用' }));
    await act(async () => {});
    expect((screen.getByRole('button', { name: '信任并启用' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('McpDecisionDialog', () => {
  it.each([
    ['disable', '确认停用', '保留'],
    ['revoke', '确认撤销信任', '清除'],
    ['remove', '确认移除', '历史'],
  ] as const)(
    'defaults %s to next turn and explains its authority effect',
    async (action, button, explanation) => {
      const onConfirm = vi.fn(async () => {});
      render(
        <McpDecisionDialog
          {...shared}
          server={server()}
          action={action}
          expectedSequence={4}
          hasRunningSessions={false}
          onConfirm={onConfirm}
        />,
      );
      expect(screen.getByRole('dialog').textContent).toContain(explanation);
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: button }));
      await act(async () => {});
      expect(onConfirm).toHaveBeenCalledWith(false);
    },
  );

  it('always offers immediate and sends the explicit choice after known sessions become idle', async () => {
    const onConfirm = vi.fn(async () => {});
    const props = {
      ...shared,
      server: server(),
      action: 'remove' as const,
      expectedSequence: 4,
      onConfirm,
    };
    const { rerender } = render(<McpDecisionDialog {...props} hasRunningSessions={true} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '立即生效（取消所有进行中的回合）' }));
    rerender(<McpDecisionDialog {...props} hasRunningSessions={false} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('dialog').textContent).toContain('退役');
    fireEvent.click(screen.getByRole('button', { name: '确认移除' }));
    await act(async () => {});
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('blocks stale and conflicted decisions without disabling cancel', async () => {
    const onConfirm = vi.fn(async () => {
      throw new McpApiError('mcp-conflict', 'changed', 409);
    });
    const props = {
      ...shared,
      server: server(),
      action: 'disable' as const,
      expectedSequence: 4,
      hasRunningSessions: false,
      onConfirm,
    };
    const { rerender } = render(<McpDecisionDialog {...props} stale={true} />);
    expect((screen.getByRole('button', { name: '确认停用' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    rerender(<McpDecisionDialog {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    await act(async () => {});
    expect((screen.getByRole('button', { name: '确认停用' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
