// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { MemoryPage } from '../src/features/memory/MemoryPage.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const memoryId = '22222222-2222-4222-8222-222222222222';
const scope = { kind: 'project' as const, projectId };
const ref = { scope, memoryId, revision: 1, sha256: 'a'.repeat(64) };
const record = {
  ref,
  title: 'Team preference',
  content: 'Use **strict TS**. <script>bad()</script> [unsafe](file:///tmp/x)',
  tags: ['coding'],
  review: 'agent-authored',
  provenance: {
    actor: 'agent',
    sessionId: 'verified-session',
    executionId: 'e',
    turnId: 't',
    toolCallId: 'tool',
  },
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-23T00:00:00.000Z',
};
const summary = {
  ref: record.ref,
  title: record.title,
  tags: record.tags,
  review: record.review,
  provenance: record.provenance,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  excerpt: 'Use strict TS',
};
function receipt(body: Record<string, unknown>, operation: string) {
  return {
    receipt: {
      requestId: body.requestId,
      operation,
      sequence: 2,
      subject: { kind: 'record', scope, memoryId, revision: operation === 'create' ? 1 : 2 },
      result: { ...ref, revision: operation === 'create' ? 1 : 2 },
    },
  };
}
function setup(
  override?: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined,
  strictMode = false,
) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const custom = override?.(url, init);
    if (custom !== undefined) return custom;
    if (url.pathname === '/memory/scopes')
      return Response.json({
        scopes: [
          { scope, name: 'Project A', access: { scope, level: 'disabled', settingRevision: 0 } },
          {
            scope: { kind: 'user' },
            name: '个人记忆',
            access: { scope: { kind: 'user' }, level: 'disabled', settingRevision: 0 },
          },
        ],
      });
    if (url.pathname.endsWith('/history'))
      return Response.json({
        entries: [
          {
            sequence: 1,
            subject: { kind: 'record', scope, memoryId, revision: 1 },
            kind: 'created',
            occurredAt: record.createdAt,
            provenance: record.provenance,
            ref,
            review: 'agent-authored',
          },
        ],
      });
    if (url.pathname === '/memory/records')
      return Response.json({ records: url.searchParams.get('scope') === 'user' ? [] : [summary] });
    if (url.pathname === '/memory/access')
      return Response.json({ access: { scope, level: 'disabled', settingRevision: 0 } });
    if (url.pathname === '/memory/records/' + memoryId) return Response.json({ record });
    throw new Error('Unhandled Memory request ' + url.pathname);
  });
  vi.stubGlobal('fetch', fetch);
  const props = {
    selectedProjectId: projectId,
    verifiedSessionIds: ['verified-session'],
    onNavigateSession: vi.fn(),
  };
  const page = <MemoryPage {...props} />;
  return { ...render(strictMode ? <StrictMode>{page}</StrictMode> : page), fetch, props };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Memory management page', () => {
  it('keeps disabled management available, renders safe Markdown and only verified Session navigation', async () => {
    const f = setup();
    fireEvent.click(await screen.findByRole('button', { name: '查看 Team preference' }));
    await screen.findByRole('heading', { name: 'Team preference' });
    expect(screen.getByText(/已停用使用/)).toBeDefined();
    expect(screen.getByRole('button', { name: '编辑记忆' })).toBeDefined();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a[href^="file:"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开来源会话' }));
    expect(f.props.onNavigateSession).toHaveBeenCalledWith('verified-session');
  });
  it('preserves a conflict draft and retries an unchanged failed save with the same requestId', async () => {
    const writes: Array<Record<string, unknown>> = [];
    let conflict = false;
    setup((url, init) => {
      if (url.pathname === '/memory/records' && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        return conflict
          ? Response.json(
              { error: { code: 'memory-stale-revision', message: 'Changed' } },
              { status: 409 },
            )
          : Promise.reject(new TypeError('offline'));
      }
      return undefined;
    });
    fireEvent.click(await screen.findByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByRole('textbox', { name: '标题' }), {
      target: { value: 'My draft' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), {
      target: { value: 'Preserve me' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存记忆' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '保存记忆' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]?.requestId).toBe(writes[1]?.requestId);
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存记忆' }).disabled).toBe(
        false,
      ),
    );
    conflict = true;
    fireEvent.click(screen.getByRole('button', { name: '保存记忆' }));
    await screen.findByText(/草稿已保留/);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '标题' }).value).toBe('My draft');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '正文' }).value).toBe(
      'Preserve me',
    );
    expect(
      screen.getByRole('textbox', { name: '正文' }).getAttribute('aria-describedby'),
    ).toContain('memory-editor-error');
  });
  it('disables duplicate saves while a write is in flight', async () => {
    let finish!: (value: Response) => void;
    let writes = 0;
    setup((url, init) => {
      if (url.pathname === '/memory/records' && init.method === 'POST') {
        writes++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return undefined;
    });
    fireEvent.click(await screen.findByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByRole('textbox', { name: '标题' }), { target: { value: 'One' } });
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), {
      target: { value: 'One body' },
    });
    const save = screen.getByRole<HTMLButtonElement>('button', { name: '保存记忆' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(save.disabled).toBe(true);
    expect(writes).toBe(1);
    await act(async () => {
      finish(Response.json({ error: { code: 'memory-busy', message: 'Busy' } }, { status: 503 }));
    });
  });
  it('reviews exactly the displayed revision and explains retained history in delete confirmation', async () => {
    let reviewed: unknown;
    setup((url, init) => {
      if (url.pathname.endsWith('/review')) {
        const body = JSON.parse(String(init.body));
        reviewed = body;
        return Response.json(receipt(body, 'review'));
      }
      return undefined;
    });
    fireEvent.click(await screen.findByRole('button', { name: '查看 Team preference' }));
    fireEvent.click(await screen.findByRole('button', { name: '审阅版本 1' }));
    await waitFor(() => expect(reviewed).toMatchObject({ scope, targetRef: ref }));
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '删除记忆' }).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '删除记忆' }));
    const dialog = within(screen.getByRole('alertdialog'));
    expect(dialog.getByText(/删除后当前搜索不再显示，保留历史版本/)).toBeDefined();
    expect(dialog.getByText('Team preference')).toBeDefined();
    expect(document.activeElement).toBe(dialog.getByRole('button', { name: '取消删除' }));
  });
  it('discards a previous scope response and fences at least 100 controlled out-of-order list responses', async () => {
    const pending: Array<{
      url: URL;
      finish: (value: Response) => void;
      signal?: AbortSignal | null;
    }> = [];
    setup((url, init) =>
      url.pathname === '/memory/records' && init.method === 'GET'
        ? new Promise<Response>((finish) => {
            pending.push({ url, finish, signal: init.signal });
          })
        : undefined,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(screen.getByRole('combobox', { name: '记忆范围' }), {
      target: { value: 'user' },
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1]!.finish(Response.json({ records: [] }));
      pending[0]!.finish(Response.json({ records: [summary] }));
    });
    expect(pending[0]!.signal?.aborted).toBe(true);
    expect(screen.queryByRole('button', { name: '查看 Team preference' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: '记忆范围' }), {
      target: { value: 'project:' + projectId },
    });
    await waitFor(() => expect(pending).toHaveLength(3));
    for (let i = 0; i < 100; i++) {
      await act(async () => {
        fireEvent.change(screen.getByRole('searchbox', { name: '搜索标题和正文' }), {
          target: { value: 'query-' + i },
        });
      });
    }
    expect(pending).toHaveLength(103);
    await act(async () => {
      for (let i = pending.length - 1; i >= 2; i--)
        pending[i]!.finish(Response.json({ records: [{ ...summary, title: 'Result ' + i }] }));
    });
    expect(await screen.findByRole('button', { name: '查看 Result 102' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '查看 Result 2' })).toBeNull();
  });
  it('recovers stale pagination by fetching page one in the same scope', async () => {
    let calls = 0;
    setup((url, init) => {
      if (url.pathname === '/memory/records' && init.method === 'GET') {
        calls++;
        return url.searchParams.has('cursor')
          ? Response.json(
              { error: { code: 'memory-stale-cursor', message: 'Changed' } },
              { status: 409 },
            )
          : Response.json({ records: [summary], nextCursor: 'page-2' });
      }
      return undefined;
    });
    fireEvent.click(await screen.findByRole('button', { name: '下一页记忆' }));
    await waitFor(() => expect(calls).toBe(3));
    expect(await screen.findByRole('button', { name: '查看 Team preference' })).toBeDefined();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '记忆范围' }).value).toBe(
      'project:' + projectId,
    );
  });
  it('reloads the new edit base after 409 while keeping the user draft and issues a new request identity', async () => {
    let current = record;
    const writes: Array<Record<string, unknown>> = [];
    setup((url, init) => {
      if (url.pathname === '/memory/records' && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        if (writes.length === 1) {
          current = { ...record, ref: { ...ref, revision: 2 }, content: 'Remote version' };
          return Response.json(
            { error: { code: 'memory-stale-revision', message: 'Changed' } },
            { status: 409 },
          );
        }
        current = { ...record, ref: { ...ref, revision: 3 }, content: String(body.content) };
        return Response.json({
          receipt: {
            requestId: body.requestId,
            operation: 'revise',
            sequence: 3,
            subject: { kind: 'record', scope, memoryId, revision: 3 },
            result: current.ref,
          },
        });
      }
      if (url.pathname === '/memory/records/' + memoryId) return Response.json({ record: current });
      return undefined;
    });
    fireEvent.click(await screen.findByRole('button', { name: '查看 Team preference' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑记忆' }));
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), {
      target: { value: 'My precise draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存记忆' }));
    fireEvent.click(await screen.findByRole('button', { name: '重新加载当前版本并保留草稿' }));
    await screen.findByRole('heading', { name: '编辑版本 2' });
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '正文' }).value).toBe(
      'My precise draft',
    );
    fireEvent.click(screen.getByRole('button', { name: '保存记忆' }));
    await screen.findByText('My precise draft');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ expectedRevision: 2, content: 'My precise draft' });
    expect(writes[1]?.requestId).not.toBe(writes[0]?.requestId);
  });
  it('fences a late historical read after the user selects another exact version', async () => {
    let finishOld!: (value: Response) => void;
    const secondRef = { ...ref, revision: 2 };
    setup((url) => {
      if (url.pathname.endsWith('/history'))
        return Response.json({
          entries: [2, 1].map((revision) => ({
            sequence: revision,
            subject: { kind: 'record', scope, memoryId, revision },
            kind: revision === 1 ? 'created' : 'revised',
            occurredAt: record.createdAt,
            provenance: record.provenance,
            ref: { ...ref, revision },
          })),
        });
      if (
        url.pathname === '/memory/records/' + memoryId &&
        url.searchParams.get('revision') === '1'
      )
        return new Promise((finish) => {
          finishOld = finish;
        });
      if (
        url.pathname === '/memory/records/' + memoryId &&
        url.searchParams.get('revision') === '2'
      )
        return Response.json({
          record: { ...record, ref: secondRef, title: 'Newer exact version' },
        });
      return undefined;
    });
    fireEvent.click(await screen.findByRole('button', { name: '查看 Team preference' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看版本 1' }));
    await waitFor(() => expect(finishOld).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: '查看版本 2' }));
    await screen.findByRole('heading', { name: 'Newer exact version' });
    await act(async () => {
      finishOld(Response.json({ record: { ...record, title: 'Late old version' } }));
    });
    expect(screen.getByRole('heading', { name: 'Newer exact version' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Late old version' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑记忆' })).toBeNull();
  });

  it('reloads current access when returning to a scope', async () => {
    let accessRevision = 1;
    let accessLevel = 'read-only';
    setup((url, init) => {
      if (url.pathname === '/memory/access' && init.method === 'GET') {
        const responseScope = url.searchParams.get('scope') === 'user' ? { kind: 'user' } : scope;
        return Response.json({
          access: { scope: responseScope, level: accessLevel, settingRevision: accessRevision },
        });
      }
      if (url.pathname === '/memory/access' && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        accessRevision++;
        accessLevel = body.level;
        return Response.json({
          receipt: {
            requestId: body.requestId,
            operation: 'setAccess',
            sequence: 2,
            subject: { kind: 'scope-access', scope, settingRevision: accessRevision },
            result: { scope, level: accessLevel, settingRevision: accessRevision },
          },
        });
      }
      return undefined;
    });
    const access = await screen.findByRole<HTMLSelectElement>('combobox', {
      name: 'Agent 与检索使用权限',
    });
    await waitFor(() => expect(access.value).toBe('read-only'));
    fireEvent.change(access, { target: { value: 'read-write' } });
    await waitFor(() => expect(access.value).toBe('read-write'));
    fireEvent.change(screen.getByRole('combobox', { name: '记忆范围' }), {
      target: { value: 'user' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: '记忆范围' }), {
      target: { value: 'project:' + projectId },
    });
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLSelectElement>('combobox', { name: 'Agent 与检索使用权限' }).value,
      ).toBe('read-write'),
    );
  });

  it('does not let a delayed access snapshot regress a completed setting mutation', async () => {
    let finishAccess!: (value: Response) => void;
    setup((url, init) => {
      if (url.pathname === '/memory/access' && init.method === 'GET')
        return new Promise((finish) => {
          finishAccess = finish;
        });
      if (url.pathname === '/memory/access' && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return Response.json({
          receipt: {
            requestId: body.requestId,
            operation: 'setAccess',
            sequence: 1,
            subject: { kind: 'scope-access', scope, settingRevision: 1 },
            result: { scope, level: body.level, settingRevision: 1 },
          },
        });
      }
      return undefined;
    });
    const access = await screen.findByRole<HTMLSelectElement>('combobox', {
      name: 'Agent 与检索使用权限',
    });
    fireEvent.change(access, { target: { value: 'read-write' } });
    await waitFor(() => expect(access.value).toBe('read-write'));
    await act(async () => {
      finishAccess(Response.json({ access: { scope, level: 'disabled', settingRevision: 0 } }));
    });
    expect(access.value).toBe('read-write');
  });
  it.each(['create', 'edit', 'review', 'delete', 'access'] as const)(
    'completes %s after StrictMode effect replay with a live signal and clears busy state',
    async (operation) => {
      const writes: Array<{ path: string; abortedAtStart: boolean | undefined }> = [];
      let current = record;
      let deleted = false;
      setup((url, init) => {
        if (init.method === 'POST') {
          writes.push({ path: url.pathname, abortedAtStart: init.signal?.aborted });
          if (init.signal?.aborted)
            return Promise.reject(new DOMException('Aborted', 'AbortError'));
          const body = JSON.parse(String(init.body));
          if (url.pathname === '/memory/access')
            return Response.json({
              receipt: {
                requestId: body.requestId,
                operation: 'setAccess',
                sequence: 1,
                subject: { kind: 'scope-access', scope, settingRevision: 1 },
                result: { scope, level: body.level, settingRevision: 1 },
              },
            });
          if (url.pathname.endsWith('/delete')) {
            deleted = true;
            return Response.json({
              receipt: {
                requestId: body.requestId,
                operation: 'remove',
                sequence: 2,
                subject: { kind: 'record', scope, memoryId, revision: 2 },
                result: { memoryId, revision: 2, deleted: true },
              },
            });
          }
          if (url.pathname.endsWith('/review')) {
            current = { ...current, ref: { ...current.ref, revision: 2 }, review: 'user-reviewed' };
          } else {
            current = {
              ...current,
              ref: { ...current.ref, revision: body.operation === 'create' ? 1 : 2 },
              title: body.title,
              content: body.content,
              review: 'user-reviewed',
            };
          }
          return Response.json({
            receipt: {
              requestId: body.requestId,
              operation: url.pathname.endsWith('/review') ? 'review' : body.operation,
              sequence: 2,
              subject: { kind: 'record', scope, memoryId, revision: current.ref.revision },
              result: current.ref,
            },
          });
        }
        if (url.pathname === '/memory/records')
          return Response.json({
            records: deleted
              ? []
              : [{ ...summary, ref: current.ref, title: current.title, review: current.review }],
          });
        if (url.pathname === '/memory/records/' + memoryId)
          return Response.json({ record: current });
        return undefined;
      }, true);
      await screen.findByRole('button', { name: '查看 Team preference' });
      if (operation === 'access') {
        fireEvent.change(screen.getByRole('combobox', { name: 'Agent 与检索使用权限' }), {
          target: { value: 'read-write' },
        });
      } else if (operation === 'create') {
        fireEvent.click(screen.getByRole('button', { name: '新建记忆' }));
        fireEvent.change(screen.getByRole('textbox', { name: '标题' }), {
          target: { value: 'Strict created' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: '正文' }), {
          target: { value: 'Strict created body' },
        });
        fireEvent.click(screen.getByRole('button', { name: '保存记忆' }));
      } else {
        fireEvent.click(screen.getByRole('button', { name: '查看 Team preference' }));
        await screen.findByRole('button', { name: '编辑记忆' });
        if (operation === 'edit') {
          fireEvent.click(screen.getByRole('button', { name: '编辑记忆' }));
          fireEvent.change(screen.getByRole('textbox', { name: '标题' }), {
            target: { value: 'Strict edited' },
          });
          fireEvent.click(screen.getByRole('button', { name: '保存记忆' }));
        } else if (operation === 'review')
          fireEvent.click(screen.getByRole('button', { name: '审阅版本 1' }));
        else {
          fireEvent.click(screen.getByRole('button', { name: '删除记忆' }));
          fireEvent.click(screen.getByRole('button', { name: '确认删除并保留历史' }));
        }
      }
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0]?.abortedAtStart).toBe(false);
      if (operation === 'access') {
        const access = screen.getByRole<HTMLSelectElement>('combobox', {
          name: 'Agent 与检索使用权限',
        });
        await waitFor(() => {
          expect(access.value).toBe('read-write');
          expect(access.disabled).toBe(false);
        });
      } else if (operation === 'delete') {
        await screen.findByRole('heading', { name: '记忆已删除' });
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(screen.queryByText('正在更新记忆…')).toBeNull();
      } else {
        await screen.findByRole('heading', {
          name:
            operation === 'create'
              ? 'Strict created'
              : operation === 'edit'
                ? 'Strict edited'
                : 'Team preference',
        });
        await waitFor(() =>
          expect(screen.getByRole<HTMLButtonElement>('button', { name: '编辑记忆' }).disabled).toBe(
            false,
          ),
        );
        if (operation === 'review')
          expect(screen.queryByRole('button', { name: '审阅版本 1' })).toBeNull();
      }
    },
  );

  it.each(['a,b', '  a,b  '])(
    'preserves the exact tag %j when only the body changes',
    async (tag) => {
      let savedTags: unknown;
      setup((url, init) => {
        if (url.pathname === '/memory/records/' + memoryId)
          return Response.json({ record: { ...record, tags: [tag] } });
        if (url.pathname === '/memory/records' && init.method === 'POST') {
          const body = JSON.parse(String(init.body));
          savedTags = body.tags;
          return Response.json(receipt(body, 'revise'));
        }
        return undefined;
      });
      fireEvent.click(await screen.findByRole('button', { name: '查看 Team preference' }));
      fireEvent.click(await screen.findByRole('button', { name: '编辑记忆' }));
      fireEvent.change(screen.getByRole('textbox', { name: '正文' }), {
        target: { value: 'Changed body only' },
      });
      fireEvent.click(screen.getByRole('button', { name: '保存记忆' }));
      await waitFor(() => expect(savedTags).toEqual([tag]));
    },
  );
});
