import { ChevronRight, FolderKanban, FolderOpen, X } from 'lucide-react';
import type { ReactElement, RefObject } from 'react';

import type { StudioProject } from './app-types.js';
import type { useWorkspaceNavigation } from './use-workspace-navigation.js';

type WorkspaceNavigationState = ReturnType<typeof useWorkspaceNavigation>;

export type RenameProjectDialogProps = Pick<
  WorkspaceNavigationState,
  'projectRenameInput' | 'setProjectRenameInput' | 'setRenamingProjectId' | 'saveProjectName'
>;

/** Renames one project's display name. */
export function RenameProjectDialog({
  projectRenameInput,
  setProjectRenameInput,
  setRenamingProjectId,
  saveProjectName,
}: RenameProjectDialogProps): ReactElement {
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          setRenamingProjectId(null);
        }
      }}
    >
      <section
        className="project-dialog session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-project-dialog-title"
      >
        <header className="project-dialog-header">
          <div>
            <p>项目设置</p>
            <h2 id="rename-project-dialog-title">重命名项目</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭重命名项目"
            onClick={() => setRenamingProjectId(null)}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <form
          className="project-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveProjectName();
          }}
        >
          <label className="project-name-field">
            <span>项目名称</span>
            <div>
              <FolderKanban aria-hidden="true" />
              <input
                type="text"
                aria-label="新的项目名称"
                value={projectRenameInput}
                onChange={(event) => setProjectRenameInput(event.target.value)}
                autoFocus
              />
            </div>
          </label>
          <p className="project-dialog-note">只修改显示名称，项目文件夹和会话保持不变。</p>
          <footer className="project-dialog-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setRenamingProjectId(null)}
            >
              取消
            </button>
            <button
              className="primary-button"
              type="submit"
              aria-label="保存项目名称"
              disabled={projectRenameInput.trim() === ''}
            >
              保存
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export type FolderDialogProps = Pick<
  WorkspaceNavigationState,
  | 'folderDialogPath'
  | 'folderDialogError'
  | 'setFolderDialogPath'
  | 'setFolderDialogProjectId'
  | 'pickFolderForDialog'
  | 'saveProjectFolder'
> & {
  readonly folderDialogProjectId: string;
  readonly projects: readonly StudioProject[];
};

/** Sets the local folder an Agent may read and write for a project. */
export function FolderDialog({
  folderDialogProjectId,
  folderDialogPath,
  folderDialogError,
  setFolderDialogPath,
  setFolderDialogProjectId,
  pickFolderForDialog,
  saveProjectFolder,
  projects,
}: FolderDialogProps): ReactElement {
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          setFolderDialogProjectId(null);
        }
      }}
    >
      <section
        className="project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="设置项目文件夹"
      >
        <header className="project-dialog-header">
          <div>
            <p>本地项目</p>
            <h2>设置项目文件夹</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭设置项目文件夹"
            onClick={() => setFolderDialogProjectId(null)}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <form
          className="project-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            const folderPath = folderDialogPath.trim();
            if (folderPath !== '') {
              void saveProjectFolder(folderPath);
            }
          }}
        >
          {window.weaveDesktop?.pickDirectory === undefined ? (
            <label className="project-name-field">
              <span>文件夹绝对路径</span>
              <div>
                <FolderOpen aria-hidden="true" />
                <input
                  type="text"
                  aria-label="项目文件夹绝对路径"
                  placeholder="例如 /Users/me/projects/demo"
                  value={folderDialogPath}
                  onChange={(event) => setFolderDialogPath(event.target.value)}
                />
              </div>
            </label>
          ) : (
            <div className="project-folder-field">
              <span>项目文件夹</span>
              <button
                className={`folder-picker${folderDialogPath === '' ? '' : ' folder-picker-selected'}`}
                type="button"
                aria-label="选择项目文件夹"
                onClick={() => void pickFolderForDialog()}
              >
                <span className="folder-picker-icon" aria-hidden="true">
                  <FolderOpen />
                </span>
                <span>
                  <strong className="selected-folder-name">
                    {folderDialogPath === '' ? '选择本地文件夹' : folderDialogPath}
                  </strong>
                  <small>Agent 将在该文件夹中读写文件</small>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
          )}
          <p className="project-dialog-note">
            Agent 可以读取该文件夹中的文本文件；写入文件前会请你确认。
          </p>
          {folderDialogError === null ? null : (
            <p className="project-dialog-note approval-card-error" role="alert">
              {folderDialogError}
            </p>
          )}
          <footer className="project-dialog-actions">
            {projects.find((project) => project.id === folderDialogProjectId)?.folderPath ===
            undefined ? null : (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void saveProjectFolder(null)}
              >
                清除文件夹
              </button>
            )}
            <button
              className="secondary-button"
              type="button"
              onClick={() => setFolderDialogProjectId(null)}
            >
              取消
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={folderDialogPath.trim() === ''}
            >
              保存
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export type CreateProjectDialogProps = Pick<
  WorkspaceNavigationState,
  | 'projectName'
  | 'setProjectName'
  | 'selectedFolderName'
  | 'selectedFolderPath'
  | 'setSelectedFolderPath'
  | 'setIsProjectDialogOpen'
  | 'chooseProjectFolder'
  | 'chooseFallbackFolder'
  | 'createProject'
> & {
  readonly directoryInputRef: RefObject<HTMLInputElement | null>;
};

/** Creates a project from a name and a local folder. */
export function CreateProjectDialog({
  projectName,
  setProjectName,
  selectedFolderName,
  selectedFolderPath,
  setSelectedFolderPath,
  setIsProjectDialogOpen,
  chooseProjectFolder,
  chooseFallbackFolder,
  createProject,
  directoryInputRef,
}: CreateProjectDialogProps): ReactElement {
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          setIsProjectDialogOpen(false);
        }
      }}
    >
      <section
        className="project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-dialog-title"
      >
        <header className="project-dialog-header">
          <div>
            <p>本地项目</p>
            <h2 id="project-dialog-title">创建项目</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭创建项目"
            onClick={() => setIsProjectDialogOpen(false)}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <form
          className="project-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createProject();
          }}
        >
          <label className="project-name-field">
            <span>项目名称</span>
            <div>
              <FolderKanban aria-hidden="true" />
              <input
                type="text"
                aria-label="项目名称"
                placeholder="选择文件夹后自动生成"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
            </div>
          </label>
          <div className="project-folder-field">
            <span>项目文件夹</span>
            <button
              className={`folder-picker${selectedFolderName === '' ? '' : ' folder-picker-selected'}`}
              type="button"
              aria-label="选择文件夹"
              onClick={() => void chooseProjectFolder()}
            >
              <span className="folder-picker-icon" aria-hidden="true">
                <FolderOpen />
              </span>
              {selectedFolderName === '' ? (
                <span>
                  <strong>选择本地文件夹</strong>
                  <small>项目将使用该文件夹作为工作目录</small>
                </span>
              ) : (
                <span>
                  <strong className="selected-folder-name">{selectedFolderName}</strong>
                  <small>已选择本地文件夹</small>
                </span>
              )}
              <ChevronRight aria-hidden="true" />
            </button>
            <input
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              className="sr-only"
              ref={directoryInputRef}
              type="file"
              aria-label="选择项目文件夹"
              multiple
              onChange={chooseFallbackFolder}
            />
          </div>
          {window.weaveDesktop?.pickDirectory === undefined ? (
            <label className="project-name-field">
              <span>文件夹绝对路径（可选）</span>
              <div>
                <FolderOpen aria-hidden="true" />
                <input
                  type="text"
                  aria-label="文件夹绝对路径"
                  placeholder="例如 /Users/me/projects/demo，填写后 Agent 可读写其中文件"
                  value={selectedFolderPath}
                  onChange={(event) => setSelectedFolderPath(event.target.value)}
                />
              </div>
            </label>
          ) : selectedFolderPath === '' ? null : (
            <p className="project-dialog-note project-folder-path">{selectedFolderPath}</p>
          )}
          <p className="project-dialog-note">
            {selectedFolderPath.trim() === ''
              ? '未设置文件夹路径时，Agent 不能读写项目文件。'
              : 'Agent 可以读取该文件夹中的文本文件；写入文件前会请你确认。'}
          </p>
          <footer className="project-dialog-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setIsProjectDialogOpen(false)}
            >
              取消
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={projectName.trim() === '' || selectedFolderName === ''}
            >
              创建项目
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
