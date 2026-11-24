import { describe, expect, it } from 'vitest';
import { createConversationUiState } from '../src/features/conversation/conversation-ui-state.js';

describe('pane disclosure state', () => {
  it('retains exact row and tool expansion when a row unmounts without sharing call IDs across turns or sessions', () => {
    const state = createConversationUiState();
    state.setProcess('a', 'row-1', true);
    state.setTool('a', 'row-1', 'turn-1', 'same-tool', true);
    expect(state.get('a', 'row-1').processOpen).toBe(true);
    expect(state.isToolOpen('a', 'row-1', 'turn-1', 'same-tool')).toBe(true);
    expect(state.isToolOpen('a', 'row-1', 'turn-2', 'same-tool')).toBe(false);
    expect(state.isToolOpen('b', 'row-1', 'turn-1', 'same-tool')).toBe(false);
    state.setProcess('a', 'row-1', false);
    state.setProcess('a', 'row-1', true);
    expect(state.isToolOpen('a', 'row-1', 'turn-1', 'same-tool')).toBe(true);
  });
  it('notifies only the changed row and gives stable snapshots for unchanged state', () => {
    const state = createConversationUiState();
    const first = state.get('a', 'one');
    let calls = 0;
    state.subscribe('a', 'one', () => {
      calls++;
    });
    state.setProcess('a', 'two', true);
    expect(state.get('a', 'one')).toBe(first);
    expect(calls).toBe(0);
    state.setProcess('a', 'one', true);
    expect(calls).toBe(1);
  });
});
