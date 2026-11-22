// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { useFilePicker } from '../src/features/file-context/use-file-picker.js';
import { FilePicker } from '../src/features/file-context/file-picker.js';
import type { ComposerOwner } from '../src/features/composer/use-composer-draft.js';
const mocks = vi.hoisted(() => ({ fetchFileTree: vi.fn() }));
vi.mock('../src/features/files-tree/file-tree-api.js', () => ({
  fetchFileTree: mocks.fetchFileTree,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const owner = { sessionId: 'a', projectId: 'p', rootKey: 'root', epoch: 1 };
export function PickerFixture({
  value = owner,
  onSelect = vi.fn(),
}: {
  value?: ComposerOwner;
  onSelect?: (path: string, owner: ComposerOwner) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const picker = useFilePicker({
    owner: value,
    inputRef: ref,
    text,
    setText,
    projectId: value.projectId,
    rootKey: value.rootKey,
    onSelect,
  });
  return (
    <>
      <textarea
        aria-label="draft"
        ref={ref}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          picker.updateSelection(e.target.value, e.target.selectionStart, e.target.selectionEnd);
        }}
        onKeyDown={picker.handleKeyDown}
      />
      <button type="button" onClick={picker.openFromButton}>
        files
      </button>
      <FilePicker picker={picker} />
    </>
  );
}
it('selects one explicit ref, removes only the token, and consumes Enter without submitting', async () => {
  mocks.fetchFileTree.mockResolvedValue({ files: ['src/a.ts'], truncated: true, source: 'walk' });
  const onSelect = vi.fn();
  render(<PickerFixture onSelect={onSelect} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'hello @a' } });
  expect(await screen.findByRole('option', { name: 'src/a.ts' })).toBeTruthy();
  expect(screen.getByText('仅显示部分项目文件，可从文件树添加')).toBeTruthy();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSelect).toHaveBeenCalledWith('src/a.ts', owner);
  expect((input as HTMLTextAreaElement).value).toBe('hello ');
  expect(screen.queryByRole('listbox')).toBeNull();
});
it('does not intercept IME and closes stale owner responses through ABA', async () => {
  let resolve!: (value: unknown) => void;
  mocks.fetchFileTree.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const onSelect = vi.fn();
  const { rerender } = render(<PickerFixture onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('button', { name: 'files' }));
  await waitFor(() => expect(mocks.fetchFileTree).toHaveBeenCalledTimes(1));
  rerender(<PickerFixture value={{ ...owner, sessionId: 'b', epoch: 2 }} onSelect={onSelect} />);
  rerender(<PickerFixture value={{ ...owner, epoch: 3 }} onSelect={onSelect} />);
  resolve({ files: ['stale.ts'], truncated: false, source: 'walk' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });
  expect(onSelect).not.toHaveBeenCalled();
});

it('searches full paths with spaces from the toolbar beyond the first twenty candidates', async () => {
  const selectedPath = 'src/中文 long file.ts';
  mocks.fetchFileTree.mockResolvedValue({
    files: [...Array.from({ length: 25 }, (_, i) => `${i}.ts`), selectedPath],
    source: 'walk',
    truncated: false,
  });
  const onSelect = vi.fn();
  render(<PickerFixture onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('button', { name: 'files' }));
  const search = await screen.findByRole('textbox', { name: '搜索项目文件' });
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(20));
  expect(screen.queryByRole('option', { name: selectedPath })).toBeNull();
  fireEvent.change(search, { target: { value: '中文 long file' } });
  expect(await screen.findByRole('option', { name: selectedPath })).toBeTruthy();
  expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: 'Enter', isComposing: true, keyCode: 229 });
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(onSelect).toHaveBeenCalledWith(selectedPath, owner);
  expect((screen.getByRole('textbox', { name: 'draft' }) as HTMLTextAreaElement).value).toBe('');
});
