// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { KeyboardEvent } from 'react';
import { useFilePicker } from '../src/features/file-context/use-file-picker.js';
const mocks = vi.hoisted(() => ({ fetchFileTree: vi.fn() }));
vi.mock('../src/features/files-tree/file-tree-api.js', () => ({
  fetchFileTree: mocks.fetchFileTree,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const owner = { sessionId: 'a', projectId: 'p', rootKey: 'one', epoch: 1 };
it('aborts and rejects an old A response after navigating A B A with a new epoch', async () => {
  let resolve!: (result: unknown) => void;
  mocks.fetchFileTree.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const select = vi.fn();
  const { result, rerender } = renderHook(
    ({ current }) =>
      useFilePicker({
        owner: current,
        inputRef: { current: null },
        text: '@a',
        setText: vi.fn(),
        projectId: current.projectId,
        rootKey: current.rootKey,
        onSelect: select,
      }),
    { initialProps: { current: owner } },
  );
  act(() => result.current.openFromButton());
  await waitFor(() => expect(mocks.fetchFileTree).toHaveBeenCalledTimes(1));
  const signal = mocks.fetchFileTree.mock.calls[0]![1].signal as AbortSignal;
  const staleSelect = result.current.select;
  rerender({ current: { ...owner, sessionId: 'b', epoch: 2 } });
  rerender({ current: { ...owner, epoch: 3 } });
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({ files: ['a.ts'], source: 'walk', truncated: false }));
  act(() => staleSelect('a.ts'));
  expect(select).not.toHaveBeenCalled();
  expect(result.current.open).toBe(false);
});
it('leaves IME Enter alone while consuming a non-IME Enter in an open empty menu', () => {
  const { result } = renderHook(() =>
    useFilePicker({
      owner: { ...owner, rootKey: '' },
      inputRef: { current: null },
      text: '',
      setText: vi.fn(),
      projectId: owner.projectId,
      rootKey: '',
      onSelect: vi.fn(),
    }),
  );
  act(() => result.current.openFromButton());
  const preventDefault = vi.fn();
  const event = {
    key: 'Enter',
    nativeEvent: { isComposing: true },
    preventDefault,
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
  expect(result.current.handleKeyDown(event)).toBe(false);
  expect(preventDefault).not.toHaveBeenCalled();
  expect(
    result.current.handleKeyDown({
      ...event,
      nativeEvent: { isComposing: false },
    } as KeyboardEvent<HTMLTextAreaElement>),
  ).toBe(true);
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(mocks.fetchFileTree).not.toHaveBeenCalled();
});

it.each(['> hello\n\n@a', 'queued message'])(
  'rejects old mention offsets after programmatic draft becomes %s',
  async (text) => {
    mocks.fetchFileTree.mockResolvedValue({ files: ['a.ts'], source: 'walk', truncated: false });
    const setText = vi.fn();
    const select = vi.fn();
    const { result, rerender } = renderHook(
      ({ value }) =>
        useFilePicker({
          owner,
          inputRef: { current: null },
          text: value,
          setText,
          projectId: owner.projectId,
          rootKey: owner.rootKey,
          onSelect: select,
        }),
      { initialProps: { value: '@a' } },
    );
    act(() => result.current.updateSelection('@a', 2, 2));
    await waitFor(() => expect(result.current.items).toEqual(['a.ts']));
    const oldSelect = result.current.select;
    rerender({ value: text });
    act(() => oldSelect('a.ts'));
    act(() => result.current.select('a.ts'));
    expect(setText).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(result.current.open).toBe(false);
  },
);

it('bounds toolbar queries and rejects a query callback from another owner epoch', () => {
  const { result, rerender } = renderHook(
    ({ current }) =>
      useFilePicker({
        owner: current,
        inputRef: { current: null },
        text: '',
        setText: vi.fn(),
        projectId: current.projectId,
        rootKey: '',
        onSelect: vi.fn(),
      }),
    { initialProps: { current: owner } },
  );
  act(() => result.current.openFromButton());
  const staleQuery = result.current.setQuery;
  act(() => result.current.setQuery('a'.repeat(300)));
  expect(result.current.query).toHaveLength(256);
  rerender({ current: { ...owner, epoch: 2 } });
  act(() => result.current.openFromButton());
  act(() => staleQuery('wrong owner'));
  expect(result.current.query).toBe('');
});
