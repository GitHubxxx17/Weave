// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import type { OpenMenu, PendingImage } from '../src/app/app-types.js';
import { useComposerAttachments } from '../src/app/use-composer-attachments.js';
import { useComposerDraft } from '../src/features/composer/use-composer-draft.js';
import { fetchContextAvailability } from '../src/features/file-context/context-availability-api.js';

vi.mock('../src/features/file-context/context-availability-api.js', () => ({
  fetchContextAvailability: vi.fn(),
}));

function setup(initial: { sessionId: string; openMenu: OpenMenu }) {
  vi.mocked(fetchContextAvailability).mockResolvedValue({
    gitChanges: { available: false, reason: 'git-unavailable' },
    projectTree: { available: true },
  });
  const onNotice = vi.fn();
  const hook = renderHook(
    (props: { sessionId: string }) => {
      const [openMenu, setOpenMenu] = useState<OpenMenu>(initial.openMenu);
      const composerDraft = useComposerDraft({
        sessionId: props.sessionId,
        projectId: 'p1',
        rootKey: '/root',
      });
      const attachments = useComposerAttachments({
        composerDraft,
        openMenu,
        activeProjectId: 'p1',
        setOpenMenu,
        onNotice,
      });
      return { composerDraft, openMenu, setOpenMenu, ...attachments };
    },
    { initialProps: { sessionId: initial.sessionId } },
  );
  return { ...hook, onNotice };
}

const imageFile = (name: string, content = 'abc') =>
  new File([content], name, { type: 'image/png' });
const fileList = (...files: File[]) => files as unknown as FileList;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('stages image files as base64, ignores non-images and removes a staged image', async () => {
  const { result } = setup({ sessionId: 'a', openMenu: null });

  await act(async () => {
    await result.current.addImageFiles(
      fileList(imageFile('a.png'), new File(['x'], 'note.txt', { type: 'text/plain' })),
    );
  });
  const images = result.current.composerDraft.draft.images as readonly PendingImage[];
  expect(images).toHaveLength(1);
  expect(images[0]).toMatchObject({ name: 'a.png', mediaType: 'image/png', data: 'YWJj' });

  act(() => result.current.removePendingImage(images[0]?.id ?? ''));
  expect(result.current.composerDraft.draft.images).toEqual([]);
});

it('drops images that finish reading after the composer owner changed', async () => {
  const { result, rerender } = setup({ sessionId: 'a', openMenu: null });

  let pending: Promise<void> | undefined;
  act(() => {
    pending = result.current.addImageFiles(fileList(imageFile('late.png')));
  });
  rerender({ sessionId: 'b' });
  await act(async () => {
    await pending;
  });

  expect(result.current.composerDraft.draft.images).toEqual([]);
  rerender({ sessionId: 'a' });
  expect(result.current.composerDraft.draft.images).toEqual([]);
});

it('stages pasted images and lets plain text paste through', async () => {
  const { result } = setup({ sessionId: 'a', openMenu: null });
  const textPaste = {
    clipboardData: { files: [] },
    preventDefault: vi.fn(),
  };
  act(() => result.current.handleComposerPaste(textPaste as never));
  expect(textPaste.preventDefault).not.toHaveBeenCalled();

  const imagePaste = {
    clipboardData: { files: [imageFile('p.png')] },
    preventDefault: vi.fn(),
  };
  await act(async () => result.current.handleComposerPaste(imagePaste as never));
  expect(imagePaste.preventDefault).toHaveBeenCalled();
  await waitFor(() => expect(result.current.composerDraft.draft.images).toHaveLength(1));
});

it('adds the viewer file to the draft, closes the menu and ignores a missing viewer file', () => {
  const { result } = setup({ sessionId: 'a', openMenu: 'context' });

  act(() => result.current.addViewerFileContext());
  expect(result.current.composerDraft.draft.files).toHaveLength(0);
  expect(result.current.openMenu).toBeNull();

  act(() => result.current.setViewerFilePath('src/index.ts'));
  act(() => result.current.setOpenMenu('context'));
  act(() => result.current.addViewerFileContext());
  expect(result.current.composerDraft.draft.files.map((file) => file.path)).toEqual([
    'src/index.ts',
  ]);
  expect(result.current.openMenu).toBeNull();
});

it('reads Git availability only while the context menu is open', async () => {
  vi.mocked(fetchContextAvailability).mockResolvedValueOnce({
    gitChanges: { available: true },
    projectTree: { available: true },
  });
  const { result } = setup({ sessionId: 'a', openMenu: null });
  expect(fetchContextAvailability).not.toHaveBeenCalled();

  act(() => result.current.setOpenMenu('context'));
  await waitFor(() =>
    expect(result.current.gitChangesAvailability).toEqual({
      projectId: 'p1',
      state: 'available',
    }),
  );

  vi.mocked(fetchContextAvailability).mockRejectedValue(new Error('offline'));
  act(() => result.current.setOpenMenu(null));
  act(() => result.current.setOpenMenu('context'));
  await waitFor(() => expect(result.current.gitChangesAvailability?.state).toBe('unknown'));
});
