import { type ReactElement } from 'react';
import { FilePen, FileText } from 'lucide-react';

import { collectFiles, splitPath, type PanelContext } from './panel-data.js';

/** Files the Agent read or wrote in this Session, newest first. */
export function FilesPanel(props: PanelContext): ReactElement {
  const files = collectFiles(props.messages);

  return (
    <div className="panel-body" role="region" aria-label="文件">
      <section className="overview-block">
        <div className="overview-block-heading">
          <h3>文件</h3>
          <span className="activity-state">{files.length} 个</span>
        </div>
        {files.length === 0 ? (
          <p className="activity-hint">Agent 读写文件后会列在这里。</p>
        ) : (
          <ul className="file-list">
            {files.map((file) => {
              const { name, directory } = splitPath(file.path);
              const isWrite = file.operation === '写入';
              const Icon = isWrite ? FilePen : FileText;
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    title={`${file.state} · ${file.path}`}
                    onClick={() => props.onJumpToMessage(file.messageId)}
                  >
                    <span
                      className={`file-icon${isWrite ? ' file-icon-write' : ''}`}
                      aria-hidden="true"
                    >
                      <Icon />
                    </span>
                    <span className="sr-only">{file.operation}</span>
                    <span className="file-name">{name}</span>
                    <span className="file-dir">{directory}</span>
                    {file.ok && !isWrite ? null : (
                      <span className={file.ok ? 'file-state-ok' : 'file-state-bad'}>
                        {file.state}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
