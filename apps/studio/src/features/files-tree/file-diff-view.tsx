import { useEffect, useState, type ReactElement } from 'react';
import { DiffModeEnum, DiffView } from '@git-diff-view/react';
import { generateDiffFile } from '@git-diff-view/file';
import { getDiffViewHighlighter } from '@git-diff-view/shiki';
import '@git-diff-view/react/styles/diff-view-pure.css';

import { fetchFileDiff, type FileDiff } from './file-diff-api.js';
import { languageForPath } from './highlight.js';

/**
 * The "改动" view: one file's current content diffed against its Git base
 * (`HEAD`), rendered GitHub-style via `@git-diff-view` with Shiki syntax
 * highlighting so colors match the content viewer. The whole module (diff
 * component, Shiki highlighter, its CSS) is code-split and only loaded when a
 * file's diff is first opened. Everything runs on data the Server already
 * resolved; the browser never touches Git.
 */

type Status = 'loading' | 'ready' | 'unchanged' | 'error';

type DiffFileInstance = ReturnType<typeof generateDiffFile>;
type DiffHighlighter = Awaited<ReturnType<typeof getDiffViewHighlighter>>;

interface Prepared {
  readonly diffFile: DiffFileInstance;
  readonly highlighter: DiffHighlighter;
  readonly tracked: boolean;
}

export interface FileDiffViewProps {
  readonly projectId: string;
  readonly path: string;
}

/** Builds a highlighted `DiffFile` from the two contents, ready for `DiffView`. */
async function prepareDiff(diff: FileDiff): Promise<Prepared> {
  const highlighter = await getDiffViewHighlighter();
  const lang = languageForPath(diff.path) ?? 'txt';
  const diffFile = generateDiffFile(
    diff.path,
    diff.oldContent,
    diff.path,
    diff.newContent,
    lang,
    lang,
  );
  diffFile.initTheme('light');
  diffFile.initRaw();
  diffFile.initSyntax({ registerHighlighter: highlighter });
  diffFile.buildSplitDiffLines();
  diffFile.buildUnifiedDiffLines();
  return { diffFile, highlighter, tracked: diff.tracked };
}

export function FileDiffView({ projectId, path }: FileDiffViewProps): ReactElement {
  const [status, setStatus] = useState<Status>('loading');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [tracked, setTracked] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setStatus('loading');
    setPrepared(null);
    setError('');
    void (async () => {
      try {
        const diff = await fetchFileDiff(projectId, path);
        if (!active) {
          return;
        }
        setTracked(diff.tracked);
        if (!diff.changed) {
          setStatus('unchanged');
          return;
        }
        const next = await prepareDiff(diff);
        if (!active) {
          return;
        }
        setPrepared(next);
        setStatus('ready');
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : '加载失败');
          setStatus('error');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, path]);

  if (status === 'loading') {
    return <p className="file-tree-hint">加载改动…</p>;
  }
  if (status === 'error') {
    return (
      <p className="file-tree-error" role="alert">
        {error}
      </p>
    );
  }
  if (status === 'unchanged') {
    return (
      <p className="file-viewer-note">
        {tracked ? '该文件无未提交改动。' : '新文件，基线（HEAD）中尚无内容。'}
      </p>
    );
  }
  return (
    <div className="file-diff">
      {prepared !== null && !prepared.tracked ? (
        <p className="file-viewer-note">新文件：基线（HEAD）中不存在，全部按新增显示。</p>
      ) : null}
      {prepared !== null ? (
        <DiffView
          diffFile={prepared.diffFile}
          registerHighlighter={prepared.highlighter}
          diffViewMode={DiffModeEnum.Unified}
          diffViewTheme="light"
          diffViewHighlight
          diffViewWrap
          diffViewFontSize={12}
        />
      ) : null}
    </div>
  );
}
