import type { ReactElement } from 'react';
import {
  executionContextLabels,
  type ExecutionContext,
  type ExecutionContextKind,
} from './execution-context-types.js';
import type { FileAttachmentSummary, FileReference } from './file-context-types.js';
export function DraftFileAttachments({
  files,
  onRemove,
}: {
  readonly files: readonly FileReference[];
  readonly onRemove: (path: string) => void;
}): ReactElement | null {
  return files.length === 0 ? null : (
    <div className="file-attachments" aria-label="待发送文件">
      {files.map(({ path }) => (
        <span className="file-attachment" key={path} title={path}>
          <span>{path}</span>
          <button type="button" aria-label={`移除文件 ${path}`} onClick={() => onRemove(path)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
export function FileAttachmentSummaries({
  files,
}: {
  readonly files: readonly FileAttachmentSummary[] | undefined;
}): ReactElement | null {
  return files === undefined || files.length === 0 ? null : (
    <div className="file-attachments file-attachment-summaries" aria-label="发送时快照">
      <span>发送时快照</span>
      {files.map((file) => (
        <span className="file-attachment" key={file.path} title={file.path}>
          {file.path} · {file.byteLength} 字节
        </span>
      ))}
    </div>
  );
}
export function DraftContextAttachments({
  contexts,
  onRemove,
}: {
  readonly contexts: readonly ExecutionContext[];
  readonly onRemove: (kind: ExecutionContextKind) => void;
}): ReactElement | null {
  return contexts.length === 0 ? null : (
    <div className="file-attachments" aria-label="待发送上下文">
      {contexts.map(({ kind }) => (
        <span className="file-attachment" key={kind}>
          <span>{executionContextLabels[kind]}</span>
          <button
            type="button"
            aria-label={`移除${executionContextLabels[kind]}`}
            onClick={() => onRemove(kind)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
