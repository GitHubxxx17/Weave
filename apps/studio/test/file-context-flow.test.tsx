// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { executionTurnView } from '../src/features/agent/agent-execution-view.js';
import { mergeExecutionHistory } from '../src/features/agent/execution-history.js';
import { FileAttachmentSummaries } from '../src/features/file-context/file-attachments.js';
import type { AgentExecutionSnapshot } from '../src/features/agent/agent-execution-types.js';
afterEach(cleanup);
it('shows the same accepted summaries in a live overlay and one durable history row', () => {
  const files = [
    { path: 'src/a.ts', encoding: 'utf-8' as const, byteLength: 7, sha256: 'a'.repeat(64) },
  ];
  const snapshot: AgentExecutionSnapshot = {
    executionId: 'e',
    requestId: 'r',
    sessionId: 's',
    turnId: 't',
    userMessageId: 'u',
    createdAt: '2026-11-23T00:00:00Z',
    status: 'running',
    cursor: 'epoch:e:0',
    input: {
      userMessage: { role: 'user', content: [] },
      provider: 'p',
      model: 'm',
      permissionMode: 'ask',
      files: [{ path: 'src/a.ts' }],
    },
    events: [],
    fileAttachments: files,
  };
  const live = executionTurnView(snapshot).messages;
  const durable = [
    { role: 'user' as const, turnId: 't', messageId: 'u', content: [], fileAttachments: files },
  ];
  const messages = mergeExecutionHistory(durable, live, []);
  expect(messages).toHaveLength(1);
  const message = messages[0]!;
  expect(message.role === 'user' ? message.fileAttachments : undefined).toEqual(files);
  render(
    <FileAttachmentSummaries
      files={message.role === 'user' ? message.fileAttachments : undefined}
    />,
  );
  expect(screen.getByLabelText('发送时快照').textContent).toContain('src/a.ts · 7 字节');
  expect(document.querySelector('a, button')).toBeNull();
  expect(executionTurnView(snapshot).messages[0]).toMatchObject({ fileAttachments: files });
});
