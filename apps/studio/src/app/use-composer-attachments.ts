import {
  useEffect,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { useComposerDraft } from '../features/composer/use-composer-draft.js';
import { fetchContextAvailability } from '../features/file-context/context-availability-api.js';
import type { ExecutionContextKind } from '../features/file-context/execution-context-types.js';
import { createId, readImageFile } from './app-helpers.js';
import type { OpenMenu, PendingImage } from './app-types.js';

type ComposerDraft = ReturnType<typeof useComposerDraft>;

export type UseComposerAttachmentsOptions = {
  readonly composerDraft: ComposerDraft;
  readonly openMenu: OpenMenu;
  readonly activeProjectId: string;
  readonly setOpenMenu: Dispatch<SetStateAction<OpenMenu>>;
  /** Shows (or clears with `null`) the App-level notice banner. */
  readonly onNotice: (message: string | null) => void;
};

/**
 * Owns the composer's attachment actions: staged images (picker and paste),
 * file and context additions from the "+" menu, the file open in the viewer
 * panel, and whether the active project can supply Git changes.
 */
export function useComposerAttachments({
  composerDraft,
  openMenu,
  activeProjectId,
  setOpenMenu,
  onNotice,
}: UseComposerAttachmentsOptions) {
  const [viewerFilePath, setViewerFilePath] = useState<string | null>(null);
  // Whether the active project can supply Git changes; read when the context menu opens.
  const [gitChangesAvailability, setGitChangesAvailability] = useState<{
    readonly projectId: string;
    readonly state: 'available' | 'unavailable' | 'unknown';
  } | null>(null);

  useEffect(() => {
    if (openMenu !== 'context' || activeProjectId === '') return undefined;
    const controller = new AbortController();
    void fetchContextAvailability(activeProjectId, { signal: controller.signal })
      .then((availability) =>
        setGitChangesAvailability({
          projectId: activeProjectId,
          state: availability.gitChanges.available ? 'available' : 'unavailable',
        }),
      )
      .catch(() => {
        if (!controller.signal.aborted)
          setGitChangesAvailability({ projectId: activeProjectId, state: 'unknown' });
      });
    return () => controller.abort();
  }, [openMenu, activeProjectId]);

  function addComposerContext(kind: ExecutionContextKind): void {
    composerDraft.addContext(composerDraft.owner, kind);
    setOpenMenu(null);
  }

  function addViewerFileContext(): void {
    if (viewerFilePath !== null) {
      const result = composerDraft.addFile(composerDraft.owner, viewerFilePath);
      if (result === 'full') onNotice('最多添加 8 个文件，请先移除文件。');
    }
    setOpenMenu(null);
  }

  /** Reads image files from an attach picker or paste into the staged list. */
  async function addImageFiles(files: FileList | null): Promise<void> {
    if (files === null || files.length === 0) {
      return;
    }
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      return;
    }
    const imageOwner = composerDraft.owner;
    const read = await Promise.all(
      imageFiles.map(async (file) => {
        const { mediaType, data } = await readImageFile(file);
        return { id: createId('img'), name: file.name, mediaType, data };
      }),
    );
    if (!composerDraft.isOwnerCurrent(imageOwner)) return;
    const added = read.filter((image) => image.data !== '');
    if (added.length === 0) {
      return;
    }
    composerDraft.setImages<PendingImage>((current) => [...current, ...added]);
  }

  function removePendingImage(id: string): void {
    composerDraft.setImages<PendingImage>((current) => current.filter((image) => image.id !== id));
  }

  function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    const files = event.clipboardData.files;
    if (files.length === 0 || !Array.from(files).some((file) => file.type.startsWith('image/'))) {
      return;
    }
    event.preventDefault();
    void addImageFiles(files);
  }

  return {
    viewerFilePath,
    setViewerFilePath,
    gitChangesAvailability,
    addComposerContext,
    addViewerFileContext,
    addImageFiles,
    removePendingImage,
    handleComposerPaste,
  };
}
