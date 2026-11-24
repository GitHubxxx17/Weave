// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolStep } from '../src/features/conversation/tool-step.js';
import { ConversationRow } from '../src/features/conversation/conversation-row.js';
import { createConversationUiState } from '../src/features/conversation/conversation-ui-state.js';
import { createTurnFileReviewStore } from '../src/features/file-undo/turn-file-review-store.js';

afterEach(cleanup);
const tool = {
  toolCallId: 'same-id',
  name: 'read_file',
  arguments: '{"path":"source.ts","secret":"complete arguments"}',
  result: 'complete result sentinel',
  status: 'completed' as const,
};
describe('lazy tool details', () => {
  it('mounts parameters and full result only while its details are open', () => {
    const { container } = render(<ToolStep tool={tool} />);
    expect(container.querySelector('[data-tool-parameters]')).toBeNull();
    const details = container.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(container.querySelector('[data-tool-parameters]')?.textContent).toContain(
      'complete arguments',
    );
    expect(screen.getByText('complete result sentinel')).toBeTruthy();
    details.open = false;
    fireEvent(details, new Event('toggle'));
    expect(container.querySelector('[data-tool-parameters]')).toBeNull();
  });
  it('restores process and exact tool disclosures after a virtual row remount', () => {
    const uiState = createConversationUiState();
    const fileReviewStore = createTurnFileReviewStore();
    const props = {
      row: {
        id: 'row',
        role: 'assistant' as const,
        turnId: 'turn',
        text: 'answer',
        reasoning: 'reasoning sentinel',
        tools: [tool],
        occurredAt: '2026-11-24T00:00:00Z',
      },
      sessionId: 'session',
      projectId: 'project',
      turn: undefined,
      isLatestAssistant: false,
      isLastReply: false,
      canRetry: false,
      hasRetry: false,
      hasUser: false,
      status: 'completed' as const,
      sessionHasWork: false,
      canCompose: false,
      onAction: () => {},
      uiState,
      fileReviewStore,
    };
    const view = render(<ConversationRow {...props} />);
    expect(screen.queryByText('reasoning sentinel')).toBeNull();
    const process = screen.getByRole('group', { name: '本轮过程' }) as HTMLDetailsElement;
    process.open = true;
    fireEvent(process, new Event('toggle'));
    const details = view.container.querySelector('[data-tool-call-id]') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(screen.getByText('complete result sentinel')).toBeTruthy();
    view.unmount();
    render(<ConversationRow {...props} />);
    expect(screen.getByText('reasoning sentinel')).toBeTruthy();
    expect(screen.getByText('complete result sentinel')).toBeTruthy();
  });
});
