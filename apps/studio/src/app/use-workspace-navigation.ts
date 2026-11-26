import {
  useState,
  type ChangeEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';

import { createWorkspaceApi } from '../features/workspace/workspace-api.js';
import type { SessionDetail } from '../features/workspace/workspace-types.js';
import { toStudioProject, toStudioSession, workspaceErrorMessage } from './app-helpers.js';
import type {
  DirectoryPickerWindow,
  OpenMenu,
  RunStatus,
  StudioProject,
  StudioSession,
} from './app-types.js';

const workspaceApi = createWorkspaceApi();

export type UseWorkspaceNavigationOptions = {
  readonly projects: readonly StudioProject[];
  readonly setProjects: Dispatch<SetStateAction<readonly StudioProject[]>>;
  readonly setOpenMenu: Dispatch<SetStateAction<OpenMenu>>;
  /** Shows (or clears with `null`) the App-level notice banner. */
  readonly onNotice: (message: string | null) => void;
  /** Hidden `<input webkitdirectory>` used when no directory picker API exists. */
  readonly directoryInputRef: RefObject<HTMLInputElement | null>;
  readonly getSessionRunStatus: (sessionId: string) => RunStatus;
  readonly applySessionDetail: (projectId: string, detail: SessionDetail) => boolean;
  /** Activates a freshly created project and its first session in the App. */
  readonly onProjectCreated: (project: StudioProject, session: StudioSession) => void;
};

/**
 * Owns the sidebar-level project and session management UI state: the new-project
 * dialog, the project-folder dialog, project and session renaming, and session search.
 * Active project/session selection and run state stay in the App.
 */
export function useWorkspaceNavigation({
  projects,
  setProjects,
  setOpenMenu,
  onNotice,
  directoryInputRef,
  getSessionRunStatus,
  applySessionDetail,
  onProjectCreated,
}: UseWorkspaceNavigationOptions) {
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);
  const [folderDialogProjectId, setFolderDialogProjectId] = useState<string | null>(null);
  const [folderDialogPath, setFolderDialogPath] = useState('');
  const [folderDialogError, setFolderDialogError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [selectedFolderName, setSelectedFolderName] = useState('');
  const [selectedFolderPath, setSelectedFolderPath] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingSession, setEditingSession] = useState<{
    readonly projectId: string;
    readonly sessionId: string;
  } | null>(null);
  const [sessionTitleInput, setSessionTitleInput] = useState('');
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectRenameInput, setProjectRenameInput] = useState('');

  function openSessionEditor(projectId: string, sessionId: string): void {
    if (getSessionRunStatus(sessionId) === 'streaming') {
      return;
    }

    const session = projects
      .find((project) => project.id === projectId)
      ?.sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined || session.archivedAt !== null) {
      return;
    }

    setEditingSession({ projectId, sessionId });
    setSessionTitleInput(session.title);
  }

  async function saveSessionTitle(): Promise<void> {
    const editing = editingSession;
    const title = sessionTitleInput.trim();
    if (
      editing === null ||
      title === '' ||
      getSessionRunStatus(editing.sessionId) === 'streaming'
    ) {
      return;
    }

    try {
      const detail = await workspaceApi.renameSession(editing.sessionId, title);
      applySessionDetail(editing.projectId, detail);
      setEditingSession(null);
    } catch (error: unknown) {
      onNotice(workspaceErrorMessage(error));
    }
  }

  function openProjectRename(project: StudioProject): void {
    setOpenMenu(null);
    setRenamingProjectId(project.id);
    setProjectRenameInput(project.name);
  }

  async function saveProjectName(): Promise<void> {
    const projectId = renamingProjectId;
    const name = projectRenameInput.trim();
    if (projectId === null || name === '') {
      return;
    }
    try {
      const updated = await workspaceApi.renameProject(projectId, name);
      setProjects((current) =>
        current.map((project) =>
          project.id === projectId ? { ...project, name: updated.name } : project,
        ),
      );
      setRenamingProjectId(null);
    } catch (error: unknown) {
      onNotice(workspaceErrorMessage(error));
    }
  }

  function openProjectDialog(): void {
    setOpenMenu(null);
    setProjectName('');
    setSelectedFolderName('');
    setSelectedFolderPath('');
    setIsProjectDialogOpen(true);
  }

  function applySelectedFolder(folderName: string): void {
    const normalized = folderName.trim();
    if (normalized === '') {
      return;
    }

    setSelectedFolderName(normalized);
    setProjectName(normalized);
  }

  /**
   * Desktop uses the system dialog and receives an absolute path. The browser
   * picker only exposes a folder name, so the path must be typed separately.
   */
  async function chooseProjectFolder(): Promise<void> {
    const desktopPicker = window.weaveDesktop?.pickDirectory;
    if (desktopPicker !== undefined) {
      try {
        const picked = await desktopPicker();
        if (picked !== null) {
          applySelectedFolder(picked.name);
          setSelectedFolderPath(picked.path);
        }
      } catch {
        onNotice('无法打开文件夹选择框，请重试');
      }
      return;
    }

    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (picker === undefined) {
      directoryInputRef.current?.click();
      return;
    }

    try {
      const directory = await picker();
      applySelectedFolder(directory.name);
    } catch (error: unknown) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        onNotice('无法读取所选文件夹，请重试');
      }
    }
  }

  function chooseFallbackFolder(event: ChangeEvent<HTMLInputElement>): void {
    const firstFile = event.target.files?.[0];
    if (firstFile === undefined) {
      return;
    }

    const relativePath = firstFile.webkitRelativePath;
    applySelectedFolder(relativePath.split('/')[0] || firstFile.name);
    event.target.value = '';
  }

  async function createProject(): Promise<void> {
    const name = projectName.trim();
    const folderName = selectedFolderName.trim();
    if (name === '' || folderName === '') {
      return;
    }

    try {
      const folderPath = selectedFolderPath.trim();
      const project = await workspaceApi.createProject({
        name,
        folderName,
        ...(folderPath === '' ? {} : { folderPath }),
      });
      const session = await workspaceApi.createSession(project.id);
      const studioSession = toStudioSession(session);
      const nextProject: StudioProject = {
        ...toStudioProject({ ...project, sessions: [] }),
        sessions: [studioSession],
      };
      setIsProjectDialogOpen(false);
      setSearchQuery('');
      onProjectCreated(nextProject, studioSession);
    } catch (error: unknown) {
      onNotice(workspaceErrorMessage(error));
    }
  }

  function openFolderDialog(project: StudioProject): void {
    setOpenMenu(null);
    setFolderDialogProjectId(project.id);
    setFolderDialogPath(project.folderPath ?? '');
    setFolderDialogError(null);
  }

  async function pickFolderForDialog(): Promise<void> {
    const desktopPicker = window.weaveDesktop?.pickDirectory;
    if (desktopPicker === undefined) {
      return;
    }
    try {
      const picked = await desktopPicker();
      if (picked !== null) {
        setFolderDialogPath(picked.path);
        setFolderDialogError(null);
      }
    } catch {
      setFolderDialogError('无法打开文件夹选择框，请重试');
    }
  }

  /** Saves or clears the folder of an existing Project; the Server validates the path. */
  async function saveProjectFolder(folderPath: string | null): Promise<void> {
    const projectId = folderDialogProjectId;
    if (projectId === null) {
      return;
    }
    try {
      const updated = await workspaceApi.updateProjectFolder(projectId, folderPath);
      setProjects((current) =>
        current.map((project) =>
          project.id === projectId ? { ...project, folderPath: updated.folderPath } : project,
        ),
      );
      setFolderDialogProjectId(null);
      onNotice(folderPath === null ? '已清除项目文件夹' : '项目文件夹已更新');
    } catch (error: unknown) {
      setFolderDialogError(workspaceErrorMessage(error));
    }
  }

  return {
    isProjectDialogOpen,
    setIsProjectDialogOpen,
    folderDialogProjectId,
    setFolderDialogProjectId,
    folderDialogPath,
    setFolderDialogPath,
    folderDialogError,
    projectName,
    setProjectName,
    selectedFolderName,
    selectedFolderPath,
    setSelectedFolderPath,
    isSearchOpen,
    setIsSearchOpen,
    searchQuery,
    setSearchQuery,
    editingSession,
    setEditingSession,
    sessionTitleInput,
    setSessionTitleInput,
    renamingProjectId,
    setRenamingProjectId,
    projectRenameInput,
    setProjectRenameInput,
    openSessionEditor,
    saveSessionTitle,
    openProjectRename,
    saveProjectName,
    openProjectDialog,
    chooseProjectFolder,
    chooseFallbackFolder,
    createProject,
    openFolderDialog,
    pickFolderForDialog,
    saveProjectFolder,
  };
}
