import { describe, expect, it } from 'vitest';

import {
  collectFiles,
  type OverviewMessage,
  type OverviewTool,
} from '../src/features/panel/panel-data.js';

function tool(
  name: string,
  path: string,
  status: OverviewTool['status'] = 'completed',
  result?: string,
): OverviewTool {
  return {
    toolCallId: `${name}:${path}`,
    name,
    arguments: JSON.stringify({ path }),
    status,
    ...(result === undefined ? {} : { result }),
  };
}

function message(id: string, tools: readonly OverviewTool[]): OverviewMessage {
  return { id, role: 'assistant', occurredAt: '2026-11-27T00:00:00.000Z', tools };
}

describe('collectFiles', () => {
  it('lists edit_file changes as writes alongside read_file and write_file', () => {
    const files = collectFiles([
      message('m1', [tool('read_file', 'a.ts'), tool('write_file', 'b.ts')]),
      message('m2', [tool('edit_file', 'README.md')]),
    ]);

    expect(
      files.map(({ path, operation, state, messageId }) => ({
        path,
        operation,
        state,
        messageId,
      })),
    ).toEqual([
      { path: 'README.md', operation: '写入', state: '已编辑', messageId: 'm2' },
      { path: 'b.ts', operation: '写入', state: '已写入', messageId: 'm1' },
      { path: 'a.ts', operation: '读取', state: '已读取', messageId: 'm1' },
    ]);
  });

  it('keeps only the latest operation per path and reports failed or rejected edits', () => {
    const files = collectFiles([
      message('m1', [tool('read_file', 'README.md')]),
      message('m2', [tool('edit_file', 'README.md', 'failed', 'tool-approval-rejected')]),
      message('m3', [tool('edit_file', 'b.ts', 'failed', 'oldText not found')]),
      message('m4', [tool('edit_file', 'c.ts', 'executing')]),
    ]);

    expect(files.map(({ path, state, ok }) => ({ path, state, ok }))).toEqual([
      { path: 'c.ts', state: '进行中', ok: false },
      { path: 'b.ts', state: '失败', ok: false },
      { path: 'README.md', state: '已拒绝', ok: false },
    ]);
  });

  it('ignores tools that are not file reads or writes', () => {
    expect(
      collectFiles([
        message('m1', [tool('grep', 'src'), tool('list_dir', '.'), tool('toString', 'x')]),
      ]),
    ).toEqual([]);
  });
});
