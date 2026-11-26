import { Pencil, Trash2, X } from 'lucide-react';
import type { ReactElement } from 'react';

import type { SessionToDelete } from './use-session-lifecycle.js';

export type EditSessionDialogProps = {
  readonly sessionTitleInput: string;
  readonly setSessionTitleInput: (title: string) => void;
  readonly setEditingSession: (session: null) => void;
  readonly saveSessionTitle: () => Promise<void>;
};

/** Renames one session. */
export function EditSessionDialog({
  sessionTitleInput,
  setSessionTitleInput,
  setEditingSession,
  saveSessionTitle,
}: EditSessionDialogProps): ReactElement {
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          setEditingSession(null);
        }
      }}
    >
      <section
        className="project-dialog session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-session-dialog-title"
      >
        <header className="project-dialog-header">
          <div>
            <p>会话设置</p>
            <h2 id="edit-session-dialog-title">编辑会话</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭编辑会话"
            onClick={() => setEditingSession(null)}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <form
          className="project-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveSessionTitle();
          }}
        >
          <label className="project-name-field">
            <span>会话标题</span>
            <div>
              <Pencil aria-hidden="true" />
              <input
                type="text"
                aria-label="会话标题"
                value={sessionTitleInput}
                onChange={(event) => setSessionTitleInput(event.target.value)}
                autoFocus
              />
            </div>
          </label>
          <footer className="project-dialog-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setEditingSession(null)}
            >
              取消
            </button>
            <button
              className="primary-button"
              type="submit"
              aria-label="保存标题"
              disabled={sessionTitleInput.trim() === ''}
            >
              保存
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export type DeleteSessionDialogProps = {
  readonly sessionToDelete: SessionToDelete;
  readonly setSessionToDelete: (session: null) => void;
  readonly permanentlyDeleteSession: () => Promise<void>;
};

/** Confirms permanently deleting an archived session. */
export function DeleteSessionDialog({
  sessionToDelete,
  setSessionToDelete,
  permanentlyDeleteSession,
}: DeleteSessionDialogProps): ReactElement {
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          setSessionToDelete(null);
        }
      }}
    >
      <section
        className="project-dialog session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-session-dialog-title"
      >
        <header className="project-dialog-header">
          <div>
            <p>归档会话</p>
            <h2 id="delete-session-dialog-title">删除会话</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭删除确认"
            onClick={() => setSessionToDelete(null)}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="project-dialog-form">
          <p className="delete-session-warning">
            确定要删除“{sessionToDelete.title}
            ”吗？删除后无法在界面中恢复。会话的历史记录仍保留在本机数据文件中。
          </p>
          <footer className="project-dialog-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setSessionToDelete(null)}
            >
              取消
            </button>
            <button
              className="danger-button"
              type="button"
              aria-label="确认删除"
              onClick={() => void permanentlyDeleteSession()}
            >
              <Trash2 aria-hidden="true" />
              删除
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}
